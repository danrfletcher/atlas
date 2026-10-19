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

/** PR-2.F2 R2: `startAddUnderFolder` itself (the prompt, the per-parent lock, the parent-exists
 * checks) already has full coverage in `tests/unit/add-under-folder.test.ts`. Mocking it here
 * isolates `runAddUnderFolder`'s own wiring — the render-then-check-visibility step — and lets the
 * test drive the real `addUnderFolderDeps()`/`render()`/`awaitRenderSettled()`/`queueRender()`
 * methods through a deliberately staged overlapping-render race. */
vi.mock("../../src/add-under-folder", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/add-under-folder")>();
	return { ...actual, startAddUnderFolder: vi.fn() };
});

import { Menu, Notice } from "obsidian";
import { ApiSourceModal } from "../../src/api-source-modal";
import { AtlasExplorerView } from "../../src/explorer-view";
import { AddUnderFolderDeps, startAddUnderFolder } from "../../src/add-under-folder";
import { View, ViewNode } from "../../src/types";
import { meta } from "../integration/create-from-meta-fixtures";

const mockStartAddUnderFolder = startAddUnderFolder as unknown as ReturnType<typeof vi.fn>;

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
			{ plugin: {}, startCreateFromMeta: vi.fn(), openStatusesModal: vi.fn(), openApiSourceModal: openApiSourceModalSpy },
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

// PR-2.F2 R1: addUnderFolderDeps.selectOnly only ever cleared the bucket selection, leaving a prior
// inbox selection (and a stale anchor) live — this broke "bucket and inbox selections are mutually
// exclusive" (E5) whenever Add under… > Folder ran right-clicked with inbox rows still selected.
describe("PR-2.F2 R1 — addUnderFolderDeps.selectOnly keeps bucket/inbox selection mutually exclusive", () => {
	it("clears any inbox selection, replaces the bucket selection with exactly the new node, and anchors in bucket scope", () => {
		const fakeThis = {
			plugin: { app: {}, viewsManager: { getNode: vi.fn(), addMetaFolder: vi.fn(), setNodeCollapsed: vi.fn() } },
			selectedBucketNodeIds: new Set<string>(["old-bucket-node"]),
			selectedInboxRefKeys: new Set<string>(["file:Some.md"]),
			selectionAnchor: "old-anchor" as string | null,
			selectionAnchorScope: "inbox" as "bucket" | "inbox" | null,
		};
		const deps = (AtlasExplorerView.prototype as unknown as { addUnderFolderDeps: () => AddUnderFolderDeps }).addUnderFolderDeps.call(fakeThis);

		deps.selectOnly("new-node");

		expect([...fakeThis.selectedBucketNodeIds]).toEqual(["new-node"]);
		expect([...fakeThis.selectedInboxRefKeys]).toEqual([]);
		expect(fakeThis.selectionAnchor).toBe("new-node");
		expect(fakeThis.selectionAnchorScope).toBe("bucket");
	});
});

// PR-2.F2 R2: `render()`'s own `isCurrent()` guard only tells a superseded render to bail out early
// — it says nothing about whether the render that superseded it has itself finished building the DOM
// yet. A caller that needs the truly-latest, fully-settled DOM (like `runAddUnderFolder`'s G10 check)
// must follow whichever render turns out to be the most recently *started* one, even if it only
// starts after the caller began waiting.
describe("PR-2.F2 R2 — render()/awaitRenderSettled track the truly latest render across an overlap", () => {
	it("waits for a render that starts and supersedes an in-flight one, not just the first render it saw", async () => {
		const resolvers: Array<() => void> = [];
		const fakeThis: { latestRenderPromise: Promise<void> | null; renderNow: () => Promise<void> } = {
			latestRenderPromise: null,
			renderNow: vi.fn(() => new Promise<void>((resolve) => resolvers.push(resolve))),
		};
		const render = (AtlasExplorerView.prototype as unknown as { render: () => Promise<void> }).render.bind(fakeThis);
		const awaitRenderSettled = (AtlasExplorerView.prototype as unknown as { awaitRenderSettled: () => Promise<void> }).awaitRenderSettled.bind(fakeThis);

		// Render A starts (e.g. runAddUnderFolder's own direct `render()` call) ...
		void render();
		let settled = false;
		const settledPromise = awaitRenderSettled().then(() => {
			settled = true;
		});

		// ... then, while A is still in flight, render B starts and supersedes it — exactly the
		// queued setTimeout(0) render firing mid-flight that R2 describes.
		void render();

		// A resolves (the superseded render bailing out early via its own isCurrent() check).
		resolvers[0]();
		await Promise.resolve();
		await Promise.resolve();
		expect(settled).toBe(false); // must still be waiting on B, the real latest render

		resolvers[1]();
		await settledPromise;
		expect(settled).toBe(true);
	});
});

// PR-2.F2 R2: `startAddUnderFolder` itself is mocked (see the top of this file) so this test can
// stage the exact overlapping-render race against the real `addUnderFolderDeps()`, `render()`,
// `awaitRenderSettled()` and `queueRender()` — only `ViewsManager.addMetaFolder`/`setNodeCollapsed`
// (already covered by `tests/unit/views*.test.ts`) and the DOM-building half of `render()` are
// stubbed, standing in for the parts this test doesn't need to re-prove.
describe("PR-2.F2 R2 — runAddUnderFolder waits for an overlapping queued render before checking visibility", () => {
	it("doesn't show the 'hidden by filter/sort/grouping' Notice when a save()-triggered render starts and finishes after the add's own direct render", async () => {
		Notice.reset();
		// jsdom in this test environment has no global `CSS` at all (not even without `.escape`),
		// which `runAddUnderFolder`'s own visibility check relies on, same as `render()` itself
		// already does elsewhere (src/explorer-view.ts). None of the IDs this test uses need real
		// escaping, so a minimal stand-in is enough; restored after the test either way.
		const originalCSS = (globalThis as { CSS?: unknown }).CSS;
		(globalThis as { CSS?: { escape: (value: string) => string } }).CSS = {
			escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`),
		};

		try {
			const created: ViewNode = meta("new-node", "Archive");
			const parentNode: ViewNode = meta("parent", "Projects");

			let callIndex = 0;
			let resolveD: (() => void) | null = null;
			let resolveQ: (() => void) | null = null;
			const fakeThis: Record<string, unknown> = {
				bucketListEl: document.createElement("div"),
				latestRenderPromise: null,
				renderQueued: false,
				selectedBucketNodeIds: new Set<string>(),
				selectedInboxRefKeys: new Set<string>(),
				selectionAnchor: null,
				selectionAnchorScope: null,
				filterText: "",
				expandedTruncationGroups: new Set<string>(),
				plugin: {
					app: {},
					// PR-2.F3: `addUnderHiddenSignals` reads this to resolve the new row's governance —
					// neither node here has `statusEnabled`, so a no-op stub (always "no governor") is
					// enough; this test is about the render-overlap race, not reason classification.
					statusesManager: { findGoverningAncestor: () => null, resolveNodeStatus: () => null },
					viewsManager: {
						getNode: vi.fn(() => parentNode),
						// Standing in for the real ViewsManager.addMetaFolder, which calls save() and so
						// (via this view's own ViewsManager.onChange subscription) queueRender() — the
						// trigger for the race this test stages.
						addMetaFolder: vi.fn(() => {
							(fakeThis.queueRender as () => void)();
							return created;
						}),
						setNodeCollapsed: vi.fn(() => {
							(fakeThis.queueRender as () => void)();
						}),
					},
				},
			};
			fakeThis.render = (AtlasExplorerView.prototype as unknown as { render: () => Promise<void> }).render;
			fakeThis.awaitRenderSettled = (AtlasExplorerView.prototype as unknown as { awaitRenderSettled: () => Promise<void> }).awaitRenderSettled;
			fakeThis.addUnderFolderDeps = (AtlasExplorerView.prototype as unknown as { addUnderFolderDeps: () => AddUnderFolderDeps }).addUnderFolderDeps;
			fakeThis.queueRender = (AtlasExplorerView.prototype as unknown as { queueRender: () => void }).queueRender;
			fakeThis.runAddUnderFolder = (AtlasExplorerView.prototype as unknown as { runAddUnderFolder: (view: View, node: ViewNode) => Promise<void> }).runAddUnderFolder;
			fakeThis.addUnderHiddenSignals = (AtlasExplorerView.prototype as unknown as { addUnderHiddenSignals: (...a: unknown[]) => unknown }).addUnderHiddenSignals;
			fakeThis.ancestorsForNode = (AtlasExplorerView.prototype as unknown as { ancestorsForNode: (...a: unknown[]) => unknown }).ancestorsForNode;
			fakeThis.renderNow = vi.fn(() => {
				callIndex += 1;
				if (callIndex === 1) {
					// D: runAddUnderFolder's own direct render call. Kept pending (e.g. still awaiting a
					// promoted block's disk read in a real render) until this test resolves it below.
					return new Promise<void>((resolve) => {
						resolveD = resolve;
					});
				}
				// Q: the queued render triggered above by addMetaFolder/setNodeCollapsed. Reassigns
				// bucketListEl to a fresh, still-empty list right away (mirroring renderBucketSection's
				// own `this.bucketListEl = listEl` before any row has been appended), and only appends
				// the new row once this render itself actually finishes.
				fakeThis.bucketListEl = document.createElement("div");
				return new Promise<void>((resolve) => {
					resolveQ = () => {
						const row = document.createElement("div");
						row.setAttribute("data-select-key", created.id);
						(fakeThis.bucketListEl as HTMLElement).appendChild(row);
						resolve();
					};
				});
			});

			mockStartAddUnderFolder.mockImplementation(async (deps: AddUnderFolderDeps, viewId: string, parentId: string) => {
				const node = deps.addMetaFolder(viewId, parentId, "Archive");
				if (!node) return null;
				deps.expandParent(viewId, parentId);
				deps.selectOnly(node.id);
				return node;
			});

			const runPromise = (fakeThis.runAddUnderFolder as (view: View, node: ViewNode) => Promise<void>).call(fakeThis, view, parentNode);
			let settled = false;
			void runPromise.then(() => {
				settled = true;
			});

			// Let the real setTimeout(0) scheduled by queueRender (inside addMetaFolder, above) actually
			// fire — this is render Q starting mid-flight through render D, the overlap R2 describes.
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(resolveQ).not.toBeNull();
			expect(settled).toBe(false); // D hasn't resolved yet; nothing should have settled

			// D resolves (bails out early via isCurrent()) while Q is still mid-build (no row appended
			// yet). The buggy version checked `bucketListEl` right here and wrongly showed the Notice.
			resolveD!();
			await Promise.resolve();
			await Promise.resolve();
			expect(settled).toBe(false); // must still be waiting on Q, the real latest render

			// Q finishes and actually appends the new row.
			resolveQ!();
			await runPromise;

			expect(Notice.instances.some((n) => n.message.includes("hidden by the current filter"))).toBe(false);
		} finally {
			(globalThis as { CSS?: unknown }).CSS = originalCSS;
		}
	});
});
