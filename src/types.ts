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

/** F9 — a node in a view's bucket tree. Unit nodes have no children; meta nodes are labels with
 * no disk presence and nest without limit. */
export interface ViewNode {
	id: string;
	type: "meta" | "unit";
	label?: string; // meta only
	ref?: UnitRef; // unit only
	children: ViewNode[]; // meta nodes only; unit nodes always []
	collapsed?: boolean;
	/** PR 15: minimal status assignment — this exact node's own status, not inherited from or
	 * cascaded to any other node (that's a PR 16+ concept). Lives on the node itself (not keyed by
	 * `ref`) so it moves and duplicates with this specific placement, matching how `collapsed`
	 * already works — two duplicate placements of the same unit are independent per PR 13, and a
	 * status assignment should be too. */
	statusEnabled?: boolean;
	statusSetId?: string;
}

export interface View {
	id: string;
	name: string;
	root: ViewNode[];
	inboxMode: "view" | "global";
}

export const DEFAULT_VIEW_NAME = "Default";

export function createEmptyView(id: string, name: string): View {
	return { id, name, root: [], inboxMode: "view" };
}
