import type { App } from "obsidian";
import { describe, expect, it } from "vitest";
import { ViewsManager } from "../../src/views";
import { UnitRef, View, ViewNode } from "../../src/types";
import { callRenderNodeList, folderGovernor, makeFakeExplorer, makeStatusesManager, rowOrder } from "../unit/explorer-view-sort-truncate-helpers";

/** G7/G9: Inside-Vault Folder-source children (`folderSourceManaged: true`) are ordinary real
 * `ViewNode` units — place/nest/reorder, status assign, sort/truncate, and remove-from-view must
 * behave identically for them as for any other real unit, because nothing in `ViewsManager` or
 * `AtlasExplorerView`'s rendering special-cases the flag; it exists only so a later
 * `buildFolderSourceChildren` reconcile can tell its own rows apart (see `folder-source.test.ts`). */

function makeViewsManager() {
	return new ViewsManager({} as App, [], "", () => {});
}

const KINDS: { label: string; managed: boolean }[] = [
	{ label: "ordinary unit", managed: false },
	{ label: "Folder-source-managed unit", managed: true },
];

describe.each(KINDS)("G7 — place/nest/reorder behave identically for $label", ({ managed }) => {
	function place(vm: ViewsManager, viewId: string, ref: UnitRef, parentId: string | null) {
		vm.placeUnit(viewId, ref, parentId);
		if (managed) {
			const view = vm.getViews().find((v) => v.id === viewId)!;
			const found = findByRef(view.root, ref);
			if (found) found.folderSourceManaged = true;
		}
	}

	it("reorders a sibling by index", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		place(vm, view.id, { kind: "file", path: "a.md" }, null);
		place(vm, view.id, { kind: "file", path: "b.md" }, null);
		const nodeA = vm.getViews()[0].root[0];

		expect(vm.moveNode(view.id, nodeA.id, null, 1)).toBe(true);

		const order = vm.getViews()[0].root.map((n) => n.ref?.path);
		expect(order).toEqual(["b.md", "a.md"]);
	});

	it("nests one unit inside another via drop", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		place(vm, view.id, { kind: "file", path: "parent.md" }, null);
		place(vm, view.id, { kind: "file", path: "child.md" }, null);
		const parent = vm.getViews()[0].root[0];
		const child = vm.getViews()[0].root[1];

		expect(vm.moveNode(view.id, child.id, parent.id, 0)).toBe(true);

		const result = vm.getViews()[0];
		expect(result.root).toHaveLength(1);
		expect(result.root[0].children).toHaveLength(1);
		expect(result.root[0].children[0].ref).toEqual({ kind: "file", path: "child.md" });
	});

	it("refuses nesting a node into its own descendant, same as any other unit", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		place(vm, view.id, { kind: "file", path: "parent.md" }, null);
		const parent = vm.getViews()[0].root[0];
		place(vm, view.id, { kind: "file", path: "child.md" }, parent.id);
		const child = vm.getNode(view.id, parent.id)!.children[0];

		expect(vm.moveNode(view.id, parent.id, child.id, 0)).toBe(false);
	});
});

describe.each(KINDS)("G9 — status assign/sort/truncate behave identically for $label", ({ managed }) => {
	it("setExplicitStatus assigns a status to the node regardless of managed flag", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		vm.placeUnit(view.id, { kind: "file", path: "a.md" }, null);
		const node = vm.getViews()[0].root[0];
		if (managed) node.folderSourceManaged = true;

		vm.setExplicitStatus(view.id, node.id, "done");

		expect(vm.getNode(view.id, node.id)!.explicitStatusId).toBe("done");
	});

	it("sorts by status and groups into a truncation header identically to a plain real unit", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "status", truncatedStatuses: { todo: { enabled: true } } });
		const todo1: ViewNode = { id: "n1", type: "unit", ref: { kind: "file", path: "a.md" }, children: [], explicitStatusId: "todo", folderSourceManaged: managed };
		const todo2: ViewNode = { id: "n2", type: "unit", ref: { kind: "file", path: "b.md" }, children: [], explicitStatusId: "todo", folderSourceManaged: managed };
		const done: ViewNode = { id: "n3", type: "unit", ref: { kind: "file", path: "c.md" }, children: [], explicitStatusId: "done", folderSourceManaged: managed };

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		const view: View = { id: "v1", name: "Default", inboxMode: "view", root: [] };
		await callRenderNodeList(fake, [done, todo1, todo2], container, view, 1, [folder], folder);

		// Two matching 'todo' rows group into one truncation header (ranked first by status order);
		// 'done' is its own single row — identical outcome whether or not these are managed children.
		expect(rowOrder(container)).toEqual(["group:node:folder:todo", "n3"]);
	});
});

describe.each(KINDS)("remove-from-view lifts children up one level identically for $label", ({ managed }) => {
	it("unplaceNode removes just this node, promoting its own children into its place", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		vm.placeUnit(view.id, { kind: "folder", path: "Parent" }, null);
		const parent = vm.getViews()[0].root[0];
		if (managed) parent.folderSourceManaged = true;
		vm.placeUnit(view.id, { kind: "file", path: "Parent/child.md" }, parent.id);

		vm.unplaceNode(view.id, parent.id);

		const result = vm.getViews()[0];
		expect(result.root).toHaveLength(1);
		expect(result.root[0].ref).toEqual({ kind: "file", path: "Parent/child.md" });
	});
});

describe("E2 — a file both inside a Folder source's target AND separately duplicated/placed elsewhere resolves via existing duplicate-node handling", () => {
	it("duplicateNode (PR 13's existing multi-placement mechanism) produces a second node for the same ref, both coexisting, neither silently dropped", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const ref: UnitRef = { kind: "file", path: "Shared.md" };

		// The Folder-source's own managed reconcile places this ref once...
		vm.placeUnit(view.id, ref, null);
		const managedNode = vm.getViews()[0].root[0];
		managedNode.folderSourceManaged = true;

		// ...and it is separately duplicated elsewhere in the tree — exactly the existing
		// multi-placement path this PR adds no new dedup logic for (no new code, per the spec's E2).
		const clone = vm.duplicateNode(view.id, managedNode.id)!;

		const result = vm.getViews()[0];
		expect(result.root).toHaveLength(2);
		expect(result.root[0].ref).toEqual(ref);
		expect(result.root[0].folderSourceManaged).toBe(true);
		// The clone is its own independent node, coexisting with the original — nothing drops either.
		expect(clone.ref).toEqual(ref);
		expect(clone.id).not.toBe(managedNode.id);
		expect(vm.isPlacedAnywhere(ref)).toBe(true);
	});
});

function findByRef(nodes: ViewNode[], ref: UnitRef): ViewNode | null {
	for (const node of nodes) {
		if (node.ref && node.ref.kind === ref.kind && node.ref.path === ref.path) return node;
		const found = findByRef(node.children, ref);
		if (found) return found;
	}
	return null;
}
