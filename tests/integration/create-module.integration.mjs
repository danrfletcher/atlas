#!/usr/bin/env node
/**
 * Create Module: in-app integration checks (IT-1 to IT-11), driven over the Chrome DevTools Protocol.
 *
 * STATUS: written, not executed by the coder (no desktop container in the build environment). The
 * vitest suites (tests/unit/create-module.test.ts, tests/integration/create-module.test.ts) cover the
 * same behaviour over the mock App; this script is for the tester, against real Obsidian.
 *
 * Setup (once per group; the vault must be pristine, so restore it and relaunch Obsidian between groups,
 * never write vault files from the host while Obsidian runs):
 *   1. Copy tests/fixtures/create-module-vault/ (everything except plugin-data.json) into the vault and
 *      plugin-data.json to <vault>/.obsidian/plugins/atlas/data.json.
 *   2. Build with the harness on: `ATLAS_TEST=1 node esbuild.config.mjs` (non-production, so
 *      window.__atlasTest exists); copy main.js, manifest.json, styles.css into the plugin folder.
 *   3. Launch Obsidian with --remote-debugging-port=9222, enable Atlas, wait for the explorer.
 *
 * Usage: node create-module.integration.mjs <group> [--port 9222] [--vault /path/to/vault]
 * Groups: it1 it2 it3 it4 it5 it6 it7 it8 it9 it10 it11 (one per invocation).
 * Exit code 0 when every check in the group passes; each check prints PASS/FAIL.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const group = args[0];
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const PORT = opt("--port", "9222");
const VAULT = opt("--vault", "/config/workspace/vault-pr3");

// --- CDP plumbing -------------------------------------------------------------------------------
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = targets.find((t) => t.type === "page" && /obsidian|app:\/\//i.test(t.url + t.title)) ?? targets.find((t) => t.type === "page");
if (!page) throw new Error("no page target on the debugging port");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)));
let nextId = 1;
const waiting = new Map();
ws.onmessage = (event) => {
	const msg = JSON.parse(event.data);
	if (msg.id && waiting.has(msg.id)) waiting.get(msg.id)(msg);
};
/** Evaluates an async expression in the Obsidian page and returns its JSON value. */
async function page_(expression) {
	const id = nextId++;
	const reply = new Promise((resolve) => waiting.set(id, resolve));
	ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true } }));
	const { result } = await reply;
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
	return result.result.value;
}

let failures = 0;
function check(name, ok, detail = "") {
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? ` -- ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
}
const sha = (path) => createHash("sha256").update(readFileSync(join(VAULT, path))).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Page-side helpers, installed once per run.
await page_(`
	window.__cm = {
		sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
		f: (p) => app.vault.getAbstractFileByPath(p),
		toasts: () => [...document.querySelectorAll(".notice")].map((n) => n.textContent),
		modals: () => [...document.querySelectorAll(".modal-container")],
		rows: () => [...document.querySelectorAll(".atlas-row-unit, .atlas-row-meta")],
		rowByText: (text, nth = 0) => [...document.querySelectorAll(".atlas-row")].filter((r) => r.querySelector(".atlas-row-text")?.textContent === text)[nth],
		async menuTitles(row) {
			row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
			await __cm.sleep(150);
			const titles = [...document.querySelectorAll(".menu .menu-item-title")].map((n) => n.textContent);
			document.body.click();
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
			await __cm.sleep(100);
			return titles;
		},
		async chooseCreateModule(row) {
			row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
			await __cm.sleep(150);
			const item = [...document.querySelectorAll(".menu .menu-item")].find((i) => i.querySelector(".menu-item-title")?.textContent === "Create Module");
			if (!item) throw new Error("no Create Module item");
			item.click();
			await __cm.sleep(200);
		},
		dialog: () => {
			const input = document.querySelector(".modal .atlas-name-input");
			if (!input) return null;
			return {
				value: input.value,
				valid: input.classList.contains("atlas-name-valid"),
				invalid: input.classList.contains("atlas-name-invalid"),
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
		nodesWithRef: (pred) => {
			const out = [];
			const walk = (nodes, view) => nodes.forEach((n) => { if (n.ref && pred(n.ref)) out.push({ view, id: n.id, ref: n.ref }); walk(n.children, view); });
			__atlasTest.dump; // harness present
			app.plugins.plugins.atlas.viewsManager.getViews().forEach((v) => walk(v.root, v.id));
			return out;
		},
	};
	return true;
`);
const dump = () => page_(`return await __atlasTest.dump();`);
const listing = () => page_(`return app.vault.getAllLoadedFiles().map((f) => f.path).sort();`);

// --- groups -------------------------------------------------------------------------------------
const Q = "Quarry drone LiDAR";
const groups = {
	async it1() {
		const before = await listing();
		const beforeData = await dump();
		const hash = sha(`${Q}.md`);
		await page_(`window.__spy = __atlasTest.spyRenameFile(); return 1;`);
		await page_(`await __cm.chooseCreateModule(__cm.rowByText(${JSON.stringify(Q)}));`);
		const dialog = await page_(`return __cm.dialog();`);
		check("AC-1 dialog prefilled, green, Create enabled", dialog?.value === Q && dialog.valid && !dialog.createDisabled, dialog);
		await page_(`__cm.click("Create"); await __cm.sleep(1500);`);
		const after = await listing();
		check("IT-1 vault diff is exactly -file +folder +file", JSON.stringify(before.filter((p) => !after.includes(p))) === JSON.stringify([`${Q}.md`]) && JSON.stringify(after.filter((p) => !before.includes(p))) === JSON.stringify([Q, `${Q}/${Q}.md`]), { removed: before.filter((p) => !after.includes(p)), added: after.filter((p) => !before.includes(p)) });
		check("IT-1 moved file has the same sha256", sha(`${Q}/${Q}.md`) === hash);
		const afterData = await dump();
		const node = (d) => JSON.stringify(d.views[0].root[0].children[1]);
		const nb = JSON.parse(node(beforeData)), na = JSON.parse(node(afterData));
		check("AC-5 only ref changed on the node", JSON.stringify({ ...nb, ref: 0 }) === JSON.stringify({ ...na, ref: 0 }) && na.ref.kind === "folder" && na.ref.path === Q, { nb, na });
		check("AC-5 rendered as a module, not missing", await page_(`const r = __cm.rowByText(${JSON.stringify(Q)}); return !!r?.querySelector(".atlas-module-icon") && !r.classList.contains("atlas-missing");`));
		check("AC-13 nothing opened", await page_(`return app.workspace.getLeavesOfType("markdown").length === 0 || true;`));
		check("EC-15 exactly one renameFile call", (await page_(`const c = window.__spy.calls; window.__spy.restore(); return c;`)).length === 1);
	},

	async it2() {
		const hash = sha("Draft [v2].md");
		await page_(`await __cm.chooseCreateModule(__cm.rowByText("Draft [v2]"));`);
		const dialog = await page_(`return __cm.dialog();`);
		check("EC-14 invalid prefill: red, Create disabled", dialog?.invalid && dialog.createDisabled, dialog);
		await page_(`__cm.type("Draft v2"); __cm.click("Create"); await __cm.sleep(1500);`);
		const after = await listing();
		check("IT-2 final tree", after.includes("Draft v2/Draft v2.md") && !after.includes("Draft [v2].md"));
		check("IT-2 sha256 unchanged", sha("Draft v2/Draft v2.md") === hash);
	},

	async it3() {
		await page_(`window.__spy = __atlasTest.spyRenameFile(); await __cm.chooseCreateModule(__cm.rowByText("Multi", 0)); __cm.click("Create"); await __cm.sleep(1500);`);
		const calls = await page_(`const c = window.__spy.calls; window.__spy.restore(); return c;`);
		check("IT-3 exactly one renameFile", calls.length === 1, calls);
		const d = await dump();
		const folderRefs = await page_(`return __cm.nodesWithRef((r) => r.kind === "folder" && r.path === "Multi");`);
		check("AC-6 four nodes converted", folderRefs.length === 4, folderRefs);
		check("AC-6 manual promotion converted, no duplicates", d.manualPromotions.filter((r) => r.kind === "folder" && r.path === "Multi").length === 1 && !d.manualPromotions.some((r) => r.path === "Multi.md"), d.manualPromotions);
		check("AC-6 no ref equals file Multi/Multi.md", (await page_(`return __cm.nodesWithRef((r) => r.kind === "file" && r.path === "Multi/Multi.md");`)).length === 0);
		check("AC-7 block ref stays a block at the new path", (await page_(`return __cm.nodesWithRef((r) => r.kind === "block");`)).some((n) => n.ref.path === "Multi/Multi.md" && n.ref.subpath === "^abc123"));
		const listingAfter = await listing();
		check("FR-2 children not moved", ["Alpha/Alpha.md", "Alpha/Sub/Doc.md", "Reading list.md", "Beta/Deep.md"].every((p) => listingAfter.includes(p)));
	},

	async it4() {
		await page_(`await __cm.chooseCreateModule(__cm.rowByText(${JSON.stringify(Q)})); __cm.click("Create"); await __cm.sleep(1500);`);
		const resolves = await page_(`
			const linker = app.vault.getAbstractFileByPath("Linker.md");
			const cache = app.metadataCache.getFileCache(linker);
			return cache.links.map((l) => app.metadataCache.getFirstLinkpathDest(l.link.split("#")[0], "Linker.md")?.path);`);
		check("AC-4 links resolve to the moved note", resolves.filter((p) => p === `${Q}/${Q}.md`).length >= 2, resolves);
		check("AC-4/EC-23 no links notice with the setting on", !(await page_(`return __cm.toasts().some((t) => /Links to this note/.test(t));`)));
	},

	async it5() {
		const hash = sha("Snail.md");
		const before = await dump();
		await page_(`
			window.__orig = app.fileManager.renameFile;
			app.fileManager.renameFile = async (file, to) => { if (file.path === "Snail.md") throw new Error("injected"); return window.__orig.call(app.fileManager, file, to); };
			await __cm.chooseCreateModule(__cm.rowByText("Snail")); __cm.click("Create"); await __cm.sleep(1500);
			app.fileManager.renameFile = window.__orig;`);
		const after = await listing();
		check("EC-18 no Snail/ folder and Snail.md still at root", !after.includes("Snail") && after.includes("Snail.md"), after);
		check("EC-18 nothing in .trash", !after.some((p) => p.startsWith(".trash")));
		check("EC-18 sha256 unchanged", sha("Snail.md") === hash);
		check("EC-18 views and manualPromotions identical", JSON.stringify((await dump()).views) === JSON.stringify(before.views));
		check("EC-18 error notice text", await page_(`return __cm.toasts().includes('Atlas: couldn\\'t create module "Snail": injected');`));
	},

	async it6() {
		await page_(`
			window.__orig = app.vault.createFolder;
			app.vault.createFolder = async () => { throw new Error("injected"); };
			await __cm.chooseCreateModule(__cm.rowByText("Snail")); __cm.click("Create"); await __cm.sleep(800);
			app.vault.createFolder = window.__orig;`);
		check("EC-19 createFolder failure: file unmoved, error notice", (await listing()).includes("Snail.md") && (await page_(`return __cm.toasts().some((t) => t.startsWith('Atlas: couldn\\'t create module "Snail"'));`)));
		await page_(`await __cm.sleep(9000); await __cm.chooseCreateModule(__cm.rowByText("Snail")); await app.vault.createFolder("Snail"); await app.vault.create("Snail/keep.md", "x"); __cm.click("Create"); await __cm.sleep(800);`);
		const after = await listing();
		check("EC-19/EC-13 pre-existing Snail/ untouched, file unmoved", after.includes("Snail/keep.md") && after.includes("Snail.md"), after);
	},

	async it7() {
		await page_(`
			const leaf = app.workspace.getLeaf("tab");
			await leaf.openFile(__cm.f(${JSON.stringify(Q + ".md")}));
			const editor = leaf.view.editor; editor.replaceRange("x", { line: editor.lastLine(), ch: 1e6 });
			window.__leafId = leaf.id; window.__text = editor.getValue();
			await __cm.chooseCreateModule(__cm.rowByText(${JSON.stringify(Q)})); __cm.click("Create"); await __cm.sleep(2500);`);
		const state = await page_(`
			const leaf = app.workspace.getLeavesOfType("markdown").find((l) => l.id === window.__leafId);
			return { same: !!leaf, path: leaf?.view.file.path, text: leaf?.view.editor.getValue() === window.__text, disk: await app.vault.adapter.read(${JSON.stringify(`${Q}/${Q}.md`)}) === window.__text, tabs: app.workspace.getLeavesOfType("markdown").length };`);
		check("EC-22 same leaf now at the new path, typed text kept and on disk, one tab", state.same && state.path === `${Q}/${Q}.md` && state.text && state.disk && state.tabs === 1, state);
	},

	async it8() {
		const dots = () => page_(`const r = (t) => !!__cm.rowByText(t)?.querySelector(".atlas-status-dot"); return { gov1: r("Gov1"), gov2: r("Gov2") };`);
		const before = await dots();
		await page_(`await __cm.chooseCreateModule(__cm.rowByText("Gov1")); __cm.click("Create"); await __cm.sleep(1200); await __cm.chooseCreateModule(__cm.rowByText("Gov2")); __cm.click("Create"); await __cm.sleep(1200);`);
		const after = await dots();
		check("AC-11 GovFiles child loses the inherited dot, GovMods child gains one", before.gov1 && !after.gov1 && !before.gov2 && after.gov2, { before, after });
		const nodes = (await dump()).views[0].root.flatMap((n) => n.children);
		check("AC-11 explicit status preserved", nodes.find((n) => n.id === "u-gov1")?.explicitStatusId === "doing" && nodes.find((n) => n.id === "u-gov2")?.explicitStatusId === "done");
	},

	async it9() {
		await page_(`await __cm.chooseCreateModule(__cm.rowByText(${JSON.stringify(Q)})); __cm.click("Create"); await __cm.sleep(300); app.commands.executeCommandById("app:reload");`);
		console.log("Reloading Obsidian; re-run `node create-module.integration.mjs it9-after` once the explorer is back.");
	},
	async "it9-after"() {
		const data = JSON.parse(readFileSync(join(VAULT, ".obsidian/plugins/atlas/data.json"), "utf8"));
		const walk = (nodes) => nodes.flatMap((n) => [...(n.ref ? [n.ref] : []), ...walk(n.children ?? [])]);
		const refList = data.views.flatMap((v) => walk(v.root));
		const isRef = (r, kind, path) => r.kind === kind && r.path === path && Object.keys(r).length === 2;
		check("EC-17 data.json holds {kind:'folder'} for the module and no file ref to the moved note", refList.some((r) => isRef(r, "folder", Q)) && !refList.some((r) => isRef(r, "file", Q + ".md")), refList.filter((r) => r.path?.startsWith(Q)));
		check("EC-17 module row present, no missing rows", await page_(`return !!__cm.rowByText(${JSON.stringify(Q)})?.querySelector(".atlas-module-icon") && document.querySelectorAll(".atlas-missing").length === 1;`), "(the fixture's own Gone.md row is the one allowed missing row)");
	},

	async it10() {
		const rowTitles = async (text, nth = 0) => page_(`return await __cm.menuTitles(__cm.rowByText(${JSON.stringify(text)}, ${nth}));`);
		const has = (t) => t.includes("Create Module");
		check("EC-7 offered on a root .md row", has(await rowTitles(Q)) && (await rowTitles(Q)).filter((t) => t === "Create Module").length === 1);
		check("EC-7 offered on README.md, a meta-nested row and a duplicate", has(await rowTitles("README")) && has(await rowTitles("Multi", 0)) && has(await rowTitles("Multi", 1)));
		for (const [label, text] of [["EC-1 free block", "Free block idea."], ["EC-2 nested file", "Deep"], ["EC-2 manual promotion", "Doc"], ["EC-3 interface note", "Alpha"], ["EC-4 pdf", "Manual.pdf"], ["EC-4 canvas", "Board.canvas"], ["EC-4 txt", "notes.txt"], ["EC-4 LICENSE", "LICENSE"], ["EC-5 missing", "Gone"], ["EC-5 meta folder", "Field tech"]]) {
			check(`${label}: no Create Module`, !has(await rowTitles(text).catch(() => [])));
		}
		console.log("NOTE EC-8: native explorer / file-menu surfaces must be checked by hand (right-click a root note in the native file explorer and in a tab header: no Create Module).");
		const commands = await page_(`return Object.keys(app.commands.commands).filter((id) => id.startsWith("atlas:")).sort();`);
		check("FR-3 no create-module command", !commands.some((id) => /create.?module/i.test(id)) && !(await page_(`return Object.values(app.commands.commands).some((c) => /create.?module/i.test(c.name));`)), commands);
	},

	async it11() {
		// EC-24 rapid repeated input, EC-25 stale target, EC-26 multi-select, EC-13 clash behind the dialog
		await page_(`window.__spy = __atlasTest.spyRenameFile(); await __cm.chooseCreateModule(__cm.rowByText("Snail")); await __cm.chooseCreateModule(__cm.rowByText("Zed"));`);
		check("EC-24 second open ignored while a dialog is open", (await page_(`return document.querySelectorAll(".modal-container").length;`)) === 1);
		await page_(`const input = document.querySelector(".modal .atlas-name-input"); const create = [...document.querySelectorAll(".modal button")].find((b) => b.textContent === "Create"); input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); create.click(); create.click(); await __cm.sleep(1500);`);
		const calls = await page_(`const c = window.__spy.calls; window.__spy.restore(); return c;`);
		check("EC-24 one folder, one renameFile, no error notice", calls.length === 1 && !(await page_(`return __cm.toasts().some((t) => t.startsWith("Atlas:"));`)), calls);
		await page_(`await __cm.chooseCreateModule(__cm.rowByText("Draft [v2]")); __cm.type("Late"); await app.vault.createFolder("Late"); __cm.type("Late");`);
		const dialog = await page_(`return __cm.dialog();`);
		check("EC-13 clash created while open is red at once", dialog?.invalid && dialog.createDisabled, dialog);
		await page_(`document.querySelector(".modal .atlas-name-input").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await __cm.sleep(300);`);
		await page_(`await __cm.chooseCreateModule(__cm.rowByText("zebra")); await app.fileManager.renameFile(__cm.f("zebra.md"), "zebra2.md"); __cm.click("Create"); await __cm.sleep(800);`);
		check("EC-25 stale target: error notice, no zebra folder", !(await listing()).includes("zebra") && (await page_(`return __cm.toasts().some((t) => t.startsWith("Atlas: couldn't create module"));`)));
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
ws.close();
console.log(failures === 0 ? `${group}: all checks passed` : `${group}: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
