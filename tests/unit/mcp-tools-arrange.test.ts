import type { App } from "obsidian";
import { Vault } from "obsidian";
import type { CachedMetadata } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { Unit, UnitRef, View, ViewNode } from "../../src/types";
import { ViewsManager } from "../../src/views";
import {
	McpArrangeToolsContext,
	McpOutsideManagedError,
	McpUnitNotFoundError,
	McpWrongUnitKindError,
	createAddNodeTool,
	createCreateFolderTool,
	createMoveNodeTool,
	createRemoveNodeTool,
	createRenameFolderTool,
	resolveVaultPathToRef,
} from "../../src/mcp-arrange-tools";

/**
 * PR-3.F1: the five arranging MCP tools (`add_node`/`move_node`/`remove_node`/`create_folder`/
 * `rename_folder`), driven directly against a real `ViewsManager` with a constructor-injected fake
 * `persist` — the same pattern `tests/unit/mcp-status-tools.test.ts` uses for PR-2.F1's tools, so
 * these tests exercise the real `placeUnit`/`moveNode`/`unplaceNode`/`addMetaFolder`/
 * `renameMetaFolder` machinery, not a mock standing in for it. `add_node`'s path resolution is
 * driven against the real mocked `Vault` (`getAbstractFileByPath`), seeded with real `TFile`/
 * `TFolder` instances, not a faked return value.
 */

const VAULT_NAME = "Test Vault";
const VAULT_PATH = "/tmp/test-vault";

function unitNode(id: string, ref: ViewNode["ref"], extra: Partial<ViewNode> = {}): ViewNode {
	return { id, type: "unit", ref, children: [], ...extra };
}

function metaNode(id: string, label: string, children: ViewNode[] = []): ViewNode {
	return { id, type: "meta", label, children };
}

function fileUnit(path: string): Unit {
	return { type: "promoted-file", path, topLevelFolder: "" };
}

function folderUnit(path: string): Unit {
	return { type: "promoted-folder", path, topLevelFolder: "" };
}

function blockUnit(path: string, subpath: string): Unit {
	return { type: "promoted-block", path, subpath };
}

/** The same shape `createMoveNodeTool`/`createAddNodeTool` need from `ctx.getUnitIndex()`,
 * `ctx.getMetadataCache()`, `ctx.promoteUnit` and `ctx.forgetDeviceLocalSourceState` — fully
 * test-controlled rather than driven by the real `UnitIndex`/`MetadataCache`, since this file's
 * job is to test the arranging tools' own validation logic, not re-prove `UnitIndex`'s own rules
 * (that's `tests/unit/unit-index.test.ts`'s job). Default: every path is a recognised unit (so
 * every pre-existing test below keeps passing unmodified), nothing is excluded, nothing is an
 * interface note, and every attempted promotion/removal is just recorded, never refused. */
function setup(root: ViewNode[], viewOverrides: Partial<View> = {}) {
	const persist = vi.fn();
	const view: View = { id: "view-1", name: "Job Hunt", inboxMode: "view", root, ...viewOverrides };
	const viewsManager = new ViewsManager({} as App, [view], view.id, persist);
	const vault = new Vault();
	const knownUnits: Unit[] = [];
	const excludedPaths = new Set<string>();
	const interfaceNotePaths = new Set<string>();
	const fileCaches = new Map<string, CachedMetadata>();
	const promotedRefs: UnitRef[] = [];
	const forgottenNodeIds: string[] = [];
	const ctx: McpArrangeToolsContext = {
		getViewsManager: () => viewsManager,
		getVaultName: () => VAULT_NAME,
		getVaultPath: () => VAULT_PATH,
		getVault: () => vault,
		getUnitIndex: () => ({
			getUnits: () => knownUnits,
			isExcludedPath: (path: string) => excludedPaths.has(path),
			isInterfaceNoteFile: (file: { path: string }) => interfaceNotePaths.has(file.path),
		}),
		getMetadataCache: () => ({
			getFileCache: (file: { path: string }) => fileCaches.get(file.path) ?? null,
		}),
		promoteUnit: (ref) => {
			promotedRefs.push(ref);
			knownUnits.push(ref.kind === "block" ? blockUnit(ref.path, ref.subpath) : ref.kind === "folder" ? folderUnit(ref.path) : fileUnit(ref.path));
		},
		forgetDeviceLocalSourceState: (nodeId) => {
			forgottenNodeIds.push(nodeId);
		},
	};
	return { ctx, viewsManager, view, persist, vault, knownUnits, excludedPaths, interfaceNotePaths, fileCaches, promotedRefs, forgottenNodeIds };
}

// --- G4/E9 — add_node path resolution ------------------------------------------------------------

describe("resolveVaultPathToRef — G4 path-resolution rules", () => {
	it("resolves an existing file to a file ref", () => {
		const vault = new Vault();
		vault.seedFolder("Recruiting");
		vault.seedFile("Recruiting/Datadog.md");
		expect(resolveVaultPathToRef(vault, "Recruiting/Datadog.md")).toEqual({ kind: "file", path: "Recruiting/Datadog.md" });
	});

	it("resolves an existing folder to a folder (module) ref", () => {
		const vault = new Vault();
		vault.seedFolder("Recruiting");
		expect(resolveVaultPathToRef(vault, "Recruiting")).toEqual({ kind: "folder", path: "Recruiting" });
	});

	it("resolves an existing block ref (path#subpath) against the file at the base path", () => {
		const vault = new Vault();
		vault.seedFolder("Recruiting");
		vault.seedFile("Recruiting/Notes.md");
		expect(resolveVaultPathToRef(vault, "Recruiting/Notes.md#^abc123")).toEqual({ kind: "block", path: "Recruiting/Notes.md", subpath: "^abc123" });
	});

	it("E9: a path absent from the vault is refused, naming the path and suggesting the Obsidian CLI", () => {
		const vault = new Vault();
		expect(() => resolveVaultPathToRef(vault, "Recruiting/Ghost.md")).toThrow(McpUnitNotFoundError);
		try {
			resolveVaultPathToRef(vault, "Recruiting/Ghost.md");
			expect.unreachable();
		} catch (err) {
			expect((err as Error).message).toContain("Recruiting/Ghost.md");
			expect((err as Error).message).toMatch(/Obsidian CLI/);
		}
	});

	it('wrong unit kind: an existing folder given kind "file" is refused, not mis-typed', () => {
		const vault = new Vault();
		vault.seedFolder("Recruiting");
		expect(() => resolveVaultPathToRef(vault, "Recruiting", "file")).toThrow(McpWrongUnitKindError);
	});

	it('wrong unit kind: an existing file given kind "folder" is refused', () => {
		const vault = new Vault();
		vault.seedFolder("Recruiting");
		vault.seedFile("Recruiting/Datadog.md");
		expect(() => resolveVaultPathToRef(vault, "Recruiting/Datadog.md", "folder")).toThrow(McpWrongUnitKindError);
	});

	it("wrong unit kind: a block reference whose base path is a folder is refused", () => {
		const vault = new Vault();
		vault.seedFolder("Recruiting");
		expect(() => resolveVaultPathToRef(vault, "Recruiting#^abc")).toThrow(McpWrongUnitKindError);
	});

	it("a matching kind hint is accepted (no error) for file/folder/block", () => {
		const vault = new Vault();
		vault.seedFile("a.md");
		vault.seedFolder("Recruiting");
		vault.seedFile("b.md");
		expect(resolveVaultPathToRef(vault, "a.md", "file")).toEqual({ kind: "file", path: "a.md" });
		expect(resolveVaultPathToRef(vault, "Recruiting", "folder")).toEqual({ kind: "folder", path: "Recruiting" });
		expect(resolveVaultPathToRef(vault, "b.md#^x", "block")).toEqual({ kind: "block", path: "b.md", subpath: "^x" });
	});

	it("R4 review: \"/\" (the vault root) resolves to a folder ref, same as real Obsidian's getAbstractFileByPath", () => {
		const vault = new Vault();
		expect(resolveVaultPathToRef(vault, "/")).toEqual({ kind: "folder", path: "/" });
	});
});

describe("add_node — G4/GP1/GP3", () => {
	it("places an existing file under a named parent, returning the new node id", () => {
		const parent = metaNode("recruiting-folder", "Recruiting");
		const { ctx, view, viewsManager, vault } = setup([parent]);
		vault.seedFolder("Recruiting");
		vault.seedFile("Recruiting/Datadog.md");
		const tool = createAddNodeTool(ctx);

		const result = tool.handler({ view: "Job Hunt", path: "Recruiting/Datadog.md", parentNodeId: "recruiting-folder" }) as Record<string, unknown>;

		expect(result.vault).toEqual({ name: VAULT_NAME, path: VAULT_PATH });
		expect(result.view).toEqual({ id: "view-1", name: "Job Hunt" });
		expect(typeof result.nodeId).toBe("string");
		const node = viewsManager.getNode(view.id, result.nodeId as string);
		expect(node?.ref).toEqual({ kind: "file", path: "Recruiting/Datadog.md" });
		expect(parent.children.map((c) => c.id)).toContain(result.nodeId);
	});

	it("places at the view root when parentNodeId is omitted", () => {
		const { ctx, view, viewsManager } = setup([]);
		(ctx.getVault() as Vault).seedFile("a.md");
		const tool = createAddNodeTool(ctx);

		const result = tool.handler({ view: "Job Hunt", path: "a.md" }) as Record<string, unknown>;
		expect(view.root.some((n) => n.id === result.nodeId)).toBe(true);
		expect(viewsManager.getNode(view.id, result.nodeId as string)?.ref).toEqual({ kind: "file", path: "a.md" });
	});

	it("G4: placing a unit already placed elsewhere in the same view moves it rather than duplicating it", () => {
		const folderA = metaNode("folder-a", "A");
		const folderB = metaNode("folder-b", "B");
		const { ctx, view } = setup([folderA, folderB]);
		(ctx.getVault() as Vault).seedFile("a.md");
		const tool = createAddNodeTool(ctx);

		const first = tool.handler({ view: "Job Hunt", path: "a.md", parentNodeId: "folder-a" }) as Record<string, unknown>;
		const second = tool.handler({ view: "Job Hunt", path: "a.md", parentNodeId: "folder-b" }) as Record<string, unknown>;

		expect(second.nodeId).toBe(first.nodeId); // same node, moved — not a second node for the same ref
		expect(folderA.children).toHaveLength(0);
		expect(folderB.children.map((c) => c.id)).toEqual([first.nodeId]);
		// Exactly one node for this ref exists anywhere in the view.
		const allIds = [...folderA.children, ...folderB.children].map((c) => c.id);
		expect(allIds.filter((id) => id === first.nodeId)).toHaveLength(1);
		void view;
	});

	it("E9: a path not resolving to any vault unit is rejected as an error, not silently ignored", () => {
		const { ctx, view } = setup([]);
		const tool = createAddNodeTool(ctx);
		expect(() => tool.handler({ view: "Job Hunt", path: "Nowhere.md" })).toThrow(/Nowhere\.md/);
		expect(view.root).toHaveLength(0); // nothing written
	});

	it("G4: an existing-but-wrong-kind ref (a folder path given as a file) is rejected with a specific error", () => {
		const { ctx } = setup([]);
		(ctx.getVault() as Vault).seedFolder("Recruiting");
		const tool = createAddNodeTool(ctx);
		expect(() => tool.handler({ view: "Job Hunt", path: "Recruiting", kind: "file" })).toThrow(/is a folder, not a "file"/);
	});

	it("E9 follow-on: an unknown parentNodeId is a distinct error from an unknown path, never silently placed at root", () => {
		const { ctx, view } = setup([]);
		(ctx.getVault() as Vault).seedFile("a.md");
		const tool = createAddNodeTool(ctx);
		expect(() => tool.handler({ view: "Job Hunt", path: "a.md", parentNodeId: "does-not-exist" })).toThrow(/no node with id "does-not-exist"/);
		expect(view.root).toHaveLength(0); // never silently fell back to root
	});

	it("schema: a missing 'path' argument is refused", () => {
		const { ctx } = setup([]);
		const tool = createAddNodeTool(ctx);
		expect(() => tool.handler({ view: "Job Hunt" })).toThrow(/"path"/);
	});

	it("schema: a missing 'view' argument is refused", () => {
		const { ctx } = setup([]);
		(ctx.getVault() as Vault).seedFile("a.md");
		const tool = createAddNodeTool(ctx);
		expect(() => tool.handler({ path: "a.md" })).toThrow(/requires a "view"/);
	});

	it("schema: an unknown view id/name is refused", () => {
		const { ctx } = setup([]);
		(ctx.getVault() as Vault).seedFile("a.md");
		const tool = createAddNodeTool(ctx);
		expect(() => tool.handler({ view: "No Such View", path: "a.md" })).toThrow(/No view named or with id/);
	});

	it('schema: a wrong-type "kind" argument is refused', () => {
		const { ctx } = setup([]);
		(ctx.getVault() as Vault).seedFile("a.md");
		const tool = createAddNodeTool(ctx);
		expect(() => tool.handler({ view: "Job Hunt", path: "a.md", kind: "module" })).toThrow(/"kind" must be one of/);
	});

	it('schema: a wrong-type "parentNodeId" (number, not string/null) is refused', () => {
		const { ctx } = setup([]);
		(ctx.getVault() as Vault).seedFile("a.md");
		const tool = createAddNodeTool(ctx);
		expect(() => tool.handler({ view: "Job Hunt", path: "a.md", parentNodeId: 42 })).toThrow(/"parentNodeId" must be/);
	});
});

// --- R1 review: add_node must refuse a self/descendant cycle, same as move_node -------------------

describe("add_node — R1 review: refuses a cycle instead of losing the subtree", () => {
	it("refuses parentNodeId naming the node's own existing placement (self), leaving the tree untouched", () => {
		const child = unitNode("child", { kind: "file", path: "a.md" });
		const a = unitNode("a", { kind: "folder", path: "A" }, { children: [child] });
		const { ctx, view, knownUnits } = setup([a]);
		knownUnits.push(fileUnit("a.md"), folderUnit("A"));
		(ctx.getVault() as Vault).seedFolder("A");
		(ctx.getVault() as Vault).seedFile("a.md");
		const tool = createAddNodeTool(ctx);

		expect(() => tool.handler({ view: "Job Hunt", path: "A", parentNodeId: "a" })).toThrow(/already placed/);
		expect(view.root).toEqual([a]);
		expect(a.children.map((c) => c.id)).toEqual(["child"]);
	});

	it("refuses parentNodeId naming one of the node's own descendants, leaving the tree untouched", () => {
		const child = unitNode("child", { kind: "file", path: "a.md" });
		const a = unitNode("a", { kind: "folder", path: "A" }, { children: [child] });
		const { ctx, view, knownUnits } = setup([a]);
		knownUnits.push(fileUnit("a.md"), folderUnit("A"));
		(ctx.getVault() as Vault).seedFolder("A");
		(ctx.getVault() as Vault).seedFile("a.md");
		const tool = createAddNodeTool(ctx);

		expect(() => tool.handler({ view: "Job Hunt", path: "A", parentNodeId: "child" })).toThrow(/already placed/);
		expect(view.root).toEqual([a]);
		expect(a.children.map((c) => c.id)).toEqual(["child"]);
	});
});

// --- R10 review: a refused add_node (e.g. the R1 cycle guard) must never leave a stray promotion --

describe("add_node — R10 review: a refused call never leaves a stray manual promotion", () => {
	it("a cycle refusal after ensurePlaceableUnit would have promoted the ref records no promotion at all", () => {
		const c = metaNode("c", "C");
		// "a"'s own ref (Mod/x.md) is not a recognised unit yet — ensurePlaceableUnit would normally
		// promote it — but "a" is already placed, and the requested parentNodeId ("c") is a's own
		// child, so placeUnit's R1 cycle guard must refuse the whole call before any promotion lands.
		const a = unitNode("a", { kind: "file", path: "Mod/x.md" }, { children: [c] });
		const { ctx, view, promotedRefs } = setup([a]);
		(ctx.getVault() as Vault).seedFolder("Mod");
		(ctx.getVault() as Vault).seedFile("Mod/x.md");
		const tool = createAddNodeTool(ctx);

		expect(() => tool.handler({ view: "Job Hunt", path: "Mod/x.md", parentNodeId: "c" })).toThrow(/already placed/);
		expect(promotedRefs).toEqual([]); // the pending promotion must never have been applied
		expect(view.root).toEqual([a]);
		expect(a.children.map((child) => child.id)).toEqual(["c"]);
	});
});

// --- R2 review: add_node must report the node it actually moved/created, never a re-walk ----------

describe("add_node — R2 review: reports the moved/created node id directly, never re-derived", () => {
	it("a duplicated ref: add_node reports the id of the copy it actually moved, not the other copy", () => {
		const d1 = unitNode("d1", { kind: "file", path: "a.md" });
		const d2 = unitNode("d2", { kind: "file", path: "a.md" });
		const f = metaNode("f", "Folder");
		const { ctx, view } = setup([d1, d2, f]);
		(ctx.getVault() as Vault).seedFile("a.md");
		const tool = createAddNodeTool(ctx);

		const result = tool.handler({ view: "Job Hunt", path: "a.md", parentNodeId: "f" }) as Record<string, unknown>;

		// placeUnit moves the first DFS match (d1) under f — the reply must name that exact node,
		// not fall back to a second findUnitNode walk that could land on d2 instead.
		expect(result.nodeId).toBe("d1");
		expect(f.children.map((c) => c.id)).toEqual(["d1"]);
		expect(view.root.map((n) => n.id)).toEqual(["d2", "f"]);
	});
});

// --- R4 review: add_node must validate against real Atlas units, not just "exists on disk" --------

describe("add_node — R4 review: validates against the plugin's own unit classification", () => {
	it("a module-internal file that isn't a recognised unit yet is promoted (manual promotion) and placed", () => {
		const { ctx, view, viewsManager, promotedRefs } = setup([]);
		(ctx.getVault() as Vault).seedFolder("Recruiting");
		(ctx.getVault() as Vault).seedFile("Recruiting/Datadog.md");
		const tool = createAddNodeTool(ctx);

		const result = tool.handler({ view: "Job Hunt", path: "Recruiting/Datadog.md" }) as Record<string, unknown>;

		expect(promotedRefs).toEqual([{ kind: "file", path: "Recruiting/Datadog.md" }]);
		expect(viewsManager.getNode(view.id, result.nodeId as string)?.ref).toEqual({ kind: "file", path: "Recruiting/Datadog.md" });
	});

	it("a nested (unpromoted) module-internal folder is promoted and placed", () => {
		const { ctx, promotedRefs } = setup([]);
		(ctx.getVault() as Vault).seedFolder("Recruiting");
		(ctx.getVault() as Vault).seedFolder("Recruiting/Archive");
		const tool = createAddNodeTool(ctx);

		tool.handler({ view: "Job Hunt", path: "Recruiting/Archive" });
		expect(promotedRefs).toEqual([{ kind: "folder", path: "Recruiting/Archive" }]);
	});

	it("a non-md attachment inside a module is promoted and placed like any other module-internal file", () => {
		const { ctx, promotedRefs } = setup([]);
		(ctx.getVault() as Vault).seedFolder("Recruiting");
		(ctx.getVault() as Vault).seedFile("Recruiting/photo.png");
		const tool = createAddNodeTool(ctx);

		tool.handler({ view: "Job Hunt", path: "Recruiting/photo.png" });
		expect(promotedRefs).toEqual([{ kind: "file", path: "Recruiting/photo.png" }]);
	});

	it("already-known units are placed as is, with no promotion call at all", () => {
		const { ctx, knownUnits, promotedRefs } = setup([]);
		(ctx.getVault() as Vault).seedFolder("Recruiting");
		(ctx.getVault() as Vault).seedFile("Recruiting/Datadog.md");
		knownUnits.push(fileUnit("Recruiting/Datadog.md"));
		const tool = createAddNodeTool(ctx);

		tool.handler({ view: "Job Hunt", path: "Recruiting/Datadog.md" });
		expect(promotedRefs).toEqual([]);
	});

	it("AGENTS.md: a folder's own interface note (<Folder>/<Folder>.md) is refused, not promoted", () => {
		const { ctx, interfaceNotePaths, promotedRefs } = setup([]);
		(ctx.getVault() as Vault).seedFolder("Recruiting");
		(ctx.getVault() as Vault).seedFile("Recruiting/Recruiting.md");
		interfaceNotePaths.add("Recruiting/Recruiting.md");
		const tool = createAddNodeTool(ctx);

		expect(() => tool.handler({ view: "Job Hunt", path: "Recruiting/Recruiting.md" })).toThrow(/interface note/);
		expect(promotedRefs).toEqual([]);
	});

	it("a path inside an excluded folder is refused, not promoted", () => {
		const { ctx, excludedPaths, promotedRefs } = setup([]);
		(ctx.getVault() as Vault).seedFolder(".obsidian");
		(ctx.getVault() as Vault).seedFile(".obsidian/config.json");
		excludedPaths.add(".obsidian/config.json");
		const tool = createAddNodeTool(ctx);

		expect(() => tool.handler({ view: "Job Hunt", path: ".obsidian/config.json" })).toThrow(/excluded folder/);
		expect(promotedRefs).toEqual([]);
	});

	it("a block reference whose #subpath doesn't exist in the file is refused as not found, not promoted", () => {
		const { ctx, promotedRefs } = setup([]);
		(ctx.getVault() as Vault).seedFile("Notes.md");
		const tool = createAddNodeTool(ctx);

		expect(() => tool.handler({ view: "Job Hunt", path: "Notes.md#^ghost" })).toThrow(McpUnitNotFoundError);
		expect(promotedRefs).toEqual([]);
	});

	it("a block reference whose #^id block does exist is promoted and placed", () => {
		const { ctx, fileCaches, promotedRefs } = setup([]);
		(ctx.getVault() as Vault).seedFile("Notes.md");
		fileCaches.set("Notes.md", { blocks: { abc123: { id: "abc123", position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 0, offset: 0 } } } } });
		const tool = createAddNodeTool(ctx);

		tool.handler({ view: "Job Hunt", path: "Notes.md#^abc123" });
		expect(promotedRefs).toEqual([{ kind: "block", path: "Notes.md", subpath: "^abc123" }]);
	});

	it("a block reference whose #Heading does exist (case/whitespace-insensitive) is promoted and placed", () => {
		const { ctx, fileCaches, promotedRefs } = setup([]);
		(ctx.getVault() as Vault).seedFile("Notes.md");
		fileCaches.set("Notes.md", {
			headings: [{ heading: " My Heading ", level: 1, position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 0, offset: 0 } } }],
		});
		const tool = createAddNodeTool(ctx);

		tool.handler({ view: "Job Hunt", path: "Notes.md#my heading" });
		expect(promotedRefs).toEqual([{ kind: "block", path: "Notes.md", subpath: "my heading" }]);
	});

	it('"/" (the vault root) is refused outright, never placed or promoted', () => {
		const { ctx, promotedRefs, view } = setup([]);
		const tool = createAddNodeTool(ctx);

		expect(() => tool.handler({ view: "Job Hunt", path: "/" })).toThrow(/vault root/);
		expect(promotedRefs).toEqual([]);
		expect(view.root).toHaveLength(0);
	});
});

// --- R9 review: the excluded-folder (and interface-note/root) refusals must apply to block refs too -

describe("add_node — R9 review: excluded-folder refusal applies to a block reference's base path too", () => {
	it("a block reference whose base file is inside an excluded folder is refused, not promoted", () => {
		const { ctx, excludedPaths, promotedRefs, view } = setup([]);
		(ctx.getVault() as Vault).seedFolder("Archive");
		(ctx.getVault() as Vault).seedFile("Archive/x.md");
		excludedPaths.add("Archive/x.md");
		const tool = createAddNodeTool(ctx);

		// Before the fix, the block branch's own early return skipped isExcludedPath entirely and
		// fell straight through to ctx.promoteUnit — excluded folders must never promote, for any
		// unit kind, including a block reference.
		expect(() => tool.handler({ view: "Job Hunt", path: "Archive/x.md#^abc" })).toThrow(/excluded folder/);
		expect(promotedRefs).toEqual([]);
		expect(view.root).toHaveLength(0);
	});

	it("a block reference whose base file is a folder's interface note is refused, not promoted", () => {
		const { ctx, interfaceNotePaths, promotedRefs, view } = setup([]);
		(ctx.getVault() as Vault).seedFolder("Recruiting");
		(ctx.getVault() as Vault).seedFile("Recruiting/Recruiting.md");
		interfaceNotePaths.add("Recruiting/Recruiting.md");
		const tool = createAddNodeTool(ctx);

		expect(() => tool.handler({ view: "Job Hunt", path: "Recruiting/Recruiting.md#^abc" })).toThrow(/interface note/);
		expect(promotedRefs).toEqual([]);
		expect(view.root).toHaveLength(0);
	});
});

// --- R5 review: add_node/create_folder refuse an Outside-Vault-managed row as a parent -------------

describe("add_node/create_folder — R5 review: refuse an Outside-Vault-managed parent", () => {
	function outsideOwnerFixture() {
		const managedChild = unitNode("managed-child", { kind: "file", path: "ext/child.md" }, { folderSourceManaged: true, folderSourceOwnerId: "owner" });
		const owner: ViewNode = {
			id: "owner",
			type: "meta",
			label: "Outside source",
			children: [managedChild],
			folderSource: { type: "folder", location: "outside", path: "", showFiles: true, showFolders: false, mode: "merge" },
		};
		return { owner, managedChild };
	}

	it("add_node refuses an Outside-Vault-managed node as parentNodeId", () => {
		const { owner } = outsideOwnerFixture();
		const { ctx } = setup([owner]);
		(ctx.getVault() as Vault).seedFile("a.md");
		const tool = createAddNodeTool(ctx);

		expect(() => tool.handler({ view: "Job Hunt", path: "a.md", parentNodeId: "managed-child" })).toThrow(McpOutsideManagedError);
	});

	it("create_folder refuses an Outside-Vault-managed node as parentNodeId", () => {
		const { owner } = outsideOwnerFixture();
		const { ctx } = setup([owner]);
		const tool = createCreateFolderTool(ctx);

		expect(() => tool.handler({ view: "Job Hunt", label: "X", parentNodeId: "managed-child" })).toThrow(McpOutsideManagedError);
	});
});

// --- G5 — move_node -------------------------------------------------------------------------------

describe("move_node — G5/E-cases", () => {
	it("reparents a node into a named parent (or root) and reorders siblings", () => {
		const child = unitNode("child", { kind: "file", path: "a.md" });
		const folder = metaNode("folder", "Folder");
		const { ctx, view } = setup([child, folder]);
		const tool = createMoveNodeTool(ctx);

		const result = tool.handler({ view: "Job Hunt", nodeId: "child", newParentId: "folder", index: 0 }) as Record<string, unknown>;

		expect(result.nodeId).toBe("child");
		expect(folder.children.map((c) => c.id)).toEqual(["child"]);
		expect(view.root.map((n) => n.id)).toEqual(["folder"]);
	});

	it("omitting 'index' appends at the end", () => {
		const a = unitNode("a", { kind: "file", path: "a.md" });
		const b = unitNode("b", { kind: "file", path: "b.md" });
		const folder = metaNode("folder", "Folder", [a]);
		const { ctx } = setup([folder, b]);
		const tool = createMoveNodeTool(ctx);

		tool.handler({ view: "Job Hunt", nodeId: "b", newParentId: "folder" });
		expect(folder.children.map((c) => c.id)).toEqual(["a", "b"]);
	});

	it("Edge: an out-of-range index clamps rather than throwing", () => {
		const a = unitNode("a", { kind: "file", path: "a.md" });
		const b = unitNode("b", { kind: "file", path: "b.md" });
		const { ctx, view } = setup([a, b]);
		const tool = createMoveNodeTool(ctx);

		expect(() => tool.handler({ view: "Job Hunt", nodeId: "a", newParentId: null, index: 999 })).not.toThrow();
		expect(view.root.map((n) => n.id)).toEqual(["b", "a"]);
	});

	it("G5: refuses dropping a node into its own descendant", () => {
		const grandchild = unitNode("grandchild", { kind: "file", path: "c.md" });
		const child = metaNode("child", "Child", [grandchild]);
		const parent = metaNode("parent", "Parent", [child]);
		const { ctx } = setup([parent]);
		const tool = createMoveNodeTool(ctx);

		expect(() => tool.handler({ view: "Job Hunt", nodeId: "parent", newParentId: "grandchild", index: 0 })).toThrow(/descendant/);
	});

	it("G5: refuses dropping a node onto itself", () => {
		const node = metaNode("n1", "N1");
		const { ctx } = setup([node]);
		const tool = createMoveNodeTool(ctx);
		expect(() => tool.handler({ view: "Job Hunt", nodeId: "n1", newParentId: "n1", index: 0 })).toThrow(/descendant/);
	});

	it("Edge: an unknown nodeId is a descriptive 'not found' error, never a silent no-op", () => {
		const { ctx, view } = setup([unitNode("a", { kind: "file", path: "a.md" })]);
		const tool = createMoveNodeTool(ctx);
		expect(() => tool.handler({ view: "Job Hunt", nodeId: "nope", newParentId: null, index: 0 })).toThrow(/no node with id "nope"/);
		expect(view.root).toHaveLength(1); // nothing changed
	});

	it("E9 follow-on: an unknown newParentId is a distinct 'not found' error, never silently placed at root", () => {
		const node = unitNode("a", { kind: "file", path: "a.md" });
		const { ctx, view } = setup([node]);
		const tool = createMoveNodeTool(ctx);
		expect(() => tool.handler({ view: "Job Hunt", nodeId: "a", newParentId: "ghost", index: 0 })).toThrow(/no node with id "ghost"/);
		expect(view.root.map((n) => n.id)).toEqual(["a"]); // unchanged, never fell back to root
	});

	it("schema: a missing 'nodeId' argument is refused", () => {
		const { ctx } = setup([]);
		const tool = createMoveNodeTool(ctx);
		expect(() => tool.handler({ view: "Job Hunt" })).toThrow(/"nodeId"/);
	});

	it("schema: a wrong-type 'index' (string, not number) is refused", () => {
		const { ctx } = setup([unitNode("a", { kind: "file", path: "a.md" })]);
		const tool = createMoveNodeTool(ctx);
		expect(() => tool.handler({ view: "Job Hunt", nodeId: "a", index: "first" })).toThrow(/"index" must be/);
	});
});

// --- R7 review: move_node must report the node's actual landed position, never the raw request ----

describe("move_node — R7 review: reply index reflects where the node actually landed", () => {
	it("an omitted index reports the real append position, never the Number.MAX_SAFE_INTEGER sentinel", () => {
		const a = unitNode("a", { kind: "file", path: "a.md" });
		const b = unitNode("b", { kind: "file", path: "b.md" });
		const folder = metaNode("folder", "Folder", [a]);
		const { ctx } = setup([folder, b]);
		const tool = createMoveNodeTool(ctx);

		const result = tool.handler({ view: "Job Hunt", nodeId: "b", newParentId: "folder" }) as Record<string, unknown>;
		expect(result.index).toBe(1); // appended after "a", not Number.MAX_SAFE_INTEGER
	});

	it("an out-of-range index reports the real clamped position, never the raw out-of-range value", () => {
		const a = unitNode("a", { kind: "file", path: "a.md" });
		const b = unitNode("b", { kind: "file", path: "b.md" });
		const { ctx } = setup([a, b]);
		const tool = createMoveNodeTool(ctx);

		const result = tool.handler({ view: "Job Hunt", nodeId: "a", newParentId: null, index: 999 }) as Record<string, unknown>;
		expect(result.index).toBe(1); // clamped to the end of a 2-node root, not 999
	});

	it("an in-range index reports that same position when it matches where the node landed", () => {
		const a = unitNode("a", { kind: "file", path: "a.md" });
		const b = unitNode("b", { kind: "file", path: "b.md" });
		const c = unitNode("c", { kind: "file", path: "c.md" });
		const { ctx } = setup([a, b, c]);
		const tool = createMoveNodeTool(ctx);

		const result = tool.handler({ view: "Job Hunt", nodeId: "c", newParentId: null, index: 1 }) as Record<string, unknown>;
		expect(result.index).toBe(1);
	});
});

// --- R5 review: move_node refuses an Outside-Vault-managed node as either the target or parent -----

describe("move_node — R5 review: refuses an Outside-Vault-managed row", () => {
	function outsideOwnerFixture() {
		const managedChild = unitNode("managed-child", { kind: "file", path: "ext/child.md" }, { folderSourceManaged: true, folderSourceOwnerId: "owner" });
		const owner: ViewNode = {
			id: "owner",
			type: "meta",
			label: "Outside source",
			children: [managedChild],
			folderSource: { type: "folder", location: "outside", path: "", showFiles: true, showFolders: false, mode: "merge" },
		};
		return { owner, managedChild };
	}

	it("refuses moving an Outside-Vault-managed node itself", () => {
		const { owner } = outsideOwnerFixture();
		const other = metaNode("other", "Other");
		const { ctx } = setup([owner, other]);
		const tool = createMoveNodeTool(ctx);

		expect(() => tool.handler({ view: "Job Hunt", nodeId: "managed-child", newParentId: "other", index: 0 })).toThrow(McpOutsideManagedError);
	});

	it("refuses an Outside-Vault-managed node as the new parent", () => {
		const { owner } = outsideOwnerFixture();
		const plain = unitNode("plain", { kind: "file", path: "a.md" });
		const { ctx } = setup([owner, plain]);
		const tool = createMoveNodeTool(ctx);

		expect(() => tool.handler({ view: "Job Hunt", nodeId: "plain", newParentId: "managed-child", index: 0 })).toThrow(McpOutsideManagedError);
	});
});

// --- G5 — remove_node ------------------------------------------------------------------------------

describe("remove_node — G5/Edge", () => {
	it("removes exactly one node instance, lifting its children into its old slot", () => {
		const grandchild = unitNode("grandchild", { kind: "file", path: "c.md" });
		const child = metaNode("child", "Child", [grandchild]);
		const { ctx, view } = setup([child]);
		const tool = createRemoveNodeTool(ctx);

		const result = tool.handler({ view: "Job Hunt", nodeId: "child" }) as Record<string, unknown>;

		expect(result.removedNodeId).toBe("child");
		expect(result.liftedChildIds).toEqual(["grandchild"]);
		expect(result.sourceRemoved).toBe(false);
		expect(view.root.map((n) => n.id)).toEqual(["grandchild"]); // lifted into child's old slot
	});

	it("Edge: a managed child dropped by an Outside-Vault owner's own promotableChildren rule is reported as not lifted", () => {
		const managedChild = unitNode("managed-child", { kind: "file", path: "ext/child.md" }, { folderSourceManaged: true, folderSourceOwnerId: "owner" });
		const owninaryChild = unitNode("plain-child", { kind: "file", path: "plain.md" });
		const owner: ViewNode = {
			id: "owner",
			type: "meta",
			label: "Outside source",
			children: [managedChild, owninaryChild],
			folderSource: { type: "folder", location: "outside", path: "", showFiles: true, showFolders: false, mode: "merge" },
		};
		const { ctx, view } = setup([owner]);
		const tool = createRemoveNodeTool(ctx);

		const result = tool.handler({ view: "Job Hunt", nodeId: "owner" }) as Record<string, unknown>;

		// promotableChildren drops the Outside-Vault-managed child along with its owner; only the
		// ordinary child is actually lifted — the reply must reflect that, not claim both lifted.
		expect(result.liftedChildIds).toEqual(["plain-child"]);
		expect(view.root.map((n) => n.id)).toEqual(["plain-child"]);
	});

	it("Edge: an unknown nodeId is a descriptive 'not found' error, never a silent no-op", () => {
		const { ctx, view } = setup([unitNode("a", { kind: "file", path: "a.md" })]);
		const tool = createRemoveNodeTool(ctx);
		expect(() => tool.handler({ view: "Job Hunt", nodeId: "nope" })).toThrow(/no node with id "nope"/);
		expect(view.root).toHaveLength(1);
	});

	it("schema: a missing 'nodeId' argument is refused", () => {
		const { ctx } = setup([]);
		const tool = createRemoveNodeTool(ctx);
		expect(() => tool.handler({ view: "Job Hunt" })).toThrow(/"nodeId"/);
	});
});

// --- R3 review: remove_node must clear a sourced node's device-local state, same as the UI ---------

describe("remove_node — R3 review: clears device-local source state for a sourced node", () => {
	it("a node with a live apiSource has forgetDeviceLocalSourceState called and reports sourceRemoved: true", () => {
		const sourced = unitNode("sourced", { kind: "file", path: "a.md" }, {
			apiSource: { url: "https://api.example.com/items", method: "GET", mapping: { idField: "id", labelField: "name" }, mode: "merge", refreshOnViewLoad: false },
		});
		const { ctx, forgottenNodeIds } = setup([sourced]);
		const tool = createRemoveNodeTool(ctx);

		const result = tool.handler({ view: "Job Hunt", nodeId: "sourced" }) as Record<string, unknown>;

		expect(result.sourceRemoved).toBe(true);
		expect(forgottenNodeIds).toEqual(["sourced"]);
	});

	it("a plain node (no live source) never calls forgetDeviceLocalSourceState and reports sourceRemoved: false", () => {
		const plain = unitNode("plain", { kind: "file", path: "a.md" });
		const { ctx, forgottenNodeIds } = setup([plain]);
		const tool = createRemoveNodeTool(ctx);

		const result = tool.handler({ view: "Job Hunt", nodeId: "plain" }) as Record<string, unknown>;

		expect(result.sourceRemoved).toBe(false);
		expect(forgottenNodeIds).toEqual([]);
	});

	it("a Folder-source owner node (meta, folderSource set) also has its device-local state cleared", () => {
		const owner: ViewNode = {
			id: "owner",
			type: "meta",
			label: "Outside source",
			children: [],
			folderSource: { type: "folder", location: "outside", path: "", showFiles: true, showFolders: false, mode: "merge" },
		};
		const { ctx, forgottenNodeIds } = setup([owner]);
		const tool = createRemoveNodeTool(ctx);

		const result = tool.handler({ view: "Job Hunt", nodeId: "owner" }) as Record<string, unknown>;

		expect(result.sourceRemoved).toBe(true);
		expect(forgottenNodeIds).toEqual(["owner"]);
	});
});

// --- G6 — create_folder / rename_folder -------------------------------------------------------------

describe("create_folder — G6/Edge", () => {
	it("creates a meta node under a named parent and returns its new node id", () => {
		const parent = metaNode("parent", "Parent");
		const { ctx, view, viewsManager } = setup([parent]);
		const tool = createCreateFolderTool(ctx);

		const result = tool.handler({ view: "Job Hunt", label: "Recruiting", parentNodeId: "parent" }) as Record<string, unknown>;

		expect(typeof result.nodeId).toBe("string");
		expect(result.label).toBe("Recruiting");
		const node = viewsManager.getNode(view.id, result.nodeId as string);
		expect(node?.type).toBe("meta");
		expect(parent.children.map((c) => c.id)).toEqual([result.nodeId]);
	});

	it("creates at the view root when parentNodeId is omitted", () => {
		const { ctx, view } = setup([]);
		const tool = createCreateFolderTool(ctx);
		const result = tool.handler({ view: "Job Hunt", label: "Recruiting" }) as Record<string, unknown>;
		expect(view.root.map((n) => n.id)).toEqual([result.nodeId]);
	});

	it("Edge: an empty label is refused, not saved as a blank label", () => {
		const { ctx, view } = setup([]);
		const tool = createCreateFolderTool(ctx);
		expect(() => tool.handler({ view: "Job Hunt", label: "" })).toThrow(/non-empty/);
		expect(view.root).toHaveLength(0);
	});

	it("Edge: a whitespace-only label is refused", () => {
		const { ctx, view } = setup([]);
		const tool = createCreateFolderTool(ctx);
		expect(() => tool.handler({ view: "Job Hunt", label: "   " })).toThrow(/non-empty/);
		expect(view.root).toHaveLength(0);
	});

	it("E9 follow-on: an unknown parentNodeId is refused, never silently placed at root", () => {
		const { ctx, view } = setup([]);
		const tool = createCreateFolderTool(ctx);
		expect(() => tool.handler({ view: "Job Hunt", label: "Recruiting", parentNodeId: "ghost" })).toThrow(/no node with id "ghost"/);
		expect(view.root).toHaveLength(0);
	});

	it("schema: a missing 'label' argument is refused", () => {
		const { ctx } = setup([]);
		const tool = createCreateFolderTool(ctx);
		expect(() => tool.handler({ view: "Job Hunt" })).toThrow(/"label"/);
	});
});

describe("rename_folder — G6/Edge", () => {
	it("renames an existing meta node's label", () => {
		const meta = metaNode("meta-1", "Old label");
		const { ctx, viewsManager, view } = setup([meta]);
		const tool = createRenameFolderTool(ctx);

		const result = tool.handler({ view: "Job Hunt", nodeId: "meta-1", label: "New label" }) as Record<string, unknown>;

		expect(result.label).toBe("New label");
		expect(viewsManager.getNode(view.id, "meta-1")?.label).toBe("New label");
	});

	it("G6: a target node that is type 'unit' (a real file, block or module) is refused, pointing at the Obsidian CLI", () => {
		const unit = unitNode("unit-1", { kind: "folder", path: "Recruiting" });
		const { ctx } = setup([unit]);
		const tool = createRenameFolderTool(ctx);

		try {
			tool.handler({ view: "Job Hunt", nodeId: "unit-1", label: "New label" });
			expect.unreachable();
		} catch (err) {
			expect((err as Error).message).toMatch(/Obsidian CLI/);
			expect((err as Error).message).toMatch(/unit-1/);
		}
	});

	it("G6: distinguishes 'node id not found' from 'node exists but is not a meta folder' — renameMetaFolder returns false for both", () => {
		const unit = unitNode("unit-1", { kind: "file", path: "a.md" });
		const { ctx } = setup([unit]);
		const tool = createRenameFolderTool(ctx);

		let notFoundMessage = "";
		try {
			tool.handler({ view: "Job Hunt", nodeId: "does-not-exist", label: "New label" });
		} catch (err) {
			notFoundMessage = (err as Error).message;
		}
		let notMetaMessage = "";
		try {
			tool.handler({ view: "Job Hunt", nodeId: "unit-1", label: "New label" });
		} catch (err) {
			notMetaMessage = (err as Error).message;
		}

		expect(notFoundMessage).toMatch(/no node with id/);
		expect(notMetaMessage).toMatch(/is a unit/);
		expect(notFoundMessage).not.toBe(notMetaMessage);
	});

	it("Edge: an empty label is refused", () => {
		const meta = metaNode("meta-1", "Old label");
		const { ctx, viewsManager, view } = setup([meta]);
		const tool = createRenameFolderTool(ctx);
		expect(() => tool.handler({ view: "Job Hunt", nodeId: "meta-1", label: "" })).toThrow(/non-empty/);
		expect(viewsManager.getNode(view.id, "meta-1")?.label).toBe("Old label");
	});

	it("schema: a missing 'label' argument is refused", () => {
		const meta = metaNode("meta-1", "Old label");
		const { ctx } = setup([meta]);
		const tool = createRenameFolderTool(ctx);
		expect(() => tool.handler({ view: "Job Hunt", nodeId: "meta-1" })).toThrow(/"label"/);
	});
});

// --- Table-driven schema validation across all five tools -----------------------------------------

describe("schema validation — table-driven across every arranging tool", () => {
	function baseFixture() {
		const meta = metaNode("meta-1", "Folder");
		const unit = unitNode("unit-1", { kind: "file", path: "a.md" });
		const { ctx, vault } = setup([meta, unit]);
		(vault as Vault).seedFile("a.md");
		(vault as Vault).seedFile("b.md");
		return ctx;
	}

	const cases: { name: string; make: (ctx: McpArrangeToolsContext) => () => unknown; message: RegExp }[] = [
		{ name: "add_node missing view", make: (ctx) => () => createAddNodeTool(ctx).handler({ path: "b.md" }), message: /requires a "view"/ },
		{ name: "add_node missing path", make: (ctx) => () => createAddNodeTool(ctx).handler({ view: "Job Hunt" }), message: /"path"/ },
		{ name: "add_node unknown view", make: (ctx) => () => createAddNodeTool(ctx).handler({ view: "Ghost View", path: "b.md" }), message: /No view named or with id/ },
		{ name: "add_node wrong-type view", make: (ctx) => () => createAddNodeTool(ctx).handler({ view: 42, path: "b.md" }), message: /requires a "view"/ },
		{ name: "move_node missing view", make: (ctx) => () => createMoveNodeTool(ctx).handler({ nodeId: "unit-1" }), message: /requires a "view"/ },
		{ name: "move_node missing nodeId", make: (ctx) => () => createMoveNodeTool(ctx).handler({ view: "Job Hunt" }), message: /"nodeId"/ },
		{ name: "move_node unknown view", make: (ctx) => () => createMoveNodeTool(ctx).handler({ view: "Ghost View", nodeId: "unit-1" }), message: /No view named or with id/ },
		{ name: "move_node wrong-type nodeId", make: (ctx) => () => createMoveNodeTool(ctx).handler({ view: "Job Hunt", nodeId: 42 }), message: /"nodeId"/ },
		{ name: "remove_node missing view", make: (ctx) => () => createRemoveNodeTool(ctx).handler({ nodeId: "unit-1" }), message: /requires a "view"/ },
		{ name: "remove_node missing nodeId", make: (ctx) => () => createRemoveNodeTool(ctx).handler({ view: "Job Hunt" }), message: /"nodeId"/ },
		{ name: "remove_node unknown view", make: (ctx) => () => createRemoveNodeTool(ctx).handler({ view: "Ghost View", nodeId: "unit-1" }), message: /No view named or with id/ },
		{ name: "remove_node wrong-type nodeId", make: (ctx) => () => createRemoveNodeTool(ctx).handler({ view: "Job Hunt", nodeId: true }), message: /"nodeId"/ },
		{ name: "create_folder missing view", make: (ctx) => () => createCreateFolderTool(ctx).handler({ label: "X" }), message: /requires a "view"/ },
		{ name: "create_folder missing label", make: (ctx) => () => createCreateFolderTool(ctx).handler({ view: "Job Hunt" }), message: /"label"/ },
		{ name: "create_folder unknown view", make: (ctx) => () => createCreateFolderTool(ctx).handler({ view: "Ghost View", label: "X" }), message: /No view named or with id/ },
		{ name: "create_folder wrong-type label", make: (ctx) => () => createCreateFolderTool(ctx).handler({ view: "Job Hunt", label: 42 }), message: /"label"/ },
		{ name: "rename_folder missing view", make: (ctx) => () => createRenameFolderTool(ctx).handler({ nodeId: "meta-1", label: "X" }), message: /requires a "view"/ },
		{ name: "rename_folder missing nodeId", make: (ctx) => () => createRenameFolderTool(ctx).handler({ view: "Job Hunt", label: "X" }), message: /"nodeId"/ },
		{ name: "rename_folder missing label", make: (ctx) => () => createRenameFolderTool(ctx).handler({ view: "Job Hunt", nodeId: "meta-1" }), message: /"label"/ },
		{ name: "rename_folder unknown view", make: (ctx) => () => createRenameFolderTool(ctx).handler({ view: "Ghost View", nodeId: "meta-1", label: "X" }), message: /No view named or with id/ },
		{ name: "rename_folder wrong-type label", make: (ctx) => () => createRenameFolderTool(ctx).handler({ view: "Job Hunt", nodeId: "meta-1", label: 42 }), message: /"label"/ },
	];

	for (const { name, make, message } of cases) {
		it(name, () => {
			const ctx = baseFixture();
			expect(make(ctx)).toThrow(message);
		});
	}
});


// --- F4 review: none of the five tools ever reads or writes a node's status fields ----------------

describe("F4 — none of the five tools touches explicitStatusId/apiItemState or any other status field", () => {
	it("move_node leaves the moved node's own explicitStatusId exactly as it was", () => {
		const a = unitNode("a", { kind: "file", path: "a.md" }, { explicitStatusId: "in-progress" });
		const folder = metaNode("folder", "Folder");
		const { ctx } = setup([a, folder]);
		const tool = createMoveNodeTool(ctx);

		tool.handler({ view: "Job Hunt", nodeId: "a", newParentId: "folder", index: 0 });
		expect(folder.children[0].explicitStatusId).toBe("in-progress");
	});

	it("remove_node leaves a lifted child's own explicitStatusId exactly as it was", () => {
		const child = unitNode("child", { kind: "file", path: "c.md" }, { explicitStatusId: "blocked" });
		const parent = metaNode("parent", "Parent", [child]);
		const { ctx, view } = setup([parent]);
		const tool = createRemoveNodeTool(ctx);

		tool.handler({ view: "Job Hunt", nodeId: "parent" });
		expect(view.root[0].explicitStatusId).toBe("blocked");
	});

	it("create_folder's new node has no explicitStatusId/apiItemState of its own", () => {
		const { ctx, view } = setup([]);
		const tool = createCreateFolderTool(ctx);

		tool.handler({ view: "Job Hunt", label: "Recruiting" });
		expect(view.root[0].explicitStatusId).toBeUndefined();
		expect(view.root[0].apiItemState).toBeUndefined();
	});

	it("rename_folder leaves the renamed node's own explicitStatusId exactly as it was", () => {
		const meta = metaNode("meta-1", "Old label");
		meta.explicitStatusId = "done";
		const { ctx, viewsManager, view } = setup([meta]);
		const tool = createRenameFolderTool(ctx);

		tool.handler({ view: "Job Hunt", nodeId: "meta-1", label: "New label" });
		expect(viewsManager.getNode(view.id, "meta-1")?.explicitStatusId).toBe("done");
	});

	it("add_node's newly created node has no explicitStatusId/apiItemState of its own", () => {
		const { ctx, view, viewsManager } = setup([]);
		(ctx.getVault() as Vault).seedFile("a.md");
		const tool = createAddNodeTool(ctx);

		const result = tool.handler({ view: "Job Hunt", path: "a.md" }) as Record<string, unknown>;
		const node = viewsManager.getNode(view.id, result.nodeId as string);
		expect(node?.explicitStatusId).toBeUndefined();
		expect(node?.apiItemState).toBeUndefined();
	});
});
