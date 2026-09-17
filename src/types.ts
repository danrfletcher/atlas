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
