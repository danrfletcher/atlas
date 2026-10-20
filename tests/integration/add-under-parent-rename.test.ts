import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { App as MockApp } from "../mocks/obsidian";
import { ViewsManager } from "../../src/views";
import { ViewNode } from "../../src/types";

function findNode(nodes: ViewNode[], predicate: (n: ViewNode) => boolean): ViewNode | null {
	for (const node of nodes) {
		if (predicate(node)) return node;
		const found = findNode(node.children, predicate);
		if (found) return found;
	}
	return null;
}

/** E9: "Add under…" adds no ref-handling code of its own (this PR's seam is a no-op) — it only
 * relies on the parent/child nesting a future "Add under" choice would create surviving a vault
 * rename exactly as any other hand-nested child already does. Pins that existing behaviour so a
 * later PR that wires the seam up can trust it without re-deriving it. */
describe("PR-2.F1 E9 — a child nested under a parent keeps its place across a vault rename of the parent's file", () => {
	it("renaming the parent file rewrites the parent's own ref, keeps the child nested under the same node id, and persists", () => {
		const app = new MockApp();
		app.vault.seedFile("Parent.md");
		app.vault.seedFile("Child.md");

		const persist = vi.fn();
		const vm = new ViewsManager(app as unknown as App, [], "", persist);
		const view = vm.getViews()[0];

		vm.placeUnit(view.id, { kind: "file", path: "Parent.md" }, null);
		const parent = findNode(vm.getViews()[0].root, (n) => n.ref?.path === "Parent.md")!;
		vm.placeUnit(view.id, { kind: "file", path: "Child.md" }, parent.id);
		const child = findNode(vm.getViews()[0].root, (n) => n.ref?.path === "Child.md")!;

		persist.mockClear();
		vm.onVaultRename("Parent.md", "Renamed.md");

		const parentAfter = findNode(vm.getViews()[0].root, (n) => n.id === parent.id)!;
		expect(parentAfter.ref).toEqual({ kind: "file", path: "Renamed.md" });
		expect(parentAfter.children.map((c) => c.id)).toEqual([child.id]);
		expect(parentAfter.children[0].ref).toEqual({ kind: "file", path: "Child.md" });

		// "no save loss": the rename's rewrite was flushed through the same persist() the view relies
		// on for every other structural change, not dropped on the floor.
		expect(persist).toHaveBeenCalled();
	});
});
