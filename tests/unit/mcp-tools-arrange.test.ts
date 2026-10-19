import type { App } from "obsidian";
import { Vault } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { View, ViewNode } from "../../src/types";
import { ViewsManager } from "../../src/views";
import {
	McpArrangeToolsContext,
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

function setup(root: ViewNode[], viewOverrides: Partial<View> = {}) {
	const persist = vi.fn();
	const view: View = { id: "view-1", name: "Job Hunt", inboxMode: "view", root, ...viewOverrides };
	const viewsManager = new ViewsManager({} as App, [view], view.id, persist);
	const vault = new Vault();
	const ctx: McpArrangeToolsContext = {
		getViewsManager: () => viewsManager,
		getVaultName: () => VAULT_NAME,
		getVaultPath: () => VAULT_PATH,
		getVault: () => vault,
	};
	return { ctx, viewsManager, view, persist, vault };
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
		{ name: "move_node missing view", make: (ctx) => () => createMoveNodeTool(ctx).handler({ nodeId: "unit-1" }), message: /requires a "view"/ },
		{ name: "move_node missing nodeId", make: (ctx) => () => createMoveNodeTool(ctx).handler({ view: "Job Hunt" }), message: /"nodeId"/ },
		{ name: "move_node unknown view", make: (ctx) => () => createMoveNodeTool(ctx).handler({ view: "Ghost View", nodeId: "unit-1" }), message: /No view named or with id/ },
		{ name: "remove_node missing view", make: (ctx) => () => createRemoveNodeTool(ctx).handler({ nodeId: "unit-1" }), message: /requires a "view"/ },
		{ name: "remove_node missing nodeId", make: (ctx) => () => createRemoveNodeTool(ctx).handler({ view: "Job Hunt" }), message: /"nodeId"/ },
		{ name: "remove_node unknown view", make: (ctx) => () => createRemoveNodeTool(ctx).handler({ view: "Ghost View", nodeId: "unit-1" }), message: /No view named or with id/ },
		{ name: "create_folder missing view", make: (ctx) => () => createCreateFolderTool(ctx).handler({ label: "X" }), message: /requires a "view"/ },
		{ name: "create_folder missing label", make: (ctx) => () => createCreateFolderTool(ctx).handler({ view: "Job Hunt" }), message: /"label"/ },
		{ name: "create_folder unknown view", make: (ctx) => () => createCreateFolderTool(ctx).handler({ view: "Ghost View", label: "X" }), message: /No view named or with id/ },
		{ name: "rename_folder missing view", make: (ctx) => () => createRenameFolderTool(ctx).handler({ nodeId: "meta-1", label: "X" }), message: /requires a "view"/ },
		{ name: "rename_folder missing nodeId", make: (ctx) => () => createRenameFolderTool(ctx).handler({ view: "Job Hunt", label: "X" }), message: /"nodeId"/ },
		{ name: "rename_folder missing label", make: (ctx) => () => createRenameFolderTool(ctx).handler({ view: "Job Hunt", nodeId: "meta-1" }), message: /"label"/ },
		{ name: "rename_folder unknown view", make: (ctx) => () => createRenameFolderTool(ctx).handler({ view: "Ghost View", nodeId: "meta-1", label: "X" }), message: /No view named or with id/ },
	];

	for (const { name, make, message } of cases) {
		it(name, () => {
			const ctx = baseFixture();
			expect(make(ctx)).toThrow(message);
		});
	}
});
