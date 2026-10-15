import { describe, expect, it, vi } from "vitest";
import { View, ViewNode } from "../../src/types";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { makeFakeExplorer, makeStatusesManager, proto, view } from "./explorer-view-sort-truncate-helpers";

/** PR-1 (F2 R1): `subtreeHasMatch` must never count a match found only inside a row its own Folder
 * source's YAML rules currently hide — such a match is never visible to the user, so force-revealing
 * or un-truncating its ancestors for it would be surprising. Not yet pinned down by a test; calls the
 * real (unstubbed) `subtreeHasMatch` via the prototype, the same pattern `explorer-view.test.ts` uses
 * for `renderNode`. */

function unitNode(id: string): ViewNode {
	return { id, type: "unit", ref: { kind: "file", path: `${id}.md` }, children: [] };
}

function callSubtreeHasMatch(fake: unknown, nodes: ViewNode[], v: View): Promise<boolean> {
	const method = proto.subtreeHasMatch as unknown as (nodes: ViewNode[], v: View) => Promise<boolean>;
	return method.call(fake, nodes, v);
}

describe("subtreeHasMatch ignores a matching hidden managed row", () => {
	it("a hidden row's match never counts, and its text is never even resolved", async () => {
		const sm = makeStatusesManager();
		const hidden = unitNode("hidden");
		const resolveRef = vi.fn(async (ref: { path: string }) => ({
			text: ref.path === "hidden.md" ? "match" : "nope",
			icon: "",
			promoted: false,
			added: false,
			missing: false,
		}));
		const managedRowFilterState = vi.fn(() => "hidden");
		const fake = makeFakeExplorer(sm, {
			filterText: "match",
			resolveRef,
			plugin: { statusesManager: sm, settings: DEFAULT_SETTINGS, viewsManager: { setApiItemStatus: vi.fn(), managedRowFilterState } },
		});

		const result = await callSubtreeHasMatch(fake, [hidden], view);

		expect(result).toBe(false);
		expect(resolveRef).not.toHaveBeenCalled();
	});

	it("a sibling row that matches still force-reveals the subtree, even with a hidden row present", async () => {
		const sm = makeStatusesManager();
		const hidden = unitNode("hidden");
		const visible = unitNode("visible");
		const resolveRef = vi.fn(async (ref: { path: string }) => ({
			text: ref.path === "visible.md" ? "match" : "nope",
			icon: "",
			promoted: false,
			added: false,
			missing: false,
		}));
		const managedRowFilterState = vi.fn((_viewId: string, node: ViewNode) => (node.id === "hidden" ? "hidden" : "shown"));
		const fake = makeFakeExplorer(sm, {
			filterText: "match",
			resolveRef,
			plugin: { statusesManager: sm, settings: DEFAULT_SETTINGS, viewsManager: { setApiItemStatus: vi.fn(), managedRowFilterState } },
		});

		const result = await callSubtreeHasMatch(fake, [hidden, visible], view);

		expect(result).toBe(true);
	});

	it("a non-hidden, non-matching row with a hidden-but-matching child still misses, because the child's match never counts", async () => {
		const sm = makeStatusesManager();
		const hiddenChild = unitNode("hidden-child");
		const parent: ViewNode = { id: "parent", type: "unit", ref: { kind: "file", path: "parent.md" }, children: [hiddenChild] };
		const resolveRef = vi.fn(async (ref: { path: string }) => ({
			text: ref.path === "hidden-child.md" ? "match" : "nope",
			icon: "",
			promoted: false,
			added: false,
			missing: false,
		}));
		const managedRowFilterState = vi.fn((_viewId: string, node: ViewNode) => (node.id === "hidden-child" ? "hidden" : "shown"));
		const fake = makeFakeExplorer(sm, {
			filterText: "match",
			resolveRef,
			plugin: { statusesManager: sm, settings: DEFAULT_SETTINGS, viewsManager: { setApiItemStatus: vi.fn(), managedRowFilterState } },
		});

		const result = await callSubtreeHasMatch(fake, [parent], view);

		expect(result).toBe(false);
	});
});
