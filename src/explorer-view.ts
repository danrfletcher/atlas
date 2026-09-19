import { App, FuzzySuggestModal, ItemView, Menu, Modal, Notice, TFile, TFolder, WorkspaceLeaf, setIcon, setTooltip } from "obsidian";
import type AtlasPlugin from "./main";
import { StatusGovernance, TruncatedStatusConfig, Unit, UnitRef, View, ViewNode, unitRefKey, unitToRef } from "./types";
import { MetaTarget, flattenMetaFolders } from "./views";
import { resolveUnit } from "./unit-display";
import { TextPromptModal, ConfirmModal, StatusesModal } from "./modals";
import { StatusDefinition, pluralizeStatusLabel } from "./statuses";
import { openStatusPickerPopup } from "./status-popup";
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
/** Must match `.atlas-meta-children`'s and `.atlas-filter-wrap`'s `transition-duration` in
 * styles.css — every state-persisting toggle that triggers a full re-render (meta-folder collapse,
 * the bucket/inbox section headers, the filter-reveal toggle) delays that re-render by this long so
 * the CSS collapse/expand transition finishes playing before the DOM gets rebuilt out from under
 * it. PR 11: originally only the meta-folder chevron used this trick (hence the old name); the
 * bucket/inbox/filter toggles shipped in PR 9 without it, which is why none of them actually
 * animated despite having the CSS for it — same fix, applied to the rest of the collapse toggles. */
const COLLAPSE_TRANSITION_MS = 160;
/** PR 9 (issue 2, point 5): how long a drag has to hover a module (without dropping) before its
 * Contents modal opens automatically, mirroring the "hover a folder while dragging to expand it"
 * pattern most native file managers use. */
const MODULE_HOVER_DWELL_MS = 650;

/** PR 20: both variants now carry an array — a plain single-item drag is just the length-1 case,
 * so every existing drop-handling call site only needed to start iterating instead of gaining a
 * second, parallel "batch" code path next to the original single-item one. */
type DragPayload = { kind: "node"; nodeIds: string[]; viewId: string } | { kind: "inbox"; refs: UnitRef[] };

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
			// Always reserve the chevron's slot, even for a file (which never gets one) — otherwise
			// a file's icon sits flush against the row's edge while a folder's icon is pushed right
			// by its chevron, so icons at the same depth don't line up (found in Dan's own testing
			// of this PR). An empty same-width spacer keeps every icon at a depth aligned regardless
			// of which rows happen to be folders.
			const chevron = row.createDiv({ cls: "atlas-chevron" });
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

			if (child instanceof TFolder) {
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
	/** PR 19: which truncated-status groups are currently expanded back to their individual member
	 * rows, keyed by `${governor kind}:${governor id}:${statusId}` (see `renderNodeList`'s `keyOf`).
	 * Ephemeral UI state, not persisted — matches every other fold-state field on this view, and a
	 * collapsed-by-default group is the expected state on next load, same as a freshly-opened bucket. */
	private expandedTruncationGroups = new Set<string>();
	/** PR 20: multi-select (F8's own spec — "shift/cmd-click; drag moves the whole selection").
	 * Bucket and inbox each get their own selection, mutually exclusive: selecting in one always
	 * clears the other, same as most apps treat two independent list panes rather than trying to
	 * support a single drag gesture that mixes a placed node and an unplaced ref (genuinely different
	 * operations at drop time — `moveNode` vs `placeUnit`). Keyed by node id (bucket) / ref key
	 * (inbox) rather than storing node/ref objects directly, so a stale reference from a prior render
	 * can never leak in — every read goes back through `ViewsManager`/`unitRefKey` at use time. */
	private selectedBucketNodeIds = new Set<string>();
	private selectedInboxRefKeys = new Set<string>();
	/** PR 20: which view's ids the current bucket selection belongs to — see `render()`'s own use of
	 * this (clears the bucket selection on a view switch; inbox selection is unaffected). */
	private lastRenderedViewId: string | null = null;
	/** The last row clicked (in either scope) — where a following shift-click's range starts from.
	 * Cleared implicitly by scope: a shift-click only extends a range if the anchor's own scope
	 * matches the row just clicked, so a stray shift-click in the *other* list can't try to build a
	 * range across two unrelated lists. */
	private selectionAnchor: string | null = null;
	private selectionAnchorScope: "bucket" | "inbox" | null = null;
	/** PR 20: the bucket's own node-list container from the most recent render — queried live at
	 * shift-click time (`getBoundingClientRect().height > 0`) to build the visible row order a range
	 * selects across, so a collapsed folder's hidden contents and a filtered-out row are both
	 * correctly excluded from the range without a second, parallel bookkeeping structure to keep in
	 * sync with the DOM. */
	private bucketListEl: HTMLElement | null = null;
	/** PR 20: the inbox's own stable sort order from the most recent render, captured once right
	 * after it's computed (`renderInboxSection`) rather than queried from the DOM like the bucket's
	 * — F11's virtualization means most inbox rows genuinely aren't in the DOM at any given moment,
	 * so a DOM query would silently miss whatever's currently scrolled out of view. */
	private inboxSelectOrder: string[] = [];
	private inboxRefByKey = new Map<string, UnitRef>();
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

	/** PR 15 fix (Dan-found): Glow/Retain icons/Retained icon color are read fresh on every render,
	 * but nothing was triggering a render when they changed in Settings — `unitIndex`/`viewsManager`
	 * changes already auto-refresh via `queueRender` (wired in `onOpen`), these plain settings don't
	 * go through either, so toggling one silently had no visible effect until something else
	 * happened to re-render. Called by the settings tab right after `saveSettings()` for exactly
	 * these toggles. */
	refresh(): void {
		this.queueRender();
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

		// PR 20: bucket node ids are only meaningful within the view that minted them — switching to
		// a different view and keeping the old selection around would (extremely unlikely id
		// collision aside) just be a stale, meaningless-looking highlight on whatever nodes happen to
		// render next. Inbox selection is unaffected — a ref key means the same thing across views.
		if (view.id !== this.lastRenderedViewId) {
			this.lastRenderedViewId = view.id;
			this.selectedBucketNodeIds.clear();
			if (this.selectionAnchorScope === "bucket") {
				this.selectionAnchor = null;
				this.selectionAnchorScope = null;
			}
		}

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
			// PR 17: root-level assignment — same "Statuses" modal as any other item, just governing
			// the view's own top-level items instead of one specific node's children. Same no-nothing-
			// to-apply-to gate as any other item (PR 15): an empty bucket has nothing underneath it.
			if (view.root.length > 0) {
				menu.addSeparator();
				menu.addItem((item) => item.setTitle("Statuses").setIcon("circle-dot").onClick(() => this.openStatusesModal(view, null)));
			}
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
		// PR 11: same fix as the bucket/inbox sections — toggling `filterRevealed` used to call
		// `render()` immediately, which tears down and rebuilds the whole toolbar (including the
		// filter row) already in its new state within the same tick, so the CSS transition never had
		// a persisting element to animate from/to. `filterRow` is declared further down (still fine —
		// this closure only reads it at click time, long after the `const` has run), and the actual
		// state change + re-render is delayed the same way.
		//
		// Review follow-up (A14): the first version of this fix read `!this.filterRevealed` directly
		// inside the click handler — but that field only actually updates once the delayed block
		// below runs, so a second click inside the 160ms window read the same stale value as the
		// first and re-applied the same direction instead of toggling back. Exactly the race
		// A11/A12 already fixed once for the meta-folder chevron; `localRevealed` here is that same
		// fix — seeded once, flipped from its own prior value on every click, never re-read from
		// `this.filterRevealed` until the eventual `render()` replaces this whole closure anyway.
		let localRevealed = this.filterRevealed;
		let filterRevealTimer: number | undefined;
		this.toolbarButton(toolbar, "search", "Filter", () => {
			localRevealed = !localRevealed;
			const nowRevealed = localRevealed;
			filterRow.toggleClass("is-collapsed", !nowRevealed);
			if (filterRevealTimer !== undefined) window.clearTimeout(filterRevealTimer);
			filterRevealTimer = window.setTimeout(() => {
				filterRevealTimer = undefined;
				this.filterRevealed = nowRevealed;
				if (nowRevealed) {
					this.focusFilterOnNextRender = true;
				} else if (this.filterText) {
					// Closing the reveal always returns to the unfiltered view — a hidden input still
					// silently filtering the list would be confusing, with no visible query to explain it.
					this.filterText = "";
					this.restoreFoldStateAfterFilterClear();
				}
				void this.render();
			}, COLLAPSE_TRANSITION_MS);
		});

		// A separate block-level row below the toolbar's icon row, not an inline-growing box within
		// it — the icon row has `flex-wrap: wrap` for its own overflow handling, and a horizontally
		// growing filter box inline with those icons would (and did, per Dan's testing) eventually
		// force a line-wrap mid-animation: an instant, un-animatable reflow that jumped the
		// bucket/inbox sections below down abruptly instead of moving them smoothly. Revealing is a
		// height transition on its own row instead (`.atlas-meta-children`, same technique as
		// everywhere else in the plugin), which the icon row's wrapping can't interfere with.
		const filterRow = container.createDiv({ cls: "atlas-meta-children atlas-filter-row" });
		filterRow.toggleClass("is-collapsed", !this.filterRevealed);
		const filterRowInner = filterRow.createDiv({ cls: "atlas-meta-children-inner" });
		const filterInput = filterRowInner.createEl("input", { cls: "atlas-filter", attr: { type: "text", placeholder: "Filter…" } });
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

		// PR 11: the whole section's content used to only render at all when expanded (`if
		// (this.bucketCollapsed) return`), and the header click handler triggered an immediate full
		// re-render — so there was never a persisting DOM node for the CSS transition to animate
		// from/to, just a hard snap between "rendered" and "not rendered". Same fix as the
		// meta-folder chevron: content always renders into a dedicated wrapper, the collapse is a
		// CSS transition on that wrapper, and the state-persisting re-render is delayed until the
		// transition has had time to play.
		const sectionWrap = container.createDiv({ cls: "atlas-meta-children" });
		sectionWrap.toggleClass("is-collapsed", this.bucketCollapsed);
		const sectionInner = sectionWrap.createDiv({ cls: "atlas-meta-children-inner" });

		// The whole section (not just the list of existing rows) is the bucket-root drop target —
		// registering it on `listEl` alone left almost no reliable empty area to hit once a few
		// rows existed (the div's own height hugs its content in normal block flow, so dropping
		// just below the last row landed on `container`, which had no drop handler at all). Any
		// specific row still wins first via its own drop handler's `stopPropagation`. Safe to keep
		// registered while visually collapsed — the wrapper's `overflow: hidden` + zero-height grid
		// track means collapsed content has no interactable area regardless.
		this.makeDropZone(sectionInner, { kind: "bucket-root", viewId: view.id });

		const listEl = sectionInner.createDiv({ cls: "atlas-node-list" });
		this.bucketListEl = listEl; // PR 20: queried live for shift-click range selection
		// PR 17: the view itself is the root governor — top-level items resolve their status against
		// it exactly the same way any other item resolves against its parent node, no special-casing.
		await this.renderNodeList(view.root, listEl, view, 0, [view]);

		let localCollapsed = this.bucketCollapsed;
		let pendingPersist: number | undefined;
		header.addEventListener("click", () => {
			localCollapsed = !localCollapsed;
			setIcon(chevron, localCollapsed ? "chevron-right" : "chevron-down");
			sectionWrap.toggleClass("is-collapsed", localCollapsed);
			if (pendingPersist !== undefined) window.clearTimeout(pendingPersist);
			pendingPersist = window.setTimeout(() => {
				pendingPersist = undefined;
				this.bucketCollapsed = localCollapsed;
				void this.render();
			}, COLLAPSE_TRANSITION_MS);
		});
	}

	/** PR 19: wires PR 17's hide-completed/hide-cancelled/truncate-statuses settings (captured but
	 * inert until now) into actual rendering. A node's governor and resolved status are looked up
	 * once per node here — hidden/truncated status is a property of *this* rendering pass against
	 * *these* ancestors, not the node itself, so it can't be decided any earlier (e.g. in `moveNode`,
	 * PR 18's own finding) or cached across renders.
	 *
	 * Precedence, per TASKS.md's own edge case: hide wins outright — a hidden item is excluded from
	 * rendering *and* from a truncated group's count, never appearing even as a tally. Among what's
	 * left, a status truncation-enabled on its governor only actually collapses once at least two
	 * siblings share it (a "group" of one is just the item itself — matches the reference plugin's
	 * own `>= 2` threshold, ported directly rather than reinvented, since collapsing a lone item into
	 * a summary of itself has no purpose).
	 *
	 * Filter interaction (flagged in TASKS.md as "not yet grilled, resolve if obvious during build"):
	 * a node that itself matches the active filter, or contains a descendant that does, always
	 * renders individually — same "never let a filter match hide behind something else" principle
	 * `renderFoldableChildren` already applies to collapsed folders (PR 9 issue 6), extended to cover
	 * hide/truncate the same way. */
	private async renderNodeList(nodes: ViewNode[], container: HTMLElement, view: View, depth: number, ancestors: StatusGovernance[]): Promise<void> {
		const sm = this.plugin.statusesManager;
		const filterActive = !!this.filterText.trim();

		interface Resolved {
			node: ViewNode;
			status: StatusDefinition | null;
			governor: StatusGovernance | null;
			bypass: boolean;
		}
		const resolved: Resolved[] = [];
		for (const node of nodes) {
			const governor = sm.findGoverningAncestor(ancestors, node);
			const status = governor ? sm.resolveNodeStatus(ancestors, node) : null;
			let bypass = false;
			if (filterActive) {
				if (node.type === "unit" && node.ref) {
					const info = await this.resolveRef(node.ref);
					if (this.matchesFilter(info.text)) bypass = true;
				}
				if (!bypass && node.children.length > 0 && (await this.subtreeHasMatch(node.children))) bypass = true;
			}
			resolved.push({ node, status, governor, bypass });
		}

		const isHidden = (status: StatusDefinition, governor: StatusGovernance): boolean =>
			(!!status.isCompleted && !!governor.hideCompleted) || (!!status.isCancelled && !!governor.hideCancelled);
		const groupKeyOf = (governor: StatusGovernance, statusId: string): string =>
			(governor === view ? `view:${view.id}` : `node:${(governor as ViewNode).id}`) + `:${statusId}`;

		const counts = new Map<string, number>();
		for (const r of resolved) {
			if (r.bypass || !r.status || !r.governor) continue;
			if (isHidden(r.status, r.governor)) continue;
			if (!r.governor.truncatedStatuses?.[r.status.id]?.enabled) continue;
			const key = groupKeyOf(r.governor, r.status.id);
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}

		const groupRowShown = new Set<string>();
		for (const r of resolved) {
			const { node, status, governor, bypass } = r;
			if (!bypass && status && governor && isHidden(status, governor)) continue; // hide wins outright

			if (!bypass && status && governor) {
				const config = governor.truncatedStatuses?.[status.id];
				if (config?.enabled && (counts.get(groupKeyOf(governor, status.id)) ?? 0) >= 2) {
					const key = groupKeyOf(governor, status.id);
					const expanded = this.expandedTruncationGroups.has(key);
					if (!groupRowShown.has(key)) {
						groupRowShown.add(key);
						this.renderTruncationGroupHeader(container, view, key, status, config, counts.get(key) ?? 0, depth, expanded);
					}
					if (!expanded) continue; // folded into the placeholder above, not rendered as its own row
				}
			}

			await this.renderNode(node, container, view, depth, ancestors);
		}
	}

	/** PR 19: the group placeholder ("3 Done") when collapsed, or a small "Collapse" affordance
	 * (placed once, right before the group's first member) when expanded — both toggle the same
	 * ephemeral `expandedTruncationGroups` entry and re-render. Deliberately a dedicated row rather
	 * than the reference plugin's own double-click-a-member's-dot gesture: Atlas already binds a
	 * single click on a status dot to opening the change-status popup (PR 16), so overloading a
	 * second, timing-based meaning onto the same target would collide with an already-shipped,
	 * reviewed interaction rather than cleanly extend it — an explicit, discoverable row avoids that
	 * collision entirely and costs nothing extra to build on top of the row primitives already here. */
	private renderTruncationGroupHeader(
		container: HTMLElement,
		view: View,
		key: string,
		status: StatusDefinition,
		config: TruncatedStatusConfig,
		count: number,
		depth: number,
		expanded: boolean
	): void {
		const row = container.createDiv({ cls: "atlas-row atlas-row-internal atlas-truncation-row" });
		row.style.paddingLeft = `${depth * 16}px`;
		const chevron = row.createDiv({ cls: "atlas-chevron" });
		const iconEl = row.createDiv({ cls: "atlas-icon atlas-status-dot" });
		const circle = iconEl.createDiv({ cls: "atlas-status-dot-circle" });
		circle.style.backgroundColor = status.color;
		circle.style.color = status.color;
		if (expanded) {
			setIcon(chevron, "chevron-down");
			row.createSpan({ cls: "atlas-row-text", text: "Collapse" });
		} else {
			const label = config.label?.trim() || pluralizeStatusLabel(status.label);
			row.createSpan({ cls: "atlas-row-text", text: `${count} ${label}` });
		}
		row.addEventListener("click", () => {
			if (expanded) this.expandedTruncationGroups.delete(key);
			else this.expandedTruncationGroups.add(key);
			void this.render();
		});
	}

	private matchesFilter(text: string): boolean {
		if (!this.filterText.trim()) return true;
		return text.toLowerCase().includes(this.filterText.trim().toLowerCase());
	}

	/** PR 20 — F8's own spec: "Multi-select with shift/cmd-click; drag moves the whole selection."
	 * Shared between bucket rows (keyed by node id) and inbox rows (keyed by ref key) — same
	 * mechanics either way, just a different `scope`/`order`/selection `Set`. `order` is the visible
	 * row order to range-select across for a shift-click; the caller computes it fresh each time
	 * (`bucketVisibleOrder`/`inboxSelectOrder`) rather than this method owning it, since what counts
	 * as "visible" is a different question per scope (DOM measurement vs. F11's virtualization —
	 * see those two callers' own doc comments).
	 *
	 * Returns whether the click was *consumed* as a selection action: `true` for a shift-range or a
	 * cmd/ctrl-toggle (caller should skip whatever the row's own plain-click action would have been,
	 * e.g. opening a file), `false` for a plain click (selection still resets to just this one row,
	 * but the caller's normal action still runs right after — multi-select is additive on top of the
	 * existing single-click-opens behavior, not a replacement for it). */
	private handleSelectionClick(evt: MouseEvent, key: string, scope: "bucket" | "inbox", order: string[]): boolean {
		const selection = scope === "bucket" ? this.selectedBucketNodeIds : this.selectedInboxRefKeys;
		const otherSelection = scope === "bucket" ? this.selectedInboxRefKeys : this.selectedBucketNodeIds;

		if (evt.shiftKey && this.selectionAnchor !== null && this.selectionAnchorScope === scope) {
			evt.preventDefault();
			otherSelection.clear();
			const from = order.indexOf(this.selectionAnchor);
			const to = order.indexOf(key);
			if (from !== -1 && to !== -1) {
				selection.clear();
				const [lo, hi] = from <= to ? [from, to] : [to, from];
				for (let i = lo; i <= hi; i++) selection.add(order[i]);
			}
			void this.render();
			return true;
		}

		if (evt.metaKey || evt.ctrlKey) {
			evt.preventDefault();
			otherSelection.clear();
			if (selection.has(key)) selection.delete(key);
			else selection.add(key);
			this.selectionAnchor = key;
			this.selectionAnchorScope = scope;
			void this.render();
			return true;
		}

		// Plain click: always collapses back to a fresh single-item selection (and a fresh anchor
		// for the next shift-click) — but never consumed, so the row's own default action still runs.
		const hadVisibleSelection = selection.size > 0 || otherSelection.size > 0;
		otherSelection.clear();
		selection.clear();
		selection.add(key);
		this.selectionAnchor = key;
		this.selectionAnchorScope = scope;
		if (hadVisibleSelection) void this.render(); // nothing to redraw if there was never a highlight to begin with
		return false;
	}

	/** PR 20: the bucket's currently *visible* row order, for a shift-click range — queried live
	 * from the DOM (not tracked during render) so a collapsed folder's hidden contents and a
	 * filtered-out row are both naturally excluded without a second structure to keep in sync.
	 * `getBoundingClientRect().height > 0` is the actual "is this painted with real height right
	 * now" check — a row inside a collapsed `.atlas-meta-children` wrapper reports (near) zero here
	 * once its ancestor's `grid-template-rows` has settled to `0fr`, even though it's still present
	 * in the DOM (by design — see `renderFoldableChildren`'s own doc comment on why children always
	 * render regardless of collapsed state). */
	private bucketVisibleOrder(): string[] {
		if (!this.bucketListEl) return [];
		return Array.from(this.bucketListEl.querySelectorAll<HTMLElement>("[data-select-key]"))
			.filter((el) => el.getBoundingClientRect().height > 0)
			.map((el) => el.dataset.selectKey as string);
	}

	/** PR 20: builds this drag's payload for an existing bucket node, folding in the rest of the
	 * active selection if the dragged row is part of it. Dragging a row that *isn't* currently
	 * selected instead collapses the selection down to just that row first — same "you're now
	 * dragging what you clicked, not some other stale selection" behavior most file managers use,
	 * and keeps the drag payload always consistent with what's visibly highlighted at drag time. */
	private buildNodeDragPayload(nodeId: string, viewId: string): DragPayload {
		if (!this.selectedBucketNodeIds.has(nodeId) || this.selectedBucketNodeIds.size <= 1) {
			this.selectedInboxRefKeys.clear();
			this.selectedBucketNodeIds.clear();
			this.selectedBucketNodeIds.add(nodeId);
			this.selectionAnchor = nodeId;
			this.selectionAnchorScope = "bucket";
			void this.render();
		}
		return { kind: "node", nodeIds: [...this.selectedBucketNodeIds], viewId };
	}

	/** PR 20: same idea as `buildNodeDragPayload`, for an inbox row. */
	private buildInboxDragPayload(ref: UnitRef): DragPayload {
		const key = unitRefKey(ref);
		if (!this.selectedInboxRefKeys.has(key) || this.selectedInboxRefKeys.size <= 1) {
			this.selectedBucketNodeIds.clear();
			this.selectedInboxRefKeys.clear();
			this.selectedInboxRefKeys.add(key);
			this.selectionAnchor = key;
			this.selectionAnchorScope = "inbox";
			void this.render();
		}
		const refs = [...this.selectedInboxRefKeys].map((k) => this.inboxRefByKey.get(k)).filter((r): r is UnitRef => !!r);
		return { kind: "inbox", refs: refs.length > 0 ? refs : [ref] };
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

	/** PR 12: shared fold/unfold wiring for any node with children — meta folders (always) and now
	 * unit nodes that have gained meta-nested children (only once they have at least one, per the
	 * grilling decision that a chevron shouldn't appear pre-emptively). Handles the filter-driven
	 * auto-reveal (PR 9 issue 6), the chevron icon, the animated children wrapper, and the same
	 * optimistic-local-state-then-delayed-persist click pattern used everywhere else fold/unfold
	 * happens in this plugin — extracted here instead of duplicated per node type so the two can't
	 * drift out of sync with each other the way duplicated logic has caused bugs before in this build. */
	private async renderFoldableChildren(node: ViewNode, chevron: HTMLElement, container: HTMLElement, view: View, depth: number, ancestors: StatusGovernance[]): Promise<void> {
		// PR 9 (issue 6): a filter-matching descendant force-reveals this node regardless of its own
		// collapsed state, so a match is never hidden behind a stale fold. The state from just before
		// the filter started touching it is remembered (once) so clearing the filter can put it back
		// exactly, rather than leaving every node the filter happened to open expanded.
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
		// PR 17: `node` becomes the nearest ancestor for its own children — prepended, not replacing
		// the chain, so a grandparent's `inheritToSubfolders` can still reach past `node` if `node`
		// itself isn't a governor (or is, but doesn't itself reach — same walk either way).
		await this.renderNodeList(node.children, childrenInner, view, depth + 1, [node, ...ancestors]);

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
			}, COLLAPSE_TRANSITION_MS);
		});
	}

	/** PR 15/17: renders a row's icon slot — either its normal type icon (`fallbackIconName`) or, if
	 * some ancestor governs this row (directly, or via `inheritToSubfolders` reaching past a closer
	 * non-reaching one — see `resolveNodeStatus`'s own doc comment for the full precedence rule), a
	 * colored status dot instead. Status assignment is descendant-governing, not self-governing
	 * (Dan's own spec: "the statuses apply to the first direct children under that item") — a
	 * governor's own `statusEnabled`/`statusSetId` fields describe what's *underneath* it, never its
	 * own displayed status, so this resolves against `ancestors`, never `node` itself. `ancestors[0]`
	 * is the nearest (direct parent, or the view root for a top-level item) — the chain always has
	 * at least the view in it, so root-level assignment (PR 17) falls out of the same walk with no
	 * special-casing for "nothing above this node."
	 *
	 * Dan-found sizing fix: the dot itself is a small (10px) circle centered inside the row's normal
	 * icon-slot footprint, not the whole slot — matching the reference plugin's own `.ffsi-dot`
	 * dimensions exactly (checked its live container build) rather than the icon-slot's full size,
	 * which read as oversized. Color and glow (`currentColor`-based layered box-shadow, same
	 * technique the reference plugin uses) are set on this inner circle, not the outer slot, so the
	 * glow radius is proportioned to the small dot instead of a large box.
	 *
	 * "Retain icons" (Status → Design) keeps the normal icon visible, shrunk down inside the circle,
	 * colored via "Retained icon color" (also Status → Design) — either the theme's normal text
	 * color or its background color, Dan's choice, not a fixed black/white contrast heuristic.
	 * Shared by meta and unit rows so the two can't drift out of sync with each other, the same
	 * reasoning `renderFoldableChildren`'s own extraction already used. */
	private renderRowIcon(iconEl: HTMLElement, view: View, node: ViewNode, ancestors: StatusGovernance[], fallbackIconName: string): void {
		const status = this.plugin.statusesManager.resolveNodeStatus(ancestors, node);
		if (!status) {
			setIcon(iconEl, fallbackIconName);
			return;
		}
		iconEl.addClass("atlas-status-dot");
		const circle = iconEl.createDiv({ cls: "atlas-status-dot-circle" });
		circle.toggleClass("atlas-status-glow", this.plugin.settings.glowEnabled);
		circle.style.backgroundColor = status.color;
		circle.style.color = status.color; // currentColor source for the glow box-shadow layers
		if (this.plugin.settings.retainIcons) {
			const innerIcon = circle.createSpan({ cls: "atlas-status-dot-icon" });
			innerIcon.style.color = this.plugin.settings.retainIconMatchBackground ? "var(--background-primary)" : "var(--text-normal)";
			setIcon(innerIcon, fallbackIconName);
		}
		// PR 16: a plain left-click directly on the dot opens the status-picker popup — a dedicated
		// click target separate from the row's own click (open file) and right-click (full context
		// menu), which stay bound to the row itself and are unaffected. `stopPropagation` keeps this
		// click from also triggering the row's "open file" handler underneath it. Real drag gestures
		// never fire a `click` event at all (mousedown+move suppresses it), so this can never race
		// with the row/icon's own drag-based mechanics (meta-nest, module dwell/drop) — confirmed
		// during grilling, not just assumed.
		circle.addEventListener("click", (evt) => {
			evt.stopPropagation();
			// PR 17: re-finds the winning governor rather than reusing `ancestors[0]` — with
			// inheritance, the governor actually in effect for this row might be several levels up.
			const governor = this.plugin.statusesManager.findGoverningAncestor(ancestors, node);
			if (!governor?.statusSetId) return;
			const set = this.plugin.statusesManager.getStatusSet(governor.statusSetId);
			if (!set) return;
			openStatusPickerPopup({
				anchor: circle,
				statusSet: set,
				currentStatusId: status.id,
				onSelect: (picked) => this.plugin.viewsManager.setExplicitStatus(view.id, node.id, picked.id),
			});
		});
	}

	private async renderNode(node: ViewNode, container: HTMLElement, view: View, depth: number, ancestors: StatusGovernance[]): Promise<void> {
		if (node.type === "meta") {
			const row = container.createDiv({ cls: "atlas-row atlas-row-meta" });
			row.dataset.selectKey = node.id;
			row.toggleClass("is-selected", this.selectedBucketNodeIds.has(node.id));
			row.style.paddingLeft = `${depth * 16}px`;
			row.setAttr("draggable", "true");
			const chevron = row.createDiv({ cls: "atlas-chevron" });
			const iconEl = row.createDiv({ cls: "atlas-icon" });
			this.renderRowIcon(iconEl, view, node, ancestors, "layers");
			row.createSpan({ cls: "atlas-row-text", text: node.label ?? "" });

			// PR 20: a meta row's plain click never did anything before this (no open target) — safe
			// to bind unconditionally, since the previous behavior ("nothing happens") is preserved
			// exactly for a plain click; only shift/cmd-click gain new meaning.
			row.addEventListener("click", (evt) => this.handleSelectionClick(evt, node.id, "bucket", this.bucketVisibleOrder()));
			row.addEventListener("dragstart", () => (this.dragPayload = this.buildNodeDragPayload(node.id, view.id)));
			this.makeDropZone(row, { kind: "node", nodeId: node.id, viewId: view.id });
			row.addEventListener("keydown", (evt) => this.handleRowKeydown(evt, node, view));
			row.tabIndex = 0;
			row.addEventListener("contextmenu", (evt) => {
				evt.preventDefault();
				this.showMetaFolderMenu(evt, node, view);
			});

			await this.renderFoldableChildren(node, chevron, container, view, depth, ancestors);
			return;
		}

		const ref = node.ref;
		if (!ref) return;
		const info = await this.resolveRef(ref);
		if (!this.matchesFilter(info.text)) return;

		const row = container.createDiv({ cls: "atlas-row atlas-row-unit" });
		if (info.missing) row.addClass("atlas-missing");
		row.dataset.refKey = unitRefKey(ref);
		row.dataset.selectKey = node.id;
		row.toggleClass("is-selected", this.selectedBucketNodeIds.has(node.id));
		row.style.paddingLeft = `${depth * 16}px`;
		row.setAttr("draggable", "true");

		// PR 12: every row now gets a chevron slot, matching meta rows and the Module Contents modal
		// (PR 10) — real content only if this unit has meta-nested children (a chevron appears only
		// once a node actually gets its first child, never pre-emptively), otherwise left empty
		// purely to keep icons aligned at the same depth regardless of type. Replaces the old fixed
		// `UNIT_ROW_CHEVRON_OFFSET` padding hack, which just simulated a chevron's width in CSS —
		// an actual (possibly empty) element is what PR 10 already found to be the reliable fix for
		// this exact alignment problem, so reusing it here instead of a second magic-number offset.
		const chevron = row.createDiv({ cls: "atlas-chevron" });
		const iconEl = row.createDiv({ cls: "atlas-icon" });
		this.renderRowIcon(iconEl, view, node, ancestors, info.icon);
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
				this.plugin.viewsManager.unplaceNode(view.id, node.id);
			});
		}
		// PR 9 (issue 2): modules never expand inline anymore, in the bucket or the inbox — the icon
		// opens the Module Contents modal instead. `ref.kind === "folder"` covers both folder-unit and
		// promoted-folder (both are real folders on disk, per `unitToRef`).
		if (!info.missing && ref.kind === "folder") this.wireModuleRow(row, iconEl, ref.path);

		this.setPlacementTooltip(row, ref);
		row.addEventListener("click", (evt) => {
			const consumed = this.handleSelectionClick(evt, node.id, "bucket", this.bucketVisibleOrder());
			if (!consumed) void this.openRef(ref);
		});
		row.addEventListener("dragstart", () => (this.dragPayload = this.buildNodeDragPayload(node.id, view.id)));
		this.makeDropZone(row, { kind: "node", nodeId: node.id, viewId: view.id });
		row.tabIndex = 0;
		row.addEventListener("keydown", (evt) => this.handleRowKeydown(evt, node, view));
		row.addEventListener("contextmenu", (evt) => {
			evt.preventDefault();
			this.showUnitMenu(evt, ref, view, node);
		});

		if (node.children.length > 0) await this.renderFoldableChildren(node, chevron, container, view, depth, ancestors);
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

		// PR 11: same fix as the bucket section and the meta-folder chevron — content always renders
		// into a dedicated wrapper so the collapse is a CSS transition, not a hard snap between
		// "rendered" and "not rendered", and the state-persisting re-render is delayed to let the
		// transition play first. The inbox additionally needs to stop claiming all remaining
		// vertical space (via `container`'s own `flex: 1 1 auto`, PR 9 issue 3) once collapsed —
		// otherwise a collapsed inbox would leave a tall blank void instead of shrinking to just its
		// header, since flex-grow doesn't know or care that its content just went to zero height.
		// `.atlas-section.atlas-inbox.is-collapsed` (styles.css) overrides that back to natural
		// height; `container` is the very element that class already targets.
		container.toggleClass("is-collapsed", this.inboxCollapsed);
		const sectionWrap = container.createDiv({ cls: "atlas-meta-children" });
		sectionWrap.toggleClass("is-collapsed", this.inboxCollapsed);
		const sectionInner = sectionWrap.createDiv({ cls: "atlas-meta-children-inner" });

		const listEl = sectionInner.createDiv({ cls: "atlas-node-list" });
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

		// PR 20: captured here (not queried from the DOM like the bucket's) — F11's virtualization
		// below means most of these rows never actually exist in the DOM at once, so a shift-click on
		// a row currently scrolled into view still needs this to know the full order, not just
		// whatever's presently painted.
		this.inboxSelectOrder = sorted.map((r) => unitRefKey(r.ref));
		this.inboxRefByKey = new Map(sorted.map((r) => [unitRefKey(r.ref), r.ref]));

		// F11: the inbox can be thousands of rows (5,000 files + 2,000 free blocks scale target).
		// The non-virtualized fallback this used to need for expanded folder-unit internals is gone —
		// PR 9 (issue 2) replaced inline inbox expansion with the Module Contents modal, so every
		// inbox row is now fixed-height and the virtualized path always applies.
		this.renderVirtualizedInboxRows(listEl, sorted);

		let localCollapsed = this.inboxCollapsed;
		let pendingPersist: number | undefined;
		header.addEventListener("click", () => {
			localCollapsed = !localCollapsed;
			setIcon(chevron, localCollapsed ? "chevron-right" : "chevron-down");
			container.toggleClass("is-collapsed", localCollapsed);
			sectionWrap.toggleClass("is-collapsed", localCollapsed);
			if (pendingPersist !== undefined) window.clearTimeout(pendingPersist);
			pendingPersist = window.setTimeout(() => {
				pendingPersist = undefined;
				this.inboxCollapsed = localCollapsed;
				void this.render();
			}, COLLAPSE_TRANSITION_MS);
		});
	}

	private renderInboxRow(container: HTMLElement, ref: UnitRef, info: RowInfo): HTMLElement {
		const row = container.createDiv({ cls: "atlas-row atlas-row-unit" });
		const key = unitRefKey(ref);
		row.dataset.refKey = key;
		row.dataset.selectKey = key;
		row.toggleClass("is-selected", this.selectedInboxRefKeys.has(key));
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
		row.addEventListener("click", (evt) => {
			const consumed = this.handleSelectionClick(evt, key, "inbox", this.inboxSelectOrder);
			if (!consumed) void this.openRef(ref);
		});
		row.addEventListener("dragstart", () => (this.dragPayload = this.buildInboxDragPayload(ref)));
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

	/** PR 12: dropping onto a row now always means "nest as a child of this row" (meta-nesting,
	 * organizational only) — every node type can be a parent now, not just meta folders (Q3/Q11,
	 * grilled with Dan directly). The one exception, the real disk-move "add to module" gesture, no
	 * longer lives here at all — it moved to the module icon's own drop zone in `wireModuleRow`,
	 * which handles it and calls `stopPropagation()` before a drop event would ever reach this
	 * row-level handler. This *did* mean giving up "drop onto a row to insert as its sibling," which
	 * this branch used to do for unit targets — a deliberate simplification Dan chose over a
	 * right-side/rest-of-row zone split; reordering to a specific position among siblings now needs
	 * un-nesting to the bucket root or a meta folder first, not a single drag onto a neighbor.
	 *
	 * Also fixes a real, pre-existing bug found while rewriting this for PR 12: for a `payload.kind
	 * === "node"` drag (an *existing* tree node being reparented, not a fresh ref from the inbox),
	 * this used to route through `placeUnit` — which only makes sense for a unit ref and, worse,
	 * builds a *brand-new* node object with `children: []`, discarding whatever the dragged node's
	 * real children/collapsed state was. Harmless before PR 12 (units never had children to lose,
	 * and `placeUnit`'s `findUnitNode` lookup never matched a dragged *meta* folder's ref at all, so
	 * meta drags silently no-op'd instead of actually moving). PR 12 makes both halves of this live:
	 * units can now genuinely have children to lose, and meta-nesting makes "drag one row onto
	 * another" universal. `moveNode` is the correct operation for an existing node changing parent
	 * either way — it reparents the real node object in place instead of replacing it. */
	private handleDrop(target: { kind: "node"; nodeId: string; viewId: string } | { kind: "bucket-root"; viewId: string } | { kind: "inbox-area"; viewId: string }): void {
		const payload = this.dragPayload;
		this.dragPayload = null;
		if (!payload) return;

		if (target.kind === "inbox-area") {
			// Only a unit has a disk/ref identity to "return to the inbox" — a meta folder dropped
			// here is simply not a meaningful gesture, so it's a no-op rather than acting on a
			// fabricated ref for that one, not the whole drag.
			if (payload.kind === "node") {
				const draggedView = this.plugin.viewsManager.getView(payload.viewId);
				if (draggedView) {
					for (const nodeId of payload.nodeIds) {
						const dragged = this.findNodeAnywhere(draggedView.root, nodeId);
						// PR 13: unplaceNode removes this exact dragged instance, not every duplicate of
						// the same unit that might also be placed elsewhere in this view.
						if (dragged?.node.type === "unit") this.plugin.viewsManager.unplaceNode(payload.viewId, nodeId);
					}
				}
			}
			this.selectedBucketNodeIds.clear();
			void this.render();
			return;
		}

		const viewId = target.viewId;
		let parentId: string | null = null;
		if (target.kind === "node") {
			const view = this.plugin.viewsManager.getView(viewId);
			const found = view && this.findNodeAnywhere(view.root, target.nodeId);
			if (found) parentId = found.node.id;
		}

		if (payload.kind === "node") {
			const view = this.plugin.viewsManager.getView(viewId);
			if (!view) return;
			// PR 20: a node already nested under *another* node in this same drag batch travels along
			// with that ancestor's own move automatically — moving it again separately right after
			// would yank it back out into a sibling of its own ancestor, flattening a relationship the
			// user very likely meant to keep by dragging them together in the first place.
			const toMove = payload.nodeIds.filter((id) => {
				const found = this.findNodeAnywhere(view.root, id);
				if (!found) return false;
				return !payload.nodeIds.some((otherId) => {
					if (otherId === id) return false;
					const other = this.findNodeAnywhere(view.root, otherId);
					return !!other && this.nodeContainsDescendant(other.node, id);
				});
			});
			// An existing tree node (meta or unit) is being reparented/reordered — `moveNode` operates
			// on it directly by id, in place, so its own children/collapsed state travels with it.
			// Each move appends after the previous one, so the whole selection lands at the
			// destination in the same relative order it was dragged in.
			let index = parentId ? (this.findNodeAnywhere(view.root, parentId)?.node.children.length ?? 0) : view.root.length;
			for (const nodeId of toMove) {
				if (this.plugin.viewsManager.moveNode(viewId, nodeId, parentId, index)) index++;
			}
			this.selectedBucketNodeIds.clear();
			void this.render();
			return;
		}

		// payload.kind === "inbox": fresh unit refs, not yet placed anywhere in this view — placeUnit
		// always appends, so calling it in order already preserves the batch's relative order.
		for (const ref of payload.refs) this.plugin.viewsManager.placeUnit(viewId, ref, parentId);
		this.selectedInboxRefKeys.clear();
		void this.render();
	}

	private nodeContainsDescendant(node: ViewNode, targetId: string): boolean {
		for (const child of node.children) {
			if (child.id === targetId || this.nodeContainsDescendant(child, targetId)) return true;
		}
		return false;
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

	private refOfNode(viewId: string, nodeId: string): UnitRef {
		const view = this.plugin.viewsManager.getView(viewId);
		const found = view && this.findNodeAnywhere(view.root, nodeId);
		return found?.node.ref ?? { kind: "file", path: "" };
	}

	/** PR 20: the module-icon drop zone (`wireModuleRow`, below) is a real disk move — deliberately
	 * restricted to a single-item drag. Dragging a multi-select onto a module icon to bulk-file
	 * several things into it at once is a materially riskier gesture (several renames at once instead
	 * of one named, confirmable one) than anything asked for here, so it's a no-op rather than an
	 * unreviewed bulk-move feature — the row-level drop zone underneath still handles a multi-item
	 * drag the normal way (organizational meta-nesting, never a disk move) once this returns `null`. */
	private singleDragRef(payload: DragPayload): UnitRef | null {
		if (payload.kind === "inbox") return payload.refs.length === 1 ? payload.refs[0] : null;
		return payload.nodeIds.length === 1 ? this.refOfNode(payload.viewId, payload.nodeIds[0]) : null;
	}

	private findNodeAnywhere(nodes: ViewNode[], nodeId: string): { node: ViewNode } | null {
		for (const node of nodes) {
			if (node.id === nodeId) return { node };
			const found = this.findNodeAnywhere(node.children, nodeId);
			if (found) return found;
		}
		return null;
	}

	// --- context menus -----------------------------------------------------------------------------

	private showUnitMenu(evt: MouseEvent, ref: UnitRef, view: View, node: ViewNode): void {
		const menu = new Menu();
		menu.addItem((item) => item.setTitle("Open").setIcon("file").onClick(() => void this.openRef(ref)));
		menu.addItem((item) => item.setTitle("Open in new tab").setIcon("file-plus").onClick(() => void this.openRef(ref, true)));
		if (ref.kind === "file" || ref.kind === "folder") {
			menu.addItem((item) => item.setTitle("Reveal in native explorer").setIcon("folder-open").onClick(() => this.revealInNativeExplorer(ref.path)));
		}
		// PR 16 (grilled): always offered for modules, not just governed ones — a governed module's
		// icon click now means "change status" (see `wireModuleRow`), so viewing contents needs a
		// path that doesn't depend on whether this module currently has a status assigned.
		if (ref.kind === "folder") {
			menu.addItem((item) => item.setTitle("View module contents").setIcon("list-tree").onClick(() => this.openModuleContentsModal(ref.path)));
		}
		menu.addItem((item) => item.setTitle("Copy link").setIcon("link").onClick(() => void this.copyLink(ref)));
		menu.addSeparator();
		// PR 15 fix (Dan-found): status assignment governs this item's own *children*, not the item
		// itself — an item with no children has nothing for the option to apply to, so it's hidden
		// entirely rather than offered and doing nothing when toggled.
		if (node.children.length > 0) {
			menu.addItem((item) => item.setTitle("Statuses").setIcon("circle-dot").onClick(() => this.openStatusesModal(view, node.id)));
			menu.addSeparator();
		}
		// PR 13: clones this row (and its whole meta-nested subtree, if it has one) as a new sibling
		// right after it — same underlying unit, no disk duplicate, no naming scheme (two rows with
		// the same label is expected — see duplicateNode's own doc comment for why).
		menu.addItem((item) => item.setTitle("Duplicate (Meta)").setIcon("copy-plus").onClick(() => this.plugin.viewsManager.duplicateNode(view.id, node.id)));
		menu.addItem((item) =>
			item
				.setTitle("Remove from view")
				.setIcon("x")
				// PR 13: unplaceNode removes this exact row, not every duplicate of the same unit
				// that might also be placed elsewhere in this view.
				.onClick(() => this.plugin.viewsManager.unplaceNode(view.id, node.id))
		);
		menu.addItem((item) => item.setTitle("Place in view…").setIcon("arrow-right-left").onClick(() => this.placeInViewFlow(ref)));
		menu.showAtMouseEvent(evt);
	}

	/** PR 15/17: the "Statuses" modal — opened from a bucket unit or meta folder's own context menu
	 * (`nodeId` set), or from the view-name selector for root-level assignment (`nodeId: null`,
	 * PR 17) — both read/write through `ViewsManager`'s generic `getStatusGovernance`/
	 * `updateStatusGovernance`, so this one method serves both without knowing which kind of
	 * governor it's actually editing. */
	private openStatusesModal(view: View, nodeId: string | null): void {
		const governance = this.plugin.viewsManager.getStatusGovernance(view.id, nodeId);
		if (!governance) return;
		new StatusesModal(this.plugin.app, this.plugin.statusesManager.getStatusSets(), governance, (patch) =>
			this.plugin.viewsManager.updateStatusGovernance(view.id, nodeId, patch)
		).open();
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
		// PR 13: same clone-as-sibling action as a unit row's context menu — a meta folder has no
		// disk identity to begin with, so "duplicating" it just clones the organizational label and
		// its whole subtree, same mechanics either way (`duplicateNode` doesn't distinguish types).
		menu.addItem((item) => item.setTitle("Duplicate (Meta)").setIcon("copy-plus").onClick(() => this.plugin.viewsManager.duplicateNode(view.id, node.id)));
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
		if (node.children.length > 0) {
			menu.addItem((item) => item.setTitle("Statuses").setIcon("circle-dot").onClick(() => this.openStatusesModal(view, node.id)));
		}
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
	 * click opens the modal), its hover-during-drag dwell timer (point 5), and — PR 12 — the icon's
	 * own drop zone for the one remaining real-disk-move gesture in this row. Shared by both the
	 * inbox and bucket unit-row renderers so the two surfaces can't drift apart. `iconEl` is emptied
	 * and rebuilt with the two stacked icons the crossfade needs.
	 *
	 * PR 12: the dwell timer and the plain-drop-to-file-in confirm flow both used to be wired to the
	 * whole `row` — grilled with Dan directly (Q3/Q11) and rescoped to the icon only, since the rest
	 * of the row now means "meta-nest as a child" instead (organizational only, no disk move). The
	 * icon is the one place left where dropping a file/block still physically files it into the
	 * module; everywhere else on the row falls through to `makeDropZone`'s own row-level listener. */
	private wireModuleRow(row: HTMLElement, iconEl: HTMLElement, folderPath: string): void {
		// PR 15 fix (Dan-found, discovered while grilling the next PR): this used to unconditionally
		// wipe `iconEl` and repopulate it with the closed/open folder-icon crossfade, silently
		// overwriting a status dot `renderRowIcon` had just rendered there — meaning a governed
		// module could never actually show its dot at all, contradicting PR 15's own core promise.
		// The dot's own visual is left alone when present; the tooltip/click/drag wiring below still
		// applies to `iconEl` either way, since none of it depends on the icon's current visual
		// content. (Click's "open contents" meaning is expected to change for dotted modules once
		// the next PR's click-to-change-status lands — that's this PR's own scope, not PR 15's.)
		const hasStatusDot = iconEl.hasClass("atlas-status-dot");
		if (!hasStatusDot) {
			iconEl.empty();
			iconEl.addClass("atlas-module-icon");
			setIcon(iconEl.createSpan({ cls: "atlas-icon-closed" }), "folder");
			setIcon(iconEl.createSpan({ cls: "atlas-icon-open" }), "folder-open");
			setTooltip(iconEl, "View module contents");
			iconEl.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.openModuleContentsModal(folderPath);
			});
		}
		// PR 16 (grilled): a governed module's icon *is* its status dot, whose own click (wired in
		// `renderRowIcon`) already means "change status" — plain click can't mean two things on the
		// same element, and Dan's own original behavior list never included plain-click-opens-
		// contents as a target for a dotted module in the first place. So the click/tooltip binding
		// above is skipped entirely here; "View module contents" moves to the row's right-click menu
		// instead (added unconditionally for folder refs in `showUnitMenu`, governed or not, so the
		// path doesn't change depending on state that can flip at any time). The drag-hold-to-open
		// dwell mechanic below is unaffected either way — it was never click-based.

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
		iconEl.addEventListener("dragover", (evt) => {
			if (!this.dragPayload) return;
			evt.preventDefault();
			evt.stopPropagation();
			iconEl.addClass("atlas-drop-target");
			startDwell();
		});
		iconEl.addEventListener("dragleave", () => {
			iconEl.removeClass("atlas-drop-target");
			cancelDwell();
		});
		iconEl.addEventListener("drop", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			iconEl.removeClass("atlas-drop-target");
			cancelDwell();
			const payload = this.dragPayload;
			this.dragPayload = null;
			if (!payload) return;
			const ref = this.singleDragRef(payload);
			if (ref && ref.kind !== "folder") void this.handleAddToModule(ref, folderPath);
		});
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
		const ref = this.singleDragRef(payload);
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
		} else if (evt.key === " " && (node.type === "meta" || node.children.length > 0)) {
			// PR 12: keyboard parity for the new unit-node chevrons — same fold/unfold toggle meta
			// folders already had, now also reachable without a mouse for a unit that's gained
			// meta-nested children.
			evt.preventDefault();
			this.plugin.viewsManager.setNodeCollapsed(view.id, node.id, !node.collapsed);
		} else if (evt.key === "Delete") {
			evt.preventDefault();
			// PR 20: if the focused row is part of an active multi-selection, Delete removes every
			// *unit* currently selected (same restriction the single-row case already had — meta
			// folders delete via a distinct, different operation, `deleteMetaFolder`, that promotes
			// their children rather than a plain "remove"), not just the one row that happened to
			// have keyboard focus — same "drag moves the whole selection" spirit, applied to the one
			// other batch-shaped action this view already had.
			if (this.selectedBucketNodeIds.has(node.id) && this.selectedBucketNodeIds.size > 1) {
				for (const id of this.selectedBucketNodeIds) {
					const found = this.findNodeAnywhere(view.root, id);
					if (found?.node.type === "unit") this.plugin.viewsManager.unplaceNode(view.id, id);
				}
				this.selectedBucketNodeIds.clear();
				void this.render();
			} else if (node.type === "unit") {
				// PR 13: unplaceNode removes this exact focused row, not every duplicate of the same
				// unit that might also be placed elsewhere in this view.
				this.plugin.viewsManager.unplaceNode(view.id, node.id);
			}
		} else if (evt.key === "F2" && node.type === "meta") {
			evt.preventDefault();
			new TextPromptModal(this.plugin.app, "Rename folder", node.label ?? "", (label) => {
				this.plugin.viewsManager.renameMetaFolder(view.id, node.id, label);
			}).open();
		} else if (evt.key === "Escape" && (this.selectedBucketNodeIds.size > 0 || this.selectedInboxRefKeys.size > 0)) {
			evt.preventDefault();
			this.selectedBucketNodeIds.clear();
			this.selectedInboxRefKeys.clear();
			this.selectionAnchor = null;
			this.selectionAnchorScope = null;
			void this.render();
		}
	}
}
