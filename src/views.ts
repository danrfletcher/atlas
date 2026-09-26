import { App } from "obsidian";
import type { UnitIndex } from "./unit-index";
import { DEFAULT_VIEW_NAME, StatusGovernance, Unit, UnitRef, View, ViewNode, createEmptyView, rewriteRefPath, unitRefsEqual, unitToRef } from "./types";

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

	/** Every placement of this ref across every view, as breadcrumb-able (view name, meta-folder
	 * path) pairs. PR 13: one entry per *placement*, not per view — duplicating a unit can now put
	 * it in more than one spot within the very same view, and the old first-match-only walk would
	 * have silently under-reported that (only ever showing one of the two, or more, placements). */
	getPlacements(ref: UnitRef): { viewName: string; path: string[] }[] {
		const placements: { viewName: string; path: string[] }[] = [];
		for (const view of this.views) {
			for (const path of this.allPathsToRef(view.root, ref, [])) {
				placements.push({ viewName: view.name, path });
			}
		}
		return placements;
	}

	/** PR 12: a unit can now be a meta-nesting parent too, not just meta folders — walked here using
	 * its own basename as the breadcrumb segment rather than the fully-resolved display text
	 * `resolveRef` would give (that needs async work this synchronous path-builder has no access
	 * to; a raw basename is a reasonable stand-in for a tooltip trail). Without this, a unit placed
	 * under another unit would silently report as "not placed anywhere" here, even though it is.
	 * PR 13: collects *every* match in the subtree instead of stopping at the first — a duplicated
	 * unit can now legitimately appear more than once in the same view, including nested inside a
	 * different placement of itself. */
	private allPathsToRef(nodes: ViewNode[], ref: UnitRef, trail: string[]): string[][] {
		const out: string[][] = [];
		for (const node of nodes) {
			if (node.type === "unit" && node.ref && unitRefsEqual(node.ref, ref)) out.push(trail);
			if (node.type === "meta") {
				out.push(...this.allPathsToRef(node.children, ref, [...trail, node.label ?? ""]));
			} else if (node.type === "unit" && node.ref && node.children.length > 0) {
				const basename = node.ref.path.split("/").pop() ?? node.ref.path;
				out.push(...this.allPathsToRef(node.children, ref, [...trail, basename]));
			}
		}
		return out;
	}

	/** Places `ref` under `parentId` (or bucket root if null). Moves it if already placed elsewhere
	 * in this view, rather than creating a duplicate node for the same unit. PR 13 review (A16): the
	 * "already placed" branch used to splice out that instance and replace it with a brand-new node
	 * (`children: []`), discarding whatever it had — dead code before duplication existed (only one
	 * placement per ref per view was ever possible), now reachable: "Place in view…" onto a ref that
	 * has meta-nested children silently dropped the subtree. Fixed the same way `handleDrop`'s
	 * reparent path and `unplaceUnit` already were — move the real node in place instead of
	 * discarding and recreating it, so its id/children travel with it. */
	placeUnit(viewId: string, ref: UnitRef, parentId: string | null): void {
		const view = this.getView(viewId);
		if (!view) return;
		const existing = this.findUnitNode(view.root, ref);
		const parent = parentId ? this.findNode(view.root, parentId) : null;
		const targetChildren = parent ? parent.node.children : view.root;
		if (existing) {
			const [node] = existing.siblings.splice(existing.index, 1);
			targetChildren.push(node);
		} else {
			const node: ViewNode = { id: generateNodeId(), type: "unit", ref, children: [] };
			targetChildren.push(node);
		}
		this.save();
	}

	/** Removes *every* placement of `ref` in this view — used when the ref itself has stopped being
	 * a valid unit (demoted/deleted) and needs purging wherever it appears, not just one instance.
	 * PR 13: a duplicated unit can now legitimately have more than one placement in the same view,
	 * so this loops until none are left rather than stopping after the first match (which used to
	 * leave stale duplicates behind). For removing one specific row the user is actually looking at,
	 * use `unplaceNode` instead — this one doesn't know or care which instance you meant. PR 12: each
	 * removal promotes that instance's own children up one level, the same rule `deleteMetaFolder`
	 * already applies for meta folders — nothing organizational should silently vanish. */
	unplaceUnit(viewId: string, ref: UnitRef): void {
		const view = this.getView(viewId);
		if (!view) return;
		let changed = false;
		let found = this.findUnitNode(view.root, ref);
		while (found) {
			found.siblings.splice(found.index, 1, ...found.node.children);
			changed = true;
			found = this.findUnitNode(view.root, ref);
		}
		if (changed) this.save();
	}

	/** Removes one specific node instance by id, regardless of what other placements of the same
	 * unit (if any, via PR 13's duplication) might also exist — this is what "Remove from view",
	 * the Delete key, and dragging a row back to the inbox all actually mean: get rid of *this* row,
	 * not every copy of the unit it happens to reference. Same children-promotion rule as
	 * `unplaceUnit`/`deleteMetaFolder`. */
	unplaceNode(viewId: string, nodeId: string): void {
		const view = this.getView(viewId);
		const found = view && this.findNode(view.root, nodeId);
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

	/** PR 13: deep-clones a node (unit or meta) — including its whole meta-nested subtree, if it
	 * has one — as a new sibling immediately after the original. New node ids throughout, but every
	 * clone still points at the same underlying unit (`ref`) or carries the same `label` as its
	 * original counterpart, and never touches disk. Grilled with Dan directly: no naming/numbering
	 * scheme — there's no non-fake way to give two siblings that reference the same disk path
	 * different display names, so duplicate labels are allowed outright rather than inventing a
	 * "meta name" override field just for this. */
	duplicateNode(viewId: string, nodeId: string): void {
		const view = this.getView(viewId);
		const found = view && this.findNode(view.root, nodeId);
		if (!found) return;
		const clone = this.cloneNode(found.node);
		found.siblings.splice(found.index + 1, 0, clone);
		this.save();
	}

	/** PR 18: a duplicate keeps the same status assignment its original had at the moment of
	 * duplication (grilled default from TASKS.md, resolved during this PR's build — no reason for a
	 * clone to start "blank" when everything else about it, including its own children, is copied).
	 * The shallow `{ ...node }` spread is enough for every scalar `StatusGovernance` field
	 * (`statusEnabled`, `statusSetId`, `inheritToSubfolders`, `explicitStatusId`, the hide flags), but
	 * `applyTo`/`truncatedStatuses` are objects — spreading would leave the clone sharing the *same*
	 * object reference as the original. Every write site (`modals.ts`, `updateStatusGovernance`)
	 * happens to replace that reference wholesale rather than mutating in place, so this wouldn't
	 * currently cause a visible bug either way — but a clone silently entangled with its original is
	 * a landmine for the next person to touch this, so copy them explicitly rather than lean on that. */
	private cloneNode(node: ViewNode): ViewNode {
		return {
			...node,
			id: generateNodeId(),
			applyTo: node.applyTo ? { ...node.applyTo } : node.applyTo,
			truncatedStatuses: node.truncatedStatuses ? { ...node.truncatedStatuses } : node.truncatedStatuses,
			children: node.children.map((child) => this.cloneNode(child)),
		};
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
	 * independent of whether a set has been chosen yet, matching PR 17's later "greyed out until
	 * master toggle on" framing). */
	setNodeStatus(viewId: string, nodeId: string, enabled: boolean, statusSetId: string | null): void {
		const view = this.getView(viewId);
		const found = view && this.findNode(view.root, nodeId);
		if (!found) return;
		found.node.statusEnabled = enabled;
		found.node.statusSetId = statusSetId ?? undefined;
		this.save();
	}

	/** PR 16: which status within its *governor's* set this exact node currently shows — set from
	 * the status-picker popup opened by clicking the node's own dot. No "clear" path (grilled: the
	 * reference plugin's own equivalent is dead code, never wired to any UI) — reverting to the
	 * governor's default is just picking that status from the same popup like any other choice. */
	setExplicitStatus(viewId: string, nodeId: string, statusId: string): void {
		const view = this.getView(viewId);
		const found = view && this.findNode(view.root, nodeId);
		if (!found) return;
		found.node.explicitStatusId = statusId;
		this.save();
	}

	getNode(viewId: string, nodeId: string): ViewNode | null {
		const view = this.getView(viewId);
		const found = view && this.findNode(view.root, nodeId);
		return found ? found.node : null;
	}

	/** PR 17: a governor is either a specific node (`nodeId` set — right-clicked from the bucket) or
	 * the view root itself (`nodeId: null` — right-clicked from the view-name selector). Both are
	 * `StatusGovernance` and behave identically to `resolveNodeStatus`'s own ancestor walk; these two
	 * methods are just the read/write side, generic over which kind of governor is being edited so
	 * the "Statuses" modal doesn't need two parallel code paths for what's otherwise the same UI. */
	getStatusGovernance(viewId: string, nodeId: string | null): StatusGovernance | null {
		if (nodeId === null) return this.getView(viewId) ?? null;
		return this.getNode(viewId, nodeId);
	}

	updateStatusGovernance(viewId: string, nodeId: string | null, patch: Partial<StatusGovernance>): void {
		const target: StatusGovernance | null = nodeId === null ? this.getView(viewId) ?? null : this.getNode(viewId, nodeId);
		if (!target) return;
		Object.assign(target, patch);
		this.save();
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

	/** Create Module on a root file: every node (every view, every duplicate) referencing the file
	 * becomes a module node, keeping id, position, fold state, status settings and children. Also
	 * matches `<folder>/<folder>.md`, so it gives the same result before or after the rename hook.
	 * With `unitIndex`, manual promotions are converted too. Data-only (never touches disk); saves
	 * and notifies once, and not at all when nothing matched. Block refs are left to the rename hook. */
	convertFileNodesToModule(filePath: string, folderPath: string, unitIndex?: UnitIndex): { nodes: number; manualPromotions: number } {
		const interfacePath = `${folderPath}/${folderPath.split("/").pop()}.md`;
		let nodes = 0;
		const walk = (list: ViewNode[]) => {
			for (const node of list) {
				const ref = node.ref;
				if (node.type === "unit" && ref?.kind === "file" && (ref.path === filePath || ref.path === interfacePath)) {
					node.ref = { kind: "folder", path: folderPath };
					nodes++;
				}
				walk(node.children);
			}
		};
		for (const view of this.views) walk(view.root);
		const manualPromotions = unitIndex?.convertManualPromotionToModule(filePath, folderPath) ?? 0;
		if (nodes > 0 || manualPromotions > 0) this.save();
		return { nodes, manualPromotions };
	}

	/** Create on a meta folder: the meta node becomes a unit node in place. Same id, position, fold
	 * state, status settings and children (all left as they are); only `type`/`ref` change and the
	 * label goes. Returns false, changing nothing, unless `nodeId` is a meta node in `viewId`. */
	replaceMetaNodeWithUnit(viewId: string, nodeId: string, ref: UnitRef): boolean {
		const view = this.getView(viewId);
		const found = view && this.findNode(view.root, nodeId);
		if (!found || found.node.type !== "meta") return false;
		found.node.type = "unit";
		found.node.ref = ref;
		delete found.node.label;
		this.save();
		return true;
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
