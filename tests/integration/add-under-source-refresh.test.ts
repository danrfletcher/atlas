import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { App as MockApp } from "../mocks/obsidian";
import { ViewsManager } from "../../src/views";
import { ViewNode } from "../../src/types";

/** PR-2.F1's "known risk" (decided by code reading, pinned here by actually driving the real
 * reconcile/delete paths): a source refresh must never drop a manual child nested under a child of
 * an Inside-Vault Folder source, since that's exactly the shape "Add under…" (once PR-2.F2/PR-3.F1-F3
 * wire it up) will create. `reconcileManagedChildren` keeps every existing managed child with its own
 * `children` array untouched regardless of what the folder's current listing says, and
 * `demoteManagedMatches` (run from `onVaultDelete`) splices a removed managed row out in favour of its
 * own children rather than dropping them. */

function findNode(nodes: ViewNode[], predicate: (n: ViewNode) => boolean): ViewNode | null {
	for (const node of nodes) {
		if (predicate(node)) return node;
		const found = findNode(node.children, predicate);
		if (found) return found;
	}
	return null;
}

function setup() {
	const app = new MockApp();
	app.vault.seedFolder("Projects");
	app.vault.seedFile("Projects/a.md");
	app.vault.seedFile("Projects/b.md");

	const vm = new ViewsManager(app as unknown as App, [], "", () => {});
	const view = vm.getViews()[0];
	const owner = vm.addMetaFolder(view.id, null, "Folder source")!;
	vm.setFolderSource(view.id, owner.id, { location: "inside", path: "Projects", showFiles: true, showFolders: true });
	vm.refreshFolderSource(view.id, owner.id);

	const managedA = findNode(vm.getViews()[0].root, (n) => n.folderSourceManaged === true && n.ref?.path === "Projects/a.md")!;
	expect(managedA, "managed row for Projects/a.md").toBeTruthy();
	return { app, vm, view, owner, managedAId: managedA.id };
}

describe("PR-2.F1 known risk — a source refresh keeps a manual child added under a child of an Inside-Vault Folder source", () => {
	it("placeUnit and addMetaFolder children nested under a managed row survive a refresh with a file added and a refresh with a file removed", () => {
		const { app, vm, view, managedAId } = setup();

		// Two manual children, nested under the managed row exactly as "Add under…" (once wired up)
		// would create them: a plain unit (placeUnit) and a meta folder (addMetaFolder).
		vm.placeUnit(view.id, { kind: "file", path: "Manual.md" }, managedAId);
		const manualFolder = vm.addMetaFolder(view.id, managedAId, "Manual folder")!;

		const managedANode = () => findNode(vm.getViews()[0].root, (n) => n.id === managedAId)!;
		expect(managedANode().children.map((c) => c.id).sort()).toEqual(
			[manualFolder.id, managedANode().children.find((c) => c.ref?.path === "Manual.md")!.id].sort()
		);

		// Refresh #1: a file is added to the folder.
		app.vault.seedFile("Projects/c.md");
		vm.refreshFolderSource(view.id, vm.getViews()[0].root.find((n) => n.folderSource)!.id);
		expect(managedANode().children).toHaveLength(2);
		expect(managedANode().children.some((c) => c.id === manualFolder.id)).toBe(true);
		expect(managedANode().children.some((c) => c.ref?.path === "Manual.md")).toBe(true);

		// Refresh #2: a (different) file is removed from the folder.
		const b = app.vault.getAbstractFileByPath("Projects/b.md")!;
		void app.vault.delete(b as never);
		vm.refreshFolderSource(view.id, vm.getViews()[0].root.find((n) => n.folderSource)!.id);
		expect(managedANode().children).toHaveLength(2);
		expect(managedANode().children.some((c) => c.id === manualFolder.id)).toBe(true);
		expect(managedANode().children.some((c) => c.ref?.path === "Manual.md")).toBe(true);
	});

	it("deleting the managed row's own file lifts its children instead of dropping them", () => {
		const { app, vm, view, managedAId } = setup();
		vm.placeUnit(view.id, { kind: "file", path: "Manual.md" }, managedAId);
		const manualFolder = vm.addMetaFolder(view.id, managedAId, "Manual folder")!;

		const a = app.vault.getAbstractFileByPath("Projects/a.md")!;
		void app.vault.delete(a as never);
		vm.onVaultDelete("Projects/a.md");

		const root = vm.getViews()[0].root;
		expect(findNode(root, (n) => n.id === managedAId), "the managed row itself is gone, not left behind").toBeNull();

		const owner = root.find((n) => n.folderSource)!;
		const liftedIds = owner.children.map((c) => c.id);
		expect(liftedIds).toContain(manualFolder.id);
		expect(owner.children.some((c) => c.ref?.path === "Manual.md")).toBe(true);
	});
});
