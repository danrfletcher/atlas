import { describe, expect, it, vi } from "vitest";
import type { App, TFile } from "obsidian";
import { Notice } from "obsidian";
import { App as MockApp } from "../mocks/obsidian";
import { ViewsManager } from "../../src/views";
import { ApiItemState, FolderSourceConfig, PLACEHOLDER_ROW_KIND, UnitRef, View, ViewNode } from "../../src/types";
import { YamlFilterRule } from "../../src/folder-filter";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { callRenderApiItemRow, callRenderNodeList, makeFakeExplorer, makeStatusesManager, proto } from "../unit/explorer-view-sort-truncate-helpers";

/** PR-1.F2 integration: the filter box and selection against a Folder source's hidden and "filtered out"
 * rows. The real `ViewsManager` answers the render state, and the real `renderNode` builds the rows, so the
 * search and Remove checks run against the same DOM the explorer builds. */

const RULES: YamlFilterRule[] = [{ key: "status", value: "active" }];

function source(mode: FolderSourceConfig["mode"], rules?: YamlFilterRule[]): FolderSourceConfig {
	return {
		type: "folder",
		location: "inside",
		path: "Jobs",
		showFiles: true,
		showFolders: false,
		refreshOnViewLoad: false,
		mode,
		...(rules ? { filters: { files: { yaml: { rules } } } } : {}),
	};
}

interface Harness {
	vm: ViewsManager;
	viewId: string;
	folderId: string;
	fake: ReturnType<typeof makeFakeExplorer>;
	cache: Map<string, { frontmatter?: Record<string, unknown> } | null>;
}

/** A merge Folder source on `Jobs/` with the YAML rule saved. `beta` is hidden at save. `acme` matches,
 * unless `acmeDone` is set, which makes it a live "filtered out" row after the metadata resolves. */
function setup({ acmeDone = false }: { acmeDone?: boolean } = {}): Harness {
	const app = new MockApp();
	app.vault.seedFolder("Jobs");
	const cache = new Map<string, { frontmatter?: Record<string, unknown> } | null>([
		["Jobs/acme.md", { frontmatter: { status: "active" } }],
		["Jobs/beta.md", { frontmatter: { status: "done" } }],
	]);
	for (const path of cache.keys()) app.vault.seedFile(path);
	app.metadataCache.getFileCache = ((file: TFile) => cache.get(file.path) ?? null) as unknown as typeof app.metadataCache.getFileCache;

	const vm = new ViewsManager(app as unknown as App, [], "", () => {});
	const viewId = vm.getViews()[0].id;
	const folder = vm.addMetaFolder(viewId, null, "Job search")!;
	vm.setFolderSource(viewId, folder.id, source("merge"));
	vm.refreshFolderSource(viewId, folder.id);
	vm.onMetadataResolved();
	vm.setFolderSource(viewId, folder.id, source("merge", RULES));
	vm.onMetadataResolved();
	if (acmeDone) {
		cache.set("Jobs/acme.md", { frontmatter: { status: "done" } });
		vm.onMetadataResolved();
	}

	const sm = makeStatusesManager();
	const fake = makeFakeExplorer(sm, {
		plugin: { statusesManager: sm, settings: DEFAULT_SETTINGS, viewsManager: vm } as never,
		renderNode: proto.renderNode,
		removeUnitsFromView: proto.removeUnitsFromView,
		holdsLiveDataSource: proto.holdsLiveDataSource,
		forgetDeviceLocalSourceState: proto.forgetDeviceLocalSourceState,
		resolveRef: vi.fn(async (ref: { path: string }) => ({ text: ref.path.replace(/^.*\//, "").replace(/\.md$/, ""), missing: false, promoted: false, added: false })),
		isOutsideManagedUnit: vi.fn(() => false),
		renderRowIcon: vi.fn(),
		setPlacementTooltip: vi.fn(),
		wireModuleRow: vi.fn(),
		handleSelectionClick: vi.fn(() => false),
		bucketVisibleOrder: vi.fn(() => []),
		openRef: vi.fn(),
		makeDropZone: vi.fn(),
		handleRowKeydown: vi.fn(),
		buildNodeDragPayload: vi.fn(),
	});
	Object.assign(fake, { selectedBucketNodeIds: new Set<string>() });
	return { vm, viewId, folderId: folder.id, fake, cache };
}

const folderOf = (h: Harness): ViewNode => h.vm.getNode(h.viewId, h.folderId)!;
const rowFor = (h: Harness, path: string): ViewNode => folderOf(h).children.find((c) => c.ref?.path === path)!;

/** Renders the folder's rows through the real explorer pass, with the current filter text. */
async function render(h: Harness, filterText = ""): Promise<HTMLElement> {
	h.fake.filterText = filterText;
	const container = document.createElement("div");
	await callRenderNodeList(h.fake, folderOf(h).children, container, h.vm.getViews()[0], 1, [folderOf(h)], undefined);
	return container;
}

const rowElFor = (container: HTMLElement, id: string): HTMLElement | null => container.querySelector<HTMLElement>(`[data-select-key="${id}"]`);

describe("G12 — filter-box search: hidden rows never show, and filtered-out rows are found and removable", () => {
	it("a hidden row is not shown, even when the search matches it exactly", async () => {
		const h = setup();
		const beta = rowFor(h, "Jobs/beta.md");
		expect(h.vm.managedRowFilterState(h.viewId, beta)).toBe("hidden");

		const container = await render(h, "beta");
		expect(rowElFor(container, beta.id)).toBeNull();
		expect(container.textContent).not.toContain("beta");
	});

	it("a filtered-out row is found by search, and its Remove button removes it", async () => {
		const h = setup({ acmeDone: true });
		const acme = rowFor(h, "Jobs/acme.md");
		expect(h.vm.managedRowFilterState(h.viewId, acme)).toBe("filteredOut");

		const container = await render(h, "acme");
		const row = rowElFor(container, acme.id)!;
		expect(row).not.toBeNull();
		expect(row.classList.contains("atlas-filtered-out")).toBe(true);
		expect(row.textContent).toContain("filtered out");

		const removeBtn = row.querySelector<HTMLElement>(".atlas-row-action")!;
		expect(removeBtn).not.toBeNull();
		removeBtn.click();
		expect(rowFor(h, "Jobs/acme.md")).toBeUndefined();
		expect(folderOf(h).folderSource?.removedRefs ?? []).toEqual([]);
	});
});

describe("E9 — selection is pruned of hidden rows, and a filtered-out row stays selectable", () => {
	it("a selected row that becomes hidden is deselected, and the rest of the selection is kept", async () => {
		const h = setup();
		const acme = rowFor(h, "Jobs/acme.md");
		const beta = rowFor(h, "Jobs/beta.md");
		(h.fake as unknown as { selectedBucketNodeIds: Set<string> }).selectedBucketNodeIds = new Set([acme.id, beta.id]);

		await render(h);
		expect([...(h.fake as unknown as { selectedBucketNodeIds: Set<string> }).selectedBucketNodeIds]).toEqual([acme.id]);
	});

	it("a filtered-out row stays in the selection and shows as selected", async () => {
		const h = setup({ acmeDone: true });
		const acme = rowFor(h, "Jobs/acme.md");
		(h.fake as unknown as { selectedBucketNodeIds: Set<string> }).selectedBucketNodeIds = new Set([acme.id]);

		const container = await render(h);
		expect((h.fake as unknown as { selectedBucketNodeIds: Set<string> }).selectedBucketNodeIds.has(acme.id)).toBe(true);
		expect(rowElFor(container, acme.id)!.classList.contains("is-selected")).toBe(true);
	});
});

/** PR-1.F1 integration: `updateActiveHighlight` against the real `renderNode`/`renderNodeList`/
 * `renderApiItemRow`, so the matching rule is exercised through the exact rows the explorer builds —
 * a module, nested file rows (one of them a duplicate placed again at root), a Table/API Item row
 * (its `noteRef` attachment), and two block rows. `renderFoldableChildren` is the one stub here (the
 * real one also drives the fold-chevron chrome, which these tests don't need); it still recurses
 * through the real `renderNodeList`/`renderNode`, and renders nothing for a collapsed node, matching
 * the real one's "folded away is simply not shown" behaviour (GP4). */
interface HighlightHarness {
	app: InstanceType<typeof MockApp>;
	fake: ReturnType<typeof makeFakeExplorer>;
	content: HTMLElement;
	setActiveFile: (file: TFile | null) => void;
	setNodeCollapsed: ReturnType<typeof vi.fn>;
	projectsNode: ViewNode;
	quarryNested: ViewNode;
	quarryDuplicate: ViewNode;
	notesNode: ViewNode;
	block1: ViewNode;
	block2: ViewNode;
	/** R4: a block row whose own file path contains '#'. */
	block3: ViewNode;
	/** R3/G7: a row an `.atlas-missing` class must keep unhighlighted even when its ref matches. */
	missingNode: ViewNode;
	/** R3/G7: a row an `.atlas-filtered-out` class must keep unhighlighted even when its ref matches. */
	filteredNode: ViewNode;
	/** R3/F6: an Outside-Vault Folder source whose managed child (`outsideRow`) must never highlight. */
	outsideOwnerNode: ViewNode;
	outsideRow: ViewNode;
	groupMeta: ViewNode;
	v: View;
	/** R2(a): fires whatever the real `onOpen` (via `callOnOpen`) registered on the mock
	 * workspace — lets a test prove the `file-open`/`active-leaf-change` subscriptions themselves
	 * still drive `updateActiveHighlight`, instead of only ever calling it directly. */
	triggerWorkspace: (name: string, ...args: unknown[]) => void;
	/** R2(a): the real (unstubbed) `onOpen`, run against this harness's `fake`. `fake.render` is a
	 * no-op stub — `onOpen`'s own final `await this.render()` is irrelevant to this test, which only
	 * needs the two workspace subscriptions it wires before that call. */
	callOnOpen: () => Promise<void>;
}

function setupHighlightHarness(): HighlightHarness {
	const app = new MockApp();
	app.vault.seedFolder("Projects");
	app.vault.seedFile("Projects/Projects.md");
	app.vault.seedFile("Quarry drones.md");
	app.vault.seedFile("Notes.md");
	app.vault.seedFile("Ideas.md");
	app.vault.seedFile("Attached.md");
	app.vault.seedFile("Draft #1.md");

	const sm = makeStatusesManager();
	const setNodeCollapsed = vi.fn();

	// R3/F6: the Outside-Vault source `outsideRow` (below) belongs to — looked up by id via
	// `viewsManager.getNode`, the same way the real `isOutsideManagedUnit` looks up any owner.
	const outsideOwnerNode: ViewNode = {
		id: "outside-owner",
		type: "meta",
		label: "External",
		children: [],
		folderSource: { type: "folder", location: "outside", path: "Ext", showFiles: true, showFolders: false, mode: "merge" },
	};

	// R2(a): a minimal real event bus on the mock workspace. `onOpen` (called for real by
	// `callOnOpen`, never reimplemented here) registers its `file-open`/`active-leaf-change`
	// handlers against this the same way it would against the real Obsidian workspace; `on` itself
	// is the actual subscription (Obsidian's `registerEvent` is only cleanup bookkeeping on top of
	// it), so stubbing `registerEvent` to a no-op below still leaves the real handlers reachable.
	const workspaceListeners = new Map<string, Array<(...args: unknown[]) => void>>();
	const workspace = (app as unknown as { workspace: Record<string, unknown> }).workspace;
	workspace.on = (name: string, cb: (...args: unknown[]) => void) => {
		const arr = workspaceListeners.get(name) ?? [];
		arr.push(cb);
		workspaceListeners.set(name, arr);
		return { name, cb };
	};
	const triggerWorkspace = (name: string, ...args: unknown[]): void => {
		for (const cb of workspaceListeners.get(name) ?? []) cb(...args);
	};

	const plugin = {
		statusesManager: sm,
		settings: DEFAULT_SETTINGS,
		app: app as unknown as App,
		unitIndex: { onChange: vi.fn(() => () => {}) },
		viewsManager: {
			setApiItemStatus: vi.fn(),
			// R3/G7: only the one row tagged "filtered-node" reports filteredOut — every other row's
			// match keeps working exactly as before.
			managedRowFilterState: vi.fn((_viewId: string, node: ViewNode) => (node.id === "filtered-node" ? "filteredOut" : "shown")),
			setNodeCollapsed,
			onChange: vi.fn(() => () => {}),
			getNode: vi.fn((_viewId: string, nodeId: string) => (nodeId === "outside-owner" ? outsideOwnerNode : undefined)),
		},
	};

	let activeFile: TFile | null = null;
	(app as unknown as { workspace: { getActiveFile: () => TFile | null } }).workspace.getActiveFile = () => activeFile;

	const quarryNested: ViewNode = { id: "quarry-nested", type: "unit", ref: { kind: "file", path: "Quarry drones.md" }, children: [] };
	const projectsNode: ViewNode = { id: "projects", type: "unit", ref: { kind: "folder", path: "Projects" }, children: [quarryNested] };
	const quarryDuplicate: ViewNode = { id: "quarry-dup", type: "unit", ref: { kind: "file", path: "Quarry drones.md" }, children: [] };
	const notesNode: ViewNode = { id: "notes", type: "unit", ref: { kind: "file", path: "Notes.md" }, children: [] };
	const block1: ViewNode = { id: "block-1", type: "unit", ref: { kind: "block", path: "Ideas.md", subpath: "^b1" }, children: [] };
	const block2: ViewNode = { id: "block-2", type: "unit", ref: { kind: "block", path: "Ideas.md", subpath: "^b2" }, children: [] };
	// R4: a block row whose file path itself contains '#' — `parseUnitRefKey`'s pre-fix first-'#'
	// split misread `block:Draft #1.md#^b3` as path "Draft " + subpath "1.md#^b3", so this never
	// highlighted before the fix even though its file is open.
	const block3: ViewNode = { id: "block-3", type: "unit", ref: { kind: "block", path: "Draft #1.md", subpath: "^b3" }, children: [] };
	const missingNode: ViewNode = { id: "missing-node", type: "unit", ref: { kind: "file", path: "Missing.md" }, children: [] };
	const filteredNode: ViewNode = { id: "filtered-node", type: "unit", ref: { kind: "file", path: "Filtered.md" }, children: [] };
	// F6: ref.path deliberately reads the same as the real vault note "Quarry drones.md" above.
	const outsideRow: ViewNode = {
		id: "outside-row",
		type: "unit",
		ref: { kind: "file", path: "Quarry drones.md" },
		folderSourceManaged: true,
		folderSourceOwnerId: "outside-owner",
		children: [],
	};
	const groupMeta: ViewNode = { id: "group", type: "meta", label: "Group", children: [] };

	const v: View = { id: "v1", name: "Default", inboxMode: "view", root: [] };

	const fake = makeFakeExplorer(sm, {
		plugin: plugin as never,
		renderNode: proto.renderNode,
		renderNodeList: proto.renderNodeList,
		renderApiItemRow: proto.renderApiItemRow,
		renderFoldableChildren: vi.fn(async (node: unknown, _chevron: unknown, container: HTMLElement, view: unknown, depth: number, ancestors: unknown[]) => {
			const n = node as ViewNode;
			if (n.collapsed) return;
			const wrap = container.createDiv({ cls: "atlas-meta-children" });
			await (proto.renderNodeList as unknown as (nodes: ViewNode[], c: HTMLElement, v2: unknown, d: number, a: unknown[], o?: ViewNode) => Promise<void>).call(
				fake,
				n.children,
				wrap,
				view,
				depth + 1,
				[n, ...ancestors],
				undefined
			);
		}),
		resolveRef: vi.fn(async (ref: UnitRef) => ({
			text: ref.kind === "block" ? ref.subpath : (ref.path.split("/").pop() ?? ref.path).replace(/\.md$/, ""),
			icon: ref.kind === "folder" ? "folder" : "file",
			// R3/G7: only `missingNode`'s own path reports missing — every other row's match keeps
			// working exactly as before.
			missing: ref.kind !== "block" && ref.path === "Missing.md",
			promoted: false,
			added: false,
		})),
		// R3/F6: the real `isOutsideManagedUnit`, not a stub that always answers false. It still
		// answers false for every row here except `outsideRow` — none of the others ever set
		// `folderSourceManaged`/`folderSourceOwnerId`, so this is a no-op for every existing test.
		isOutsideManagedUnit: proto.isOutsideManagedUnit,
		resolveOutsideManagedRowInfo: proto.resolveOutsideManagedRowInfo,
		setPlacementTooltip: vi.fn(),
		wireModuleRow: vi.fn(),
		handleSelectionClick: vi.fn(() => false),
		bucketVisibleOrder: vi.fn(() => []),
		openRef: vi.fn(),
		makeDropZone: vi.fn(),
		handleRowKeydown: vi.fn(),
		buildNodeDragPayload: vi.fn(),
		// R2(a): the real `updateActiveHighlight`, so the handlers wired by the real `onOpen` (which
		// call `this.updateActiveHighlight()` directly, not through any test helper) actually run it.
		updateActiveHighlight: proto.updateActiveHighlight,
		// R2(a): the rest of `onOpen`'s own dependencies — exercised only by the test that calls
		// `callOnOpen`, harmless no-ops for every other test here, which never calls it.
		unsubscribers: [] as (() => void)[],
		registerEvent: vi.fn(),
		registerDomEvent: vi.fn(),
		leaf: {},
		viewLoadTrigger: { activate: vi.fn(() => false), deactivate: vi.fn() },
		refreshApiSourcesOnViewLoad: vi.fn(),
		render: vi.fn(async () => {}),
		dragPayload: null,
		inboxDragRowEl: null,
		cancelActiveDwell: null,
		queueRender: vi.fn(),
	});
	Object.assign(fake, { selectedBucketNodeIds: new Set<string>() });

	const header = document.createElement("div");
	const content = document.createElement("div");
	const containerEl = document.createElement("div");
	containerEl.appendChild(header);
	containerEl.appendChild(content);
	Object.assign(fake, { containerEl });

	return {
		app,
		fake,
		content,
		setActiveFile: (file) => (activeFile = file),
		setNodeCollapsed,
		projectsNode,
		quarryNested,
		quarryDuplicate,
		notesNode,
		block1,
		block2,
		block3,
		missingNode,
		filteredNode,
		outsideOwnerNode,
		outsideRow,
		groupMeta,
		v,
		triggerWorkspace,
		callOnOpen: () => (proto.onOpen as unknown as (this: unknown) => Promise<void>).call(fake),
	};
}

/** Renders the harness's root nodes plus one API Item row (a Table/API source placeholder with a
 * `noteRef` attachment) into `h.content`, real pass throughout. */
async function renderHighlightTree(h: HighlightHarness): Promise<void> {
	h.content.replaceChildren();
	const roots = [h.groupMeta, h.projectsNode, h.quarryDuplicate, h.notesNode, h.block1, h.block2, h.block3, h.missingNode, h.filteredNode, h.outsideRow];
	await callRenderNodeList(h.fake, roots, h.content, h.v, 0, [h.v], undefined);

	const apiItem: ApiItemState = { id: "api-1", label: "Attached item", kind: PLACEHOLDER_ROW_KIND, noteRef: { kind: "file", path: "Attached.md" } };
	const apiOwner: ViewNode = { id: "api-folder", type: "unit", children: [] };
	callRenderApiItemRow(h.fake, apiItem, h.content, h.v, apiOwner, 0, [h.v]);
}

function callUpdateActiveHighlight(h: HighlightHarness): void {
	(proto.updateActiveHighlight as unknown as () => void).call(h.fake);
}

function activeRefKeys(h: HighlightHarness): string[] {
	return Array.from(h.content.querySelectorAll<HTMLElement>(".atlas-row.is-active")).map((el) => el.dataset.refKey ?? "");
}

describe("PR-1.F1 — active highlight: file, module, block and Item rows via the real render pass", () => {
	it("GP1: opening a file visible, nested under an expanded module, highlights that row (and its duplicate, G1)", async () => {
		const h = setupHighlightHarness();
		await renderHighlightTree(h);
		h.setActiveFile({ path: "Quarry drones.md" } as TFile);
		callUpdateActiveHighlight(h);

		expect(activeRefKeys(h).sort()).toEqual(["file:Quarry drones.md", "file:Quarry drones.md"].sort());
		expect(h.content.querySelector(`[data-select-key="${h.quarryNested.id}"]`)!.classList.contains("is-active")).toBe(true);
		expect(h.content.querySelector(`[data-select-key="${h.quarryDuplicate.id}"]`)!.classList.contains("is-active")).toBe(true);
	});

	it("GP3: opening a different file clears the previous highlight and highlights the new row", async () => {
		const h = setupHighlightHarness();
		await renderHighlightTree(h);
		h.setActiveFile({ path: "Quarry drones.md" } as TFile);
		callUpdateActiveHighlight(h);

		h.setActiveFile({ path: "Notes.md" } as TFile);
		callUpdateActiveHighlight(h);

		expect(h.content.querySelector(`[data-select-key="${h.quarryNested.id}"]`)!.classList.contains("is-active")).toBe(false);
		expect(h.content.querySelector(`[data-select-key="${h.quarryDuplicate.id}"]`)!.classList.contains("is-active")).toBe(false);
		expect(h.content.querySelector(`[data-select-key="${h.notesNode.id}"]`)!.classList.contains("is-active")).toBe(true);
	});

	it("GP5: opening a module's interface note highlights the module row, never the module's own path", async () => {
		const h = setupHighlightHarness();
		await renderHighlightTree(h);
		h.setActiveFile({ path: "Projects/Projects.md" } as TFile);
		callUpdateActiveHighlight(h);

		const moduleRow = h.content.querySelector<HTMLElement>(`[data-select-key="${h.projectsNode.id}"]`)!;
		expect(moduleRow.classList.contains("is-active")).toBe(true);
		expect(moduleRow.dataset.refKey).toBe("folder:Projects");
		// G6: the module row highlights through its interface note only — its nested child (a
		// different file entirely) never highlights alongside it.
		expect(h.content.querySelector(`[data-select-key="${h.quarryNested.id}"]`)!.classList.contains("is-active")).toBe(false);
	});

	it("GP6: opening the file two promoted blocks live in highlights both block rows like a file row", async () => {
		const h = setupHighlightHarness();
		await renderHighlightTree(h);
		h.setActiveFile({ path: "Ideas.md" } as TFile);
		callUpdateActiveHighlight(h);

		expect(h.content.querySelector(`[data-select-key="${h.block1.id}"]`)!.classList.contains("is-active")).toBe(true);
		expect(h.content.querySelector(`[data-select-key="${h.block2.id}"]`)!.classList.contains("is-active")).toBe(true);
	});

	it("G3: a Table/API Item row's noteRef attachment highlights the same way once that note is open", async () => {
		const h = setupHighlightHarness();
		await renderHighlightTree(h);
		h.setActiveFile({ path: "Attached.md" } as TFile);
		callUpdateActiveHighlight(h);

		const itemRow = h.content.querySelector<HTMLElement>(".atlas-row-api-item")!;
		expect(itemRow.classList.contains("is-active")).toBe(true);
	});

	it("G6: a meta (Folder) row never highlights — it carries no data-ref-key at all", async () => {
		const h = setupHighlightHarness();
		await renderHighlightTree(h);
		h.setActiveFile({ path: "Quarry drones.md" } as TFile);
		callUpdateActiveHighlight(h);

		const metaRow = h.content.querySelector<HTMLElement>(`[data-select-key="${h.groupMeta.id}"]`)!;
		expect(metaRow.dataset.refKey).toBeUndefined();
		expect(metaRow.classList.contains("is-active")).toBe(false);
	});

	it("E2: no file open clears every highlight; re-running with the same active file is idempotent", async () => {
		const h = setupHighlightHarness();
		await renderHighlightTree(h);
		h.setActiveFile({ path: "Quarry drones.md" } as TFile);
		callUpdateActiveHighlight(h);
		expect(activeRefKeys(h)).toHaveLength(2);

		callUpdateActiveHighlight(h); // same active file again — idempotent, nothing flips
		expect(activeRefKeys(h)).toHaveLength(2);

		h.setActiveFile(null);
		callUpdateActiveHighlight(h);
		expect(activeRefKeys(h)).toHaveLength(0);
	});

	it("E4: deleting the open note clears the highlight, with no stale is-active left", async () => {
		const h = setupHighlightHarness();
		await renderHighlightTree(h);
		const quarry = h.app.vault.getAbstractFileByPath("Quarry drones.md") as TFile;
		h.setActiveFile(quarry);
		callUpdateActiveHighlight(h);
		expect(activeRefKeys(h)).toHaveLength(2);

		await h.app.vault.delete(quarry);
		// Obsidian reports no active file once the open note is gone.
		h.setActiveFile(null);
		callUpdateActiveHighlight(h);
		expect(activeRefKeys(h)).toHaveLength(0);
	});

	it("E5: two Atlas panes each highlight only their own rows, independent of the other's fold state", async () => {
		const h1 = setupHighlightHarness();
		await renderHighlightTree(h1);
		const h2 = setupHighlightHarness();
		h2.projectsNode.collapsed = true; // pane 2's own fold state — must not affect pane 1 at all
		await renderHighlightTree(h2);

		h1.setActiveFile({ path: "Quarry drones.md" } as TFile);
		callUpdateActiveHighlight(h1);
		h2.setActiveFile({ path: "Notes.md" } as TFile);
		callUpdateActiveHighlight(h2);

		expect(activeRefKeys(h1).sort()).toEqual(["file:Quarry drones.md", "file:Quarry drones.md"].sort());
		expect(activeRefKeys(h2)).toEqual(["file:Notes.md"]);
		// Pane 2's collapsed module never even rendered its nested child — confirms the two panes'
		// fold states are fully independent, not just their highlight state.
		expect(h2.content.querySelector(`[data-select-key="${h1.quarryNested.id}"]`)).toBeNull();
	});

	it("E3: after a vault rename of the open note, the highlight follows the row once it reflects the new ref", async () => {
		// The rewrite of a view's own node ref on rename is a separate, pre-existing mechanism
		// (F9 rename integrity, not part of this PR) — this proves only that `updateActiveHighlight`
		// itself follows once that rewrite (and the re-render it triggers) has happened.
		const h = setupHighlightHarness();
		await renderHighlightTree(h);
		const quarry = h.app.vault.getAbstractFileByPath("Quarry drones.md") as TFile;
		h.setActiveFile(quarry);
		callUpdateActiveHighlight(h);
		expect(activeRefKeys(h)).toHaveLength(2);

		await h.app.vault.rename(quarry, "Renamed drones.md");
		h.quarryNested.ref = { kind: "file", path: "Renamed drones.md" };
		h.quarryDuplicate.ref = { kind: "file", path: "Renamed drones.md" };
		await renderHighlightTree(h);
		callUpdateActiveHighlight(h);

		expect(activeRefKeys(h)).toEqual(["file:Renamed drones.md", "file:Renamed drones.md"]);
	});

	it("GP4/F1: collapsing a module shows nothing for its hidden child, and no scroll/collapse call comes from highlighting; expanding brings it back", async () => {
		const h = setupHighlightHarness();
		h.projectsNode.collapsed = true;
		await renderHighlightTree(h);
		h.content.scrollTop = 42;
		Notice.reset();

		h.setActiveFile({ path: "Quarry drones.md" } as TFile);
		callUpdateActiveHighlight(h);
		// Only the root-level duplicate is in the DOM at all while collapsed — nothing "shows" for
		// the hidden nested row, matching "folded away is simply not shown" (not merely un-highlighted).
		expect(h.content.querySelector(`[data-select-key="${h.quarryNested.id}"]`)).toBeNull();
		expect(activeRefKeys(h)).toHaveLength(1);
		expect(h.content.scrollTop).toBe(42);
		expect(h.setNodeCollapsed).not.toHaveBeenCalled();
		expect(Notice.instances).toHaveLength(0);

		h.projectsNode.collapsed = false;
		await renderHighlightTree(h);
		callUpdateActiveHighlight(h);
		expect(h.content.querySelector(`[data-select-key="${h.quarryNested.id}"]`)!.classList.contains("is-active")).toBe(true);
		expect(activeRefKeys(h)).toHaveLength(2);
		expect(h.content.scrollTop).toBe(42);
		expect(h.setNodeCollapsed).not.toHaveBeenCalled();
		expect(Notice.instances).toHaveLength(0);
	});

	it("R4: a block row whose own file path contains '#' highlights once that file is open, exactly like any other block row", async () => {
		const h = setupHighlightHarness();
		await renderHighlightTree(h);
		h.setActiveFile({ path: "Draft #1.md" } as TFile);
		callUpdateActiveHighlight(h);

		const row = h.content.querySelector<HTMLElement>(`[data-select-key="${h.block3.id}"]`)!;
		expect(row.dataset.refKey).toBe("block:Draft #1.md#^b3");
		expect(row.classList.contains("is-active")).toBe(true);
	});

	it("R3/F6: an Outside-Vault-managed row whose ref.path equals the open vault note's path never highlights, even while the real vault rows for that same path do", async () => {
		const h = setupHighlightHarness();
		await renderHighlightTree(h);
		const outsideRowEl = h.content.querySelector<HTMLElement>(`[data-select-key="${h.outsideRow.id}"]`)!;
		expect(outsideRowEl.dataset.outsideManaged).toBe("true");

		h.setActiveFile({ path: "Quarry drones.md" } as TFile);
		callUpdateActiveHighlight(h);

		expect(outsideRowEl.classList.contains("is-active")).toBe(false);
		expect(h.content.querySelector(`[data-select-key="${h.quarryNested.id}"]`)!.classList.contains("is-active")).toBe(true);
		expect(h.content.querySelector(`[data-select-key="${h.quarryDuplicate.id}"]`)!.classList.contains("is-active")).toBe(true);
	});

	it("R3/G7: a missing row and a filtered-out row stay unhighlighted even though their own ref matches the open file's path", async () => {
		const h = setupHighlightHarness();
		await renderHighlightTree(h);
		const missingRow = h.content.querySelector<HTMLElement>(`[data-select-key="${h.missingNode.id}"]`)!;
		const filteredRow = h.content.querySelector<HTMLElement>(`[data-select-key="${h.filteredNode.id}"]`)!;
		expect(missingRow.classList.contains("atlas-missing")).toBe(true);
		expect(filteredRow.classList.contains("atlas-filtered-out")).toBe(true);

		h.setActiveFile({ path: "Missing.md" } as TFile);
		callUpdateActiveHighlight(h);
		expect(missingRow.classList.contains("is-active")).toBe(false);

		h.setActiveFile({ path: "Filtered.md" } as TFile);
		callUpdateActiveHighlight(h);
		expect(filteredRow.classList.contains("is-active")).toBe(false);
	});

	it("G8: a row that is both selected and the open note carries is-selected and is-active together", async () => {
		const h = setupHighlightHarness();
		(h.fake as unknown as { selectedBucketNodeIds: Set<string> }).selectedBucketNodeIds = new Set([h.quarryNested.id]);
		await renderHighlightTree(h);

		h.setActiveFile({ path: "Quarry drones.md" } as TFile);
		callUpdateActiveHighlight(h);

		const row = h.content.querySelector<HTMLElement>(`[data-select-key="${h.quarryNested.id}"]`)!;
		expect(row.classList.contains("is-selected")).toBe(true);
		expect(row.classList.contains("is-active")).toBe(true);
	});

	it("R2(a): the real file-open and active-leaf-change subscriptions wired in onOpen drive the highlight, not just a direct call to updateActiveHighlight", async () => {
		const h = setupHighlightHarness();
		await renderHighlightTree(h);
		await h.callOnOpen();

		h.setActiveFile({ path: "Quarry drones.md" } as TFile);
		h.triggerWorkspace("file-open");
		expect(h.content.querySelector(`[data-select-key="${h.quarryNested.id}"]`)!.classList.contains("is-active")).toBe(true);
		expect(h.content.querySelector(`[data-select-key="${h.quarryDuplicate.id}"]`)!.classList.contains("is-active")).toBe(true);

		h.setActiveFile({ path: "Notes.md" } as TFile);
		h.triggerWorkspace("active-leaf-change", {});
		expect(h.content.querySelector(`[data-select-key="${h.quarryNested.id}"]`)!.classList.contains("is-active")).toBe(false);
		expect(h.content.querySelector(`[data-select-key="${h.notesNode.id}"]`)!.classList.contains("is-active")).toBe(true);
	});
});
