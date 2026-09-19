import { App } from "obsidian";
import { DEFAULT_VIEW_NAME, Unit, UnitRef, View, ViewNode, createEmptyView, rewriteRefPath, unitRefsEqual, unitToRef } from "./types";

function generateNodeId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface MetaTarget {
	id: string | null;
	label: string;
}

/** Every meta folder in a view's tree, breadcrumb-labelled, for "Place in view ▸" pickers. */
export function flattenMetaFolders(nodes: ViewNode[], trail: string[] = []): MetaTarget[] {
	const out: MetaTarget[] = [];
	for (const node of nodes) {
		if (node.type !== "meta") continue;
		const label = [...trail, node.label ?? ""].join(" › ");
		out.push({ id: node.id, label });
		out.push(...flattenMetaFolders(node.children, [...trail, node.label ?? ""]));
	}
	return out;
}

interface FoundNode {
	node: ViewNode;
	siblings: ViewNode[];
	index: number;
}

/**
 * F9 — views (named arrangements of units into a bucket tree) with storage/integrity. The bucket
 * is a drawing over the vault, never a second copy of it: placing/removing/reparenting a node here
 * never touches the filesystem (Part 7's own warning) — the only paths that do are F3/F4's
 * `createInterfaceNote`/`Add block`, both outside this file entirely.
 */
export class ViewsManager {
	private views: View[];
	private activeViewId: string;
	private changeListeners = new Set<() => void>();

	constructor(private app: App, initialViews: View[], initialActiveViewId: string, private persist: () => void) {
		this.views = initialViews.length > 0 ? initialViews : [createEmptyView(generateNodeId(), DEFAULT_VIEW_NAME)];
		this.activeViewId = this.views.some((v) => v.id === initialActiveViewId) ? initialActiveViewId : this.views[0].id;
	}

	onChange(cb: () => void): () => void {
		this.changeListeners.add(cb);
		return () => this.changeListeners.delete(cb);
	}

	private save(): void {
		this.persist();
		for (const cb of this.changeListeners) cb();
	}

	getViews(): View[] {
		return this.views;
	}

	getActiveViewId(): string {
		return this.activeViewId;
	}

	getActiveView(): View {
		return this.views.find((v) => v.id === this.activeViewId) ?? this.views[0];
	}

	getView(id: string): View | undefined {
		return this.views.find((v) => v.id === id);
	}

	setActiveViewId(id: string): void {
		if (!this.views.some((v) => v.id === id) || id === this.activeViewId) return;
		this.activeViewId = id;
		this.save();
	}

	/** F9 edge case: view names must be unique (case-insensitive, so "Default"/"default" collide). */
	private nameTaken(name: string, excludingId?: string): boolean {
		const lower = name.trim().toLowerCase();
		return this.views.some((v) => v.id !== excludingId && v.name.toLowerCase() === lower);
	}

	createView(name: string): View | null {
		const trimmed = name.trim();
		if (!trimmed || this.nameTaken(trimmed)) return null;
		const view = createEmptyView(generateNodeId(), trimmed);
		this.views.push(view);
		this.save();
		return view;
	}

	renameView(id: string, name: string): boolean {
		const trimmed = name.trim();
		const view = this.getView(id);
		if (!trimmed || !view || this.nameTaken(trimmed, id)) return false;
		view.name = trimmed;
		this.save();
		return true;
	}

	/** F9 edge case: deleting the last view recreates "Default". */
	deleteView(id: string): void {
		this.views = this.views.filter((v) => v.id !== id);
		if (this.views.length === 0) {
			this.views.push(createEmptyView(generateNodeId(), DEFAULT_VIEW_NAME));
		}
		if (this.activeViewId === id) {
			this.activeViewId = this.views[0].id;
		}
		this.save();
	}

	private findNode(nodes: ViewNode[], nodeId: string): FoundNode | null {
		for (let i = 0; i < nodes.length; i++) {
			if (nodes[i].id === nodeId) return { node: nodes[i], siblings: nodes, index: i };
			const found = this.findNode(nodes[i].children, nodeId);
			if (found) return found;
		}
		return null;
	}

	private findUnitNode(nodes: ViewNode[], ref: UnitRef): FoundNode | null {
		for (let i = 0; i < nodes.length; i++) {
			if (nodes[i].type === "unit" && nodes[i].ref && unitRefsEqual(nodes[i].ref as UnitRef, ref)) {
				return { node: nodes[i], siblings: nodes, index: i };
			}
			const found = this.findUnitNode(nodes[i].children, ref);
			if (found) return found;
		}
		return null;
	}

	isPlaced(viewId: string, ref: UnitRef): boolean {
		const view = this.getView(viewId);
		return !!view && this.findUnitNode(view.root, ref) !== null;
	}

	isPlacedAnywhere(ref: UnitRef): boolean {
		return this.views.some((v) => this.findUnitNode(v.root, ref) !== null);
	}

	/** Every view this ref is currently placed in, as breadcrumb-able (view name, meta-folder path) pairs. */
	getPlacements(ref: UnitRef): { viewName: string; path: string[] }[] {
		const placements: { viewName: string; path: string[] }[] = [];
		for (const view of this.views) {
			const path = this.pathToRef(view.root, ref, []);
			if (path) placements.push({ viewName: view.name, path });
		}
		return placements;
	}

	/** PR 12: a unit can now be a meta-nesting parent too, not just meta folders — walked here using
	 * its own basename as the breadcrumb segment rather than the fully-resolved display text
	 * `resolveRef` would give (that needs async work this synchronous path-builder has no access
	 * to; a raw basename is a reasonable stand-in for a tooltip trail). Without this, a unit placed
	 * under another unit would silently report as "not placed anywhere" here, even though it is. */
	private pathToRef(nodes: ViewNode[], ref: UnitRef, trail: string[]): string[] | null {
		for (const node of nodes) {
			if (node.type === "unit" && node.ref && unitRefsEqual(node.ref, ref)) return trail;
			if (node.type === "meta") {
				const found = this.pathToRef(node.children, ref, [...trail, node.label ?? ""]);
				if (found) return found;
			} else if (node.type === "unit" && node.ref && node.children.length > 0) {
				const basename = node.ref.path.split("/").pop() ?? node.ref.path;
				const found = this.pathToRef(node.children, ref, [...trail, basename]);
				if (found) return found;
			}
		}
		return null;
	}

	/** Places `ref` under `parentId` (or bucket root if null). Moves it if already placed elsewhere
	 * in this view, rather than creating a duplicate node for the same unit. */
	placeUnit(viewId: string, ref: UnitRef, parentId: string | null): void {
		const view = this.getView(viewId);
		if (!view) return;
		const existing = this.findUnitNode(view.root, ref);
		if (existing) existing.siblings.splice(existing.index, 1);
		const node: ViewNode = { id: generateNodeId(), type: "unit", ref, children: [] };
		const parent = parentId ? this.findNode(view.root, parentId) : null;
		(parent ? parent.node.children : view.root).push(node);
		this.save();
	}

	/** PR 12: a unit can now have meta-nested children of its own (any node can be a parent).
	 * Removing it from the view promotes its children up one level at the position it occupied,
	 * the same rule `deleteMetaFolder` already applies — nothing organizational should silently
	 * vanish just because its parent was unplaced. */
	unplaceUnit(viewId: string, ref: UnitRef): void {
		const view = this.getView(viewId);
		if (!view) return;
		const found = this.findUnitNode(view.root, ref);
		if (!found) return;
		found.siblings.splice(found.index, 1, ...found.node.children);
		this.save();
	}

	addMetaFolder(viewId: string, parentId: string | null, label: string): ViewNode | null {
		const view = this.getView(viewId);
		if (!view) return null;
		const node: ViewNode = { id: generateNodeId(), type: "meta", label: label.trim() || "New folder", children: [] };
		const parent = parentId ? this.findNode(view.root, parentId) : null;
		(parent ? parent.node.children : view.root).push(node);
		this.save();
		return node;
	}

	renameMetaFolder(viewId: string, nodeId: string, label: string): boolean {
		const trimmed = label.trim();
		const view = this.getView(viewId);
		const found = view && this.findNode(view.root, nodeId);
		if (!trimmed || !found || found.node.type !== "meta") return false;
		found.node.label = trimmed;
		this.save();
		return true;
	}

	/** Deleting a meta folder moves its children up one level, at the position it occupied — never
	 * deletes the children themselves, and never touches disk (they're labels, not folders). */
	deleteMetaFolder(viewId: string, nodeId: string): void {
		const view = this.getView(viewId);
		const found = view && this.findNode(view.root, nodeId);
		if (!found || found.node.type !== "meta") return;
		found.siblings.splice(found.index, 1, ...found.node.children);
		this.save();
	}

	private isSameOrDescendant(node: ViewNode, targetId: string): boolean {
		if (node.id === targetId) return true;
		return node.children.some((child) => this.isSameOrDescendant(child, targetId));
	}

	/** Reparents/reorders any node (unit or meta) within the bucket. Refuses a node being dropped
	 * into its own descendant, or onto itself (Part 4 edge case / PR 12 — would disconnect the tree
	 * or self-reference). PR 12: any node can now be a parent, not just meta folders — meta-nesting
	 * via drop (issue 3) lets a module/file/block become an organizational parent the same way a
	 * meta folder already could, without a real disk move. */
	moveNode(viewId: string, nodeId: string, newParentId: string | null, index: number): boolean {
		const view = this.getView(viewId);
		if (!view) return false;
		const found = this.findNode(view.root, nodeId);
		if (!found) return false;
		if (newParentId && this.isSameOrDescendant(found.node, newParentId)) return false;

		const newParent = newParentId ? this.findNode(view.root, newParentId) : null;
		if (newParentId && !newParent) return false;

		found.siblings.splice(found.index, 1);
		const targetChildren = newParent ? newParent.node.children : view.root;
		targetChildren.splice(Math.max(0, Math.min(index, targetChildren.length)), 0, found.node);
		this.save();
		return true;
	}

	getInboxUnits(allUnits: Unit[], viewId: string, mode: "view" | "global"): Unit[] {
		if (mode === "global") {
			return allUnits.filter((u) => !this.isPlacedAnywhere(unitToRef(u)));
		}
		return allUnits.filter((u) => !this.isPlaced(viewId, unitToRef(u)));
	}

	setNodeCollapsed(viewId: string, nodeId: string, collapsed: boolean): void {
		const view = this.getView(viewId);
		const found = view && this.findNode(view.root, nodeId);
		if (!found) return;
		found.node.collapsed = collapsed;
		this.save();
	}

	/** PR 15: this node's minimal status assignment (master toggle + which set) governing its own
	 * *direct children* — never this node's own displayed status (Dan's spec: "the statuses apply
	 * to the first direct children under that item"). `statusSetId: null` clears the assignment's
	 * set without necessarily disabling it (the "Statuses" modal keeps the toggle's state
	 * independent of whether a set has been chosen yet, matching PR 16's later "greyed out until
	 * master toggle on" framing). */
	setNodeStatus(viewId: string, nodeId: string, enabled: boolean, statusSetId: string | null): void {
		const view = this.getView(viewId);
		const found = view && this.findNode(view.root, nodeId);
		if (!found) return;
		found.node.statusEnabled = enabled;
		found.node.statusSetId = statusSetId ?? undefined;
		this.save();
	}

	getNode(viewId: string, nodeId: string): ViewNode | null {
		const view = this.getView(viewId);
		const found = view && this.findNode(view.root, nodeId);
		return found ? found.node : null;
	}

	/** PR 12: also collapses unit nodes that have gained meta-nested children — meta folders always
	 * collapse here regardless of child count (existing behavior, a folder is always a foldable
	 * concept even empty), but a unit only ever shows a chevron once it actually has a child (Q5),
	 * so collapsing a childless one would be a no-op with nothing to reflect it visually anyway. */
	collapseAll(viewId: string): void {
		const view = this.getView(viewId);
		if (!view) return;
		const walk = (nodes: ViewNode[]) => {
			for (const node of nodes) {
				if (node.type === "meta" || node.children.length > 0) {
					node.collapsed = true;
					walk(node.children);
				}
			}
		};
		walk(view.root);
		this.save();
	}

	setInboxMode(viewId: string, mode: "view" | "global"): void {
		const view = this.getView(viewId);
		if (!view || view.inboxMode === mode) return;
		view.inboxMode = mode;
		this.save();
	}

	/** F9 rename integrity: rewrite every matching ref (exact + prefix) across every view. */
	onVaultRename(oldPath: string, newPath: string): void {
		let changed = false;
		for (const view of this.views) {
			if (this.rewriteTree(view.root, oldPath, newPath)) changed = true;
		}
		if (changed) this.save();
	}

	private rewriteTree(nodes: ViewNode[], oldPath: string, newPath: string): boolean {
		let changed = false;
		for (const node of nodes) {
			if (node.type === "unit" && node.ref) {
				const rewritten = rewriteRefPath(node.ref, oldPath, newPath);
				if (rewritten !== node.ref) {
					node.ref = rewritten;
					changed = true;
				}
			}
			if (this.rewriteTree(node.children, oldPath, newPath)) changed = true;
		}
		return changed;
	}
}
