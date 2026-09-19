import { App, FuzzySuggestModal, ItemView, Menu, Modal, Notice, TFile, TFolder, WorkspaceLeaf, setIcon, setTooltip } from "obsidian";
import type AtlasPlugin from "./main";
import { Unit, UnitRef, View, ViewNode, unitRefKey, unitToRef } from "./types";
import { MetaTarget, flattenMetaFolders } from "./views";
import { resolveUnit } from "./unit-display";
import { contrastingTextColor } from "./statuses";
import { TextPromptModal, ConfirmModal, StatusesModal } from "./modals";
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
		await this.renderNodeList(view.root, listEl, view, 0, null);

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

	private async renderNodeList(nodes: ViewNode[], container: HTMLElement, view: View, depth: number, parentNode: ViewNode | null): Promise<void> {
		for (const node of nodes) {
			await this.renderNode(node, container, view, depth, parentNode);
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

	/** PR 12: shared fold/unfold wiring for any node with children — meta folders (always) and now
	 * unit nodes that have gained meta-nested children (only once they have at least one, per the
	 * grilling decision that a chevron shouldn't appear pre-emptively). Handles the filter-driven
	 * auto-reveal (PR 9 issue 6), the chevron icon, the animated children wrapper, and the same
	 * optimistic-local-state-then-delayed-persist click pattern used everywhere else fold/unfold
	 * happens in this plugin — extracted here instead of duplicated per node type so the two can't
	 * drift out of sync with each other the way duplicated logic has caused bugs before in this build. */
	private async renderFoldableChildren(node: ViewNode, chevron: HTMLElement, container: HTMLElement, view: View, depth: number): Promise<void> {
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
		await this.renderNodeList(node.children, childrenInner, view, depth + 1, node);

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

	/** PR 15: renders a row's icon slot — either its normal type icon (`fallbackIconName`) or, if
	 * this row's *parent* has statuses turned on for its children, a colored status dot instead.
	 * Status assignment is descendant-governing, not self-governing (Dan's own spec: "the statuses
	 * apply to the first direct children under that item") — a node's own `statusEnabled`/
	 * `statusSetId` fields describe what its children show, never itself, so this deliberately
	 * resolves against `parentNode`, not `node`. `parentNode` is `null` at the bucket root, where
	 * nothing governs (PR 16 adds root-level assignment via the view-name selector). "Retain icons"
	 * (Status → Design) keeps the normal icon visible, shrunk down inside the dot, rather than
	 * replacing it outright. Shared by meta and unit rows so the two can't drift out of sync with
	 * each other, the same reasoning `renderFoldableChildren`'s own extraction already used. */
	private renderRowIcon(iconEl: HTMLElement, parentNode: ViewNode | null, fallbackIconName: string): void {
		const status = parentNode ? this.plugin.statusesManager.resolveNodeStatus(parentNode) : null;
		if (!status) {
			setIcon(iconEl, fallbackIconName);
			return;
		}
		iconEl.addClass("atlas-status-dot");
		iconEl.toggleClass("atlas-status-glow", this.plugin.settings.glowEnabled);
		iconEl.style.backgroundColor = status.color;
		iconEl.style.setProperty("--status-dot-glow-color", status.color);
		if (this.plugin.settings.retainIcons) {
			const innerIcon = iconEl.createSpan({ cls: "atlas-status-dot-icon" });
			innerIcon.style.color = contrastingTextColor(status.color);
			setIcon(innerIcon, fallbackIconName);
		}
	}

	private async renderNode(node: ViewNode, container: HTMLElement, view: View, depth: number, parentNode: ViewNode | null): Promise<void> {
		if (node.type === "meta") {
			const row = container.createDiv({ cls: "atlas-row atlas-row-meta" });
			row.style.paddingLeft = `${depth * 16}px`;
			row.setAttr("draggable", "true");
			const chevron = row.createDiv({ cls: "atlas-chevron" });
			const iconEl = row.createDiv({ cls: "atlas-icon" });
			this.renderRowIcon(iconEl, parentNode, "layers");
			row.createSpan({ cls: "atlas-row-text", text: node.label ?? "" });

			row.addEventListener("dragstart", () => (this.dragPayload = { kind: "node", nodeId: node.id, viewId: view.id }));
			this.makeDropZone(row, { kind: "node", nodeId: node.id, viewId: view.id });
			row.addEventListener("keydown", (evt) => this.handleRowKeydown(evt, node, view));
			row.tabIndex = 0;
			row.addEventListener("contextmenu", (evt) => {
				evt.preventDefault();
				this.showMetaFolderMenu(evt, node, view);
			});

			await this.renderFoldableChildren(node, chevron, container, view, depth);
			return;
		}

		const ref = node.ref;
		if (!ref) return;
		const info = await this.resolveRef(ref);
		if (!this.matchesFilter(info.text)) return;

		const row = container.createDiv({ cls: "atlas-row atlas-row-unit" });
		if (info.missing) row.addClass("atlas-missing");
		row.dataset.refKey = unitRefKey(ref);
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
		this.renderRowIcon(iconEl, parentNode, info.icon);
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
			this.showUnitMenu(evt, ref, view, node);
		});

		if (node.children.length > 0) await this.renderFoldableChildren(node, chevron, container, view, depth);
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
			// fabricated ref.
			if (payload.kind === "node") {
				const draggedView = this.plugin.viewsManager.getView(payload.viewId);
				const dragged = draggedView && this.findNodeAnywhere(draggedView.root, payload.nodeId);
				if (dragged?.node.type === "unit" && dragged.node.ref) this.plugin.viewsManager.unplaceUnit(payload.viewId, dragged.node.ref);
			}
			return;
		}

		const viewId = target.viewId;
		let parentId: string | null = null;
		let index = 0;
		if (target.kind === "node") {
			const view = this.plugin.viewsManager.getView(viewId);
			const found = view && this.findNodeAnywhere(view.root, target.nodeId);
			if (found) {
				parentId = found.node.id;
				index = found.node.children.length;
			}
		}

		if (payload.kind === "node") {
			// An existing tree node (meta or unit) is being reparented/reordered — `moveNode` operates
			// on it directly by id, in place, so its own children/collapsed state travels with it.
			this.plugin.viewsManager.moveNode(viewId, payload.nodeId, parentId, index);
			return;
		}

		// payload.kind === "inbox": a fresh unit ref, not yet placed anywhere in this view.
		this.plugin.viewsManager.placeUnit(viewId, payload.ref, parentId);
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
		menu.addItem((item) => item.setTitle("Copy link").setIcon("link").onClick(() => void this.copyLink(ref)));
		menu.addSeparator();
		// PR 15 fix (Dan-found): status assignment governs this item's own *children*, not the item
		// itself — an item with no children has nothing for the option to apply to, so it's hidden
		// entirely rather than offered and doing nothing when toggled.
		if (node.children.length > 0) {
			menu.addItem((item) => item.setTitle("Statuses").setIcon("circle-dot").onClick(() => this.openStatusesModal(node, view)));
			menu.addSeparator();
		}
		menu.addItem((item) =>
			item
				.setTitle("Remove from view")
				.setIcon("x")
				.onClick(() => this.plugin.viewsManager.unplaceUnit(view.id, ref))
		);
		menu.addItem((item) => item.setTitle("Place in view…").setIcon("arrow-right-left").onClick(() => this.placeInViewFlow(ref)));
		menu.showAtMouseEvent(evt);
	}

	/** PR 15: the minimal "Statuses" modal — opened from a bucket unit or meta folder's own context
	 * menu, applying live to that exact node via `setNodeStatus`. */
	private openStatusesModal(node: ViewNode, view: View): void {
		new StatusesModal(
			this.plugin.app,
			this.plugin.statusesManager.getStatusSets(),
			!!node.statusEnabled,
			node.statusSetId ?? null,
			(enabled, statusSetId) => this.plugin.viewsManager.setNodeStatus(view.id, node.id, enabled, statusSetId)
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
			menu.addItem((item) => item.setTitle("Statuses").setIcon("circle-dot").onClick(() => this.openStatusesModal(node, view)));
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
			const ref = payload.kind === "inbox" ? payload.ref : this.refOfNode(payload);
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
		} else if (evt.key === " " && (node.type === "meta" || node.children.length > 0)) {
			// PR 12: keyboard parity for the new unit-node chevrons — same fold/unfold toggle meta
			// folders already had, now also reachable without a mouse for a unit that's gained
			// meta-nested children.
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
