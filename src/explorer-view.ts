import { FuzzySuggestModal, ItemView, Menu, Notice, TFile, TFolder, WorkspaceLeaf, setIcon, setTooltip } from "obsidian";
import type AtlasPlugin from "./main";
import { Unit, UnitRef, View, ViewNode, unitRefKey, unitRefsEqual, unitToRef } from "./types";
import { MetaTarget, flattenMetaFolders } from "./views";
import { resolveUnit } from "./unit-display";
import { TextPromptModal, ConfirmModal } from "./modals";
import { createInterfaceNote, findInterfaceNote } from "./interface-notes";
import { addBlock } from "./commands";

export const ATLAS_VIEW_TYPE = "atlas-explorer";

type DragPayload =
	| { kind: "node"; nodeId: string; viewId: string }
	| { kind: "inbox"; ref: UnitRef }
	| { kind: "internal"; path: string; isFolder: boolean };

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
	private expandedFolders = new Set<string>();
	private dragPayload: DragPayload | null = null;
	private unsubscribers: (() => void)[] = [];
	private renderQueued = false;

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
		const unit = this.plugin.unitIndex.getUnits().find((u) => unitRefsEqual(unitToRef(u), ref));
		if (unit) {
			const resolved = await resolveUnit(this.plugin.app, this.plugin.settings, unit);
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
		container.empty();
		container.addClass("atlas-explorer");

		const view = this.plugin.viewsManager.getActiveView();
		const allUnits = this.plugin.unitIndex.getUnits();

		this.renderToolbar(container, view);

		const bucketEl = container.createDiv({ cls: "atlas-section atlas-bucket" });
		await this.renderBucketSection(bucketEl, view);

		const inboxUnits = this.plugin.viewsManager.getInboxUnits(allUnits, view.id, view.inboxMode);
		const inboxEl = container.createDiv({ cls: "atlas-section atlas-inbox" });
		await this.renderInboxSection(inboxEl, view, inboxUnits);

		container.scrollTop = scrollTop;
		this.updateActiveHighlight();
	}

	// --- toolbar -------------------------------------------------------------------------------

	private renderToolbar(container: HTMLElement, view: View): void {
		const toolbar = container.createDiv({ cls: "atlas-toolbar" });

		const viewSelect = toolbar.createEl("select", { cls: "atlas-view-select" });
		for (const v of this.plugin.viewsManager.getViews()) {
			const option = viewSelect.createEl("option", { text: v.name, value: v.id });
			if (v.id === view.id) option.selected = true;
		}
		viewSelect.addEventListener("change", () => {
			this.plugin.viewsManager.setActiveViewId(viewSelect.value);
		});

		this.toolbarButton(toolbar, "plus", "New view", () => {
			new TextPromptModal(this.plugin.app, "New view", "", (name) => {
				if (!name.trim()) return;
				const created = this.plugin.viewsManager.createView(name);
				if (!created) return new Notice(`Atlas: a view named "${name}" already exists.`);
				this.plugin.viewsManager.setActiveViewId(created.id);
			}).open();
		});

		this.toolbarButton(toolbar, "pencil", "Rename view", () => {
			new TextPromptModal(this.plugin.app, "Rename view", view.name, (name) => {
				if (!this.plugin.viewsManager.renameView(view.id, name)) {
					new Notice(`Atlas: a view named "${name}" already exists.`);
				}
			}).open();
		});

		this.toolbarButton(toolbar, "trash-2", "Delete view", () => {
			new ConfirmModal(
				this.plugin.app,
				`Delete the view "${view.name}"? Units placed only in this view move to the global inbox — nothing on disk changes.`,
				"Delete",
				() => this.plugin.viewsManager.deleteView(view.id)
			).open();
		});

		toolbar.createDiv({ cls: "atlas-toolbar-sep" });

		this.toolbarButton(toolbar, "square-plus", "Add block", () => void addBlock(this.plugin));
		this.toolbarButton(toolbar, "file-plus", "Add file", () => void this.addFile());
		this.toolbarButton(toolbar, "folder-plus", "Add folder", () => void this.addFolder());
		this.toolbarButton(toolbar, "layers", "Add meta folder", () => this.addMetaFolder(view, null));

		toolbar.createDiv({ cls: "atlas-toolbar-sep" });

		this.toolbarButton(toolbar, this.sortMode === "manual" ? "arrow-up-down" : "arrow-down-a-z", "Sort: manual / A–Z", () => {
			this.sortMode = this.sortMode === "manual" ? "alphabetical" : "manual";
			void this.render();
		});
		this.toolbarButton(toolbar, "chevrons-down-up", "Collapse all", () => this.plugin.viewsManager.collapseAll(view.id));

		const filterInput = toolbar.createEl("input", { cls: "atlas-filter", attr: { type: "text", placeholder: "Filter…" } });
		filterInput.value = this.filterText;
		filterInput.addEventListener("input", () => {
			this.filterText = filterInput.value;
			void this.render();
		});
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
		await this.plugin.app.vault.createFolder(await this.uniquePath("New folder", null));
	}

	private async uniquePath(base: string, ext: string | null): Promise<string> {
		const suffix = ext ? `.${ext}` : "";
		let candidate = `${base}${suffix}`;
		let i = 1;
		while (this.plugin.app.vault.getAbstractFileByPath(candidate)) {
			candidate = `${base} ${++i}${suffix}`;
		}
		return candidate;
	}

	private addMetaFolder(view: View, parentId: string | null): void {
		new TextPromptModal(this.plugin.app, "New meta folder", "New folder", (label) => {
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

		const listEl = container.createDiv({ cls: "atlas-node-list" });
		this.makeDropZone(listEl, { kind: "bucket-root", viewId: view.id });
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

	private async renderNode(node: ViewNode, container: HTMLElement, view: View, depth: number): Promise<void> {
		if (node.type === "meta") {
			const row = container.createDiv({ cls: "atlas-row atlas-row-meta" });
			row.style.paddingLeft = `${depth * 16}px`;
			row.setAttr("draggable", "true");
			const chevron = row.createDiv({ cls: "atlas-chevron" });
			setIcon(chevron, node.collapsed ? "chevron-right" : "chevron-down");
			chevron.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.plugin.viewsManager.setNodeCollapsed(view.id, node.id, !node.collapsed);
			});
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

			if (!node.collapsed) {
				await this.renderNodeList(node.children, container, view, depth + 1);
			}
			return;
		}

		const ref = node.ref;
		if (!ref) return;
		const info = await this.resolveRef(ref);
		if (!this.matchesFilter(info.text)) return;

		const row = container.createDiv({ cls: "atlas-row atlas-row-unit" });
		if (info.missing) row.addClass("atlas-missing");
		row.dataset.refKey = unitRefKey(ref);
		row.style.paddingLeft = `${depth * 16 + 16}px`;
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

		for (const { ref, info, unit } of sorted) {
			const row = listEl.createDiv({ cls: "atlas-row atlas-row-unit" });
			row.dataset.refKey = unitRefKey(ref);
			row.setAttr("draggable", "true");
			const iconEl = row.createDiv({ cls: "atlas-icon" });
			setIcon(iconEl, info.icon);
			row.createSpan({ cls: "atlas-row-text", text: info.text });
			if (info.promoted) row.createSpan({ cls: "atlas-badge", text: "promoted" });
			if (info.secondary) row.createSpan({ cls: "atlas-row-secondary", text: info.secondary });
			if (unit.type === "folder-unit") this.addExpandChevron(row, unit.path, listEl, view);

			this.setPlacementTooltip(row, ref);
			row.addEventListener("click", () => void this.openRef(ref));
			row.addEventListener("dragstart", () => (this.dragPayload = { kind: "inbox", ref }));
			row.tabIndex = 0;
			row.addEventListener("contextmenu", (evt) => {
				evt.preventDefault();
				this.showInboxUnitMenu(evt, ref);
			});
		}
	}

	// --- F3: expanding a folder-unit's internals from the inbox -----------------------------------

	private addExpandChevron(row: HTMLElement, folderPath: string, container: HTMLElement, view: View): void {
		const chevron = row.createDiv({ cls: "atlas-chevron atlas-chevron-inline" });
		const expanded = this.expandedFolders.has(folderPath);
		setIcon(chevron, expanded ? "chevron-down" : "chevron-right");
		chevron.addEventListener("click", (evt) => {
			evt.stopPropagation();
			if (this.expandedFolders.has(folderPath)) this.expandedFolders.delete(folderPath);
			else this.expandedFolders.add(folderPath);
			void this.render();
		});
		if (expanded) {
			const folder = this.plugin.app.vault.getAbstractFileByPath(folderPath);
			if (folder instanceof TFolder) {
				const internalsEl = container.createDiv({ cls: "atlas-internals" });
				this.renderInternals(folder, internalsEl, 1, view);
			}
		}
	}

	private renderInternals(folder: TFolder, container: HTMLElement, depth: number, view: View): void {
		for (const child of folder.children) {
			const row = container.createDiv({ cls: "atlas-row atlas-row-internal" });
			row.style.paddingLeft = `${depth * 16 + 16}px`;
			row.setAttr("draggable", "true");
			const iconEl = row.createDiv({ cls: "atlas-icon" });
			setIcon(iconEl, child instanceof TFolder ? "folder" : "file");
			row.createSpan({ cls: "atlas-row-text", text: child.name });
			row.addEventListener("click", () => {
				if (child instanceof TFile) void this.plugin.app.workspace.getLeaf(false).openFile(child);
			});
			row.addEventListener("dragstart", () => {
				this.dragPayload = { kind: "internal", path: child.path, isFolder: child instanceof TFolder };
			});
			row.addEventListener("contextmenu", (evt) => {
				evt.preventDefault();
				const menu = new Menu();
				menu.addItem((item) => item.setTitle("Reveal in native explorer").setIcon("folder-open").onClick(() => this.revealInNativeExplorer(child.path)));
				menu.showAtMouseEvent(evt);
			});
			if (child instanceof TFolder) this.renderInternals(child, container, depth + 1, view);
		}
	}

	/** F3: dragging an internal out of the expanded tree manually promotes it and places it. */
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

	/** Never calls `vault.rename`/`fileManager.renameFile` — every branch here only touches
	 * plugin-owned view/promotion data (Part 7). */
	private handleDrop(target: { kind: "node"; nodeId: string; viewId: string } | { kind: "bucket-root"; viewId: string } | { kind: "inbox-area"; viewId: string }): void {
		const payload = this.dragPayload;
		this.dragPayload = null;
		if (!payload) return;

		if (target.kind === "inbox-area") {
			if (payload.kind === "node") this.plugin.viewsManager.unplaceUnit(payload.viewId, this.refOfNode(payload));
			return;
		}

		const viewId = target.viewId;
		let parentId: string | null = null;
		let index = 0;
		if (target.kind === "node") {
			const view = this.plugin.viewsManager.getView(viewId);
			const found = view && this.findNodeAnywhere(view.root, target.nodeId);
			if (found?.node.type === "meta") {
				parentId = found.node.id;
				index = found.node.children.length;
			} else if (found) {
				// Part 4 edge case: dropping onto a unit node inserts as a sibling after it.
				parentId = null;
				index = this.indexInParent(view!.root, target.nodeId) + 1;
			}
		}

		if (payload.kind === "internal") {
			this.promoteAndPlace(payload.path, payload.isFolder, this.plugin.viewsManager.getView(viewId)!, parentId);
			return;
		}
		const ref = payload.kind === "inbox" ? payload.ref : this.refOfNode(payload);
		if (!ref) return;
		this.plugin.viewsManager.placeUnit(viewId, ref, parentId);
		if (payload.kind === "node" && parentId !== undefined) {
			this.plugin.viewsManager.moveNode(viewId, this.nodeIdForRef(viewId, ref) ?? "", parentId, index);
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
				.setTitle("Rename meta folder")
				.setIcon("pencil")
				.onClick(() => {
					new TextPromptModal(this.plugin.app, "Rename meta folder", node.label ?? "", (label) => {
						this.plugin.viewsManager.renameMetaFolder(view.id, node.id, label);
					}).open();
				})
		);
		menu.addItem((item) =>
			item
				.setTitle("Delete meta folder")
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
			new TextPromptModal(this.plugin.app, "Rename meta folder", node.label ?? "", (label) => {
				this.plugin.viewsManager.renameMetaFolder(view.id, node.id, label);
			}).open();
		}
	}
}
