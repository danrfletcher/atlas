import { beforeEach, describe, expect, it, vi } from "vitest";
import { App, Notice } from "obsidian";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
import { ViewsManager } from "../../src/views";
import { StatusGovernance, UnitRef, View, ViewNode } from "../../src/types";
import { StatusesManager } from "../../src/statuses";
import { noticeIfLinksNotUpdated } from "../../src/links-notice";

const file = (path: string): UnitRef => ({ kind: "file", path });
const unit = (id: string, ref: UnitRef, extra: Partial<ViewNode> = {}): ViewNode => ({ id, type: "unit", ref, children: [], ...extra });
const meta = (id: string, label: string, children: ViewNode[] = [], extra: Partial<ViewNode> = {}): ViewNode => ({
	id,
	type: "meta",
	label,
	children,
	...extra,
});

/** FX-VIEWS-MULTI */
function fixtureViews(): View[] {
	return [
		{
			id: "v1",
			name: "Default",
			inboxMode: "view",
			root: [
				meta(
					"m1",
					"Field tech",
					[
						unit("n1", file("Foo.md"), { explicitStatusId: "s-doing", children: [meta("sub", "Sub")] }),
						unit("n2", file("Foo.md")),
						unit("n3", { kind: "block", path: "Foo.md", subpath: "^abc" }),
					],
					{ collapsed: false }
				),
				unit("n9", file("Bar.md")),
			],
		},
		{
			id: "v2",
			name: "Second",
			inboxMode: "view",
			root: [
				unit("n4", file("Foo.md"), {
					collapsed: true,
					statusEnabled: true,
					statusSetId: "set1",
					children: [unit("n5", file("Other.md"))],
				}),
			],
		},
		{
			id: "v3",
			name: "Third",
			inboxMode: "view",
			root: [unit("n6", file("Gone.md")), unit("n7", { kind: "folder", path: "Projects" })],
		},
	];
}

const fixturePromotions = (): UnitRef[] => [
	file("Foo.md"),
	file("Projects/Deep.md"),
	{ kind: "block", path: "Foo.md", subpath: "^abc" },
];

interface Setup {
	app: App;
	persist: ReturnType<typeof vi.fn>;
	views: ViewsManager;
	index: UnitIndex;
	listener: ReturnType<typeof vi.fn>;
	/** What Atlas's main.ts does on a vault rename. */
	wireRename(): void;
}

function setup(promotions = fixturePromotions()): Setup {
	const app = new App();
	for (const f of ["Foo.md", "Bar.md", "Other.md", "Linker.md"]) app.vault.seedFile(f);
	app.vault.seedFolder("Projects");
	app.vault.seedFile("Projects/Deep.md");
	const persist = vi.fn();
	const listener = vi.fn();
	const views = new ViewsManager(app, fixtureViews(), "v1", persist);
	views.onChange(listener);
	const index = new UnitIndex(app, { ...DEFAULT_SETTINGS, excludedFolders: ["_pool"] }, promotions);
	index.rebuild();
	return {
		app,
		persist,
		views,
		index,
		listener,
		wireRename() {
			app.vault.on("create", (f) => index.onVaultCreate(f));
			app.vault.on("rename", (f, oldPath) => {
				index.onVaultRename(f, oldPath);
				views.onVaultRename(oldPath, f.path);
			});
		},
	};
}

const node = (s: Setup, id: string) => s.views.getNode("v1", id) ?? s.views.getNode("v2", id) ?? s.views.getNode("v3", id)!;
const allRefs = (views: View[]): UnitRef[] => {
	const out: UnitRef[] = [];
	const walk = (nodes: ViewNode[]) => nodes.forEach((n) => (n.ref && out.push(n.ref), walk(n.children)));
	views.forEach((v) => walk(v.root));
	return out;
};
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

beforeEach(() => Notice.reset());

describe("convertFileNodesToModule", () => {
	it("IT-C1 converts every duplicate node in one save", () => {
		const s = setup();
		const result = s.views.convertFileNodesToModule("Foo.md", "Foo", s.index);
		expect(result).toEqual({ nodes: 3, manualPromotions: 1 });
		for (const id of ["n1", "n2", "n4"]) expect(node(s, id).ref).toEqual({ kind: "folder", path: "Foo" });
		expect(s.persist).toHaveBeenCalledTimes(1);
		expect(s.listener).toHaveBeenCalledTimes(1);
	});

	it("IT-C2 keeps id, position, fold state, status settings, explicit status and children", () => {
		const s = setup();
		const before = { n1: clone(node(s, "n1")), n4: clone(node(s, "n4")) };
		s.views.convertFileNodesToModule("Foo.md", "Foo", s.index);
		const m1 = node(s, "m1");
		expect(m1.children.map((c) => c.id)).toEqual(["n1", "n2", "n3"]);
		expect({ ...node(s, "n1"), ref: undefined }).toEqual({ ...before.n1, ref: undefined });
		expect(node(s, "n1").explicitStatusId).toBe("s-doing");
		expect(node(s, "n1").children[0].label).toBe("Sub");
		expect({ ...node(s, "n4"), ref: undefined }).toEqual({ ...before.n4, ref: undefined });
		expect(node(s, "n4").collapsed).toBe(true);
		expect(node(s, "n4").children[0].id).toBe("n5");
	});

	it("IT-C3/IT-C4 with the rename hook: block ref follows, no file refs left, promotions in order", () => {
		const s = setup();
		s.views.convertFileNodesToModule("Foo.md", "Foo", s.index);
		s.views.onVaultRename("Foo.md", "Foo/Foo.md");
		expect(node(s, "n3").ref).toEqual({ kind: "block", path: "Foo/Foo.md", subpath: "^abc" });
		const refs = allRefs(s.views.getViews());
		expect(refs).not.toContainEqual(file("Foo/Foo.md"));
		expect(refs).not.toContainEqual(file("Foo.md"));
	});

	it("IT-C4 manual promotions after conversion and the rename hook", () => {
		const s = setup();
		s.views.convertFileNodesToModule("Foo.md", "Foo", s.index);
		s.app.vault.seedFolder("Foo");
		const renamed = s.app.vault.seedFile("Foo/Foo.md");
		s.index.onVaultRename(renamed, "Foo.md");
		expect(s.index.getManualPromotions()).toEqual([
			{ kind: "folder", path: "Foo" },
			file("Projects/Deep.md"),
			{ kind: "block", path: "Foo/Foo.md", subpath: "^abc" },
		]);
	});

	it("IT-C5 everything else is untouched", () => {
		const s = setup();
		const before = ["n6", "n7", "n9", "n5"].map((id) => clone(node(s, id)));
		s.views.convertFileNodesToModule("Foo.md", "Foo", s.index);
		expect(["n6", "n7", "n9", "n5"].map((id) => node(s, id))).toEqual(before);
		expect(s.views.getView("v3")!.root).toEqual(fixtureViews()[2].root);
	});

	it("IT-C6 order independence: rename hook first or conversion first end identically", () => {
		const finalState = (renameFirst: boolean) => {
			const s = setup();
			s.app.vault.seedFolder("Foo");
		const renamed = s.app.vault.seedFile("Foo/Foo.md");
			const rename = () => {
				s.views.onVaultRename("Foo.md", "Foo/Foo.md");
				s.index.onVaultRename(renamed, "Foo.md");
			};
			if (renameFirst) rename();
			const result = s.views.convertFileNodesToModule("Foo.md", "Foo", s.index);
			if (!renameFirst) rename();
			return { views: JSON.stringify(s.views.getViews()), promotions: JSON.stringify(s.index.getManualPromotions()), result };
		};
		const a = finalState(true);
		const b = finalState(false);
		expect(a.views).toBe(b.views);
		expect(a.promotions).toBe(b.promotions);
		expect(a.result).toEqual({ nodes: 3, manualPromotions: 1 });
		expect(b.result).toEqual({ nodes: 3, manualPromotions: 1 });
		expect(JSON.parse(a.promotions).filter((r: UnitRef) => r.kind === "folder")).toHaveLength(1);
	});

	it("dedupes when the rename hook already produced {file, Foo/Foo.md} and {folder, Foo} exists", () => {
		const s = setup([file("Foo/Foo.md"), { kind: "folder", path: "Foo" }, file("Other.md")]);
		expect(s.index.convertManualPromotionToModule("Foo.md", "Foo")).toBe(1);
		expect(s.index.getManualPromotions()).toEqual([{ kind: "folder", path: "Foo" }, file("Other.md")]);
	});

	it("IT-C7 idempotent: a second call does nothing and saves nothing", () => {
		const s = setup();
		s.views.convertFileNodesToModule("Foo.md", "Foo", s.index);
		s.persist.mockClear();
		s.listener.mockClear();
		expect(s.views.convertFileNodesToModule("Foo.md", "Foo", s.index)).toEqual({ nodes: 0, manualPromotions: 0 });
		expect(s.persist).not.toHaveBeenCalled();
		expect(s.listener).not.toHaveBeenCalled();
	});

	it("no match, and a differently-cased path, change nothing", () => {
		const s = setup();
		const before = JSON.stringify(s.views.getViews());
		expect(s.views.convertFileNodesToModule("foo.md", "foo", s.index)).toEqual({ nodes: 0, manualPromotions: 0 });
		expect(s.views.convertFileNodesToModule("Gone2.md", "Gone2", s.index)).toEqual({ nodes: 0, manualPromotions: 0 });
		expect(JSON.stringify(s.views.getViews())).toBe(before);
		expect(s.persist).not.toHaveBeenCalled();
	});

	it("a missing (deleted-file) node keeps its existing missing ref", () => {
		const s = setup();
		s.views.convertFileNodesToModule("Foo.md", "Foo", s.index);
		expect(node(s, "n6").ref).toEqual(file("Gone.md"));
	});

	it("works without a unit index (nodes only)", () => {
		const s = setup();
		expect(s.views.convertFileNodesToModule("Foo.md", "Foo")).toEqual({ nodes: 3, manualPromotions: 0 });
		expect(s.index.getManualPromotions()[0]).toEqual(file("Foo.md"));
	});

	it("IT-C8 after the real vault events the index has the folder unit and every node resolves", async () => {
		const s = setup();
		s.wireRename();
		const foo = s.app.vault.getAbstractFileByPath("Foo.md")!;
		await s.app.vault.createFolder("Foo");
		await s.app.fileManager.renameFile(foo, "Foo/Foo.md");
		s.views.convertFileNodesToModule("Foo.md", "Foo", s.index);
		const units = s.index.getUnits();
		expect(units).toContainEqual({ type: "folder-unit", path: "Foo" });
		expect(units).not.toContainEqual({ type: "root-file", path: "Foo.md" });
		const known = new Set(units.map((u) => (u.type === "folder-unit" || u.type === "promoted-folder" ? `folder:${u.path}` : `file:${u.path}`)));
		for (const id of ["n1", "n2", "n4"]) {
			const ref = node(s, id).ref!;
			expect(known.has(`${ref.kind}:${ref.path}`), id).toBe(true);
		}
	});

	it("IT-C9 / IT-M9 makes no disk API calls", () => {
		const s = setup();
		s.views.convertFileNodesToModule("Foo.md", "Foo", s.index);
		s.views.replaceMetaNodeWithUnit("v1", "m1", { kind: "folder", path: "Field tech" });
		expect(s.app.vault.calls).toEqual([]);
	});

	it("IT-N1 with the links setting off, views and manual promotions are still rewritten", () => {
		const s = setup();
		s.app.vault.config.alwaysUpdateLinks = false;
		const result = s.views.convertFileNodesToModule("Foo.md", "Foo", s.index);
		noticeIfLinksNotUpdated(s.app);
		expect(result).toEqual({ nodes: 3, manualPromotions: 1 });
		expect(Notice.instances).toHaveLength(1);
		expect(node(s, "n1").ref).toEqual({ kind: "folder", path: "Foo" });
		expect(s.index.getManualPromotions()).toEqual([
			{ kind: "folder", path: "Foo" },
			file("Projects/Deep.md"),
			{ kind: "block", path: "Foo.md", subpath: "^abc" },
		]);
	});

	it("IT-N1 replaceMetaNodeWithUnit also still works with the links setting off", () => {
		const s = setup();
		s.app.vault.config.alwaysUpdateLinks = false;
		expect(s.views.replaceMetaNodeWithUnit("v1", "m1", { kind: "folder", path: "Field tech" })).toBe(true);
		noticeIfLinksNotUpdated(s.app);
		expect(node(s, "m1").type).toBe("unit");
		expect(node(s, "m1").ref).toEqual({ kind: "folder", path: "Field tech" });
		expect(Notice.instances).toHaveLength(1);
	});

	it("only the new folder ref is deduped; unrelated duplicate promotions stay untouched", () => {
		const dup = file("Projects/Deep.md");
		const s = setup([dup, { ...dup }, file("Foo.md"), file("Foo.md"), { kind: "folder", path: "Foo" }]);
		s.views.convertFileNodesToModule("Foo.md", "Foo", s.index);
		expect(s.index.getManualPromotions()).toEqual([dup, dup, { kind: "folder", path: "Foo" }]);
	});

	it("IT-S6 a file node with an explicit status converts to a module, keeping it and switching resolver", () => {
		const statuses = new StatusesManager(
			[
				{
					id: "set1",
					name: "Set",
					defaultStatusId: "s-idea",
					statuses: [
						{ id: "s-idea", label: "Idea", color: "#888888" },
						{ id: "s-done", label: "Done", color: "#00cc00" },
					],
				} as never,
			],
			[],
			() => {}
		);
		const run = (applyTo: StatusGovernance["applyTo"]) => {
			const s = setup();
			const root: StatusGovernance = { statusEnabled: true, statusSetId: "set1", inheritToSubfolders: true, applyTo };
			node(s, "n1").explicitStatusId = "s-done";
			const before = statuses.resolveNodeStatus([root], node(s, "n1"))?.label ?? null;
			s.views.convertFileNodesToModule("Foo.md", "Foo", s.index);
			expect(node(s, "n1").ref).toEqual({ kind: "folder", path: "Foo" });
			expect(node(s, "n1").explicitStatusId).toBe("s-done");
			return { before, after: statuses.resolveNodeStatus([root], node(s, "n1"))?.label ?? null };
		};
		expect(run({ file: true, module: false })).toEqual({ before: "Done", after: null });
		expect(run({ file: false, module: true })).toEqual({ before: null, after: "Done" });
	});
});
