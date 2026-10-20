import { describe, expect, it, vi } from "vitest";

/** PR-3: isolates `explorer-view.ts`'s wiring (which fields of `ApiSourceModalResult` it reads, what
 * it does with them) from the real modal's own rendering/validation, which already has full coverage
 * in `tests/unit/api-source-modal.test.ts`. */
vi.mock("../../src/api-source-modal", () => {
	class FakeApiSourceModal {
		static instances: FakeApiSourceModal[] = [];
		onSave: (result: unknown) => void;
		open = vi.fn();
		constructor(public app: unknown, public initial: unknown, public headers: unknown, onSave: (result: unknown) => void) {
			this.onSave = onSave;
			FakeApiSourceModal.instances.push(this);
		}
	}
	return { ApiSourceModal: FakeApiSourceModal };
});

import type { App } from "obsidian";
import { Menu } from "obsidian";
import { ApiSourceModal } from "../../src/api-source-modal";
import { AtlasExplorerView } from "../../src/explorer-view";
import { View, ViewNode } from "../../src/types";
import { ViewsManager } from "../../src/views";
import { meta } from "../integration/create-from-meta-fixtures";
import { App as MockApp } from "../mocks/obsidian";

const FakeApiSourceModal = ApiSourceModal as unknown as {
	instances: { app: unknown; initial: unknown; headers: unknown; open: () => void; onSave: (result: unknown) => void }[];
};

const view: View = { id: "v1", name: "Default", inboxMode: "view", root: [] };

function openApiSourceModal(node: ViewNode, plugin: Record<string, unknown>, refreshApiSource = vi.fn()) {
	(AtlasExplorerView.prototype as unknown as { openApiSourceModal: (...a: unknown[]) => void }).openApiSourceModal.call(
		{ plugin, refreshApiSource },
		view,
		node
	);
	return refreshApiSource;
}

describe("PR-3 — explorer-view.ts call sites keep working with the new ApiSourceModalResult.type field", () => {
	it("openApiSourceModal and context-menu entry point still invoke modal and handle onSave result", () => {
		FakeApiSourceModal.instances.length = 0;
		const node = meta("m", "Folder");

		// The "Data source…" context-menu item still delegates to openApiSourceModal(view, node), same
		// as before this PR — unchanged by adding `type` to the result.
		const openApiSourceModalSpy = vi.fn();
		let builtMenu: Menu | undefined;
		const show = vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
			builtMenu = this;
		});
		(AtlasExplorerView.prototype as unknown as { showMetaFolderMenu: (...a: unknown[]) => void }).showMetaFolderMenu.call(
			{
				plugin: { statusesManager: { findSortGovernor: () => null } },
				startCreateFromMeta: vi.fn(),
				openStatusesModal: vi.fn(),
				openApiSourceModal: openApiSourceModalSpy,
			},
			new MouseEvent("contextmenu"),
			node,
			view
		);
		show.mockRestore();

		const dataSourceItem = builtMenu!.items.find((item) => item.title === "Data source…");
		expect(dataSourceItem).toBeTruthy();
		dataSourceItem!.clickHandler!();
		expect(openApiSourceModalSpy).toHaveBeenCalledWith(view, node);

		// Directly exercise the real openApiSourceModal: it builds the modal with the node's existing
		// headers/apiSource and wires onSave to persist headers + source and trigger a manual refresh.
		const headers = [{ key: "X", value: "Y" }];
		const apiHeadersStore = { get: vi.fn(() => headers), set: vi.fn() };
		const viewsManager = { setApiSource: vi.fn() };
		const folderSourcePathStore = { get: vi.fn(() => ""), set: vi.fn(), delete: vi.fn() };
		const plugin = { app: {}, apiHeadersStore, viewsManager, folderSourcePathStore };
		const refreshApiSource = openApiSourceModal(node, plugin);

		expect(FakeApiSourceModal.instances).toHaveLength(1);
		const modal = FakeApiSourceModal.instances[0];
		expect(modal.app).toBe(plugin.app);
		expect(modal.initial).toBeNull();
		expect(modal.headers).toBe(headers);
		expect(apiHeadersStore.get).toHaveBeenCalledWith(node.id);

		// onSave now always receives a `type` field (PR-3) alongside the unchanged `source`/`headers` —
		// explorer-view.ts must keep working without reading or requiring that field.
		const newHeaders = [{ key: "A", value: "B" }];
		modal.onSave({ type: "api", source: { url: "https://api.example.com/items" }, headers: newHeaders });

		expect(apiHeadersStore.set).toHaveBeenCalledWith(node.id, newHeaders);
		expect(viewsManager.setApiSource).toHaveBeenCalledWith(view.id, node.id, { url: "https://api.example.com/items" });
		expect(refreshApiSource).toHaveBeenCalledWith(view, node, "manual");
	});
});

describe("R8 — switching API->CSV drops the API source's device-local headers, same as Remove data source", () => {
	it("deletes the ApiHeadersStore entry when a node that had a live apiSource is switched to csv", () => {
		FakeApiSourceModal.instances.length = 0;
		const node = meta("m", "Folder");
		node.apiSource = { url: "https://api.example.com/items", method: "GET", mapping: { idField: "id", labelField: "name" }, mode: "merge" };

		const apiHeadersStore = { get: vi.fn(() => []), set: vi.fn(), delete: vi.fn() };
		const viewsManager = { setCsvSource: vi.fn() };
		const folderSourcePathStore = { get: vi.fn(() => ""), set: vi.fn(), delete: vi.fn() };
		const plugin = { app: {}, apiHeadersStore, viewsManager, folderSourcePathStore };
		const refreshCsvSource = vi.fn();
		(AtlasExplorerView.prototype as unknown as { openApiSourceModal: (...a: unknown[]) => void }).openApiSourceModal.call(
			{ plugin, refreshCsvSource },
			view,
			node
		);

		const modal = FakeApiSourceModal.instances[0];
		const csvSource = { path: "data/items.csv", mapping: { idField: "id", labelField: "name" }, mode: "merge" as const };
		modal.onSave({ type: "csv", source: csvSource });

		expect(viewsManager.setCsvSource).toHaveBeenCalledWith(view.id, node.id, csvSource);
		expect(apiHeadersStore.delete).toHaveBeenCalledWith(node.id);
		expect(refreshCsvSource).toHaveBeenCalledWith(view, node, "manual");
	});

	it("does not touch ApiHeadersStore when switching to csv from a node that never had an apiSource", () => {
		FakeApiSourceModal.instances.length = 0;
		const node = meta("m2", "Folder");

		const apiHeadersStore = { get: vi.fn(() => []), set: vi.fn(), delete: vi.fn() };
		const viewsManager = { setCsvSource: vi.fn() };
		const folderSourcePathStore = { get: vi.fn(() => ""), set: vi.fn(), delete: vi.fn() };
		const plugin = { app: {}, apiHeadersStore, viewsManager, folderSourcePathStore };
		(AtlasExplorerView.prototype as unknown as { openApiSourceModal: (...a: unknown[]) => void }).openApiSourceModal.call(
			{ plugin, refreshCsvSource: vi.fn() },
			view,
			node
		);

		const modal = FakeApiSourceModal.instances[0];
		const csvSource = { path: "data/items.csv", mapping: { idField: "id", labelField: "name" }, mode: "merge" as const };
		modal.onSave({ type: "csv", source: csvSource });

		expect(apiHeadersStore.delete).not.toHaveBeenCalled();
	});
});

describe("PR-4 R3 — switching source types cleans up the other type's device-local state", () => {
	it("switching API->Folder drops the API source's device-local headers, same as switching to csv/markdown-table", () => {
		FakeApiSourceModal.instances.length = 0;
		const node = meta("m", "Folder");
		node.apiSource = { url: "https://api.example.com/items", method: "GET", mapping: { idField: "id", labelField: "name" }, mode: "merge" };

		const apiHeadersStore = { get: vi.fn(() => []), set: vi.fn(), delete: vi.fn() };
		const viewsManager = { setFolderSource: vi.fn() };
		const folderSourcePathStore = { get: vi.fn(() => ""), set: vi.fn(), delete: vi.fn() };
		const plugin = { app: {}, apiHeadersStore, viewsManager, folderSourcePathStore };
		const refreshFolderSource = vi.fn();
		(AtlasExplorerView.prototype as unknown as { openApiSourceModal: (...a: unknown[]) => void }).openApiSourceModal.call(
			{ plugin, refreshFolderSource },
			view,
			node
		);

		const modal = FakeApiSourceModal.instances[0];
		const folderSource = { location: "inside" as const, path: "Projects", showFiles: true, showFolders: true };
		modal.onSave({ type: "folder", source: folderSource, outsidePath: "" });

		expect(viewsManager.setFolderSource).toHaveBeenCalledWith(view.id, node.id, folderSource);
		expect(apiHeadersStore.delete).toHaveBeenCalledWith(node.id);
		expect(refreshFolderSource).toHaveBeenCalledWith(view, node);
	});

	it("does not touch ApiHeadersStore when switching to folder from a node that never had an apiSource", () => {
		FakeApiSourceModal.instances.length = 0;
		const node = meta("m2", "Folder");

		const apiHeadersStore = { get: vi.fn(() => []), set: vi.fn(), delete: vi.fn() };
		const viewsManager = { setFolderSource: vi.fn() };
		const folderSourcePathStore = { get: vi.fn(() => ""), set: vi.fn(), delete: vi.fn() };
		const plugin = { app: {}, apiHeadersStore, viewsManager, folderSourcePathStore };
		(AtlasExplorerView.prototype as unknown as { openApiSourceModal: (...a: unknown[]) => void }).openApiSourceModal.call(
			{ plugin, refreshFolderSource: vi.fn() },
			view,
			node
		);

		const modal = FakeApiSourceModal.instances[0];
		modal.onSave({ type: "folder", source: { location: "inside" as const, path: "Projects", showFiles: true, showFolders: true }, outsidePath: "" });

		expect(apiHeadersStore.delete).not.toHaveBeenCalled();
	});

	it("switching Folder(outside)->API drops the folder source's device-local outside path", () => {
		FakeApiSourceModal.instances.length = 0;
		const node = meta("m3", "Folder");
		node.folderSource = { location: "outside", path: "/abs/Notes", showFiles: true, showFolders: true };

		const apiHeadersStore = { get: vi.fn(() => []), set: vi.fn(), delete: vi.fn() };
		const viewsManager = { setApiSource: vi.fn() };
		const folderSourcePathStore = { get: vi.fn(() => "/abs/Notes"), set: vi.fn(), delete: vi.fn() };
		const plugin = { app: {}, apiHeadersStore, viewsManager, folderSourcePathStore };
		const refreshApiSource = openApiSourceModal(node, plugin);

		const modal = FakeApiSourceModal.instances[0];
		modal.onSave({ type: "api", source: { url: "https://api.example.com/items" }, headers: [] });

		expect(viewsManager.setApiSource).toHaveBeenCalledWith(view.id, node.id, { url: "https://api.example.com/items" });
		expect(folderSourcePathStore.delete).toHaveBeenCalledWith(node.id);
		expect(refreshApiSource).toHaveBeenCalledWith(view, node, "manual");
	});

	it("does not touch FolderSourcePathStore when switching to API from an Inside-Vault (not Outside) folder source", () => {
		FakeApiSourceModal.instances.length = 0;
		const node = meta("m4", "Folder");
		node.folderSource = { location: "inside", path: "Projects", showFiles: true, showFolders: true };

		const apiHeadersStore = { get: vi.fn(() => []), set: vi.fn(), delete: vi.fn() };
		const viewsManager = { setApiSource: vi.fn() };
		const folderSourcePathStore = { get: vi.fn(() => ""), set: vi.fn(), delete: vi.fn() };
		const plugin = { app: {}, apiHeadersStore, viewsManager, folderSourcePathStore };
		openApiSourceModal(node, plugin);

		const modal = FakeApiSourceModal.instances[0];
		modal.onSave({ type: "api", source: { url: "https://api.example.com/items" }, headers: [] });

		expect(folderSourcePathStore.delete).not.toHaveBeenCalled();
	});
});

// PR-1 (G11b/E-a): the four source walks visit every node and recurse into every node's children,
// including unit children, so a sourced folder nested under a unit still refreshes at load and on timers.
describe("PR-1 G11b/E-a — source walks reach a sourced node nested under units and meta folders", () => {
	type Walk = "collectApiSourceNodes" | "collectFolderSourceNodes" | "collectCsvSourceNodes" | "collectMarkdownTableSourceNodes";
	const proto = AtlasExplorerView.prototype as unknown as Record<Walk, (nodes: ViewNode[]) => ViewNode[]>;
	const WALKS: Array<{ walk: Walk; field: keyof ViewNode; sourced: Partial<ViewNode> }> = [
		{ walk: "collectApiSourceNodes", field: "apiSource", sourced: { apiSource: { url: "https://x", method: "GET", mapping: { idField: "id", labelField: "name" }, mode: "merge", refreshOnViewLoad: false } } },
		{ walk: "collectFolderSourceNodes", field: "folderSource", sourced: { folderSource: { location: "inside", path: "P", showFiles: true, showFolders: true, refreshOnViewLoad: false } } },
		{ walk: "collectCsvSourceNodes", field: "csvSource", sourced: { csvSource: { path: "d.csv", mapping: { idField: "id", labelField: "name" }, mode: "merge", refreshOnViewLoad: false } } },
		{
			walk: "collectMarkdownTableSourceNodes",
			field: "markdownTableSource",
			sourced: { markdownTableSource: { path: "t.md", tableIndex: 0, mapping: { idField: "id", labelField: "name" }, mode: "merge", refreshOnViewLoad: false } },
		},
	];

	for (const { walk, field, sourced } of WALKS) {
		it(`${walk} finds a source under unit > unit > meta and under unit > unit`, () => {
			const deep: ViewNode = { id: "deep", type: "unit", ref: { kind: "folder", path: "Deep" }, children: [], ...sourced };
			const middle: ViewNode = { id: "mid", type: "unit", ref: { kind: "file", path: "Mid.md" }, children: [deep] };
			const metaWrap: ViewNode = { id: "m", type: "meta", label: "Wrap", children: [middle] };
			const unitUnder: ViewNode = { id: "u2", type: "unit", ref: { kind: "file", path: "Top.md" }, children: [{ ...deep, id: "deep2" }] };
			const found = proto[walk].call(AtlasExplorerView.prototype, [metaWrap, unitUnder]);
			expect(found.map((n) => n.id)).toEqual(["deep", "deep2"]);
			expect(found.every((n) => n[field] !== undefined)).toBe(true);
		});

		it(`${walk} visits a sourced unit that has no children and skips unsourced nodes`, () => {
			const leaf: ViewNode = { id: "leaf", type: "unit", ref: { kind: "file", path: "L.md" }, children: [], ...sourced };
			const plain: ViewNode = { id: "plain", type: "unit", ref: { kind: "file", path: "P.md" }, children: [] };
			expect(proto[walk].call(AtlasExplorerView.prototype, [plain, leaf]).map((n) => n.id)).toEqual(["leaf"]);
		});
	}
});

// PR-3 (G1/G2/G3/E1/E2/F3): the real `makeDropZone`/`handleDrop` wiring, driven with dispatched
// `dragover`/`drop`/`dragleave` events and a mocked row rectangle, against a real `ViewsManager` so
// the assertions are on genuine `moveNode`/`placeUnit` results, not a mock that was merely called.
describe("PR-3 — edge-drop row wiring (dragover/drop/dragleave against the real drag handlers)", () => {
	type DropFake = {
		plugin: { viewsManager: ViewsManager };
		dragPayload: unknown;
		dropIndicatorEl: HTMLElement | null;
		selectedBucketNodeIds: Set<string>;
		selectedInboxRefKeys: Set<string>;
		queueRender: ReturnType<typeof vi.fn>;
		removeUnitsFromView: ReturnType<typeof vi.fn>;
		makeDropZone: (el: HTMLElement, target: unknown, hasBottomZone?: boolean) => void;
	};
	// Every other private method `makeDropZone`'s own closures reach via `this.xxx(...)`
	// (`handleDrop`, `findNodeAnywhere`, `findNodeParent`, `isCycleDrop`, `nodeContainsDescendant`,
	// `showDropIndicator`, `clearDropIndicator`) must be assigned onto the fake too -- a closure's
	// captured `this` is whatever `this` was when `makeDropZone` itself was *called* (`fake`, since
	// it's invoked as `fake.makeDropZone(...)` below), not just whichever one property is read here.
	const dragMethodNames = [
		"makeDropZone",
		"handleDrop",
		"findNodeAnywhere",
		"findNodeParent",
		"isCycleDrop",
		"nodeContainsDescendant",
		"showDropIndicator",
		"clearDropIndicator",
	] as const;
	const dragProto = AtlasExplorerView.prototype as unknown as Record<(typeof dragMethodNames)[number], (...a: unknown[]) => unknown>;

	function makeDropFake(viewsManager: ViewsManager): DropFake {
		const fake: Record<string, unknown> = {
			plugin: { viewsManager },
			dragPayload: null,
			dropIndicatorEl: null,
			selectedBucketNodeIds: new Set(),
			selectedInboxRefKeys: new Set(),
			queueRender: vi.fn(),
			removeUnitsFromView: vi.fn(),
		};
		for (const name of dragMethodNames) fake[name] = dragProto[name];
		return fake as unknown as DropFake;
	}

	function makeRow(height = 100): HTMLElement {
		const row = document.createElement("div");
		row.getBoundingClientRect = () =>
			({ top: 0, bottom: height, height, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
		return row;
	}

	function dragOverAt(row: HTMLElement, clientY: number): void {
		row.dispatchEvent(new MouseEvent("dragover", { bubbles: true, cancelable: true, clientY }));
	}

	function makeVm(root: ViewNode[]): ViewsManager {
		const app = new MockApp() as unknown as App;
		return new ViewsManager(app, [{ id: "v1", name: "Default", inboxMode: "view", root }], "v1", () => {});
	}

	function node(id: string, path: string, children: ViewNode[] = []): ViewNode {
		return { id, type: "unit", ref: { kind: "file", path }, children };
	}

	it("G1/E1: an edge zone (top 25%) shows exactly one indicator line positioned before the row, cleared on drop", () => {
		const a = node("a", "A.md");
		const b = node("b", "B.md");
		const vm = makeVm([a, b]);
		const fake = makeDropFake(vm);
		fake.dragPayload = { kind: "node", nodeIds: ["a"], viewId: "v1" };

		const container = document.createElement("div");
		const row = makeRow();
		container.appendChild(row);
		fake.makeDropZone(row, { kind: "node", nodeId: "b", viewId: "v1" }, true);

		dragOverAt(row, 10); // 10% of 100 -> top edge -> "before"
		expect(container.querySelectorAll(".atlas-drop-indicator")).toHaveLength(1);
		expect(Array.from(container.children)).toEqual([fake.dropIndicatorEl, row]);

		row.dispatchEvent(new Event("drop", { bubbles: true }));
		expect(container.querySelectorAll(".atlas-drop-indicator")).toHaveLength(0);
		expect(fake.dropIndicatorEl).toBeNull();
		// "a" lands as b's sibling right before it, at the bucket root -- no nesting.
		expect(vm.getViews()[0].root.map((n) => n.id)).toEqual(["a", "b"]);
	});

	it("G1: the indicator line is cleared on dragleave, without a drop", () => {
		const vm = makeVm([node("a", "A.md"), node("b", "B.md")]);
		const fake = makeDropFake(vm);
		fake.dragPayload = { kind: "node", nodeIds: ["a"], viewId: "v1" };

		const container = document.createElement("div");
		const row = makeRow();
		container.appendChild(row);
		fake.makeDropZone(row, { kind: "node", nodeId: "b", viewId: "v1" }, true);

		dragOverAt(row, 90); // bottom edge -> "after"
		expect(container.querySelectorAll(".atlas-drop-indicator")).toHaveLength(1);

		row.dispatchEvent(new Event("dragleave", { bubbles: true }));
		expect(container.querySelectorAll(".atlas-drop-indicator")).toHaveLength(0);
		expect(fake.dropIndicatorEl).toBeNull();
	});

	it("F3/G2: the middle zone shows no line and nests as the target's child, unchanged", () => {
		const a = node("a", "A.md");
		const b = node("b", "B.md");
		const vm = makeVm([a, b]);
		const fake = makeDropFake(vm);
		fake.dragPayload = { kind: "node", nodeIds: ["a"], viewId: "v1" };

		const container = document.createElement("div");
		const row = makeRow();
		container.appendChild(row);
		fake.makeDropZone(row, { kind: "node", nodeId: "b", viewId: "v1" }, true);

		dragOverAt(row, 50); // dead centre -> "nest"
		expect(container.querySelectorAll(".atlas-drop-indicator")).toHaveLength(0);
		expect(row.classList.contains("atlas-drop-target")).toBe(true);

		row.dispatchEvent(new Event("drop", { bubbles: true }));
		const root = vm.getViews()[0].root;
		expect(root.map((n) => n.id)).toEqual(["b"]);
		expect(root[0].children.map((n) => n.id)).toEqual(["a"]);
	});

	it("G3/G20: a multi-select batch including a selected ancestor's own child lands together, the child travels with its ancestor and isn't placed twice", () => {
		const b = node("b", "B.md");
		const a = node("a", "A.md", [b]);
		const c = node("c", "C.md");
		const d = node("d", "D.md");
		const vm = makeVm([a, c, d]);
		const fake = makeDropFake(vm);
		// Both "a" and its own child "b" are in the drag batch -- "b" must not be moved separately.
		fake.dragPayload = { kind: "node", nodeIds: ["a", "b"], viewId: "v1" };

		const row = makeRow();
		document.body.appendChild(row);
		fake.makeDropZone(row, { kind: "node", nodeId: "d", viewId: "v1" }, true);

		dragOverAt(row, 10); // top edge of "d" -> before "d"
		row.dispatchEvent(new Event("drop", { bubbles: true }));

		const root = vm.getViews()[0].root;
		expect(root.map((n) => n.id)).toEqual(["c", "a", "d"]);
		expect(root.find((n) => n.id === "a")!.children.map((n) => n.id)).toEqual(["b"]);
	});

	it("R1/G3: a same-parent batch where a selected row sits above the drop point lands in drag order, not shifted by moveNode's own pre-removal index adjustment", () => {
		// [A,B,C,D,E], select A,B, drop before D -- naively incrementing `index` after each move
		// ignores that moving "a" out from above "d" closes a gap moveNode already compensated for,
		// so the stale running counter puts "b" one slot too far right (C,A,D,B,E instead of C,A,B,D,E).
		const vm = makeVm([node("a", "A.md"), node("b", "B.md"), node("c", "C.md"), node("d", "D.md"), node("e", "E.md")]);
		const fake = makeDropFake(vm);
		fake.dragPayload = { kind: "node", nodeIds: ["a", "b"], viewId: "v1" };

		const row = makeRow();
		document.body.appendChild(row);
		fake.makeDropZone(row, { kind: "node", nodeId: "d", viewId: "v1" }, true);

		dragOverAt(row, 10); // top edge of "d" -> before "d"
		row.dispatchEvent(new Event("drop", { bubbles: true }));

		expect(vm.getViews()[0].root.map((n) => n.id)).toEqual(["c", "a", "b", "d", "e"]);
	});

	it("R1/G3: a same-parent batch mixing a row from above and a row from below the drop point lands in drag order", () => {
		// [A,B,C,D,E], select A,E, drop before C -- "a" moves up (index decrements), "e" moves down
		// (no decrement); the naive counter also gets this pairing wrong (B,A,C,E,D instead of B,A,E,C,D).
		const vm = makeVm([node("a", "A.md"), node("b", "B.md"), node("c", "C.md"), node("d", "D.md"), node("e", "E.md")]);
		const fake = makeDropFake(vm);
		fake.dragPayload = { kind: "node", nodeIds: ["a", "e"], viewId: "v1" };

		const row = makeRow();
		document.body.appendChild(row);
		fake.makeDropZone(row, { kind: "node", nodeId: "c", viewId: "v1" }, true);

		dragOverAt(row, 10); // top edge of "c" -> before "c"
		row.dispatchEvent(new Event("drop", { bubbles: true }));

		expect(vm.getViews()[0].root.map((n) => n.id)).toEqual(["b", "a", "e", "c", "d"]);
	});

	it("R1/G3/E1: a same-parent batch already sitting immediately before the drop point nets out unchanged", () => {
		// [A,B,C,D], select B,C, drop before D (B,C are already exactly there, in order) -- the
		// naive counter instead produced A,B,D,C.
		const vm = makeVm([node("a", "A.md"), node("b", "B.md"), node("c", "C.md"), node("d", "D.md")]);
		const fake = makeDropFake(vm);
		fake.dragPayload = { kind: "node", nodeIds: ["b", "c"], viewId: "v1" };

		const row = makeRow();
		document.body.appendChild(row);
		fake.makeDropZone(row, { kind: "node", nodeId: "d", viewId: "v1" }, true);

		dragOverAt(row, 10); // top edge of "d" -> before "d"
		row.dispatchEvent(new Event("drop", { bubbles: true }));

		expect(vm.getViews()[0].root.map((n) => n.id)).toEqual(["a", "b", "c", "d"]);
	});

	it("R1/G3: a mixed-parent batch (one row already a root sibling, one row from inside another folder) lands together in drag order", () => {
		// root [A,B,C,F(children=[X])], select A (root) and X (inside F), drop before C. "a" is a
		// same-parent move (index decrements); "x" is a cross-parent move (no decrement) -- the naive
		// counter, chained off "a"'s pre-adjustment index instead of where "a" actually landed, put
		// "x" after "c" instead of before it.
		const x = node("x", "X.md");
		const f: ViewNode = { id: "f", type: "meta", label: "F", children: [x] };
		const vm = makeVm([node("a", "A.md"), node("b", "B.md"), node("c", "C.md"), f]);
		const fake = makeDropFake(vm);
		fake.dragPayload = { kind: "node", nodeIds: ["a", "x"], viewId: "v1" };

		const row = makeRow();
		document.body.appendChild(row);
		fake.makeDropZone(row, { kind: "node", nodeId: "c", viewId: "v1" }, true);

		dragOverAt(row, 10); // top edge of "c" -> before "c"
		row.dispatchEvent(new Event("drop", { bubbles: true }));

		const root = vm.getViews()[0].root;
		expect(root.map((n) => n.id)).toEqual(["b", "a", "x", "c", "f"]);
		expect(root.find((n) => n.id === "f")!.children).toEqual([]);
	});

	it("E2: dropping on an edge inside the dragged node's own descendants is refused, with no indicator line", () => {
		const b = node("b", "B.md");
		const a = node("a", "A.md", [b]);
		const vm = makeVm([a]);
		const fake = makeDropFake(vm);
		fake.dragPayload = { kind: "node", nodeIds: ["a"], viewId: "v1" };

		const container = document.createElement("div");
		const row = makeRow();
		container.appendChild(row);
		// "b" is "a"'s own child -- dragging "a" onto "b"'s edge is a cycle.
		fake.makeDropZone(row, { kind: "node", nodeId: "b", viewId: "v1" }, true);

		dragOverAt(row, 10);
		expect(container.querySelectorAll(".atlas-drop-indicator")).toHaveLength(0);
		expect(row.classList.contains("atlas-drop-target")).toBe(true); // falls back to the plain nest highlight

		row.dispatchEvent(new Event("drop", { bubbles: true }));
		// moveNode's own cycle guard refuses it regardless; tree is untouched either way.
		expect(vm.getViews()[0].root.map((n) => n.id)).toEqual(["a"]);
		expect(vm.getViews()[0].root[0].children.map((n) => n.id)).toEqual(["b"]);
	});

	it("GP1/GP2: the golden path -- dragging Zebra Census to the top edge of quarry-drones", () => {
		const quarry = node("quarry", "quarry-drones.md");
		const annual = node("annual", "Annual Review.md");
		const projects: ViewNode = { id: "projects", type: "meta", label: "Projects", children: [quarry, annual] };
		const zebra = node("zebra", "Zebra Census.md");
		const vm = makeVm([zebra, projects]);
		const fake = makeDropFake(vm);
		fake.dragPayload = { kind: "node", nodeIds: ["zebra"], viewId: "v1" };

		const container = document.createElement("div");
		const row = makeRow();
		container.appendChild(row);
		fake.makeDropZone(row, { kind: "node", nodeId: "quarry", viewId: "v1" }, true);

		dragOverAt(row, 5); // GP1: a line appears above quarry-drones
		expect(container.querySelectorAll(".atlas-drop-indicator")).toHaveLength(1);
		expect(Array.from(container.children)).toEqual([fake.dropIndicatorEl, row]);

		row.dispatchEvent(new Event("drop", { bubbles: true })); // GP2
		const root = vm.getViews()[0].root;
		expect(root.map((n) => n.id)).toEqual(["projects"]);
		expect(root[0].children.map((n) => n.id)).toEqual(["zebra", "quarry", "annual"]);
	});

	it("rows with no edge zone (bucket-root/inbox-area targets) keep today's behaviour: always a plain nest append, no line", () => {
		const vm = makeVm([node("a", "A.md")]);
		const fake = makeDropFake(vm);
		fake.dragPayload = { kind: "inbox", refs: [{ kind: "file", path: "New.md" }] };

		const container = document.createElement("div");
		const row = makeRow();
		container.appendChild(row);
		fake.makeDropZone(row, { kind: "bucket-root", viewId: "v1" });

		dragOverAt(row, 10); // bucket-root/inbox-area targets never carry an edge zone
		expect(container.querySelectorAll(".atlas-drop-indicator")).toHaveLength(0);
		expect(row.classList.contains("atlas-drop-target")).toBe(true);

		row.dispatchEvent(new Event("drop", { bubbles: true }));
		expect(vm.getViews()[0].root.map((n) => n.ref?.path)).toEqual(["A.md", "New.md"]);
	});

	it("an inbox drop on an edge places the batch at that position, in order, instead of appending last", () => {
		const vm = makeVm([node("a", "A.md"), node("b", "B.md")]);
		const fake = makeDropFake(vm);
		fake.dragPayload = { kind: "inbox", refs: [{ kind: "file", path: "X.md" }, { kind: "file", path: "Y.md" }] };

		const row = makeRow();
		document.body.appendChild(row);
		fake.makeDropZone(row, { kind: "node", nodeId: "b", viewId: "v1" }, true);

		dragOverAt(row, 10); // before "b"
		row.dispatchEvent(new Event("drop", { bubbles: true }));

		expect(vm.getViews()[0].root.map((n) => n.ref?.path)).toEqual(["A.md", "X.md", "Y.md", "B.md"]);
	});
});
