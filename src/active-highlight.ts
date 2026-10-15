import type { UnitRef } from "./types";

/** PR-1.F1: everything `updateActiveHighlight` needs to decide whether one rendered row stands for
 * the currently open note, pulled out of the DOM-walking method as a pure function so the matching
 * rule itself (file, module-via-interface-note, block, Outside-Vault exclusion) can be exercised with
 * plain table-driven inputs instead of a live App/DOM. `updateActiveHighlight` resolves every field
 * below once per row and hands the result here; this function makes no further lookups of its own. */
export interface ActiveHighlightQuery {
	/** `workspace.getActiveFile()?.path ?? null` — the same value for every row checked this pass. */
	activeFilePath: string | null;
	/** The row's own ref, recovered from its `data-ref-key`. Null for a row with no ref at all (a
	 * meta/Folder row never carries `data-ref-key`, so it never reaches this function — G6). */
	ref: UnitRef | null;
	/** Only meaningful when `ref.kind === "folder"`: the module's interface note path, resolved via
	 * `findInterfaceNote` (honouring the alternate-names setting), or null when the module has none
	 * (or doesn't resolve to a folder at all) — ignored for every other `ref.kind`. */
	interfaceNotePath: string | null;
	/** True for a row an Outside-Vault Folder source manages. Such a row's `ref.path` is root-relative
	 * to that external source, never a real vault path, so it must never match even when the two
	 * strings happen to read the same (F6) — checked before any path comparison below. */
	isOutsideManaged: boolean;
}

/** PR-1.F1 (G1, G3-G6, F6): true exactly when `query.ref`'s row stands for the open note.
 * - No open file, no ref at all (meta row), or an Outside-Vault-managed row: never matches.
 * - A `folder` ref matches only through its resolved interface note's path, never the folder's own
 *   path (a module's row is never itself "the open note" — only its interface note is).
 * - A `file` or `block` ref matches by comparing `ref.path` against the open file's path directly
 *   (a block's own `subpath` plays no part — G5 matches on the file the block lives in). Plain
 *   string equality throughout: no selector is built from either path, so special characters in a
 *   file name (`[`, `]`, `"`, `#`, ...) need no escaping and can't be read as a selector. */
export function matchesActiveFile(query: ActiveHighlightQuery): boolean {
	const { activeFilePath, ref, interfaceNotePath, isOutsideManaged } = query;
	if (!activeFilePath || !ref || isOutsideManaged) return false;
	if (ref.kind === "folder") return interfaceNotePath !== null && interfaceNotePath === activeFilePath;
	return ref.path === activeFilePath;
}
