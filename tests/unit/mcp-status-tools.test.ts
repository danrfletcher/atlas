import type { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { View, ViewNode } from "../../src/types";
import { StatusSet, StatusesManager } from "../../src/statuses";
import { ViewsManager } from "../../src/views";
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

		const result = tool.handler({ nodeId: "row-1" }) as Record<string, unknown>;
		expect(result.explicitStatusId).toBe("s-applied");
		expect(result.resolvedStatus).toEqual({ id: "s-applied", label: "Applied", color: "#222222" });
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

		const result = tool.handler({ view: "Job Hunt", nodeId: "row-1", statusLabel: "Applied" }) as Record<string, unknown>;

		expect(owner.apiItemState?.["row-1"].explicitStatusId).toBe("s-applied");
		expect(owner.explicitStatusId).toBeUndefined(); // never mistakenly written onto the owning ViewNode
		expect(persist).toHaveBeenCalled();
		expect(result.newStatus).toEqual({ id: "s-applied", label: "Applied", color: "#222222" });
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
