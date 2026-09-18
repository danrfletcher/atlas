import { App, FuzzySuggestModal, ItemView, Menu, Modal, Notice, TFile, TFolder, WorkspaceLeaf, setIcon, setTooltip } from "obsidian";
import type AtlasPlugin from "./main";
import { Unit, UnitRef, View, ViewNode, unitRefKey, unitRefsEqual, unitToRef } from "./types";
import { MetaTarget, flattenMetaFolders } from "./views";
import { resolveUnit } from "./unit-display";
import { TextPromptModal, ConfirmModal } from "./modals";
import { createInterfaceNote, findInterfaceNote } from "./interface-notes";
import { addBlock } from "./commands";

export const ATLAS_VIEW_TYPE = "atlas-explorer";

/** F11: fixed row height assumed for inbox virtualization (all inbox rows are single-line,
 * `white-space: nowrap` per `.atlas-row` in styles.css, so this holds across Obsidian's own font
 * settings closely enough — a few px of slack either way just means a bit of overscan, not overlap). */
const INBOX_ROW_HEIGHT = 28;
/** Extra rows rendered above/below the visible window, so a fast scroll doesn't show blank gaps
 * before the next frame's window recomputes. */
const INBOX_OVERSCAN = 8;
/** A bucket unit row has no `.atlas-chevron` before its icon (only meta rows do); this offset
 * stands in for one so unit-row icons line up with meta-row icons at the same depth. Must match
 * `.atlas-chevron`'s width (14px) + `.atlas-row`'s gap (6px) exactly, or the icons drift apart —
 * this was previously 16, 4px short of the real 20, which is exactly the misalignment reported. */
const UNIT_ROW_CHEVRON_OFFSET = 20;
/** Must match `.atlas-meta-children`'s `transition-duration` in styles.css — the state-persisting
 * `setNodeCollapsed` call (which triggers a full re-render) is delayed by this long so the CSS
 * collapse/expand transition finishes playing before the DOM gets rebuilt out from under it. */
const META_COLLAPSE_TRANSITION_MS = 160;
/** PR 9 (issue 2, point 5): how long a drag has to hover a module (without dropping) before its
 * Contents modal opens automatically, mirroring the "hover a folder while dragging to expand it"
 * pattern most native file managers use. */
const MODULE_HOVER_DWELL_MS = 650;

type DragPayload = { kind: "node"; nodeId: string; viewId: string } | { kind: "inbox"; ref: UnitRef };

interface RowInfo {
	text: string;
	secondary?: string;
	icon: string;
	promoted: boolean;
	missing: boolean;
}

export class ViewSuggestModal extends FuzzySuggestModal<View> {
	constructor(app: AtlasPlugin["app"], private views: View[], private onChoose: (view: View) => void) {
		super(app);
	}
	getItems(): View[] {
		return this.views;
	}
	getItemText(view: View): string {
		return view.name;
	}
	onChooseItem(view: View): void {
		this.onChoose(view);
	}
}

export class MetaFolderSuggestModal extends FuzzySuggestModal<MetaTarget> {
	constructor(app: AtlasPlugin["app"], private targets: MetaTarget[], private onChoose: (target: MetaTarget) => void) {
		super(app);
	}
	getItems(): MetaTarget[] {
		return this.targets;
	}
	getItemText(target: MetaTarget): string {
		return target.label;
	}
	onChooseItem(target: MetaTarget): void {
		this.onChoose(target);
	}
}

/** PR 9 (issue 2): replaces inline fold/unfold for modules with a browsable read-only tree of the
 * module's physical internals — modules are opaque, first-class units whose internal organization
 * Atlas doesn't otherwise rearrange, so this is look-don't-touch by default (clicking a file opens
 * it and closes the modal; right-click still offers "Reveal in native explorer", same as before).
 * In `dropTarget` mode (only ever passed when opened via the hover-during-drag gesture, issue 2
 * point 5) every folder shown — including the module's own root — becomes a live drop target for
 * whatever's still being dragged, skipping the usual confirm dialog entirely, since choosing an
 * exact destination inside this modal already *is* the confirmation. */
export interface ModuleContentsModalCallbacks {
	onOpenFile: (file: TFile) => void;
	onRevealInNative: (path: string) => void;
	onPromoteAndPlace: (path: string, isFolder: boolean) => void;
	/** Set only when opened via the hover-during-drag gesture — every folder shown becomes a live
	 * drop target for the drag still in progress, and dropping skips the usual confirm dialog. */
	dropTarget?: { onDrop: (targetFolderPath: string) => void };
	onCloseCallback?: () => void;
	/** PR 10: whether a subfolder (by vault path) should render expanded — backed by
	 * `AtlasPlugin.isModuleFolderExpanded`, persisted across modal close/reopen and Obsidian
	 * restarts. Defaults to collapsed for any path never toggled before. */
	isFolderExpanded: (path: string) => boolean;
	/** PR 10: called when the user clicks a subfolder's chevron, so the explorer view can persist
	 * the new state via `AtlasPlugin.setModuleFolderExpanded`. */
	onToggleFolder: (path: string, expanded: boolean) => void;
}

export class ModuleContentsModal extends Modal {
	private filterText = "";
	private rows: { el: HTMLElement; name: string }[] = [];

	constructor(app: App, private folder: TFolder, private callbacks: ModuleContentsModalCallbacks) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.folder.name);
		this.contentEl.addClass("atlas-module-modal-content");
		const treeEl = this.contentEl.createDiv({ cls: "atlas-module-modal-tree" });

		if (this.callbacks.dropTarget) {
			const rootRow = treeEl.createDiv({ cls: "atlas-row atlas-row-internal atlas-module-modal-root" });
			rootRow.createSpan({ cls: "atlas-row-text", text: `${this.folder.name} (module root)` });
			this.wireDropZone(rootRow, this.folder.path);
			this.rows.push({ el: rootRow, name: this.folder.name });
		}

		this.renderTree(this.folder, treeEl, 0);
		if (this.filterText) this.setFilterText(this.filterText);
	}

	onClose(): void {
		this.contentEl.empty();
		this.callbacks.onCloseCallback?.();
	}

	/** Re-applies match highlighting against a (possibly changed) filter without closing/reopening —
	 * called live by the explorer view while this modal is open and the filter text changes. */
	setFilterText(text: string): void {
		this.filterText = text;
		const needle = text.trim().toLowerCase();
		for (const { el, name } of this.rows) {
			el.toggleClass("atlas-row-filter-match", needle.length > 0 && name.toLowerCase().includes(needle));
		}
	}

	/** PR 10: a folder child gets its own chevron and a dedicated children-wrapper (the same
	 * `.atlas-meta-children`/`-inner` grid-collapse technique used everywhere else in the plugin),
	 * so fold/unfold animates and each subfolder's state is independent. Toggling here has no
	 * re-render side effect to worry about (unlike the main tree's meta-folder collapse, whose
	 * persist call triggers a full external re-render) — it's just a class toggle plus a debounced
	 * write, so no delayed-persist trick is needed. */
	private renderTree(folder: TFolder, container: HTMLElement, depth: number): void {
		for (const child of folder.children) {
			const row = container.createDiv({ cls: "atlas-row atlas-row-internal" });
			row.style.paddingLeft = `${depth * 16 + 16}px`;
			const chevron = child instanceof TFolder ? row.createDiv({ cls: "atlas-chevron" }) : null;
			const iconEl = row.createDiv({ cls: "atlas-icon" });
			setIcon(iconEl, child instanceof TFolder ? "folder" : "file");
			row.createSpan({ cls: "atlas-row-text", text: child.name });
			this.rows.push({ el: row, name: child.name });

			if (child instanceof TFile) {
				row.addEventListener("click", () => {
					this.callbacks.onOpenFile(child);
					this.close();
				});
			} else if (this.callbacks.dropTarget) {
				this.wireDropZone(row, child.path);
			}
			row.addEventListener("contextmenu", (evt) => {
				evt.preventDefault();
				const menu = new Menu();
				menu.addItem((item) =>
					item
						.setTitle("Reveal in native explorer")
						.setIcon("folder-open")
						.onClick(() => this.callbacks.onRevealInNative(child.path))
				);
				menu.addItem((item) =>
					item
						.setTitle("Promote and place in view…")
						.setIcon("arrow-right-left")
						.onClick(() => {
							this.callbacks.onPromoteAndPlace(child.path, child instanceof TFolder);
							this.close();
						})
				);
				menu.showAtMouseEvent(evt);
			});

			if (child instanceof TFolder && chevron) {
				let expanded = this.callbacks.isFolderExpanded(child.path);
				setIcon(chevron, expanded ? "chevron-down" : "chevron-right");

				const childrenWrap = container.createDiv({ cls: "atlas-meta-children" });
				childrenWrap.toggleClass("is-collapsed", !expanded);
				const childrenInner = childrenWrap.createDiv({ cls: "atlas-meta-children-inner" });
				this.renderTree(child, childrenInner, depth + 1);

				chevron.addEventListener("click", (evt) => {
					evt.stopPropagation();
					expanded = !expanded;
					setIcon(chevron, expanded ? "chevron-down" : "chevron-right");
					childrenWrap.toggleClass("is-collapsed", !expanded);
					this.callbacks.onToggleFolder(child.path, expanded);
				});
			}
		}
	}

	private wireDropZone(row: HTMLElement, folderPath: string): void {
		row.addEventListener("dragover", (evt) => {
			evt.preventDefault();
			row.addClass("atlas-drop-target");
		});
		row.addEventListener("dragleave", () => row.removeClass("atlas-drop-target"));
		row.addEventListener("drop", (evt) => {
			evt.preventDefault();
			row.removeClass("atlas-drop-target");
			this.callbacks.dropTarget?.onDrop(folderPath);
			this.close();
		});
	}
}

/**
 * F8 — the explorer view. A flat unit index (F2) arranged into a bucket tree per view (F9). This
 * view never moves anything on disk — the only filesystem writes anywhere in it are `vault.create`
 * (Add block/file/folder) and `createInterfaceNote`, both already on Part 7's allowed list. Every
 * drag/promote/placement path below is plugin-data only.
 */
export class AtlasExplorerView extends ItemView {
	private filterText = "";
	private sortMode: "manual" | "alphabetical" = "manual";
	private bucketCollapsed = false;
	private inboxCollapsed = true;
	/** PR 9: filter input is hidden behind a reveal toggle now instead of always shown. */
	private filterRevealed = false;
	/** One-shot: set when the reveal toggle is clicked open, consumed by the very next
	 * `renderToolbar` call so the newly-created input is auto-focused exactly once, not on every
	 * render while revealed (which would fight the existing focus-preservation logic in `render()`). */
	private focusFilterOnNextRender = false;
	/** PR 9: a folder's collapsed state as it was *before* the current filter run started
	 * auto-revealing folders that contain a match — restored verbatim once the filter clears, so
	 * filtering never permanently changes what the user had manually folded/unfolded. `undefined`
	 * (rather than absent from the map) is a valid stored value, so presence-checking uses `has`. */
	private preFilterCollapsedState: Map<string, boolean | undefined> | null = null;
	/** PR 9 (issue 6): tracked so the filter input's handler can push a live update into an
	 * already-open Module Contents modal, rather than the modal only ever seeing the filter text
	 * that was active at the moment it was opened. */
	private openModuleModal: ModuleContentsModal | null = null;
	private dragPayload: DragPayload | null = null;
	/** Review follow-up (retroactive PR 9 finding): cancels whichever module row's dwell timer is
	 * currently pending, if any — invoked from the window-level `dragend` backstop below. At most
	 * one dwell timer is ever pending at a time in practice (only one row can be mid-hover during a
	 * single drag), so a single reference is enough; each `wireModuleRow` call points this at its
	 * own `cancelDwell` while its timer is live and clears it again once the timer fires or cancels
	 * normally via `dragleave`/`drop`. */
	private cancelActiveDwell: (() => void) | null = null;
	private unsubscribers: (() => void)[] = [];
	private renderQueued = false;
	/** F11: rebuilt once per render from the flat unit list, so resolving a ref is O(1) instead of
	 * an O(n) `find` per row — at thousands of units the naive scan-per-row was O(n^2) per render. */
	private unitsByRefKey = new Map<string, Unit>();
	/** Tracked so `render()` can restore focus/caret after rebuilding the toolbar — see the comment
	 * in `render()` for why this is necessary at all. */
	private filterInputEl: HTMLInputElement | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: AtlasPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return ATLAS_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Atlas";
	}

	getIcon(): string {
		return "map";
	}

	async onOpen(): Promise<void> {
		this.unsubscribers.push(this.plugin.unitIndex.onChange(() => this.queueRender()));
		this.unsubscribers.push(this.plugin.viewsManager.onChange(() => this.queueRender()));
		this.registerEvent(this.plugin.app.workspace.on("active-leaf-change", () => this.updateActiveHighlight()));
		this.registerEvent(this.plugin.app.workspace.on("file-open", () => this.updateActiveHighlight()));
		// Review follow-up (retroactive PR 9 finding): `dragPayload` was only ever cleared by a
		// specific row's own `drop` handler or a Module Contents modal closing — never by a drag
		// ending abnormally (dropped outside the window, over an uninstrumented area, cancelled via
		// Escape). A stale `dragPayload` was harmless before PR 9 (nothing read it outside an active
		// drop), but PR 9's dwell timer treats its mere presence as proof a drag is live, so a later,
		// unrelated drag hovering a module row within the dwell window could pop the Contents modal
		// using stale drag data. This window-level backstop clears it (and cancels any pending dwell
		// timer) whenever a drag ends, regardless of how.
		this.registerDomEvent(window, "dragend", () => {
			this.dragPayload = null;
			this.cancelActiveDwell?.();
		});
		await this.render();
	}

	async onClose(): Promise<void> {
		for (const unsub of this.unsubscribers) unsub();
	}

	/** Collapses bursts of index/view change events (a drag can fire several) into one render. */
	private queueRender(): void {
		if (this.renderQueued) return;
		this.renderQueued = true;
		window.setTimeout(() => {
			this.renderQueued = false;
			void this.render();
		}, 0);
	}

	// --- ref resolution (shared by bucket + inbox rendering) -------------------------------------

	private async resolveRef(ref: UnitRef): Promise<RowInfo> {
		const unit = this.unitsByRefKey.get(unitRefKey(ref));
		if (unit) {
			const resolved = await resolveUnit(this.plugin.app, this.plugin.settings, unit, this.plugin.freeBlockTextCache);
			if (resolved) return { text: resolved.text, secondary: resolved.secondary, icon: resolved.icon, promoted: resolved.promoted, missing: false };
		}
		// F9: refs are never deleted automatically — render greyed as missing rather than crash.
		const fallbackText = ref.kind === "block" ? ref.subpath : (ref.path.split("/").pop() ?? ref.path);
		return { text: fallbackText, icon: ref.kind === "folder" ? "folder" : ref.kind === "block" ? "quote" : "file", promoted: false, missing: true };
	}

	// --- top-level render --------------------------------------------------------------------------

	private async render(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		const scrollTop = container.scrollTop;
		// The filter input lives inside `container` and gets torn down by `container.empty()` below
		// like everything else — every keystroke re-renders the whole view (index/view-change events
		// and typing both go through this same `render()`). Capture focus/caret here and restore it
		// on the freshly-created input after rebuilding, or every keystroke past the first would be
		// silently lost as focus falls off the removed element.
		const activeEl = document.activeElement;
		const filterHadFocus = activeEl instanceof HTMLInputElement && activeEl.classList.contains("atlas-filter");
		const filterSelectionStart = filterHadFocus ? activeEl.selectionStart : null;
		const filterSelectionEnd = filterHadFocus ? activeEl.selectionEnd : null;

		container.empty();
		container.addClass("atlas-explorer");

		const view = this.plugin.viewsManager.getActiveView();
		const allUnits = this.plugin.unitIndex.getUnits();
		this.unitsByRefKey = new Map(allUnits.map((u) => [unitRefKey(unitToRef(u)), u]));

		this.renderToolbar(container, view);
		if (filterHadFocus && this.filterInputEl) {
			this.filterInputEl.focus();
			this.filterInputEl.setSelectionRange(filterSelectionStart, filterSelectionEnd);
		}

		const bucketEl = container.createDiv({ cls: "atlas-section atlas-bucket" });
		await this.renderBucketSection(bucketEl, view);

		const inboxUnits = this.plugin.viewsManager.getInboxUnits(allUnits, view.id, view.inboxMode);
		const inboxEl = container.createDiv({ cls: "atlas-section atlas-inbox" });
		await this.renderInboxSection(inboxEl, view, inboxUnits);

		container.scrollTop = scrollTop;
		this.updateActiveHighlight();
	}

	// --- toolbar -------------------------------------------------------------------------------

	/** PR 9: one dense row, three sections (view identity | create | view controls) — replaces the
	 * previous always-visible New/Rename/Delete-view icon trio (moved to the view-name button's
	 * right-click menu) and the always-visible filter input (now behind a reveal toggle), per Dan's
	 * live-testing feedback that the old toolbar was too cluttered to fit one line comfortably. */
	private renderToolbar(container: HTMLElement, view: View): void {
		const toolbar = container.createDiv({ cls: "atlas-toolbar" });

		// --- section 1: view identity ---------------------------------------------------------
		const viewName = toolbar.createDiv({ cls: "atlas-view-name" });
		viewName.setText(view.name);
		setTooltip(viewName, "Click to switch views, right-click for more");
		viewName.addEventListener("click", () => {
			new ViewSuggestModal(this.plugin.app, this.plugin.viewsManager.getViews(), (v) => {
				this.plugin.viewsManager.setActiveViewId(v.id);
			}).open();
		});
		viewName.addEventListener("contextmenu", (evt) => {
			evt.preventDefault();
			const menu = new Menu();
			menu.addItem((item) =>
				item.setTitle("New view").setIcon("plus").onClick(() => {
					new TextPromptModal(this.plugin.app, "New view", "", (name) => {
						if (!name.trim()) return;
						const created = this.plugin.viewsManager.createView(name);
						if (!created) return new Notice(`Atlas: a view named "${name}" already exists.`);
						this.plugin.viewsManager.setActiveViewId(created.id);
					}).open();
				})
			);
			menu.addItem((item) =>
				item.setTitle("Rename view").setIcon("pencil").onClick(() => {
					new TextPromptModal(this.plugin.app, "Rename view", view.name, (name) => {
						if (!this.plugin.viewsManager.renameView(view.id, name)) {
							new Notice(`Atlas: a view named "${name}" already exists.`);
						}
					}).open();
				})
			);
			menu.addItem((item) =>
				item.setTitle("Delete view").setIcon("trash-2").onClick(() => {
					new ConfirmModal(
						this.plugin.app,
						`Delete the view "${view.name}"? Units placed only in this view move to the global inbox — nothing on disk changes.`,
						"Delete",
						() => this.plugin.viewsManager.deleteView(view.id)
					).open();
				})
			);
			menu.showAtMouseEvent(evt);
		});

		toolbar.createDiv({ cls: "atlas-toolbar-sep" });

		// --- section 2: create ------------------------------------------------------------------
		this.toolbarButton(toolbar, "square-plus", "Add block", () => void addBlock(this.plugin));
		this.toolbarButton(toolbar, "file-plus", "Add file", () => void this.addFile());
		this.toolbarButton(toolbar, "folder-plus", "Add module", () => void this.addFolder());
		this.toolbarButton(toolbar, "layers", "Add folder", () => this.addMetaFolder(view, null));

		toolbar.createDiv({ cls: "atlas-toolbar-sep" });

		// --- section 3: view controls ------------------------------------------------------------
		this.toolbarButton(toolbar, this.sortMode === "manual" ? "arrow-up-down" : "arrow-down-a-z", "Sort: manual / A–Z", () => {
			this.sortMode = this.sortMode === "manual" ? "alphabetical" : "manual";
			void this.render();
		});
		this.toolbarButton(toolbar, "chevrons-down-up", "Collapse all", () => this.plugin.viewsManager.collapseAll(view.id));
		this.toolbarButton(toolbar, "search", "Filter", () => {
			this.filterRevealed = !this.filterRevealed;
			if (this.filterRevealed) {
				this.focusFilterOnNextRender = true;
			} else if (this.filterText) {
				// Closing the reveal always returns to the unfiltered view — a hidden input still
				// silently filtering the list would be confusing, with no visible query to explain it.
				this.filterText = "";
				this.restoreFoldStateAfterFilterClear();
			}
			void this.render();
		});

		const filterWrap = toolbar.createDiv({ cls: "atlas-filter-wrap" });
		filterWrap.toggleClass("is-revealed", this.filterRevealed);
		const filterInner = filterWrap.createDiv({ cls: "atlas-filter-wrap-inner" });
		const filterInput = filterInner.createEl("input", { cls: "atlas-filter", attr: { type: "text", placeholder: "Filter…" } });
		filterInput.value = this.filterText;
		this.filterInputEl = filterInput;
		filterInput.addEventListener("input", () => {
			const wasActive = !!this.filterText.trim();
			this.filterText = filterInput.value;
			if (wasActive && !this.filterText.trim()) this.restoreFoldStateAfterFilterClear();
			this.openModuleModal?.setFilterText(this.filterText);
			void this.render();
		});
		if (this.focusFilterOnNextRender) {
			this.focusFilterOnNextRender = false;
			window.setTimeout(() => filterInput.focus(), 0);
		}
	}

	private toolbarButton(toolbar: HTMLElement, icon: string, tooltip: string, onClick: () => void): void {
		const btn = toolbar.createDiv({ cls: "atlas-toolbar-btn" });
		setIcon(btn, icon);
		setTooltip(btn, tooltip);
		btn.addEventListener("click", onClick);
	}

	private async addFile(): Promise<void> {
		const file = await this.plugin.app.vault.create(await this.uniquePath("Untitled", "md"), "");
		await this.plugin.app.workspace.getLeaf(false).openFile(file);
	}

	private async addFolder(): Promise<void> {
		await this.plugin.app.vault.createFolder(await this.uniquePath("New module", null));
	}

	private async uniquePath(base: string, ext: string | null, folder = ""): Promise<string> {
		const suffix = ext ? `.${ext}` : "";
		const prefix = folder ? `${folder}/` : "";
		let candidate = `${prefix}${base}${suffix}`;
		let i = 1;
		while (this.plugin.app.vault.getAbstractFileByPath(candidate)) {
			candidate = `${prefix}${base} ${++i}${suffix}`;
		}
		return candidate;
	}

	private addMetaFolder(view: View, parentId: string | null): void {
		new TextPromptModal(this.plugin.app, "New folder", "New folder", (label) => {
			if (label.trim()) this.plugin.viewsManager.addMetaFolder(view.id, parentId, label);
		}).open();
	}

	// --- bucket ----------------------------------------------------------------------------------

	private async renderBucketSection(container: HTMLElement, view: View): Promise<void> {
		const header = container.createDiv({ cls: "atlas-section-header" });
		const chevron = header.createDiv({ cls: "atlas-chevron" });
		setIcon(chevron, this.bucketCollapsed ? "chevron-right" : "chevron-down");
		header.createSpan({ text: "Bucket" });
		header.addEventListener("click", () => {
			this.bucketCollapsed = !this.bucketCollapsed;
			void this.render();
		});

		if (this.bucketCollapsed) return;

		// The whole section (not just the list of existing rows) is the bucket-root drop target —
		// registering it on `listEl` alone left almost no reliable empty area to hit once a few
		// rows existed (the div's own height hugs its content in normal block flow, so dropping
		// just below the last row landed on `container`, which had no drop handler at all). Any
		// specific row still wins first via its own drop handler's `stopPropagation`.
		this.makeDropZone(container, { kind: "bucket-root", viewId: view.id });

		const listEl = container.createDiv({ cls: "atlas-node-list" });
		await this.renderNodeList(view.root, listEl, view, 0);
	}

	private async renderNodeList(nodes: ViewNode[], container: HTMLElement, view: View, depth: number): Promise<void> {
		for (const node of nodes) {
			await this.renderNode(node, container, view, depth);
		}
	}

	private matchesFilter(text: string): boolean {
		if (!this.filterText.trim()) return true;
		return text.toLowerCase().includes(this.filterText.trim().toLowerCase());
	}

	/** PR 9 (issue 6): does this subtree contain a unit whose resolved text matches the active
	 * filter? Used to force-reveal a folder that would otherwise hide a match behind a stale fold. */
	private async subtreeHasMatch(nodes: ViewNode[]): Promise<boolean> {
		for (const n of nodes) {
			if (n.type === "unit" && n.ref) {
				const info = await this.resolveRef(n.ref);
				if (this.matchesFilter(info.text)) return true;
			}
			if (n.children.length > 0 && (await this.subtreeHasMatch(n.children))) return true;
		}
		return false;
	}

	/** PR 9 (issue 6): restores every folder's fold state to what it was immediately before the
	 * current filter run started force-revealing matches, then forgets that snapshot. Safe to call
	 * even with nothing to restore (`preFilterCollapsedState` is null until a filter actually
	 * force-reveals something). */
	private restoreFoldStateAfterFilterClear(): void {
		if (!this.preFilterCollapsedState) return;
		const view = this.plugin.viewsManager.getActiveView();
		for (const [nodeId, collapsed] of this.preFilterCollapsedState) {
			this.plugin.viewsManager.setNodeCollapsed(view.id, nodeId, !!collapsed);
		}
		this.preFilterCollapsedState = null;
	}

	private async renderNode(node: ViewNode, container: HTMLElement, view: View, depth: number): Promise<void> {
		if (node.type === "meta") {
			const row = container.createDiv({ cls: "atlas-row atlas-row-meta" });
			row.style.paddingLeft = `${depth * 16}px`;
			row.setAttr("draggable", "true");
			const chevron = row.createDiv({ cls: "atlas-chevron" });
			const iconEl = row.createDiv({ cls: "atlas-icon" });
			setIcon(iconEl, "layers");
			row.createSpan({ cls: "atlas-row-text", text: node.label ?? "" });

			row.addEventListener("dragstart", () => (this.dragPayload = { kind: "node", nodeId: node.id, viewId: view.id }));
			this.makeDropZone(row, { kind: "node", nodeId: node.id, viewId: view.id });
			row.addEventListener("keydown", (evt) => this.handleRowKeydown(evt, node, view));
			row.tabIndex = 0;
			row.addEventListener("contextmenu", (evt) => {
				evt.preventDefault();
				this.showMetaFolderMenu(evt, node, view);
			});

			// PR 9 (issue 6): a filter-matching descendant force-reveals this folder regardless of its
			// own collapsed state, so a match is never hidden behind a stale fold. The state from just
			// before the filter started touching it is remembered (once) so clearing the filter can put
			// it back exactly, rather than leaving every folder the filter happened to open expanded.
			const filterActive = !!this.filterText.trim();
			let effectiveCollapsed = !!node.collapsed;
			if (filterActive) {
				if (!this.preFilterCollapsedState) this.preFilterCollapsedState = new Map();
				if (!this.preFilterCollapsedState.has(node.id)) this.preFilterCollapsedState.set(node.id, node.collapsed);
				if (await this.subtreeHasMatch(node.children)) effectiveCollapsed = false;
			}
			setIcon(chevron, effectiveCollapsed ? "chevron-right" : "chevron-down");

			// Children always render (regardless of collapsed state) inside a dedicated wrapper, so
			// collapsing/expanding can be a CSS transition on that wrapper (grid-template-rows 1fr↔0fr,
			// the standard height:auto-safe collapse technique) instead of the row disappearing from
			// the DOM outright. The state-persisting call (which triggers a full re-render via
			// `onChange`) is deliberately delayed to let the transition actually play first — firing
			// it immediately would rebuild the DOM from scratch on the next tick and cut the animation
			// short with a hard snap instead of a slide.
			const childrenWrap = container.createDiv({ cls: "atlas-meta-children" });
			childrenWrap.toggleClass("is-collapsed", effectiveCollapsed);
			const childrenInner = childrenWrap.createDiv({ cls: "atlas-meta-children-inner" });
			await this.renderNodeList(node.children, childrenInner, view, depth + 1);

			// Local optimistic state, not `node.collapsed` — real bug caught in review: `node.collapsed`
			// only updates once the delayed `setNodeCollapsed` below actually runs, so a second click
			// inside that window previously read the same stale value as the first and re-applied the
			// same direction instead of toggling back. Also cancels/reschedules the pending persist
			// call per click, so only the last click in a rapid burst ever gets persisted.
			let localCollapsed = effectiveCollapsed;
			let pendingPersist: number | undefined;
			chevron.addEventListener("click", (evt) => {
				evt.stopPropagation();
				localCollapsed = !localCollapsed;
				setIcon(chevron, localCollapsed ? "chevron-right" : "chevron-down");
				childrenWrap.toggleClass("is-collapsed", localCollapsed);
				if (pendingPersist !== undefined) window.clearTimeout(pendingPersist);
				pendingPersist = window.setTimeout(() => {
					pendingPersist = undefined;
					this.plugin.viewsManager.setNodeCollapsed(view.id, node.id, localCollapsed);
				}, META_COLLAPSE_TRANSITION_MS);
			});
			return;
		}

		const ref = node.ref;
		if (!ref) return;
		const info = await this.resolveRef(ref);
		if (!this.matchesFilter(info.text)) return;

		const row = container.createDiv({ cls: "atlas-row atlas-row-unit" });
		if (info.missing) row.addClass("atlas-missing");
		row.dataset.refKey = unitRefKey(ref);
		row.style.paddingLeft = `${depth * 16 + UNIT_ROW_CHEVRON_OFFSET}px`;
		row.setAttr("draggable", "true");

		const iconEl = row.createDiv({ cls: "atlas-icon" });
		setIcon(iconEl, info.icon);
		row.createSpan({ cls: "atlas-row-text", text: info.text });
		if (info.promoted) row.createSpan({ cls: "atlas-badge", text: "promoted" });
		if (info.secondary) row.createSpan({ cls: "atlas-row-secondary", text: info.secondary });
		if (info.missing) {
			row.createSpan({ cls: "atlas-row-secondary", text: "(missing)" });
			const removeBtn = row.createDiv({ cls: "atlas-row-action" });
			setIcon(removeBtn, "x");
			setTooltip(removeBtn, "Remove from view");
			removeBtn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.plugin.viewsManager.unplaceUnit(view.id, ref);
			});
		}
		// PR 9 (issue 2): modules never expand inline anymore, in the bucket or the inbox — the icon
		// opens the Module Contents modal instead. `ref.kind === "folder"` covers both folder-unit and
		// promoted-folder (both are real folders on disk, per `unitToRef`).
		if (!info.missing && ref.kind === "folder") this.wireModuleRow(row, iconEl, ref.path);

		this.setPlacementTooltip(row, ref);
		row.addEventListener("click", () => void this.openRef(ref));
		row.addEventListener("dragstart", () => (this.dragPayload = { kind: "node", nodeId: node.id, viewId: view.id }));
		this.makeDropZone(row, { kind: "node", nodeId: node.id, viewId: view.id });
		row.tabIndex = 0;
		row.addEventListener("keydown", (evt) => this.handleRowKeydown(evt, node, view));
		row.addEventListener("contextmenu", (evt) => {
			evt.preventDefault();
			this.showUnitMenu(evt, ref, view, node.id);
		});
	}

	// --- inbox -----------------------------------------------------------------------------------

	private async renderInboxSection(container: HTMLElement, view: View, units: Unit[]): Promise<void> {
		const header = container.createDiv({ cls: "atlas-section-header" });
		const chevron = header.createDiv({ cls: "atlas-chevron" });
		setIcon(chevron, this.inboxCollapsed ? "chevron-right" : "chevron-down");
		header.createSpan({ text: "Inbox" });
		header.createSpan({ cls: "atlas-badge atlas-count-badge", text: String(units.length) });

		const modeToggle = header.createDiv({ cls: "atlas-inbox-mode" });
		for (const mode of ["view", "global"] as const) {
			const btn = modeToggle.createSpan({ cls: "atlas-inbox-mode-btn", text: mode === "view" ? "This view" : "Global" });
			if (view.inboxMode === mode) btn.addClass("is-active");
			btn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.plugin.viewsManager.setInboxMode(view.id, mode);
			});
		}

		header.addEventListener("click", () => {
			this.inboxCollapsed = !this.inboxCollapsed;
			void this.render();
		});

		if (this.inboxCollapsed) return;

		const listEl = container.createDiv({ cls: "atlas-node-list" });
		this.makeDropZone(listEl, { kind: "inbox-area", viewId: view.id });

		const resolved = await Promise.all(
			units.map(async (unit) => ({ unit, ref: unitToRef(unit), info: await this.resolveRef(unitToRef(unit)) }))
		);
		const filtered = resolved.filter((r) => this.matchesFilter(r.info.text));
		const sorted =
			this.sortMode === "alphabetical"
				? filtered.sort((a, b) => a.info.text.localeCompare(b.info.text))
				: filtered.sort((a, b) => {
						const fileA = this.plugin.app.vault.getAbstractFileByPath(a.unit.path);
						const fileB = this.plugin.app.vault.getAbstractFileByPath(b.unit.path);
						const ctimeA = fileA instanceof TFile ? fileA.stat.ctime : 0;
						const ctimeB = fileB instanceof TFile ? fileB.stat.ctime : 0;
						return ctimeB - ctimeA; // newest first, per spec default
				  });

		// F11: the inbox can be thousands of rows (5,000 files + 2,000 free blocks scale target).
		// The non-virtualized fallback this used to need for expanded folder-unit internals is gone —
		// PR 9 (issue 2) replaced inline inbox expansion with the Module Contents modal, so every
		// inbox row is now fixed-height and the virtualized path always applies.
		this.renderVirtualizedInboxRows(listEl, sorted);
	}

	private renderInboxRow(container: HTMLElement, ref: UnitRef, info: RowInfo): HTMLElement {
		const row = container.createDiv({ cls: "atlas-row atlas-row-unit" });
		row.dataset.refKey = unitRefKey(ref);
		row.setAttr("draggable", "true");
		const iconEl = row.createDiv({ cls: "atlas-icon" });
		setIcon(iconEl, info.icon);
		row.createSpan({ cls: "atlas-row-text", text: info.text });
		if (info.promoted) row.createSpan({ cls: "atlas-badge", text: "promoted" });
		if (info.secondary) row.createSpan({ cls: "atlas-row-secondary", text: info.secondary });
		// PR 9 (issue 2): modules never expand inline anymore, in the inbox or the bucket — the icon
		// opens the Module Contents modal instead (see `wireModuleRow`).
		if (ref.kind === "folder") this.wireModuleRow(row, iconEl, ref.path);

		this.setPlacementTooltip(row, ref);
		row.addEventListener("click", () => void this.openRef(ref));
		row.addEventListener("dragstart", () => (this.dragPayload = { kind: "inbox", ref }));
		row.tabIndex = 0;
		row.addEventListener("contextmenu", (evt) => {
			evt.preventDefault();
			this.showInboxUnitMenu(evt, ref);
		});
		return row;
	}

	/** F11: renders only the rows within the scrolled viewport (+ overscan) of a fixed-height,
	 * absolutely-positioned window, with a full-height spacer so the scrollbar reflects the true
	 * list length. Redraws on scroll (rAF-throttled) rather than re-running the whole view's
	 * `render()`, so scrolling thousands of rows doesn't re-resolve/re-sort/re-render the toolbar
	 * and bucket section on every frame. */
	private renderVirtualizedInboxRows(listEl: HTMLElement, sorted: { ref: UnitRef; info: RowInfo; unit: Unit }[]): void {
		const viewport = listEl.createDiv({ cls: "atlas-inbox-viewport" });
		const spacer = viewport.createDiv({ cls: "atlas-inbox-spacer" });
		spacer.style.height = `${sorted.length * INBOX_ROW_HEIGHT}px`;

		let frameQueued = false;
		const drawWindow = () => {
			frameQueued = false;
			spacer.empty();
			const viewportHeight = viewport.clientHeight || 300;
			const start = Math.max(0, Math.floor(viewport.scrollTop / INBOX_ROW_HEIGHT) - INBOX_OVERSCAN);
			const count = Math.ceil(viewportHeight / INBOX_ROW_HEIGHT) + INBOX_OVERSCAN * 2;
			const end = Math.min(sorted.length, start + count);
			for (let i = start; i < end; i++) {
				const { ref, info } = sorted[i];
				const row = this.renderInboxRow(spacer, ref, info);
				row.addClass("atlas-row-virtual");
				row.style.top = `${i * INBOX_ROW_HEIGHT}px`;
			}
		};

		drawWindow();
		viewport.addEventListener("scroll", () => {
			if (frameQueued) return;
			frameQueued = true;
			window.requestAnimationFrame(drawWindow);
		});
	}

	/** F3: promotes and places a module's internal file/folder — called from the Module Contents
	 * modal's "Promote and place in view…" context menu item (`promoteAndPlaceFlow`). Used to also be
	 * reachable by dragging an internal out of an inline-expanded tree; PR 9 (issue 2) replaced that
	 * inline expansion with the modal, and a modal backdrop makes dragging out into the now-hidden
	 * bucket impractical, so this is click-driven only now. */
	private promoteAndPlace(path: string, isFolder: boolean, view: View, parentId: string | null): void {
		const ref: UnitRef = isFolder ? { kind: "folder", path } : { kind: "file", path };
		this.plugin.unitIndex.addManualPromotion(ref);
		void this.plugin.saveManualPromotions();
		this.plugin.viewsManager.placeUnit(view.id, ref, parentId);
	}

	// --- drag and drop -----------------------------------------------------------------------------

	private makeDropZone(
		el: HTMLElement,
		target: { kind: "node"; nodeId: string; viewId: string } | { kind: "bucket-root"; viewId: string } | { kind: "inbox-area"; viewId: string }
	): void {
		el.addEventListener("dragover", (evt) => {
			if (!this.dragPayload) return;
			evt.preventDefault();
			el.addClass("atlas-drop-target");
		});
		el.addEventListener("dragleave", () => el.removeClass("atlas-drop-target"));
		el.addEventListener("drop", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			el.removeClass("atlas-drop-target");
			this.handleDrop(target);
		});
	}

	/** The only branch that ever calls `fileManager.renameFile` in the whole explorer — dropping a
	 * file/block directly onto a folder-unit (see `handleAddToModule`), a deliberate, confirmable
	 * exception to Part 7's "never touches disk" rule for everything else here. */
	private handleDrop(target: { kind: "node"; nodeId: string; viewId: string } | { kind: "bucket-root"; viewId: string } | { kind: "inbox-area"; viewId: string }): void {
		const payload = this.dragPayload;
		this.dragPayload = null;
		if (!payload) return;

		if (target.kind === "inbox-area") {
			if (payload.kind === "node") this.plugin.viewsManager.unplaceUnit(payload.viewId, this.refOfNode(payload));
			return;
		}

		const viewId = target.viewId;
		if (target.kind === "node") {
			const view = this.plugin.viewsManager.getView(viewId);
			const found = view && this.findNodeAnywhere(view.root, target.nodeId);
			if (found?.node.type === "unit" && found.node.ref?.kind === "folder") {
				const ref = payload.kind === "inbox" ? payload.ref : this.refOfNode(payload);
				// Only a file/block being dropped onto a folder-unit is "add to module" — dropping
				// one folder-unit onto another would mean moving a whole folder's worth of content
				// and internals wholesale, out of scope for what was asked; falls through to the
				// ordinary sibling-insert behavior below instead.
				if (ref && ref.kind !== "folder") {
					void this.handleAddToModule(ref, found.node.ref.path);
					return;
				}
			}
		}

		let parentId: string | null = null;
		let index = 0;
		if (target.kind === "node") {
			const view = this.plugin.viewsManager.getView(viewId);
			const found = view && this.findNodeAnywhere(view.root, target.nodeId);
			if (found?.node.type === "meta") {
				parentId = found.node.id;
				index = found.node.children.length;
			} else if (found) {
				// Part 4 edge case: dropping onto a unit node inserts as a sibling after it — in
				// whichever parent (root or meta folder) that unit node actually lives in, not
				// unconditionally the bucket root (a real bug caught in review: a unit nested
				// inside a meta folder would incorrectly escape to root on this branch).
				const parent = this.parentIdOf(view!.root, target.nodeId);
				parentId = parent === undefined ? null : parent;
				index = this.indexInParent(view!.root, target.nodeId) + 1;
			}
		}

		const ref = payload.kind === "inbox" ? payload.ref : this.refOfNode(payload);
		if (!ref) return;
		this.plugin.viewsManager.placeUnit(viewId, ref, parentId);
		if (payload.kind === "node" && parentId !== undefined) {
			this.plugin.viewsManager.moveNode(viewId, this.nodeIdForRef(viewId, ref) ?? "", parentId, index);
		}
	}

	/** Files/blocks are opaque internals to a folder-unit until something links to them — dropping
	 * one directly onto the module is the one deliberate way this explorer lets you physically file
	 * something into it, since Atlas otherwise never rearranges a module's internal organization.
	 * Gated by a confirm dialog (toggleable in settings) precisely because it's the one exception.
	 * Whether the moved file stays visible as its own addressable unit afterward is decided entirely
	 * by the existing link-graph promotion recompute (does it have a real backlink from outside the
	 * module?) — this never force-promotes it; a file with no backlinks simply becomes ordinary,
	 * invisible internals, matching the rest of the model. */
	private async handleAddToModule(ref: UnitRef, folderPath: string, skipConfirm = false): Promise<void> {
		const file = this.plugin.app.vault.getAbstractFileByPath(ref.path);
		const folder = this.plugin.app.vault.getAbstractFileByPath(folderPath);
		if (!(file instanceof TFile) || !(folder instanceof TFolder)) return;

		const perform = async (): Promise<void> => {
			const dotIndex = file.name.lastIndexOf(".");
			const base = dotIndex > 0 ? file.name.slice(0, dotIndex) : file.name;
			const ext = dotIndex > 0 ? file.name.slice(dotIndex + 1) : null;
			const newPath = await this.uniquePath(base, ext, folderPath);
			await this.plugin.app.fileManager.renameFile(file, newPath);

			const newRef: UnitRef = ref.kind === "block" ? { kind: "block", path: newPath, subpath: ref.subpath } : { kind: "file", path: newPath };
			// Promotion status only settles once Obsidian's own link graph re-resolves after the
			// move (rewritten backlink text elsewhere needs a metadataCache pass) — wait for exactly
			// that event once, then clean up any now-stale placement rather than leave a "missing"
			// ghost if it turned out to have no real backlinks and isn't a unit anymore. Cleaned up in
			// *every* view that held it (review, A11), not just the one the drag originated in — the
			// file moved on disk for the whole vault, not "within" whichever view was on screen, so
			// losing unit status is a vault-wide fact the same way `onVaultRename`'s own ref-rewriting
			// already treats path changes as cross-view, not scoped to one view's context.
			const offRef = this.plugin.app.metadataCache.on("resolved", () => {
				this.plugin.app.metadataCache.offref(offRef);
				const stillAUnit = this.plugin.unitIndex.getUnits().some((u) => unitRefKey(unitToRef(u)) === unitRefKey(newRef));
				if (!stillAUnit) {
					for (const v of this.plugin.viewsManager.getViews()) this.plugin.viewsManager.unplaceUnit(v.id, newRef);
				}
			});
		};

		// PR 9 (issue 2, point 5): dropping into a specific nested location via the Module Contents
		// modal (opened by holding a drag over the module rather than releasing it) skips the confirm
		// dialog outright, regardless of the setting — the deliberate hold-to-open gesture and picking
		// an exact destination inside the modal already *is* the confirmation. The setting only ever
		// gated the plain direct-drop path.
		if (skipConfirm) {
			await perform();
		} else if (this.plugin.settings.confirmAddToModule) {
			new ConfirmModal(
				this.plugin.app,
				`Add "${file.basename}" to "${folder.name}"? This moves the file on disk into that folder — Atlas doesn't otherwise touch a module's internal organization.`,
				"Add",
				() => void perform()
			).open();
		} else {
			await perform();
		}
	}

	private refOfNode(payload: { kind: "node"; nodeId: string; viewId: string }): UnitRef {
		const view = this.plugin.viewsManager.getView(payload.viewId);
		const found = view && this.findNodeAnywhere(view.root, payload.nodeId);
		return found?.node.ref ?? { kind: "file", path: "" };
	}

	private nodeIdForRef(viewId: string, ref: UnitRef): string | null {
		const view = this.plugin.viewsManager.getView(viewId);
		if (!view) return null;
		const search = (nodes: ViewNode[]): string | null => {
			for (const node of nodes) {
				if (node.type === "unit" && node.ref && unitRefsEqual(node.ref, ref)) return node.id;
				const found = search(node.children);
				if (found) return found;
			}
			return null;
		};
		return search(view.root);
	}

	private findNodeAnywhere(nodes: ViewNode[], nodeId: string): { node: ViewNode } | null {
		for (const node of nodes) {
			if (node.id === nodeId) return { node };
			const found = this.findNodeAnywhere(node.children, nodeId);
			if (found) return found;
		}
		return null;
	}

	private indexInParent(nodes: ViewNode[], nodeId: string): number {
		const idx = nodes.findIndex((n) => n.id === nodeId);
		if (idx !== -1) return idx;
		for (const node of nodes) {
			const found = this.indexInParent(node.children, nodeId);
			if (found !== -1) return found;
		}
		return -1;
	}

	/** The id of the meta folder `nodeId` actually lives in, or `null` if it's at the bucket root.
	 * Returns `undefined` only if `nodeId` isn't in the tree at all (callers treat that as root). */
	private parentIdOf(nodes: ViewNode[], nodeId: string, parentId: string | null = null): string | null | undefined {
		for (const node of nodes) {
			if (node.id === nodeId) return parentId;
			const found = this.parentIdOf(node.children, nodeId, node.id);
			if (found !== undefined) return found;
		}
		return undefined;
	}

	// --- context menus -----------------------------------------------------------------------------

	private showUnitMenu(evt: MouseEvent, ref: UnitRef, view: View, nodeId: string): void {
		const menu = new Menu();
		menu.addItem((item) => item.setTitle("Open").setIcon("file").onClick(() => void this.openRef(ref)));
		menu.addItem((item) => item.setTitle("Open in new tab").setIcon("file-plus").onClick(() => void this.openRef(ref, true)));
		if (ref.kind === "file" || ref.kind === "folder") {
			menu.addItem((item) => item.setTitle("Reveal in native explorer").setIcon("folder-open").onClick(() => this.revealInNativeExplorer(ref.path)));
		}
		menu.addItem((item) => item.setTitle("Copy link").setIcon("link").onClick(() => void this.copyLink(ref)));
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("Remove from view")
				.setIcon("x")
				.onClick(() => this.plugin.viewsManager.unplaceUnit(view.id, ref))
		);
		menu.addItem((item) => item.setTitle("Place in view…").setIcon("arrow-right-left").onClick(() => this.placeInViewFlow(ref)));
		menu.showAtMouseEvent(evt);
	}

	private showInboxUnitMenu(evt: MouseEvent, ref: UnitRef): void {
		const menu = new Menu();
		menu.addItem((item) => item.setTitle("Open").setIcon("file").onClick(() => void this.openRef(ref)));
		menu.addItem((item) => item.setTitle("Open in new tab").setIcon("file-plus").onClick(() => void this.openRef(ref, true)));
		if (ref.kind === "file" || ref.kind === "folder") {
			menu.addItem((item) => item.setTitle("Reveal in native explorer").setIcon("folder-open").onClick(() => this.revealInNativeExplorer(ref.path)));
		}
		if (ref.kind === "folder") {
			const folder = this.plugin.app.vault.getAbstractFileByPath(ref.path);
			if (folder instanceof TFolder && !findInterfaceNote(this.plugin.app, folder, this.plugin.settings)) {
				menu.addItem((item) =>
					item
						.setTitle("Create interface note")
						.setIcon("file-plus-2")
						.onClick(async () => {
							const note = await createInterfaceNote(this.plugin.app, folder);
							await this.plugin.app.workspace.getLeaf(false).openFile(note);
						})
				);
			}
		}
		menu.addItem((item) => item.setTitle("Copy link").setIcon("link").onClick(() => void this.copyLink(ref)));
		menu.addSeparator();
		menu.addItem((item) => item.setTitle("Place in view…").setIcon("arrow-right-left").onClick(() => this.placeInViewFlow(ref)));
		menu.showAtMouseEvent(evt);
	}

	private showMetaFolderMenu(evt: MouseEvent, node: ViewNode, view: View): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle("Rename folder")
				.setIcon("pencil")
				.onClick(() => {
					new TextPromptModal(this.plugin.app, "Rename folder", node.label ?? "", (label) => {
						this.plugin.viewsManager.renameMetaFolder(view.id, node.id, label);
					}).open();
				})
		);
		menu.addItem((item) =>
			item
				.setTitle("Delete folder")
				.setIcon("trash-2")
				.onClick(() => {
					new ConfirmModal(
						this.plugin.app,
						`Delete "${node.label}"? Its contents move up one level — nothing on disk changes.`,
						"Delete",
						() => this.plugin.viewsManager.deleteMetaFolder(view.id, node.id)
					).open();
				})
		);
		menu.showAtMouseEvent(evt);
	}

	/** "Place in view ▸" as a two-step fuzzy flow — Obsidian's public Menu API has no submenu support. */
	private placeInViewFlow(ref: UnitRef): void {
		const views = this.plugin.viewsManager.getViews();
		new ViewSuggestModal(this.plugin.app, views, (view) => {
			const targets: MetaTarget[] = [{ id: null, label: "(bucket root)" }, ...flattenMetaFolders(view.root)];
			new MetaFolderSuggestModal(this.plugin.app, targets, (target) => {
				this.plugin.viewsManager.placeUnit(view.id, ref, target.id);
			}).open();
		}).open();
	}

	/** PR 9: click-driven equivalent of F3's "drag an internal out of the expanded tree to promote
	 * and place it" — that gesture stopped being possible once module internals moved into a modal
	 * (a modal backdrop makes dragging out into the now-hidden bucket impractical), so this preserves
	 * the same underlying capability (`promoteAndPlace`) from the Module Contents modal's own
	 * context menu instead of a drag. */
	private promoteAndPlaceFlow(path: string, isFolder: boolean): void {
		const views = this.plugin.viewsManager.getViews();
		new ViewSuggestModal(this.plugin.app, views, (view) => {
			const targets: MetaTarget[] = [{ id: null, label: "(bucket root)" }, ...flattenMetaFolders(view.root)];
			new MetaFolderSuggestModal(this.plugin.app, targets, (target) => {
				this.promoteAndPlace(path, isFolder, view, target.id);
			}).open();
		}).open();
	}

	// --- shared actions ------------------------------------------------------------------------

	private async openRef(ref: UnitRef, newTab = false): Promise<void> {
		if (ref.kind === "block") {
			this.plugin.app.workspace.openLinkText(`${ref.path}#${ref.subpath}`, "", newTab);
			return;
		}
		const file = this.plugin.app.vault.getAbstractFileByPath(ref.path);
		if (ref.kind === "folder" && file instanceof TFolder) {
			const note = findInterfaceNote(this.plugin.app, file, this.plugin.settings);
			if (note) await this.plugin.app.workspace.getLeaf(newTab).openFile(note);
			return;
		}
		if (file instanceof TFile) await this.plugin.app.workspace.getLeaf(newTab).openFile(file);
	}

	private revealInNativeExplorer(path: string): void {
		this.plugin.app.workspace.getLeavesOfType("file-explorer")[0]?.setViewState({ type: "file-explorer" });
		const fileExplorer = this.plugin.app.workspace.getLeavesOfType("file-explorer")[0]?.view as unknown as {
			revealInFolder?: (file: TFile | TFolder) => void;
		};
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if ((file instanceof TFile || file instanceof TFolder) && fileExplorer?.revealInFolder) fileExplorer.revealInFolder(file);
	}

	// --- PR 9 (issue 2): module row icon — opens Module Contents instead of inline fold/unfold ------

	/** Wires a module row's icon (closed↔open crossfade on hover, "View module contents" tooltip,
	 * click opens the modal) and its hover-during-drag dwell timer (point 5) — shared by both the
	 * inbox and bucket unit-row renderers so the two surfaces can't drift apart. `iconEl` is emptied
	 * and rebuilt with the two stacked icons the crossfade needs. */
	private wireModuleRow(row: HTMLElement, iconEl: HTMLElement, folderPath: string): void {
		iconEl.empty();
		iconEl.addClass("atlas-module-icon");
		setIcon(iconEl.createSpan({ cls: "atlas-icon-closed" }), "folder");
		setIcon(iconEl.createSpan({ cls: "atlas-icon-open" }), "folder-open");
		setTooltip(iconEl, "View module contents");
		iconEl.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.openModuleContentsModal(folderPath);
		});

		let dwellTimer: number | undefined;
		const cancelDwell = () => {
			if (dwellTimer === undefined) return;
			window.clearTimeout(dwellTimer);
			dwellTimer = undefined;
			if (this.cancelActiveDwell === cancelDwell) this.cancelActiveDwell = null;
		};
		const startDwell = () => {
			if (!this.dragPayload || dwellTimer !== undefined) return;
			this.cancelActiveDwell = cancelDwell;
			dwellTimer = window.setTimeout(() => {
				dwellTimer = undefined;
				this.cancelActiveDwell = null;
				this.openModuleContentsModalForDrag(folderPath);
			}, MODULE_HOVER_DWELL_MS);
		};
		row.addEventListener("dragover", startDwell);
		row.addEventListener("dragleave", cancelDwell);
		row.addEventListener("drop", cancelDwell);
	}

	private trackModuleModal(modal: ModuleContentsModal): void {
		modal.setFilterText(this.filterText);
		this.openModuleModal = modal;
	}

	private openModuleContentsModal(folderPath: string): void {
		const folder = this.plugin.app.vault.getAbstractFileByPath(folderPath);
		if (!(folder instanceof TFolder)) return;
		const modal: ModuleContentsModal = new ModuleContentsModal(this.plugin.app, folder, {
			onOpenFile: (file) => void this.openRef({ kind: "file", path: file.path }),
			onRevealInNative: (path) => this.revealInNativeExplorer(path),
			onPromoteAndPlace: (path, isFolder) => this.promoteAndPlaceFlow(path, isFolder),
			isFolderExpanded: (path) => this.plugin.isModuleFolderExpanded(path),
			onToggleFolder: (path, expanded) => this.plugin.setModuleFolderExpanded(path, expanded),
			onCloseCallback: () => {
				if (this.openModuleModal === modal) this.openModuleModal = null;
			},
		});
		this.trackModuleModal(modal);
		modal.open();
	}

	/** Opened via the hover-during-drag dwell timer only — every folder shown (including the
	 * module's own root) is a live drop target for whatever's still being dragged, and dropping
	 * anywhere in it skips the usual confirm dialog (`handleAddToModule`'s `skipConfirm`). */
	private openModuleContentsModalForDrag(folderPath: string): void {
		const folder = this.plugin.app.vault.getAbstractFileByPath(folderPath);
		const payload = this.dragPayload;
		if (!(folder instanceof TFolder) || !payload) return;
		const ref = payload.kind === "inbox" ? payload.ref : this.refOfNode(payload);
		if (!ref || ref.kind === "folder") return; // only files/blocks are moveable into a module (see handleDrop)
		const modal: ModuleContentsModal = new ModuleContentsModal(this.plugin.app, folder, {
			onOpenFile: (file) => void this.openRef({ kind: "file", path: file.path }),
			onRevealInNative: (path) => this.revealInNativeExplorer(path),
			onPromoteAndPlace: (path, isFolder) => this.promoteAndPlaceFlow(path, isFolder),
			isFolderExpanded: (path) => this.plugin.isModuleFolderExpanded(path),
			onToggleFolder: (path, expanded) => this.plugin.setModuleFolderExpanded(path, expanded),
			dropTarget: { onDrop: (targetFolderPath) => void this.handleAddToModule(ref, targetFolderPath, true) },
			onCloseCallback: () => {
				if (this.openModuleModal === modal) this.openModuleModal = null;
				this.dragPayload = null; // the drag gesture is considered resolved once this modal closes
			},
		});
		this.trackModuleModal(modal);
		modal.open();
	}

	private async copyLink(ref: UnitRef): Promise<void> {
		const file = this.plugin.app.vault.getAbstractFileByPath(ref.path);
		let link = "";
		if (ref.kind === "block" && file instanceof TFile) {
			link = this.plugin.app.fileManager.generateMarkdownLink(file, "", `#${ref.subpath}`);
		} else if (ref.kind === "folder" && file instanceof TFolder) {
			const note = findInterfaceNote(this.plugin.app, file, this.plugin.settings);
			if (note) link = this.plugin.app.fileManager.generateMarkdownLink(note, "");
		} else if (file instanceof TFile) {
			link = this.plugin.app.fileManager.generateMarkdownLink(file, "");
		}
		if (link) await navigator.clipboard.writeText(link);
	}

	// --- active-file tracking + keyboard ---------------------------------------------------------

	private setPlacementTooltip(row: HTMLElement, ref: UnitRef): void {
		const placements = this.plugin.viewsManager.getPlacements(ref);
		if (placements.length === 0) return;
		const text = placements.map((p) => [p.viewName, ...p.path].join(" › ")).join("\n");
		setTooltip(row, text);
	}

	private updateActiveHighlight(): void {
		const container = this.containerEl.children[1] as HTMLElement;
		const activeFile = this.plugin.app.workspace.getActiveFile();
		container.querySelectorAll(".atlas-row.is-active").forEach((el) => el.removeClass("is-active"));
		if (!activeFile) return;
		const ref: UnitRef = { kind: "file", path: activeFile.path };
		container.querySelectorAll<HTMLElement>(`[data-ref-key="${CSS.escape(unitRefKey(ref))}"]`).forEach((el) => el.addClass("is-active"));
	}

	private handleRowKeydown(evt: KeyboardEvent, node: ViewNode, view: View): void {
		if (evt.key === "Enter" && node.type === "unit" && node.ref) {
			evt.preventDefault();
			void this.openRef(node.ref);
		} else if (evt.key === " " && node.type === "meta") {
			evt.preventDefault();
			this.plugin.viewsManager.setNodeCollapsed(view.id, node.id, !node.collapsed);
		} else if (evt.key === "Delete") {
			evt.preventDefault();
			if (node.type === "unit" && node.ref) this.plugin.viewsManager.unplaceUnit(view.id, node.ref);
		} else if (evt.key === "F2" && node.type === "meta") {
			evt.preventDefault();
			new TextPromptModal(this.plugin.app, "Rename folder", node.label ?? "", (label) => {
				this.plugin.viewsManager.renameMetaFolder(view.id, node.id, label);
			}).open();
		}
	}
}
