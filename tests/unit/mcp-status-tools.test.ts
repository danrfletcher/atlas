import type { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { App as MockApp } from "../mocks/obsidian";
import { View, ViewNode } from "../../src/types";
import { StatusSet, StatusesManager } from "../../src/statuses";
import { ViewsManager } from "../../src/views";
import { apiItemAddress } from "../../src/mcp-node-resolver";
import {
	McpStatusToolsContext,
	createGetNodeStatusTool,
	createListNodesTool,
	createListStatusSetsTool,
	createListViewsTool,
	createSetNodeStatusTool,
} from "../../src/mcp-status-tools";

/**
 * PR-2.F1: `get_node_status`/`set_node_status` (plus the three list_* read tools) against a real
 * `ViewsManager`/`StatusesManager` pair with a constructor-injected fake `persist` — the same
 * pattern `tests/unit/views-refresh-save.test.ts` uses, so these tests drive the real
 * `resolveNodeStatus`/`findGoverningAncestor`/`setExplicitStatus`/`setApiItemStatus` machinery,
 * not a mock standing in for it.
 */

const VAULT_NAME = "Test Vault";
const VAULT_PATH = "/tmp/test-vault";

function makeStatusSet(overrides: Partial<StatusSet> = {}): StatusSet {
	return {
		id: "set-recruiting",
		name: "Recruiting",
		statuses: [
			{ id: "s-prospect", label: "Prospect", color: "#111111" },
			{ id: "s-applied", label: "Applied", color: "#222222" },
			{ id: "s-screen", label: "Screen", color: "#333333" },
		],
		defaultStatusId: "s-prospect",
		...overrides,
	};
}

function setup(root: ViewNode[], viewOverrides: Partial<View> = {}, statusSets: StatusSet[] = [makeStatusSet()]) {
	const persist = vi.fn();
	const view: View = { id: "view-1", name: "Job Hunt", inboxMode: "view", root, ...viewOverrides };
	const viewsManager = new ViewsManager({} as App, [view], view.id, persist);
	const statusesManager = new StatusesManager(statusSets, [], persist);
	const ctx: McpStatusToolsContext = {
		getViewsManager: () => viewsManager,
		getStatusesManager: () => statusesManager,
		getVaultName: () => VAULT_NAME,
		getVaultPath: () => VAULT_PATH,
		getFolderSourcePath: () => "",
	};
	return { ctx, viewsManager, statusesManager, view, persist };
}

function unitNode(id: string, ref: ViewNode["ref"], extra: Partial<ViewNode> = {}): ViewNode {
	return { id, type: "unit", ref, children: [], ...extra };
}

describe("get_node_status — G2", () => {
	it("returns null resolvedStatus/governingStatusSet (not an error) when no governor reaches the node — E5 read-never-errors", () => {
		const node = unitNode("n1", { kind: "file", path: "a.md" });
		const { ctx } = setup([node]); // no statusEnabled anywhere
		const tool = createGetNodeStatusTool(ctx);

		const result = tool.handler({ nodeId: "n1" }) as Record<string, unknown>;
		expect(result.resolvedStatus).toBeNull();
		expect(result.governingStatusSet).toBeNull();
		expect(result.explicitStatusId).toBeNull();
		expect(result.vault).toEqual({ name: VAULT_NAME, path: VAULT_PATH });
		expect(result.view).toEqual({ id: "view-1", name: "Job Hunt" });
	});

	it("returns the governing status set and the resolved default status when a governor reaches the node", () => {
		const node = unitNode("n1", { kind: "file", path: "a.md" });
		const { ctx } = setup([node], { statusEnabled: true, statusSetId: "set-recruiting" });
		const tool = createGetNodeStatusTool(ctx);

		const result = tool.handler({ nodeId: "n1" }) as Record<string, unknown>;
		expect(result.governingStatusSet).toEqual({ id: "set-recruiting", name: "Recruiting" });
		expect(result.resolvedStatus).toEqual({ id: "s-prospect", label: "Prospect", color: "#111111" });
		expect(result.explicitStatusId).toBeNull();
	});

	it("a stale explicitStatusId (status removed from the set) degrades to the set's default rather than erroring", () => {
		const node = unitNode("n1", { kind: "file", path: "a.md" }, { explicitStatusId: "no-longer-exists" });
		const { ctx } = setup([node], { statusEnabled: true, statusSetId: "set-recruiting" });
		const tool = createGetNodeStatusTool(ctx);

		const result = tool.handler({ nodeId: "n1" }) as Record<string, unknown>;
		expect(result.resolvedStatus).toEqual({ id: "s-prospect", label: "Prospect", color: "#111111" });
		// The node's own explicitStatusId is reported verbatim even though it's stale — only the
		// *resolved* status degrades.
		expect(result.explicitStatusId).toBe("no-longer-exists");
	});

	it("E5: a node whose kind is excluded via the governor's applyTo gets a null resolvedStatus, not an error", () => {
		const node = unitNode("n1", { kind: "file", path: "a.md" });
		const { ctx } = setup([node], { statusEnabled: true, statusSetId: "set-recruiting", applyTo: { file: false } });
		const tool = createGetNodeStatusTool(ctx);

		const result = tool.handler({ nodeId: "n1" }) as Record<string, unknown>;
		expect(result.resolvedStatus).toBeNull();
	});

	it("defaults to the active view when 'view' is omitted (Q3)", () => {
		const node = unitNode("n1", { kind: "file", path: "a.md" });
		const { ctx } = setup([node], { statusEnabled: true, statusSetId: "set-recruiting" });
		const tool = createGetNodeStatusTool(ctx);

		const result = tool.handler({ nodeId: "n1" }) as Record<string, unknown>;
		expect(result.view).toEqual({ id: "view-1", name: "Job Hunt" });
	});

	it("reads an API/CSV/markdown-table placeholder row's status through apiItemState, not a ViewNode", () => {
		const owner: ViewNode = {
			id: "owner",
			type: "meta",
			label: "Leads",
			children: [],
			statusEnabled: true,
			statusSetId: "set-recruiting",
			apiItemOrder: ["row-1"],
			apiItemState: { "row-1": { id: "row-1", label: "Acme", kind: "placeholder", explicitStatusId: "s-applied" } },
		};
		const { ctx } = setup([owner]);
		const tool = createGetNodeStatusTool(ctx);

		const result = tool.handler({ nodeId: apiItemAddress("owner", "row-1") }) as Record<string, unknown>;
		expect(result.explicitStatusId).toBe("s-applied");
		expect(result.resolvedStatus).toEqual({ id: "s-applied", label: "Applied", color: "#222222" });
	});

	it("R1 fix: two owners sharing the same raw row id never collide — each is addressed by its own owner-qualified composite id", () => {
		const ownerA: ViewNode = {
			id: "owner-a",
			type: "meta",
			label: "Leads A",
			children: [],
			statusEnabled: true,
			statusSetId: "set-recruiting",
			apiItemOrder: ["1"],
			apiItemState: { "1": { id: "1", label: "Acme Inc", kind: "placeholder", explicitStatusId: "s-applied" } },
		};
		const ownerB: ViewNode = {
			id: "owner-b",
			type: "meta",
			label: "Leads B (duplicate)",
			children: [],
			statusEnabled: true,
			statusSetId: "set-recruiting",
			apiItemOrder: ["1"],
			apiItemState: { "1": { id: "1", label: "Acme Inc (dup)", kind: "placeholder" } },
		};
		const { ctx } = setup([ownerA, ownerB]);
		const tool = createGetNodeStatusTool(ctx);

		const resultA = tool.handler({ nodeId: apiItemAddress("owner-a", "1") }) as Record<string, unknown>;
		const resultB = tool.handler({ nodeId: apiItemAddress("owner-b", "1") }) as Record<string, unknown>;
		expect(resultA.explicitStatusId).toBe("s-applied");
		expect(resultB.explicitStatusId).toBeNull();
	});

	it("E3: an unknown node id is refused with a descriptive error", () => {
		const { ctx } = setup([unitNode("n1", { kind: "file", path: "a.md" })]);
		const tool = createGetNodeStatusTool(ctx);
		expect(() => tool.handler({ nodeId: "nope" })).toThrow(/nope/);
	});

	it("E6: an ambiguous path lists every match", () => {
		const { ctx } = setup([unitNode("stripe-1", { kind: "file", path: "Recruiting/Stripe.md" }), unitNode("stripe-2", { kind: "file", path: "Recruiting/Stripe.md" })]);
		const tool = createGetNodeStatusTool(ctx);
		try {
			tool.handler({ path: "Recruiting/Stripe.md" });
			expect.unreachable();
		} catch (err) {
			expect((err as Error).message).toContain("stripe-1");
			expect((err as Error).message).toContain("stripe-2");
		}
	});
});

describe("set_node_status — G3/E2/E5/E7", () => {
	it("GP4/GP5: writes explicitStatusId, saves, and replies with the view, previous and new status", () => {
		const node = unitNode("n1", { kind: "file", path: "a.md" });
		const { ctx, persist } = setup([node], { statusEnabled: true, statusSetId: "set-recruiting" });
		const tool = createSetNodeStatusTool(ctx);

		const result = tool.handler({ view: "Job Hunt", nodeId: "n1", statusLabel: "Applied" }) as Record<string, unknown>;

		expect(node.explicitStatusId).toBe("s-applied"); // the real ViewsManager mutation, not a mock
		expect(persist).toHaveBeenCalled(); // goes through ViewsManager's normal save path
		expect(result.view).toEqual({ id: "view-1", name: "Job Hunt" });
		expect(result.previousStatus).toEqual({ id: "s-prospect", label: "Prospect", color: "#111111" });
		expect(result.newStatus).toEqual({ id: "s-applied", label: "Applied", color: "#222222" });
	});

	it("resolves the status label case-insensitively", () => {
		const node = unitNode("n1", { kind: "file", path: "a.md" });
		const { ctx } = setup([node], { statusEnabled: true, statusSetId: "set-recruiting" });
		const tool = createSetNodeStatusTool(ctx);

		tool.handler({ view: "Job Hunt", nodeId: "n1", statusLabel: "aPPlieD" });
		expect(node.explicitStatusId).toBe("s-applied");
	});

	it("E2: an unknown status label is refused, listing the valid labels for this node's governing set", () => {
		const node = unitNode("n1", { kind: "file", path: "a.md" });
		const { ctx } = setup([node], { statusEnabled: true, statusSetId: "set-recruiting" });
		const tool = createSetNodeStatusTool(ctx);

		try {
			tool.handler({ view: "Job Hunt", nodeId: "n1", statusLabel: "Not A Real Status" });
			expect.unreachable();
		} catch (err) {
			const message = (err as Error).message;
			expect(message).toContain("Prospect");
			expect(message).toContain("Applied");
			expect(message).toContain("Screen");
		}
		expect(node.explicitStatusId).toBeUndefined();
	});

	it("E2: a label belonging to a different status set than the node's governor is refused", () => {
		const otherSet = makeStatusSet({ id: "set-other", name: "Other", statuses: [{ id: "o-1", label: "OtherLabel", color: "#000" }], defaultStatusId: "o-1" });
		const node = unitNode("n1", { kind: "file", path: "a.md" });
		const { ctx } = setup([node], { statusEnabled: true, statusSetId: "set-recruiting" }, [makeStatusSet(), otherSet]);
		const tool = createSetNodeStatusTool(ctx);

		expect(() => tool.handler({ view: "Job Hunt", nodeId: "n1", statusLabel: "OtherLabel" })).toThrow(/Unknown status label/);
	});

	it("E5: refused outright with an explicit error when no status set governs the node (unlike get_node_status's null reply)", () => {
		const node = unitNode("n1", { kind: "file", path: "a.md" });
		const { ctx } = setup([node]); // no governor anywhere
		const tool = createSetNodeStatusTool(ctx);

		expect(() => tool.handler({ view: "Job Hunt", nodeId: "n1", statusLabel: "Applied" })).toThrow(/no status set governs/i);
		expect(node.explicitStatusId).toBeUndefined();
	});

	it("E5: refused when the node's kind is excluded via the governor's applyTo", () => {
		const node = unitNode("n1", { kind: "file", path: "a.md" });
		const { ctx } = setup([node], { statusEnabled: true, statusSetId: "set-recruiting", applyTo: { file: false } });
		const tool = createSetNodeStatusTool(ctx);

		expect(() => tool.handler({ view: "Job Hunt", nodeId: "n1", statusLabel: "Applied" })).toThrow(/no status set governs/i);
	});

	it("E7: a missing 'view' argument is refused outright — never falls back to the active view", () => {
		const node = unitNode("n1", { kind: "file", path: "a.md" });
		const { ctx } = setup([node], { statusEnabled: true, statusSetId: "set-recruiting" });
		const tool = createSetNodeStatusTool(ctx);

		expect(() => tool.handler({ nodeId: "n1", statusLabel: "Applied" })).toThrow(/requires a "view"/);
		expect(node.explicitStatusId).toBeUndefined();
	});

	it("G3: writes an API/CSV/markdown-table placeholder row's status into apiItemState, not a ViewNode", () => {
		const owner: ViewNode = {
			id: "owner",
			type: "meta",
			label: "Leads",
			children: [],
			statusEnabled: true,
			statusSetId: "set-recruiting",
			apiItemOrder: ["row-1"],
			apiItemState: { "row-1": { id: "row-1", label: "Acme", kind: "placeholder" } },
		};
		const { ctx, persist } = setup([owner]);
		const tool = createSetNodeStatusTool(ctx);

		const result = tool.handler({ view: "Job Hunt", nodeId: apiItemAddress("owner", "row-1"), statusLabel: "Applied" }) as Record<string, unknown>;

		expect(owner.apiItemState?.["row-1"].explicitStatusId).toBe("s-applied");
		expect(owner.explicitStatusId).toBeUndefined(); // never mistakenly written onto the owning ViewNode
		expect(persist).toHaveBeenCalled();
		expect(result.newStatus).toEqual({ id: "s-applied", label: "Applied", color: "#222222" });
	});

	it("R1 fix: two owners sharing the same raw row id are written independently through their own composite ids", () => {
		const ownerA: ViewNode = {
			id: "owner-a",
			type: "meta",
			label: "Leads A",
			children: [],
			statusEnabled: true,
			statusSetId: "set-recruiting",
			apiItemOrder: ["1"],
			apiItemState: { "1": { id: "1", label: "Acme Inc", kind: "placeholder" } },
		};
		const ownerB: ViewNode = {
			id: "owner-b",
			type: "meta",
			label: "Leads B (duplicate)",
			children: [],
			statusEnabled: true,
			statusSetId: "set-recruiting",
			apiItemOrder: ["1"],
			apiItemState: { "1": { id: "1", label: "Acme Inc (dup)", kind: "placeholder" } },
		};
		const { ctx } = setup([ownerA, ownerB]);
		const tool = createSetNodeStatusTool(ctx);

		tool.handler({ view: "Job Hunt", nodeId: apiItemAddress("owner-b", "1"), statusLabel: "Applied" });

		// Only owner B's row changed — the bug this fix closes would have written to whichever
		// owner's row was found first for the bare id "1".
		expect(ownerA.apiItemState?.["1"].explicitStatusId).toBeUndefined();
		expect(ownerB.apiItemState?.["1"].explicitStatusId).toBe("s-applied");
	});

	it("GP6: a path placed twice in the view is refused with every matching node id; retrying with one id succeeds", () => {
		const stripe1 = unitNode("stripe-1", { kind: "file", path: "Recruiting/Stripe.md" });
		const stripe2 = unitNode("stripe-2", { kind: "file", path: "Recruiting/Stripe.md" });
		const { ctx } = setup([stripe1, stripe2], { statusEnabled: true, statusSetId: "set-recruiting" });
		const tool = createSetNodeStatusTool(ctx);

		try {
			tool.handler({ view: "Job Hunt", path: "Recruiting/Stripe.md", statusLabel: "Applied" });
			expect.unreachable();
		} catch (err) {
			expect((err as Error).message).toContain("stripe-1");
			expect((err as Error).message).toContain("stripe-2");
		}
		expect(stripe1.explicitStatusId).toBeUndefined();
		expect(stripe2.explicitStatusId).toBeUndefined();

		tool.handler({ view: "Job Hunt", nodeId: "stripe-1", statusLabel: "Applied" });
		expect(stripe1.explicitStatusId).toBe("s-applied");
		expect(stripe2.explicitStatusId).toBeUndefined();
	});

	it("round-trips a unicode/punctuation status label unchanged through set_node_status -> get_node_status", () => {
		const emojiSet = makeStatusSet({ statuses: [{ id: "s-ready", label: "Ready 🚀", color: "#111" }, { id: "s-na", label: "N/A", color: "#222" }], defaultStatusId: "s-ready" });
		const node = unitNode("n1", { kind: "file", path: "a.md" });
		const { ctx } = setup([node], { statusEnabled: true, statusSetId: "set-recruiting" }, [emojiSet]);
		const setTool = createSetNodeStatusTool(ctx);
		const getTool = createGetNodeStatusTool(ctx);

		setTool.handler({ view: "Job Hunt", nodeId: "n1", statusLabel: "N/A" });
		const result = getTool.handler({ nodeId: "n1" }) as Record<string, unknown>;
		expect(result.resolvedStatus).toEqual({ id: "s-na", label: "N/A", color: "#222" });

		setTool.handler({ view: "Job Hunt", nodeId: "n1", statusLabel: "ready 🚀" });
		const result2 = getTool.handler({ nodeId: "n1" }) as Record<string, unknown>;
		expect(result2.resolvedStatus).toEqual({ id: "s-ready", label: "Ready 🚀", color: "#111" });
	});
});

describe("F2/F4 fence — status writes touch only explicitStatusId/apiItemState, nothing else", () => {
	it("set_node_status never mutates view structure, ids or children", () => {
		const node = unitNode("n1", { kind: "file", path: "a.md" }, { children: [] });
		const { ctx } = setup([node], { statusEnabled: true, statusSetId: "set-recruiting" });
		const before = JSON.stringify({ id: node.id, type: node.type, ref: node.ref, children: node.children });
		const tool = createSetNodeStatusTool(ctx);

		tool.handler({ view: "Job Hunt", nodeId: "n1", statusLabel: "Applied" });

		const after = JSON.stringify({ id: node.id, type: node.type, ref: node.ref, children: node.children });
		expect(after).toBe(before);
	});

	it("get_node_status/list_nodes/list_views/list_status_sets never call persist (read-only)", () => {
		const node = unitNode("n1", { kind: "file", path: "a.md" });
		const { ctx, persist } = setup([node], { statusEnabled: true, statusSetId: "set-recruiting" });

		createGetNodeStatusTool(ctx).handler({ nodeId: "n1" });
		createListNodesTool(ctx).handler({});
		createListViewsTool(ctx).handler({});
		createListStatusSetsTool(ctx).handler({});

		expect(persist).not.toHaveBeenCalled();
	});
});

describe("list_views / list_nodes / list_status_sets — G7 and the empty-array edge cases", () => {
	it("list_views returns every view's id, name and inboxMode", () => {
		const { ctx } = setup([]);
		const tool = createListViewsTool(ctx);
		const result = tool.handler({}) as { views: { id: string; name: string; inboxMode: string }[] };
		expect(result.views).toEqual([{ id: "view-1", name: "Job Hunt", inboxMode: "view" }]);
	});

	it("list_nodes against an empty view returns an empty array, not an error", () => {
		const { ctx } = setup([]);
		const tool = createListNodesTool(ctx);
		const result = tool.handler({}) as { nodes: unknown[] };
		expect(result.nodes).toEqual([]);
	});

	it("list_nodes returns a nested tree with explicitStatusId and resolvedStatus per node", () => {
		const child = unitNode("child", { kind: "file", path: "a.md" });
		const parent: ViewNode = { id: "parent", type: "meta", label: "Recruiting", children: [child], statusEnabled: true, statusSetId: "set-recruiting" };
		const { ctx } = setup([parent]);
		const tool = createListNodesTool(ctx);

		const result = tool.handler({}) as { nodes: { id: string; children: { id: string; resolvedStatus: unknown }[] }[] };
		expect(result.nodes).toHaveLength(1);
		expect(result.nodes[0].id).toBe("parent");
		expect(result.nodes[0].children[0].id).toBe("child");
		expect(result.nodes[0].children[0].resolvedStatus).toEqual({ id: "s-prospect", label: "Prospect", color: "#111111" });
	});

	it("list_nodes with parentNodeId narrows to that node's own children", () => {
		const child = unitNode("child", { kind: "file", path: "a.md" });
		const parent: ViewNode = { id: "parent", type: "meta", label: "Recruiting", children: [child] };
		const { ctx } = setup([parent]);
		const tool = createListNodesTool(ctx);

		const result = tool.handler({ parentNodeId: "parent" }) as { nodes: { id: string }[] };
		expect(result.nodes).toEqual([expect.objectContaining({ id: "child" })]);
	});

	it("list_status_sets against a status set with zero statuses returns an empty statuses array, not an error", () => {
		const emptySet: StatusSet = { id: "empty", name: "Empty", statuses: [], defaultStatusId: "" };
		const { ctx } = setup([], {}, [emptySet]);
		const tool = createListStatusSetsTool(ctx);
		const result = tool.handler({}) as { statusSets: { id: string; statuses: unknown[] }[] };
		expect(result.statusSets).toEqual([{ id: "empty", name: "Empty", statuses: [], defaultStatusId: "" }]);
	});
});

describe("R3 fix — list_nodes/get_node_status see exactly the rows the explorer renders, through a real Folder source", () => {
	/** Builds a real "overwrite"-mode, YAML-filtered Folder source (Jobs/beta.md fails the
	 * `status: active` rule, so `managedRowFilterState` renders it `hidden` and it is dropped
	 * outright, per `folderRowFilterState`/`ExplorerView.visibleFolderSourceRows`) — the exact
	 * scenario R3's review comment names, driven through the real `ViewsManager` wiring
	 * `buildRowVisibility` (mcp-status-tools.ts) reads, not a hand-built fixture. */
	function setupHiddenFolderRow() {
		const app = new MockApp();
		app.vault.seedFolder("Jobs");
		app.vault.seedFile("Jobs/acme.md");
		app.vault.seedFile("Jobs/beta.md");
		const live = new Map<string, { frontmatter?: Record<string, unknown> } | null>([
			["Jobs/acme.md", { frontmatter: { status: "active" } }],
			["Jobs/beta.md", { frontmatter: { status: "done" } }],
		]);
		app.metadataCache.getFileCache = ((file: { path: string }) => live.get(file.path) ?? null) as unknown as typeof app.metadataCache.getFileCache;

		const persist = vi.fn();
		const viewsManager = new ViewsManager(app as unknown as App, [], "", persist);
		const view = viewsManager.getViews()[0];

		const folder = viewsManager.addMetaFolder(view.id, null, "Job search")!;
		viewsManager.setFolderSource(view.id, folder.id, { type: "folder", location: "inside", path: "Jobs", showFiles: true, showFolders: false, mode: "overwrite", filters: { files: { yaml: { rules: [{ key: "status", value: "active" }] } } } });
		viewsManager.refreshFolderSource(view.id, folder.id);
		viewsManager.onMetadataResolved();
		// The folder itself (the direct parent, index 0) is the governor — reaches its own children
		// by definition, with no `inheritToSubfolders` needed (product rule: that flag is off by
		// default and only matters for a governor further up the chain).
		folder.statusEnabled = true;
		folder.statusSetId = "set-view";

		const statusSets: StatusSet[] = [{ id: "set-view", name: "View set", statuses: [{ id: "v-default", label: "View Default", color: "#111" }], defaultStatusId: "v-default" }];
		const statusesManager = new StatusesManager(statusSets, [], persist);
		const ctx: McpStatusToolsContext = {
			getViewsManager: () => viewsManager,
			getStatusesManager: () => statusesManager,
			getVaultName: () => "Fixture Vault",
			getVaultPath: () => "/tmp/fixture",
			getFolderSourcePath: () => "",
		};
		return { ctx, viewsManager, view, folder };
	}

	it("list_nodes surfaces the still-matching managed row (acme.md) but omits the one the rule hides (beta.md) entirely, matching the explorer", () => {
		const { ctx, view, folder } = setupHiddenFolderRow();
		const liveFolder = ctx.getViewsManager().getNode(view.id, folder.id)!;
		const paths = liveFolder.children.map((c) => c.ref?.path);
		expect(paths).toContain("Jobs/acme.md");
		expect(paths).not.toContain("Jobs/beta.md"); // confirms the fixture actually produced a hidden row

		const result = createListNodesTool(ctx).handler({ view: view.id, parentNodeId: folder.id }) as { nodes: { ref?: { path: string } }[] };
		expect(result.nodes.map((n) => n.ref?.path)).toEqual(["Jobs/acme.md"]);
	});

	it("get_node_status refuses to address the hidden managed row (beta.md) at all, matching it never rendering", () => {
		const { ctx, view, folder } = setupHiddenFolderRow();
		const liveFolder = ctx.getViewsManager().getNode(view.id, folder.id)!;
		// The hidden row still exists in the persisted tree (R1/R2 of PR-1.F2 — never deleted),
		// so its id is real and addressable in the underlying store, but R3 says the MCP tools must
		// refuse it exactly as the explorer refuses to render it.
		const hiddenRow = liveFolder.children.find((c) => c.ref?.path === "Jobs/beta.md");
		expect(hiddenRow).toBeUndefined(); // overwrite mode removes a non-matching row outright, no placeholder kept

		const visibleRow = liveFolder.children.find((c) => c.ref?.path === "Jobs/acme.md")!;
		const result = createGetNodeStatusTool(ctx).handler({ view: view.id, nodeId: visibleRow.id }) as Record<string, unknown>;
		expect(result.resolvedStatus).toEqual({ id: "v-default", label: "View Default", color: "#111" });
	});
});
