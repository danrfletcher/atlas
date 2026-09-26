import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, Notice, TAbstractFile, TFile } from "obsidian";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
import { ViewsManager } from "../../src/views";
import { StatusesManager } from "../../src/statuses";
import { UnitRef, View, ViewNode } from "../../src/types";
import { GraduationController } from "../../src/graduation";
import { closeNameDialog, openNameDialog } from "../../src/name-dialog";
import { button, inputEl, key, messageEl, modals, type } from "../helpers";

const K3XQ = "_pool/20260925143012-k3xq.md";
const A1B2 = "_pool/20260925150000-a1b2.md";
const ZZ99 = "_pool/20260925160000-zz99.md";
const NEW = "Quarry drone LiDAR.md";
const CLASH = (n: string) => `A note or folder called '${n}' already exists at the vault root`;

const file = (path: string): UnitRef => ({ kind: "file", path });
const unit = (id: string, ref: UnitRef, extra: Partial<ViewNode> = {}): ViewNode => ({ id, type: "unit", ref, children: [], ...extra });
const meta = (id: string, label: string, children: ViewNode[], extra: Partial<ViewNode> = {}): ViewNode => ({ id, type: "meta", label, children, ...extra });

function fixtureViews(): View[] {
	return [
		{
			id: "default",
			name: "Default",
			inboxMode: "view",
			root: [
				meta(
					"m1",
					"Field tech",
					[unit("u-b1", file(K3XQ), { explicitStatusId: "doing" }), unit("u-child-host", file(A1B2), { children: [unit("u-nested", file("Loose.md"))] })],
					{ statusEnabled: true, statusSetId: "set-basic" }
				),
				unit("u-b1-dup", file(K3XQ)),
				unit("u-gone", file("_pool/20250101000000-dead.md")),
				meta("m2", "No files", [unit("u-zz", file(ZZ99))], { statusEnabled: true, statusSetId: "set-basic", applyTo: { file: false } }),
			],
		},
		{ id: "reading", name: "Reading", inboxMode: "view", root: [unit("u-b1-dup2", file(K3XQ))] },
	];
}

const SETS = [
	{
		id: "set-basic",
		name: "Basic",
		defaultStatusId: "idea",
		statuses: [
			{ id: "idea", label: "Idea", color: "#aaa" },
			{ id: "doing", label: "Doing", color: "#bbb" },
			{ id: "done", label: "Done", color: "#ccc", isCompleted: true },
		],
	},
];

/** Obsidian's `renameFile` in miniature: rename, then rewrite each linker (`modify`), then re-resolve. */
class FakeFileManager {
	log: string[] = [];
	contents = new Map<string, string>();
	linkers: string[] = [];
	updateLinks = true;
	constructor(private app: App) {}
	async renameFile(entry: TAbstractFile, newPath: string): Promise<void> {
		this.log.push(`renameFile:${newPath}`);
		this.app.vault.calls.push("fileManager.renameFile");
		const oldBase = entry.name.replace(/\.md$/, "");
		await this.app.vault.rename(entry, newPath);
		if (this.updateLinks) {
			const newBase = newPath.slice(newPath.lastIndexOf("/") + 1).replace(/\.md$/, "");
			this.app.metadataCache.trigger("resolved"); // an early re-resolve, before the linkers are rewritten
			this.log.push("resolved");
			for (const path of this.linkers) {
				await new Promise((r) => setTimeout(r, 10));
				this.contents.set(path, (this.contents.get(path) ?? "").split(`[[${oldBase}]]`).join(`[[${newBase}]]`));
				await this.app.vault.modify(this.app.vault.getAbstractFileByPath(path) as TFile, "");
			}
		}
		this.app.metadataCache.trigger("resolved");
		this.log.push("resolved");
	}
}

interface Rig {
	app: App;
	views: ViewsManager;
	index: UnitIndex;
	statuses: StatusesManager;
	fm: FakeFileManager;
	ctrl: GraduationController;
	persist: ReturnType<typeof vi.fn>;
	atlasRenames(): string[];
	settle(ms?: number): Promise<void>;
}

function rig(seed: (app: App) => void = () => {}): Rig {
	const app = new App();
	for (const f of [K3XQ, A1B2, ZZ99, "_pool/Untitled.md", "Reading list.md", "Loose.md", "Diagram.png"]) {
		if (f.startsWith("_pool/") && !app.vault.getAbstractFileByPath("_pool")) app.vault.seedFolder("_pool");
		app.vault.seedFile(f);
	}
	seed(app);
	const fm = new FakeFileManager(app);
	(app as unknown as { fileManager: unknown }).fileManager = fm;
	const persist = vi.fn();
	const views = new ViewsManager(app, fixtureViews(), "default", persist);
	const index = new UnitIndex(app, { ...DEFAULT_SETTINGS, excludedFolders: ["_pool"] }, [file(K3XQ)]);
	index.rebuild();
	const statuses = new StatusesManager(structuredClone(SETS), [], persist);
	const ctrl = new GraduationController({
		vault: app.vault,
		fileManager: fm,
		scheduler: { setTimeout: (cb, ms) => setTimeout(cb, ms), clearTimeout: (h) => clearTimeout(h as never) },
		getPoolFolder: () => "_pool",
		getExcludedFolders: () => ["_pool"],
		notify: (message, ms) => void new Notice(message, ms),
		afterMove: () => void 0,
		openDialog: (o) => openNameDialog(app, o),
	});
	// What main.ts does: the existing hooks first, graduation last.
	app.vault.on("rename", (f: TAbstractFile, oldPath: string) => {
		fm.log.push("rename-event");
		index.onVaultRename(f, oldPath);
		views.onVaultRename(oldPath, f.path);
		ctrl.handleRename(f, oldPath);
	});
	app.vault.on("delete", (f: TAbstractFile) => ctrl.handleDelete(f));
	app.vault.on("modify", () => {
		fm.log.push("modify");
		ctrl.handleModify();
	});
	app.metadataCache.on("resolved", () => ctrl.handleResolved());
	return {
		app,
		views,
		index,
		statuses,
		fm,
		ctrl,
		persist,
		atlasRenames: () => fm.log.filter((l) => l.startsWith("renameFile:")),
		settle: (ms = 3000) => vi.advanceTimersByTimeAsync(ms).then(() => undefined),
	};
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const get = (r: Rig, path: string) => r.app.vault.getAbstractFileByPath(path) as TFile;
const toasts = () => Notice.instances.map((n) => n.message);
const listing = (r: Rig) => r.app.vault.getFiles().map((f) => f.path).sort();

beforeEach(() => {
	vi.useFakeTimers();
	Notice.reset();
});
afterEach(async () => {
	closeNameDialog();
	await vi.advanceTimersByTimeAsync(10);
	document.body.innerHTML = "";
	vi.useRealTimers();
});

describe("graduation over the real views, index and dialog", () => {
	it("IT-1 / AC-1..3 / EC-31 renames, keeps every placement, index, status and promotion in one move", async () => {
		const r = rig();
		const before = clone(r.views.getViews());
		const user = get(r, K3XQ);
		await r.fm.renameFile(user, "_pool/Quarry drone LiDAR.md");
		r.fm.log.length = 0;
		await r.settle();

		expect(get(r, NEW)).toBe(user);
		expect(r.app.vault.getAbstractFileByPath(K3XQ)).toBeNull();
		expect(r.atlasRenames()).toEqual([`renameFile:${NEW}`]);
		expect(toasts()).toEqual(["Moved 'Quarry drone LiDAR' out of the pool"]);

		const expected = clone(before);
		const rewrite = (nodes: ViewNode[]) =>
			nodes.forEach((n) => {
				if (n.ref?.path === K3XQ) n.ref.path = NEW;
				rewrite(n.children);
			});
		expected.forEach((v) => rewrite(v.root));
		expect(r.views.getViews()).toEqual(expected);
		expect(r.views.getNode("default", "u-b1")?.explicitStatusId).toBe("doing");
		expect(r.index.getManualPromotions()).toEqual([file(NEW)]);
	});

	it("AC-2 child indices are unchanged", async () => {
		const r = rig();
		const indexOf = (viewId: string, id: string) => {
			const walk = (nodes: ViewNode[]): number | null => {
				for (const [i, n] of nodes.entries()) {
					if (n.id === id) return i;
					const inner = walk(n.children);
					if (inner !== null) return inner;
				}
				return null;
			};
			return walk(r.views.getView(viewId)!.root);
		};
		const before = [indexOf("default", "u-b1"), indexOf("default", "u-b1-dup"), indexOf("reading", "u-b1-dup2")];
		await r.fm.renameFile(get(r, K3XQ), "_pool/Quarry drone LiDAR.md");
		await r.settle();
		expect([indexOf("default", "u-b1"), indexOf("default", "u-b1-dup"), indexOf("reading", "u-b1-dup2")]).toEqual(before);
	});

	it("AC-4 inherited status follows the parent's file switch, the same before and after", async () => {
		const r = rig();
		const status = (id: string) => {
			const view = r.views.getView("default")!;
			const parent = view.root.find((n) => n.children.some((c) => c.id === id))!;
			return r.statuses.resolveNodeStatus([parent], parent.children.find((c) => c.id === id)!)?.id ?? null;
		};
		const beforeOff = status("u-zz");
		const beforeOn = status("u-b1");
		await r.fm.renameFile(get(r, ZZ99), "_pool/Second.md");
		await r.fm.renameFile(get(r, K3XQ), "_pool/Quarry drone LiDAR.md");
		await r.settle();
		expect([beforeOff, beforeOn]).toEqual([null, "doing"]);
		expect([status("u-zz"), status("u-b1")]).toEqual([beforeOff, beforeOn]);
		expect(r.views.getNode("default", "u-zz")?.ref).toEqual(file("Second.md"));
	});

	it("EC-14 waits for the link rewrite of the last linker and the resolved after it", async () => {
		const linkers = Array.from({ length: 30 }, (_, i) => `Linker-${String(i + 1).padStart(2, "0")}.md`);
		const r = rig((app) => linkers.forEach((l) => app.vault.seedFile(l)));
		r.fm.linkers = linkers;
		linkers.forEach((l) => r.fm.contents.set(l, "[[20260925143012-k3xq]]"));

		const done = r.fm.renameFile(get(r, K3XQ), "_pool/Quarry drone LiDAR.md");
		await r.settle(5000);
		await done;

		const log = r.fm.log;
		const graduation = log.indexOf(`renameFile:${NEW}`);
		expect(graduation).toBeGreaterThan(-1);
		const lastModify = log.lastIndexOf("modify", graduation);
		expect(log.slice(0, graduation).filter((l) => l === "modify")).toHaveLength(30);
		expect(log.slice(lastModify, graduation)).toContain("resolved");
		expect(log.indexOf("rename-event")).toBeLessThan(log.indexOf("modify"));
		for (const l of linkers) expect(r.fm.contents.get(l)).toBe("[[Quarry drone LiDAR]]");
	});

	it("EC-15 no resolved event and no linkers: still graduates within 2 s", async () => {
		const r = rig();
		r.fm.updateLinks = false;
		await r.fm.renameFile(get(r, K3XQ), "_pool/Quarry drone LiDAR.md");
		r.fm.log.length = 0;
		await r.settle(1999);
		expect(get(r, NEW)).toBeTruthy();
	});

	it("EC-35 an unplaced block graduates and shows in the inbox as a root file, with no view node", async () => {
		const r = rig();
		const nodesBefore = JSON.stringify(r.views.getViews());
		await r.fm.renameFile(get(r, "_pool/Untitled.md"), "_pool/Second idea.md");
		await r.settle();
		expect(get(r, "Second idea.md")).toBeTruthy();
		const units = r.index.getUnits();
		expect(units).toContainEqual({ type: "root-file", path: "Second idea.md" });
		expect(units.some((u) => u.path === "_pool/Untitled.md" || u.path === "_pool/Second idea.md")).toBe(false);
		expect(JSON.stringify(r.views.getViews())).toBe(nodesBefore);
	});

	it("EC-34 a missing ref keeps its old path and the other graduation does not touch it", async () => {
		const r = rig();
		await r.fm.renameFile(get(r, K3XQ), "_pool/Quarry drone LiDAR.md");
		await r.settle();
		expect(r.views.getNode("default", "u-gone")?.ref).toEqual(file("_pool/20250101000000-dead.md"));
	});

	it("FR-9 nested children stay put; nothing else on disk moves", async () => {
		const r = rig();
		const before = listing(r);
		await r.fm.renameFile(get(r, A1B2), "_pool/Second idea.md");
		await r.settle();
		expect(r.views.getNode("default", "u-nested")?.ref).toEqual(file("Loose.md"));
		expect(r.views.getNode("default", "u-child-host")?.children.map((c) => c.id)).toEqual(["u-nested"]);
		expect(listing(r)).toEqual(before.map((p) => (p === A1B2 ? "Second idea.md" : p)).sort());
	});

	it("EC-33 links setting off: still graduates, links untouched", async () => {
		const r = rig((app) => app.vault.seedFile("Linker.md"));
		r.fm.updateLinks = false;
		r.fm.linkers = ["Linker.md"];
		r.fm.contents.set("Linker.md", "[[20260925143012-k3xq]]");
		await r.fm.renameFile(get(r, K3XQ), "_pool/Quarry drone LiDAR.md");
		await r.settle();
		expect(get(r, NEW)).toBeTruthy();
		expect(r.fm.contents.get("Linker.md")).toBe("[[20260925143012-k3xq]]");
		expect(r.views.getNode("default", "u-b1")?.ref).toEqual(file(NEW));
	});

	describe("the clash dialog", () => {
		const isRed = () => inputEl().classList.contains("atlas-name-invalid");
		const isGreen = () => inputEl().classList.contains("atlas-name-valid");
		const tick = () => vi.advanceTimersByTimeAsync(0);

		async function clash(r: Rig, path = A1B2, name = "Reading list") {
			await r.fm.renameFile(get(r, path), `_pool/${name}.md`);
			await r.settle(2000);
		}

		it("AC-5 opens with the name, a red border, the message, and Create disabled", async () => {
			const r = rig();
			await clash(r);
			expect(modals()).toHaveLength(1);
			expect(inputEl().value).toBe("Reading list");
			expect(isRed()).toBe(true);
			expect(messageEl().textContent).toBe(CLASH("Reading list"));
			expect(button("Create").disabled).toBe(true);
			expect(toasts()).toEqual([]);
		});

		it("AC-7 Create with a free name renames straight to it; the untouched note stays", async () => {
			const r = rig();
			await clash(r);
			type("Reading list 2");
			expect(isGreen()).toBe(true);
			expect(button("Create").disabled).toBe(false);
			r.fm.log.length = 0;
			button("Create").click();
			await r.settle();
			expect(get(r, "Reading list 2.md")).toBeTruthy();
			expect(get(r, "Reading list.md")).toBeTruthy();
			expect(r.app.vault.getAbstractFileByPath(A1B2)).toBeNull();
			expect(r.atlasRenames()).toEqual(["renameFile:Reading list 2.md"]);
			expect(toasts()).toEqual(["Moved 'Reading list 2' out of the pool"]);
			expect(r.views.getNode("default", "u-child-host")?.ref).toEqual(file("Reading list 2.md"));
			expect(modals()).toHaveLength(0);
		});

		it("Enter confirms a valid name", async () => {
			const r = rig();
			await clash(r);
			type("Reading list 3");
			key("Enter");
			await r.settle();
			expect(get(r, "Reading list 3.md")).toBeTruthy();
		});

		it("AC-8 Cancel restores the file and every placement; nothing else changed", async () => {
			const r = rig();
			const filesBefore = listing(r);
			const viewsBefore = clone(r.views.getViews());
			await clash(r);
			button("Cancel").click();
			await r.settle();
			expect(listing(r)).toEqual(filesBefore);
			expect(r.views.getViews()).toEqual(viewsBefore);
			expect(toasts()).toEqual([]);
			expect(modals()).toHaveLength(0);
			expect(r.ctrl.pendingCount()).toBe(0);
			expect(r.atlasRenames().filter((l) => l !== `renameFile:${A1B2}`)).toEqual(["renameFile:_pool/Reading list.md"]);
		});

		it.each([
			["Escape", () => key("Escape")],
			["the close X", () => document.querySelector<HTMLElement>(".modal-close-button")!.click()],
		])("EC-25 dismissing with %s reverts like Cancel", async (_label, dismiss) => {
			const r = rig();
			await clash(r);
			dismiss();
			await r.settle();
			expect(get(r, A1B2)).toBeTruthy();
			expect(r.app.vault.getAbstractFileByPath("_pool/Reading list.md")).toBeNull();
			expect(toasts()).toEqual([]);
		});

		it("EC-22/EC-23 a non-ID original comes back once, without looping, and later renames still graduate", async () => {
			const r = rig();
			await clash(r, "_pool/Untitled.md");
			r.fm.log.length = 0;
			button("Cancel").click();
			await r.settle(5000);
			expect(get(r, "_pool/Untitled.md")).toBeTruthy();
			expect(r.atlasRenames()).toEqual(["renameFile:_pool/Untitled.md"]);
			expect(modals()).toHaveLength(0);
			expect(toasts()).toEqual([]);
			expect(r.ctrl.getOwnReverts().size).toBe(0);

			await r.fm.renameFile(get(r, "_pool/Untitled.md"), "_pool/Notes.md");
			await r.settle();
			expect(get(r, "Notes.md")).toBeTruthy();
		});

		it("EC-26 a root note created while the dialog is open keeps it open and red on Create", async () => {
			const r = rig();
			await clash(r);
			type("Reading list 2");
			r.app.vault.seedFile("Reading list 2.md");
			button("Create").click();
			await tick();
			expect(modals()).toHaveLength(1);
			expect(isRed()).toBe(true);
			expect(get(r, "_pool/Reading list.md")).toBeTruthy();
		});

		it("EC-27 one dialog at a time; the second opens after the first closes", async () => {
			const r = rig();
			await r.fm.renameFile(get(r, A1B2), "_pool/Reading list.md");
			await r.fm.renameFile(get(r, ZZ99), "_pool/reading LIST.md");
			await r.settle(2000);
			expect(modals()).toHaveLength(1);
			expect(inputEl().value).toBe("Reading list");
			type("First");
			button("Create").click();
			await r.settle(10);
			expect(get(r, "First.md")).toBeTruthy();
			expect(modals()).toHaveLength(1);
			expect(inputEl().value).toBe("reading LIST");
			button("Cancel").click();
			await r.settle(10);
			expect(get(r, ZZ99)).toBeTruthy();
			expect(modals()).toHaveLength(0);
		});

		it("EC-28 a name that breaks another shared rule goes through the dialog too", async () => {
			const r = rig();
			await r.fm.renameFile(get(r, A1B2), "_pool/Ideas.md".replace("Ideas", "A#B"));
			await r.settle(2000);
			expect(isRed()).toBe(true);
			expect(messageEl().textContent).toContain("#");
			expect(button("Create").disabled).toBe(true);
			button("Cancel").click();
			await r.settle();
			expect(get(r, A1B2)).toBeTruthy();
		});

		it("EC-16 unload while the dialog is open: no revert, no move", async () => {
			const r = rig();
			await clash(r);
			r.fm.log.length = 0;
			r.ctrl.dispose();
			closeNameDialog();
			await r.settle();
			expect(r.atlasRenames()).toEqual([]);
			expect(get(r, "_pool/Reading list.md")).toBeTruthy();
		});
	});
});
