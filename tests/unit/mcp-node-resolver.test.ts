import { describe, expect, it } from "vitest";
import { View, ViewNode } from "../../src/types";
import {
	McpAmbiguousPathError,
	McpNodeNotFoundError,
	describeMcpTarget,
	extractMcpAddress,
	pseudoNodeForApiItem,
	pseudoNodeForTarget,
	resolveMcpAddress,
} from "../../src/mcp-node-resolver";

/**
 * PR-2.F1: `resolveMcpAddress`/`extractMcpAddress` are the one shared addressing rule every status
 * tool (`get_node_status`/`set_node_status`/`list_nodes`'s `parentNodeId`) uses — node-id lookup,
 * unique-path lookup across file/folder/block `UnitRef`s, ambiguous-path refusal (G7/E6), unknown
 * id/path (E3). Built entirely from hand-made `View`/`ViewNode` fixtures, no real `App`.
 */

function makeView(root: ViewNode[], overrides: Partial<View> = {}): View {
	return { id: "view-1", name: "Job Hunt", inboxMode: "view", root, ...overrides };
}

function unitNode(id: string, ref: ViewNode["ref"], children: ViewNode[] = []): ViewNode {
	return { id, type: "unit", ref, children };
}

describe("resolveMcpAddress — node-id lookup", () => {
	it("finds a top-level unit node by id, with the view itself as its nearest ancestor", () => {
		const node = unitNode("n1", { kind: "file", path: "Recruiting/Datadog.md" });
		const view = makeView([node]);

		const target = resolveMcpAddress(view, view.name, { nodeId: "n1" });

		expect(target.kind).toBe("node");
		expect(target.id).toBe("n1");
		expect(target.ancestors[0]).toBe(view);
	});

	it("finds a nested unit node by id, with its real parent as the nearest ancestor (not the view)", () => {
		const child = unitNode("child", { kind: "file", path: "Recruiting/Datadog.md" });
		const parent: ViewNode = { id: "parent", type: "meta", label: "Recruiting", children: [child] };
		const view = makeView([parent]);

		const target = resolveMcpAddress(view, view.name, { nodeId: "child" });

		expect(target.kind).toBe("node");
		expect(target.ancestors[0]).toBe(parent);
		expect(target.ancestors[1]).toBe(view);
	});

	it("finds a meta (folder) node by id", () => {
		const meta: ViewNode = { id: "meta-1", type: "meta", label: "Recruiting", children: [] };
		const view = makeView([meta]);

		const target = resolveMcpAddress(view, view.name, { nodeId: "meta-1" });
		expect(target.kind).toBe("node");
		if (target.kind === "node") expect(target.node.type).toBe("meta");
	});

	it("finds an API/CSV/markdown-table placeholder row by its own item id, never a real ViewNode", () => {
		const owner: ViewNode = {
			id: "owner",
			type: "meta",
			label: "Leads",
			children: [],
			apiItemOrder: ["row-1"],
			apiItemState: { "row-1": { id: "row-1", label: "Acme Inc", kind: "placeholder" } },
		};
		const view = makeView([owner]);

		const target = resolveMcpAddress(view, view.name, { nodeId: "row-1" });

		expect(target.kind).toBe("api-item");
		if (target.kind === "api-item") {
			expect(target.item.label).toBe("Acme Inc");
			expect(target.owner).toBe(owner);
			// G8: the placeholder row's ancestors are the same chain its owner's real children get —
			// the owner itself is the nearest governor, not the view.
			expect(target.ancestors[0]).toBe(owner);
		}
	});

	it("E3: an unknown node id is refused with a descriptive error naming the view searched", () => {
		const view = makeView([unitNode("n1", { kind: "file", path: "a.md" })]);
		expect(() => resolveMcpAddress(view, view.name, { nodeId: "nope" })).toThrow(McpNodeNotFoundError);
		try {
			resolveMcpAddress(view, view.name, { nodeId: "nope" });
			expect.unreachable();
		} catch (err) {
			expect((err as Error).message).toContain("nope");
			expect((err as Error).message).toContain("Job Hunt");
		}
	});
});

describe("resolveMcpAddress — unique-path lookup across file/folder/block UnitRefs", () => {
	it("resolves a unique file path", () => {
		const node = unitNode("n1", { kind: "file", path: "Recruiting/Datadog.md" });
		const view = makeView([node]);
		const target = resolveMcpAddress(view, view.name, { path: "Recruiting/Datadog.md" });
		expect(target.id).toBe("n1");
	});

	it("resolves a unique folder path", () => {
		const node = unitNode("n1", { kind: "folder", path: "Recruiting" });
		const view = makeView([node]);
		const target = resolveMcpAddress(view, view.name, { path: "Recruiting" });
		expect(target.id).toBe("n1");
	});

	it("resolves a unique block path as path#subpath", () => {
		const node = unitNode("n1", { kind: "block", path: "Notes/Idea.md", subpath: "^abc123" });
		const view = makeView([node]);
		const target = resolveMcpAddress(view, view.name, { path: "Notes/Idea.md#^abc123" });
		expect(target.id).toBe("n1");
	});

	it("a path that happens to equal a file's path never matches a block ref pointing into a different subpath", () => {
		const node = unitNode("n1", { kind: "block", path: "Notes/Idea.md", subpath: "^abc123" });
		const view = makeView([node]);
		expect(() => resolveMcpAddress(view, view.name, { path: "Notes/Idea.md" })).toThrow(McpNodeNotFoundError);
	});

	it("E6: a path matching more than one node anywhere in the view is refused, listing every match's node id", () => {
		const first = unitNode("stripe-1", { kind: "file", path: "Recruiting/Stripe.md" });
		const second = unitNode("stripe-2", { kind: "file", path: "Recruiting/Stripe.md" });
		const view = makeView([first, second]);

		expect(() => resolveMcpAddress(view, view.name, { path: "Recruiting/Stripe.md" })).toThrow(McpAmbiguousPathError);
		try {
			resolveMcpAddress(view, view.name, { path: "Recruiting/Stripe.md" });
			expect.unreachable();
		} catch (err) {
			const ambiguous = err as InstanceType<typeof McpAmbiguousPathError>;
			expect(ambiguous.matches).toHaveLength(2);
			expect(ambiguous.matches.map((m) => m.id).sort()).toEqual(["stripe-1", "stripe-2"]);
			expect(ambiguous.message).toContain("stripe-1");
			expect(ambiguous.message).toContain("stripe-2");
			expect(ambiguous.message).toContain("Job Hunt");
		}
	});

	it("E6 across nested placements too: a duplicated unit nested at different depths is still refused", () => {
		const leafA = unitNode("stripe-a", { kind: "file", path: "Recruiting/Stripe.md" });
		const leafB = unitNode("stripe-b", { kind: "file", path: "Recruiting/Stripe.md" });
		const folder: ViewNode = { id: "folder", type: "meta", label: "Recruiting", children: [leafB] };
		const view = makeView([leafA, folder]);

		expect(() => resolveMcpAddress(view, view.name, { path: "Recruiting/Stripe.md" })).toThrow(McpAmbiguousPathError);
	});

	it("E3: a path with zero matches in the view is refused with a descriptive error naming the view searched", () => {
		const view = makeView([unitNode("n1", { kind: "file", path: "a.md" })]);
		try {
			resolveMcpAddress(view, view.name, { path: "nowhere.md" });
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(McpNodeNotFoundError);
			expect((err as Error).message).toContain("nowhere.md");
			expect((err as Error).message).toContain("Job Hunt");
		}
	});
});

describe("extractMcpAddress — exactly one of nodeId/path", () => {
	it("accepts nodeId alone", () => {
		expect(extractMcpAddress({ nodeId: "abc" })).toEqual({ nodeId: "abc" });
	});
	it("accepts path alone", () => {
		expect(extractMcpAddress({ path: "a.md" })).toEqual({ path: "a.md" });
	});
	it("refuses when neither is given", () => {
		expect(() => extractMcpAddress({})).toThrow(/nodeId.*path/i);
	});
	it("refuses when both are given", () => {
		expect(() => extractMcpAddress({ nodeId: "abc", path: "a.md" })).toThrow(/not both/i);
	});
	it("ignores a blank string as if it were absent", () => {
		expect(() => extractMcpAddress({ nodeId: "" })).toThrow();
		expect(extractMcpAddress({ nodeId: "", path: "a.md" })).toEqual({ path: "a.md" });
	});
});

describe("pseudoNodeForApiItem / pseudoNodeForTarget", () => {
	it("builds a throwaway unit-typed pseudo-node carrying the item's own explicitStatusId", () => {
		const pseudo = pseudoNodeForApiItem({ id: "row-1", label: "Acme", kind: "placeholder", explicitStatusId: "s-applied" });
		expect(pseudo).toEqual({ id: "row-1", type: "unit", children: [], explicitStatusId: "s-applied" });
	});

	it("pseudoNodeForTarget returns the real node unchanged for a 'node' target", () => {
		const node = unitNode("n1", { kind: "file", path: "a.md" });
		const view = makeView([node]);
		const target = resolveMcpAddress(view, view.name, { nodeId: "n1" });
		expect(pseudoNodeForTarget(target)).toBe(node);
	});
});

describe("describeMcpTarget — ancestry breadcrumb for ambiguity errors", () => {
	it("includes the view name and every ancestor label/path down to the node itself", () => {
		const child = unitNode("child", { kind: "file", path: "Recruiting/Datadog.md" });
		const parent: ViewNode = { id: "parent", type: "meta", label: "Recruiting", children: [child] };
		const view = makeView([parent]);
		const target = resolveMcpAddress(view, view.name, { nodeId: "child" });

		const description = describeMcpTarget(target);
		expect(description).toContain("Job Hunt");
		expect(description).toContain("Recruiting");
		expect(description).toContain("Recruiting/Datadog.md");
	});
});
