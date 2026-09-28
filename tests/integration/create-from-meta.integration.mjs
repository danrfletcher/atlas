#!/usr/bin/env node
/**
 * Create from a meta folder (Block / File / Module): in-app integration checks over the Chrome DevTools
 * Protocol (spec C2 IT-1 to IT-4, IT-6 to IT-8, IT-10, IT-12, plus the menu fence checks).
 *
 * STATUS: written, not executed by the coder (no desktop container in the build environment). The vitest
 * suites (tests/unit/create-from-meta.test.ts, tests/integration/create-from-meta.test.ts) cover the same
 * behaviour over the mock App; this script is for the tester, against real Obsidian. The golden-path
 * script (spec E) and the screenshots are separate and are not in this file.
 *
 * Setup (once per group; the vault must be pristine, so restore it and relaunch Obsidian between groups,
 * never write vault files from the host while Obsidian runs):
 *   1. Build the `atlas-pr4` fixture vault from the spec's T0 (root files Existing.md, MixedCase.md,
 *      Reading list.md, Report.pdf, Ärger.md; folders Existing Folder, Archive, Sub, _pool) and seed
 *      data.json with the T-many view (meta "Field tech", id "ft", at index 1 of the Default root,
 *      expanded, with children Existing.md, the Archive module, a "Sub" meta holding Sub/Nested Note.md
 *      and a "Deep" meta holding the Existing Folder module, and Report.pdf).
 *   2. Build with the harness on: `ATLAS_TEST=1 node esbuild.config.mjs` (non-production, so
 *      window.__atlasTest exists); copy main.js, manifest.json, styles.css into the plugin folder.
 *   3. Launch Obsidian with --remote-debugging-port=9222, enable Atlas, wait for the explorer.
 *
 * Usage: node create-from-meta.integration.mjs <group> [--port 9222] [--vault /path/to/vault]
 * Groups: file module block children menu clash cancel failure links tab
 * (one per invocation). Exit code 0 when every check in the group passes; each check prints PASS/FAIL.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const group = args[0];
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const PORT = opt("--port", "9222");
const VAULT = opt("--vault", "/config/workspace/vault-pr4");

// --- CDP plumbing -------------------------------------------------------------------------------
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = targets.find((t) => t.type === "page" && /obsidian|app:\/\//i.test(t.url + t.title)) ?? targets.find((t) => t.type === "page");
if (!page) throw new Error("no page target on the debugging port");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)));
let nextId = 1;
const waiting = new Map();
const consoleProblems = [];
ws.onmessage = (event) => {
	const msg = JSON.parse(event.data);
	if (msg.id && waiting.has(msg.id)) waiting.get(msg.id)(msg);
	if (msg.method === "Runtime.exceptionThrown") consoleProblems.push(msg.params.exceptionDetails.text);
	if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") consoleProblems.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
};
async function send(method, params = {}) {
	const id = nextId++;
	const reply = new Promise((resolve) => waiting.set(id, resolve));
	ws.send(JSON.stringify({ id, method, params }));
	return reply;
}
await send("Runtime.enable");
/** Evaluates an async body in the Obsidian page and returns its JSON value. */
async function page_(body) {
	const { result } = await send("Runtime.evaluate", { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
	return result.result.value;
}

let failures = 0;
function check(name, ok, detail = "") {
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? ` -- ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
}
const sha = (path) => createHash("sha256").update(readFileSync(join(VAULT, path))).digest("hex");
const mtime = (path) => statSync(join(VAULT, path)).mtimeMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Page-side helpers, installed once per run.
await page_(`
	window.__cfm = {
		sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
		toasts: () => [...document.querySelectorAll(".notice")].map((n) => n.textContent),
		rowByText: (text, nth = 0) => [...document.querySelectorAll(".atlas-row")].filter((r) => r.querySelector(".atlas-row-text")?.textContent === text)[nth],
		menuTitles: () => [...document.querySelectorAll(".menu .menu-item-title")].map((n) => n.textContent),
		async rightClick(row) {
			row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }));
			await __cfm.sleep(150);
		},
		async pickMenu(title) {
			const item = [...document.querySelectorAll(".menu .menu-item")].find((i) => i.querySelector(".menu-item-title")?.textContent === title);
			if (!item) throw new Error("no menu item " + title);
			item.click();
			await __cfm.sleep(200);
		},
		async closeMenus() { document.body.click(); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await __cfm.sleep(100); },
		/** Right-click the meta row, then Create, then the kind. Leaves the name dialog open. */
		async choose(label, kind) {
			await __cfm.rightClick(__cfm.rowByText(label));
			await __cfm.pickMenu("Create");
			await __cfm.pickMenu(kind);
		},
		dialog() {
			const input = document.querySelector(".modal .atlas-name-input");
			if (!input) return null;
			return {
				title: document.querySelector(".modal .modal-title")?.textContent,
				value: input.value,
				valid: input.classList.contains("atlas-name-valid"),
				invalid: input.classList.contains("atlas-name-invalid"),
				border: getComputedStyle(input).borderColor,
				message: document.querySelector(".modal .atlas-name-message")?.textContent ?? "",
				createDisabled: [...document.querySelectorAll(".modal button")].find((b) => b.textContent === "Create").disabled,
			};
		},
		type(value) {
			const input = document.querySelector(".modal .atlas-name-input");
			input.value = value;
			input.dispatchEvent(new Event("input", { bubbles: true }));
		},
		click(label) { [...document.querySelectorAll(".modal button")].find((b) => b.textContent === label).click(); },
		nodes: (pred) => {
			const out = [];
			const walk = (nodes, view) => nodes.forEach((n) => { if (pred(n)) out.push({ view, id: n.id, node: n }); walk(n.children, view); });
			app.plugins.plugins.atlas.viewsManager.getViews().forEach((v) => walk(v.root, v.id));
			return out;
		},
	};
	return true;
`);
const dump = () => page_(`return await __atlasTest.dump();`);
const listing = () => page_(`return app.vault.getAllLoadedFiles().map((f) => f.path).sort();`);
const diff = (before, after) => ({ added: after.filter((p) => !before.includes(p)), removed: before.filter((p) => !after.includes(p)) });
const CHILDREN = ["Existing.md", "Archive/Archive.md", "Sub/Nested Note.md", "Existing Folder/Existing Folder.md", "Report.pdf"];
const snapshot = () => Object.fromEntries(CHILDREN.map((p) => [p, { sha: sha(p), mtime: mtime(p) }]));
const ftNode = (d) => d.views[0].root[1];

async function runCreate(kind, name) {
	const before = await listing();
	const beforeData = await dump();
	const kids = snapshot();
	await page_(`await __cfm.choose("Field tech", ${JSON.stringify(kind)});`);
	const dialog = await page_(`return __cfm.dialog();`);
	check(`AC-1/AC-3 ${kind}: dialog is "Create ${kind[0].toUpperCase() + kind.slice(1)}", prefilled "Field tech", green, Create enabled`, dialog?.title === `Create ${kind[0].toUpperCase() + kind.slice(1)}` && dialog.value === "Field tech" && dialog.valid && !dialog.createDisabled, dialog);
	if (name) await page_(`__cfm.type(${JSON.stringify(name)});`);
	await page_(`__cfm.click("Create"); await __cfm.sleep(1500);`);
	const after = await listing();
	const afterData = await dump();
	check(`IT-4/F-1 ${kind}: every child has the same SHA-256 and mtime`, JSON.stringify(snapshot()) === JSON.stringify(kids));
	const kidsNode = JSON.stringify(ftNode(beforeData).children);
	check(`AC-4 ${kind}: same position (index 1) and the same children`, ftNode(afterData).id === ftNode(beforeData).id && JSON.stringify(ftNode(afterData).children) === kidsNode, { was: ftNode(beforeData), now: ftNode(afterData) });
	check(`AC-4 ${kind}: it is a unit node now and the label is gone`, ftNode(afterData).type === "unit" && !("label" in ftNode(afterData)), ftNode(afterData));
	return { before, after, beforeData, afterData };
}

// --- groups -------------------------------------------------------------------------------------
const groups = {
	async file() {
		const { before, after, afterData } = await runCreate("file");
		const d = diff(before, after);
		check("IT-1 vault diff is exactly + Field tech.md", d.removed.length === 0 && JSON.stringify(d.added) === JSON.stringify(["Field tech.md"]), d);
		check("IT-1 content is `# Field tech`", (await page_(`return await app.vault.adapter.read("Field tech.md");`)).trimEnd() === "# Field tech");
		check("IT-1 ref is the root file, and the unit index knows it", ftNode(afterData).ref?.path === "Field tech.md" && (await page_(`return app.plugins.plugins.atlas.unitIndex.getUnits().some((u) => u.type === "root-file" && u.path === "Field tech.md");`)));
		check("AC-6 nothing opened", (await page_(`return app.workspace.getActiveFile()?.path ?? null;`)) !== "Field tech.md");
	},

	async module() {
		const { before, after, afterData } = await runCreate("module");
		const d = diff(before, after);
		check("IT-2 diff is exactly + Field tech/ and + Field tech/Field tech.md", d.removed.length === 0 && JSON.stringify(d.added) === JSON.stringify(["Field tech", "Field tech/Field tech.md"]), d);
		check("IT-2 `Field tech/` holds only the note (children not pulled in)", after.filter((p) => p.startsWith("Field tech/")).length === 1);
		check("IT-2 ref is the folder, the row is a module and not missing", ftNode(afterData).ref?.kind === "folder" && (await page_(`const r = __cfm.rowByText("Field tech"); return !!r && !r.classList.contains("atlas-missing");`)));
		check("AC-6 nothing opened", (await page_(`return app.workspace.getActiveFile()?.path ?? null;`)) !== "Field tech/Field tech.md");
	},

	async block() {
		const { before, after, afterData } = await runCreate("block");
		const d = diff(before, after);
		check("IT-3 diff is exactly one new _pool/<ID>.md", d.removed.length === 0 && d.added.length === 1 && /^_pool\/\d{14}-[0-9a-z]{4}\.md$/.test(d.added[0]), d);
		const path = d.added[0];
		check("IT-3 first line is `# Field tech`", (await page_(`return (await app.vault.adapter.read(${JSON.stringify(path)})).split("\\n")[0];`)) === "# Field tech");
		check("IT-3 indexed as a free block", await page_(`return app.plugins.plugins.atlas.unitIndex.getUnits().some((u) => u.type === "free-block" && u.path === ${JSON.stringify(path)});`));
		await sleep(5000);
		check("IT-3 still in _pool with the same name after 5 seconds", (await listing()).includes(path) && ftNode(await dump()).ref?.path === path);
	},

	async children() {
		// IT-4 for the kind named on the command line (run once per kind on a pristine vault).
		const kind = opt("--kind", "module");
		await runCreate(kind);
	},

	async menu() {
		await page_(`await __cfm.rightClick(__cfm.rowByText("Field tech"));`);
		const titles = await page_(`return __cfm.menuTitles();`);
		check("AC-1 Create is in the meta menu, once, after Rename folder", titles.filter((t) => t === "Create").length === 1 && titles.indexOf("Create") > titles.indexOf("Rename folder"), titles);
		await page_(`await __cfm.pickMenu("Create");`);
		const chooser = await page_(`return __cfm.menuTitles();`);
		check("AC-1 the chooser offers Block, File, Module in that order", JSON.stringify(chooser.slice(-3)) === JSON.stringify(["Block", "File", "Module"]), chooser);
		await page_(`await __cfm.closeMenus(); await __cfm.closeMenus();`);
		for (const [label, text] of [["F-4 unit row (file)", "Existing"], ["F-4 unit row (pdf)", "Report.pdf"]]) {
			await page_(`await __cfm.rightClick(__cfm.rowByText(${JSON.stringify(text)}));`);
			check(`${label}: no Create`, !(await page_(`return __cfm.menuTitles();`)).includes("Create"));
			await page_(`await __cfm.closeMenus();`);
		}
		const commands = await page_(`return Object.keys(app.commands.commands).filter((id) => id.startsWith("atlas:")).sort();`);
		check("F-6 no create command on the palette", !commands.some((id) => /create/i.test(id)), commands);
		console.log("NOTE F-4: also right-click a free block, a root file, a module and a promoted block row in the inbox by hand or extend this group.");
	},

	async clash() {
		await page_(`await __cfm.choose("Field tech", "File");`);
		for (const name of ["Existing", "existing", "EXISTING", "Existing Folder", "existing folder"]) {
			await page_(`__cfm.type(${JSON.stringify(name)});`);
			const dialog = await page_(`return __cfm.dialog();`);
			check(`IT-6 File "${name}": red, exact message, Create disabled`, dialog.invalid && dialog.createDisabled && dialog.message === `A note or folder called '${name}' already exists at the vault root`, dialog);
		}
		await page_(`__cfm.type("Report");`);
		const green = await page_(`return __cfm.dialog();`);
		check("IT-6 File 'Report' is green (Report.pdf is not a note clash)", green.valid && !green.createDisabled, green);
		const redBorder = await page_(`__cfm.type("existing"); return __cfm.dialog().border;`);
		const greenBorder = await page_(`__cfm.type("Report"); return __cfm.dialog().border;`);
		check("IT-6 the computed border colour differs between red and green", redBorder !== greenBorder, { redBorder, greenBorder });
		await page_(`document.querySelector(".modal .atlas-name-input").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await __cfm.sleep(200);`);
		await page_(`await __cfm.choose("Field tech", "Block"); __cfm.type("Existing");`);
		const block = await page_(`return __cfm.dialog();`);
		check("AC-9 Block takes a clashing name as typed", block.valid && !block.createDisabled, block);
		await page_(`__cfm.type("   ");`);
		check("AC-9 Block refuses an empty name", (await page_(`return __cfm.dialog();`)).createDisabled);
		await page_(`document.querySelector(".modal .atlas-name-input").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await __cfm.sleep(200);`);
	},

	async cancel() {
		const before = await listing();
		const data = JSON.stringify(await dump());
		for (const dismiss of [
			`document.querySelector(".modal .atlas-name-input").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));`,
			`__cfm.click("Cancel");`,
			`document.querySelector(".modal-bg")?.click();`,
		]) {
			await page_(`await __cfm.choose("Field tech", "Module"); ${dismiss} await __cfm.sleep(300);`);
		}
		check("IT-7 vault listing identical after Escape, Cancel and an outside click", JSON.stringify(await listing()) === JSON.stringify(before));
		check("IT-7 data.json state identical", JSON.stringify(await dump()) === data);
		check("IT-7 no notice appeared", (await page_(`return __cfm.toasts();`)).length === 0);
	},

	async failure() {
		// IT-8: each call throws once. Restart from a pristine vault between the three runs.
		const kind = opt("--kind", "file");
		// For Module the folder is made first and the note create throws, which also exercises the cleanup.
		const method = "create";
		const before = await listing();
		const data = JSON.stringify((await dump()).views);
		await page_(`
			window.__orig = app.vault.${method};
			app.vault.${method} = async () => { throw new Error("injected"); };
			await __cfm.choose("Field tech", ${JSON.stringify(kind[0].toUpperCase() + kind.slice(1))}); __cfm.click("Create"); await __cfm.sleep(1000);
			app.vault.${method} = window.__orig;`);
		check(`IT-8 ${kind}: no orphan file or folder left on disk`, JSON.stringify(await listing()) === JSON.stringify(before), diff(before, await listing()));
		check(`IT-8 ${kind}: the meta folder is unchanged`, JSON.stringify((await dump()).views) === data);
		check(`IT-8 ${kind}: error notice names the kind and the reason`, await page_(`return __cfm.toasts().some((t) => t.startsWith('Atlas: couldn\\'t create ${kind} "Field tech": injected'));`));
	},

	async links() {
		await page_(`app.vault.setConfig("alwaysUpdateLinks", false);`);
		const kids = snapshot();
		await runCreate(opt("--kind", "file"));
		check("IT-10 no notice mentions 'Links to this note'", !(await page_(`return __cfm.toasts().some((t) => /Links to this note/.test(t));`)));
		check("IT-10 no other note changed", JSON.stringify(snapshot()) === JSON.stringify(kids));
		await page_(`app.vault.setConfig("alwaysUpdateLinks", true);`);
	},

	async tab() {
		const state = () => page_(`return { active: app.workspace.getActiveFile()?.path ?? null, tabs: app.workspace.getLeavesOfType("markdown").length };`);
		const before = await state();
		await runCreate(opt("--kind", "file"));
		check("IT-12 the active file and the number of tabs are unchanged", JSON.stringify(await state()) === JSON.stringify(before), { before, after: await state() });
	},
};

if (!groups[group]) {
	console.error(`unknown group '${group}'. Groups: ${Object.keys(groups).join(", ")}`);
	process.exit(2);
}
try {
	await groups[group]();
} catch (error) {
	failures++;
	console.log(`FAIL ${group} threw: ${error.message}`);
}
await sleep(100);
check("IT-13 no console error or unhandled rejection during the group", consoleProblems.length === 0, consoleProblems);
ws.close();
console.log(failures === 0 ? `${group}: all checks passed` : `${group}: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
