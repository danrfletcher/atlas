/** A stable reference to a unit, persisted in plugin data (manual promotions, later views). */
export type UnitRef =
	| { kind: "file"; path: string }
	| { kind: "folder"; path: string }
	| { kind: "block"; path: string; subpath: string };

export function unitRefKey(ref: UnitRef): string {
	return ref.kind === "block" ? `block:${ref.path}#${ref.subpath}` : `${ref.kind}:${ref.path}`;
}

export function unitRefsEqual(a: UnitRef, b: UnitRef): boolean {
	return unitRefKey(a) === unitRefKey(b);
}

/** F9 rename integrity: rewrite `ref.path` if it's an exact match for `oldPath`, or a descendant
 * of it (`oldPath/...`) — the same rule Obsidian applies to link paths on rename. Returns the same
 * `ref` instance, unchanged, if neither applies (so callers can cheaply detect "did this change"). */
export function rewriteRefPath(ref: UnitRef, oldPath: string, newPath: string): UnitRef {
	if (ref.path === oldPath) return { ...ref, path: newPath };
	if (ref.path.startsWith(`${oldPath}/`)) return { ...ref, path: `${newPath}${ref.path.slice(oldPath.length)}` };
	return ref;
}

/** A unit as classified by the index — the computed shape the explorer (F8) will render. */
export type Unit =
	| { type: "root-file"; path: string }
	| { type: "free-block"; path: string }
	| { type: "folder-unit"; path: string }
	| { type: "promoted-file"; path: string; topLevelFolder: string }
	| { type: "promoted-folder"; path: string; topLevelFolder: string }
	| { type: "promoted-block"; path: string; subpath: string };

export function unitKey(unit: Unit): string {
	return unit.type === "promoted-block" ? `block:${unit.path}#${unit.subpath}` : `${unit.type}:${unit.path}`;
}

export function unitToRef(unit: Unit): UnitRef {
	if (unit.type === "promoted-block") {
		return { kind: "block", path: unit.path, subpath: unit.subpath };
	}
	if (unit.type === "folder-unit" || unit.type === "promoted-folder") {
		return { kind: "folder", path: unit.path };
	}
	return { kind: "file", path: unit.path };
}

/** PR 17: which unit kinds actually receive status treatment from a governor's assignment. Absent
 * (or an absent individual field) defaults to `true` — matches the reference plugin's own default
 * (`applyToFiles`/`applyToFolders` both default on) — so a governor created before this PR existed
 * keeps applying to everything, not silently narrowing. "Module" is a real on-disk folder (Atlas's
 * own term for a folder-unit); "metaFolder" is the organizational, no-disk-presence kind — the two
 * are genuinely different things in Atlas even though the reference plugin only has one "Folders"
 * concept, since it has no meta-folder equivalent at all. */
export interface ApplyToConfig {
	block?: boolean;
	file?: boolean;
	module?: boolean;
	metaFolder?: boolean;
}

/** PR 17: whether one particular status's matching items should collapse into a single summary row
 * instead of listing individually — ported from the reference plugin's `truncatedStatuses` shape,
 * keyed by status id within whichever set this governor is currently assigned. Capture-only in this
 * PR (the modal saves it, nothing reads it yet) — PR 19 wires it into actual rendering. */
export interface TruncatedStatusConfig {
	enabled: boolean;
	label?: string;
}

/** PR 15-17: the full set of status-related fields a "governor" (something with "Statuses" turned
 * on for what's underneath it) carries. Shared between `ViewNode` (an item governing its own direct
 * children) and `View` (the view root, governing its top-level items) — `resolveNodeStatus` walks a
 * mixed chain of both without needing to know which kind of governor it's looking at at each step,
 * since the fields and their meaning are identical either way. */
export interface StatusGovernance {
	/** PR 15: master toggle — governs this governor's own *direct children*, never the governor's
	 * own displayed status (a `ViewNode`'s own display comes from *its* governor, one level up). */
	statusEnabled?: boolean;
	statusSetId?: string;
	/** PR 17: when on, this governor's assignment cascades past direct children to every descendant,
	 * until a closer governor (with its own `statusEnabled`+`statusSetId`) takes over for its own
	 * subtree — same "nearest ancestor wins" precedence an inherited CSS property would have. Off by
	 * default (the reference plugin defaults this on; Dan explicitly wants the opposite for Atlas). */
	inheritToSubfolders?: boolean;
	/** PR 17 (capture only — PR 19 wires this into actual rendering): hide items whose current
	 * status is flagged completed/cancelled from the tree entirely. */
	hideCompleted?: boolean;
	hideCancelled?: boolean;
	applyTo?: ApplyToConfig;
	/** PR 17 (capture only — PR 19 wires this into actual rendering). */
	truncatedStatuses?: Record<string, TruncatedStatusConfig>;
	/** PR 22: ranks this governor's children ascending by their resolved status's own position
	 * within the governing status set's `statuses[]` (index 0 = highest rank) instead of the
	 * existing manual/drag-ordered arrangement. Absent (or `"manual"`) is today's default —
	 * unaffected by this field entirely. */
	sortMode?: "manual" | "status";
	/** PR 22: reverses the rank order from `sortMode: "status"` — meaningless (and left unset/
	 * ignored) while `sortMode` isn't `"status"`; not a general "flip manual order" toggle. */
	sortReverse?: boolean;
}

/** F9 — a node in a view's bucket tree. Unit nodes have no children; meta nodes are labels with
 * no disk presence and nest without limit. */
export interface ViewNode extends StatusGovernance {
	id: string;
	type: "meta" | "unit";
	label?: string; // meta only
	ref?: UnitRef; // unit only
	children: ViewNode[]; // meta nodes only; unit nodes always []
	collapsed?: boolean;
	/** PR 16: which status within a *governing parent's* set this exact node currently shows —
	 * never about this node's own children (that's `statusEnabled`/`statusSetId`, inherited from
	 * `StatusGovernance`, above). Absent means "show the governing set's own default status," the
	 * same as before this PR existed. */
	explicitStatusId?: string;
}

/** PR 17: extends `StatusGovernance` so the view root itself can be a governor — "Statuses" on the
 * view-name selector assigns statuses to top-level bucket items the same way right-clicking any
 * other item assigns them to its children. */
export interface View extends StatusGovernance {
	id: string;
	name: string;
	root: ViewNode[];
	inboxMode: "view" | "global";
}

export const DEFAULT_VIEW_NAME = "Default";

export function createEmptyView(id: string, name: string): View {
	return { id, name, root: [], inboxMode: "view" };
}
