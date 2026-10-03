import { App } from "obsidian";
import type { UnitIndex } from "./unit-index";
import { clampRefreshMinutes } from "./api-refresh-timer";
import { ApiClickAction, ApiFieldMapping, ApiItemState, ApiSourceConfig, DEFAULT_VIEW_NAME, StatusGovernance, Unit, UnitRef, View, ViewNode, createEmptyView, rewriteRefPath, unitRefsEqual, unitToRef } from "./types";

function generateNodeId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** R20/E9: a `noteRef` loaded from `data.json` can be any JSON value — validates it actually has the
 * `UnitRef` shape (a known `kind` and a string `path`, plus `subpath` for a block) before it's trusted
 * anywhere else, the same way `sanitizeApiItemState` validates the rest of a row's fields. */
function isValidUnitRef(value: unknown): value is UnitRef {
	if (!value || typeof value !== "object") return false;
	const ref = value as { kind?: unknown; path?: unknown; subpath?: unknown };
	if (typeof ref.path !== "string") return false;
	if (ref.kind === "file" || ref.kind === "folder") return true;
	if (ref.kind === "block") return typeof ref.subpath === "string";
	return false;
}

/** R20/E9: `apiItemState` entries come straight from `data.json` and can each be malformed
 * independently of the container being a well-shaped object — e.g. `{"1": {"id": "1"}}` (no label) or
 * `{"1": 5}`. Left unchecked, a missing/non-string `label` crashes `apiItemMatchesFilter` and
 * `item.label.trim()` (both called on every render/filter keystroke), and a non-string or unparsable
 * `lastSeenAt` renders as "not found, last seen NaN-NaN-NaN". Returns `null` for an entry too broken to
 * repair (not an object, or no string `label`); everything else is dropped field-by-field rather than
 * discarding the whole row. `id` is always retaken from the state map's own key, since that's the
 * value every other lookup (by id) actually keys on. */
function sanitizeApiItemState(raw: unknown, key: string): ApiItemState | null {
	if (!raw || typeof raw !== "object") return null;
	const item = raw as Partial<ApiItemState>;
	if (typeof item.label !== "string") return null;

	const sanitized: ApiItemState = { id: key, label: item.label };
	if (typeof item.secondary === "string") sanitized.secondary = item.secondary;
	if (typeof item.explicitStatusId === "string") sanitized.explicitStatusId = item.explicitStatusId;
	if (isValidUnitRef(item.noteRef)) sanitized.noteRef = item.noteRef;
	if (item.notFound === true) sanitized.notFound = true;
	if (typeof item.lastSeenAt === "string" && !isNaN(new Date(item.lastSeenAt).getTime())) {
		sanitized.lastSeenAt = item.lastSeenAt;
	}
	return sanitized;
}

/** R17/E9: `data.json` is free-form JSON — hand-edited or corrupted, `apiSource` can be missing its
 * `mapping`, and `apiItemOrder`/`apiItemState` can be any shape at all (an object instead of an array,
 * a number, absent). Left unchecked, that crashes `renderApiItems`'s `for...of` over `apiItemOrder`,
 * `mergeApiItems`'s own iteration over the same, and `mapResponseRows` reading `mapping.arrayField` off
 * `undefined`. Called once, here, on load — so every other API-source code path can assume these
 * fields are always well-shaped afterwards instead of re-guarding at every use site. An `apiSource`
 * missing a usable `mapping` is dropped entirely (rather than guessed at — there's no safe default id/
 * label field to invent), but PR-3's G4 means that no longer implies wiping `apiItemState`/
 * `apiItemOrder` too: a Folder can legitimately have rows with no source at all (source removed, or a
 * `data.json` that dropped just the `apiSource` object by hand), and those rows are sanitized on their
 * own merits below, independent of whether `apiSource` survived. */
function sanitizeApiFields(node: ViewNode): void {
	if (node.apiSource) {
		const raw = node.apiSource as Partial<ApiSourceConfig> & { mapping?: Partial<ApiFieldMapping> };
		const mapping = raw.mapping;
		const validMapping = !!mapping && typeof mapping.idField === "string" && typeof mapping.labelField === "string";
		// PR-4/G3: in "js" mode the mapping step is replaced by `jsSource` — a JS-mode source is valid
		// on a usable `jsSource` string, not a usable drag `mapping` (which may never have been touched
		// at all for a source built entirely in JS mode). `mapping` is still sanitized/kept either way
		// (defaulted to empty fields if absent) so a later switch back to drag has something to show,
		// matching "mapping is retained unchanged while in js mode."
		const isJsMode = raw.mappingMode === "js";
		const validJsSource = typeof raw.jsSource === "string";
		const mappingOrJsValid = isJsMode ? validJsSource : validMapping;
		if (typeof raw.url !== "string" || !mappingOrJsValid) {
			node.apiSource = undefined;
		} else {
			// G5b/R6: any out-of-range `refreshEveryMinutes` reaching here some other way (hand-edited
			// `data.json`) is clamped into range rather than rejected outright — including zero and
			// negative values, per the spec's "interval change to below 5 minutes ... is clamped to 5 at
			// load" (clampRefreshMinutes floors at MIN_REFRESH_MINUTES regardless of how far below it the
			// stored value is). A toggle left on with no usable number at all (missing, or not a finite
			// number) is forced off instead of inventing one (there is deliberately no fixed default value
			// for this field).
			const rawMinutes = raw.refreshEveryMinutes;
			const validMinutes = typeof rawMinutes === "number" && Number.isFinite(rawMinutes);
			const refreshEveryMinutes = validMinutes ? clampRefreshMinutes(rawMinutes) : undefined;
			const rawExtras = mapping?.extraFields ?? (mapping as unknown as { extras?: unknown })?.extras;
			const extraFields: Record<string, string> = {};
			if (rawExtras && typeof rawExtras === "object" && !Array.isArray(rawExtras)) {
				for (const [k, v] of Object.entries(rawExtras)) {
					if (typeof k === "string" && typeof v === "string" && /^[a-zA-Z0-9_]+$/.test(k)) {
						extraFields[k] = v;
					}
				}
			}
			const extraFieldsRecord = Object.keys(extraFields).length > 0 ? extraFields : undefined;
			const rawAction = raw.action ?? raw.clickAction;
			const action: ApiClickAction | undefined =
				rawAction === "none" || rawAction === "run-command" || rawAction === "open-attachment" ? rawAction : undefined;
			const command = typeof raw.command === "string" ? raw.command : undefined;
			node.apiSource = {
				url: raw.url,
				method: "GET",
				mapping: {
					idField: typeof mapping?.idField === "string" ? mapping.idField : "",
					labelField: typeof mapping?.labelField === "string" ? mapping.labelField : "",
					secondaryField: typeof mapping?.secondaryField === "string" ? mapping.secondaryField : undefined,
					arrayField: typeof mapping?.arrayField === "string" ? mapping.arrayField : undefined,
					extraFields: extraFieldsRecord,
				},
				mode: raw.mode === "append" ? "append" : raw.mode === "overwrite" ? "overwrite" : "merge",
				refreshOnViewLoad: !!raw.refreshOnViewLoad,
				refreshEveryMinutesEnabled: !!raw.refreshEveryMinutesEnabled && refreshEveryMinutes !== undefined,
				refreshEveryMinutes,
				keepOnEmpty: typeof raw.keepOnEmpty === "boolean" ? raw.keepOnEmpty : undefined,
				confirmBeforeDelete: typeof raw.confirmBeforeDelete === "boolean" ? raw.confirmBeforeDelete : undefined,
				mappingMode: isJsMode ? "js" : undefined,
				jsSource: typeof raw.jsSource === "string" ? raw.jsSource : undefined,
				action,
				clickAction: action,
				command,
			};
		}
	}

	// G4: rows survive a source's removal as plain static rows — sanitize `apiItemState`/`apiItemOrder`
	// whenever either is actually present (or a source exists to have produced them), rather than only
	// when `apiSource` currently exists.
	const hasApiState = !!node.apiSource || node.apiItemState !== undefined || node.apiItemOrder !== undefined;
	if (hasApiState) {
		if (!node.apiItemState || typeof node.apiItemState !== "object" || Array.isArray(node.apiItemState)) {
			node.apiItemState = {};
		} else {
			const cleaned: Record<string, ApiItemState> = {};
			for (const [id, raw] of Object.entries(node.apiItemState)) {
				const sanitized = sanitizeApiItemState(raw, id);
				if (sanitized) cleaned[id] = sanitized;
			}
			node.apiItemState = cleaned;
		}
		if (!Array.isArray(node.apiItemOrder)) {
			node.apiItemOrder = Object.keys(node.apiItemState);
		} else {
			node.apiItemOrder = node.apiItemOrder.filter((id) => typeof id === "string" && Object.prototype.hasOwnProperty.call(node.apiItemState, id));
		}
	} else {
		node.apiItemState = undefined;
		node.apiItemOrder = undefined;
	}

	// Cache and the awaiting-confirmation flag are meaningless without a live source — G4's static rows
	// never show a dot at all (that's `explorer-view.ts`'s job, gated on `apiSource`, not this).
	if (node.apiSource) {
		if (!node.apiCache || typeof node.apiCache !== "object") node.apiCache = undefined;
		if (typeof node.apiAwaitingConfirmation !== "boolean") node.apiAwaitingConfirmation = undefined;
	} else {
		node.apiCache = undefined;
		node.apiAwaitingConfirmation = undefined;
	}

	for (const child of node.children) sanitizeApiFields(child);
}

/** G9b: resolves the effective click action for a source, defaulting to "open-attachment". */
export function resolveClickAction(source: ApiSourceConfig | undefined | null): ApiClickAction {
	return source?.action ?? source?.clickAction ?? "open-attachment";
}

/** G2: resolves the extra fields mapping for a source, defaulting to empty record. */
export function resolveExtraFields(mapping: ApiFieldMapping | undefined | null): Record<string, string> {
	return mapping?.extraFields ?? {};
}

/** R17/E9: sanitizes every view's tree in place before anything else touches it. */
function sanitizeViewsApiFields(views: View[]): void {
	for (const view of views) {
		for (const node of view.root) sanitizeApiFields(node);
	}
}

/** G7: a deep copy of a source config — `duplicateNode`'s clone must never share `mapping` (or any
 * later-added nested object) by reference with the original, or editing one's field mapping would
 * silently edit the other's too. */
function cloneApiSource(source: ApiSourceConfig): ApiSourceConfig {
	return {
		...source,
		mapping: {
			...source.mapping,
			extraFields: source.mapping.extraFields ? { ...source.mapping.extraFields } : undefined,
		},
	};
}

export interface ApiSourceIdPair {
	originalId: string;
	cloneId: string;
}

/** G7/R3: `cloneNode` deep-copies `apiSource` itself, but the device-local request headers for it live
 * outside this tree entirely, in `ApiHeadersStore` (keyed by node id) — a duplicate's headers have no
 * home in `duplicateNode`'s return value, so the caller (`explorer-view.ts`) walks the original and its
 * clone side by side (identical shape/order — both built by the same `cloneNode` recursion) and copies
 * each sourced node's headers entry across using these pairs. Covers nested sourced Folders in the
 * duplicated subtree too, not just the duplicated node itself. */
export function collectApiSourceNodeIdPairs(original: ViewNode, clone: ViewNode): ApiSourceIdPair[] {
	const pairs: ApiSourceIdPair[] = [];
	if (original.apiSource) pairs.push({ originalId: original.id, cloneId: clone.id });
	for (let i = 0; i < original.children.length; i++) {
		pairs.push(...collectApiSourceNodeIdPairs(original.children[i], clone.children[i]));
	}
	return pairs;
}

/** G7 (extended to G4's static rows): a deep copy of a Folder's per-id row state — `noteRef` is itself
 * an object, so a shallow copy of the map would still leave both copies' rows pointing at (and able to
 * mutate) the very same `UnitRef`. */
function cloneApiItemState(state: Record<string, ApiItemState>): Record<string, ApiItemState> {
	const out: Record<string, ApiItemState> = {};
	for (const [id, item] of Object.entries(state)) {
		out[id] = { ...item, noteRef: item.noteRef ? { ...item.noteRef } : item.noteRef };
	}
	return out;
}

/** G4/T2: a Folder has API rows to show — either a live source (even before its first refresh
 * fills any rows) or static rows left behind by "Remove data source" — gated on this, never on
 * `apiSource` alone, so removing the source doesn't also hide the rows it leaves behind. */
export function nodeHasApiRows(node: Pick<ViewNode, "apiSource" | "apiItemOrder">): boolean {
	return Boolean(node.apiSource) || Boolean(node.apiItemOrder && node.apiItemOrder.length > 0);
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
		sanitizeViewsApiFields(initialViews);
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
	duplicateNode(viewId: string, nodeId: string): ViewNode | null {
		const view = this.getView(viewId);
		const found = view && this.findNode(view.root, nodeId);
		if (!found) return null;
		const clone = this.cloneNode(found.node);
		found.siblings.splice(found.index + 1, 0, clone);
		this.save();
		return clone;
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
	 * a landmine for the next person to touch this, so copy them explicitly rather than lean on that.
	 *
	 * G7: the same shallow-spread hazard applies to a Folder's API fields, and here it *was* live —
	 * `apiSource`/`apiItemState`/`apiItemOrder` would otherwise be the very same objects on both nodes,
	 * so editing one's mapping or an item's status would silently edit the other's too. A duplicate's
	 * source is deep-copied; its cache and rows are never carried over at all (G7: "copy starts with
	 * grey dot, no rows until first refresh") — a node with leftover static rows but no source (G4) still
	 * gets its own independent copy of those, for the same reference-sharing reason. */
	private cloneNode(node: ViewNode): ViewNode {
		const clone: ViewNode = {
			...node,
			id: generateNodeId(),
			applyTo: node.applyTo ? { ...node.applyTo } : node.applyTo,
			truncatedStatuses: node.truncatedStatuses ? { ...node.truncatedStatuses } : node.truncatedStatuses,
			children: node.children.map((child) => this.cloneNode(child)),
		};

		if (node.apiSource) {
			clone.apiSource = cloneApiSource(node.apiSource);
			clone.apiItemState = {};
			clone.apiItemOrder = [];
		} else if (node.apiItemState) {
			clone.apiItemState = cloneApiItemState(node.apiItemState);
			clone.apiItemOrder = node.apiItemOrder ? [...node.apiItemOrder] : [];
		}
		clone.apiCache = undefined;
		clone.apiAwaitingConfirmation = undefined;

		return clone;
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

	/** PR-4 (G4/G5): `unitIndex` is optional only so existing callers/tests that predate dismiss state
	 * keep compiling unchanged — every real caller passes it. A row is excluded once dismissed per the
	 * OR-check `UnitIndex.isDismissed` already implements: global mode only ever reads the global
	 * dismiss set (so a non-Global dismiss never hides a row from Global, per G4's "no over-broad
	 * write"), while view mode reads that view's own set OR'd with the global set (so a Global-view
	 * dismiss cascades here without this method needing to enumerate views itself). */
	getInboxUnits(allUnits: Unit[], viewId: string, mode: "view" | "global", unitIndex?: UnitIndex): Unit[] {
		const placed =
			mode === "global"
				? allUnits.filter((u) => !this.isPlacedAnywhere(unitToRef(u)))
				: allUnits.filter((u) => !this.isPlaced(viewId, unitToRef(u)));
		if (!unitIndex) return placed;
		return placed.filter((u) => {
			const ref = unitToRef(u);
			return mode === "global" ? !unitIndex.isDismissed(ref, "global") : !unitIndex.isDismissed(ref, "view", viewId);
		});
	}

	/** PR-5 (G8): the complement of `getInboxUnits` — same placed-filter, but returns only units
	 * dismissed for this scope, so "Show Dismissed" can reveal exactly the rows the plain inbox
	 * excludes. Shares the same mode semantics as `getInboxUnits` (global reads only the global
	 * dismiss set; view reads that view's own set OR'd with global), so toggling never reveals a row
	 * that `getInboxUnits` wouldn't otherwise have hidden for the same `(viewId, mode)`. */
	getDismissedInboxUnits(allUnits: Unit[], viewId: string, mode: "view" | "global", unitIndex: UnitIndex): Unit[] {
		const placed =
			mode === "global"
				? allUnits.filter((u) => !this.isPlacedAnywhere(unitToRef(u)))
				: allUnits.filter((u) => !this.isPlaced(viewId, unitToRef(u)));
		return placed.filter((u) => {
			const ref = unitToRef(u);
			return mode === "global" ? unitIndex.isDismissed(ref, "global") : unitIndex.isDismissed(ref, "view", viewId);
		});
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

	/** G1/G4/E6: sets a Folder's API data source, or removes it (passing `undefined` — "Remove data
	 * source", G4). Removing drops the cache and the awaiting-confirmation flag (meaningless without a
	 * live source, and it stops refreshing entirely — no more dot at all) but deliberately keeps
	 * `apiItemState`/`apiItemOrder` untouched: the rows themselves, with whatever status/notes they
	 * already had, survive as plain static rows. The device-local headers entry is a separate store the
	 * caller owns (see `ApiHeadersStore`); this method only ever touches the synced view data. */
	setApiSource(viewId: string, nodeId: string, source: ApiSourceConfig | undefined): void {
		const view = this.getView(viewId);
		const found = view && this.findNode(view.root, nodeId);
		if (!found || found.node.type !== "meta") return;
		found.node.apiSource = source;
		if (!source) {
			found.node.apiCache = undefined;
			found.node.apiAwaitingConfirmation = undefined;
		}
		this.save();
	}

	/** G8: sets one API item's own explicit status — the item has no real `ViewNode`, so
	 * `setExplicitStatus` (which addresses a node by id) can't be reused directly. */
	setApiItemStatus(viewId: string, nodeId: string, itemId: string, statusId: string): void {
		const view = this.getView(viewId);
		const found = view && this.findNode(view.root, nodeId);
		const item = found?.node.apiItemState?.[itemId];
		if (!item) return;
		item.explicitStatusId = statusId;
		this.save();
	}

	/** G9: attaches (or replaces) the one note a given API item opens by default. */
	setApiItemNoteRef(viewId: string, nodeId: string, itemId: string, noteRef: UnitRef): void {
		const view = this.getView(viewId);
		const found = view && this.findNode(view.root, nodeId);
		const item = found?.node.apiItemState?.[itemId];
		if (!item) return;
		item.noteRef = noteRef;
		this.save();
	}

	/** G1/G6/G11: for callers (`ApiSourceController`) that mutate a node's `apiCache`/`apiItemState`
	 * fields directly rather than through a dedicated setter — persists and notifies the same as any
	 * other change here. */
	notifyExternalMutation(): void {
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
			// R12: an API item's attached note/block/module (`setApiItemNoteRef`) is a `UnitRef` just
			// like a unit node's own `ref` — it goes stale on the same renames and needs the same
			// rewrite, or the default click (G9) silently does nothing once the target moves.
			if (node.apiItemState) {
				for (const item of Object.values(node.apiItemState)) {
					if (!item.noteRef) continue;
					const rewritten = rewriteRefPath(item.noteRef, oldPath, newPath);
					if (rewritten !== item.noteRef) {
						item.noteRef = rewritten;
						changed = true;
					}
				}
			}
			if (this.rewriteTree(node.children, oldPath, newPath)) changed = true;
		}
		return changed;
	}
}
