/** PR-1: the comparator + mode table for "Sort children..." — the foundation other PRs in this
 * ticket build on (PR-2 adds the sort icon/tooltip and Status to the menu; PR-3 the edge-drop
 * reorder refusal; PR-4 the drag rules). `"status"` (PR 22, pre-existing) is untouched here; this
 * file only adds `"alphabetical"` / `"modified"` / `"time-added"`, which — unlike `"status"` — are
 * never inherited past a governor's own direct children (F6), so the render pass reads them
 * straight off the nearest ancestor rather than walking `findSortGovernor`'s inheritance chain. */
import { ViewNode, StatusGovernance } from "./types";

/** Every value `StatusGovernance.sortMode` can hold. Kept here (not re-exported from `types.ts`)
 * so call sites that only care about "which of the menu's choices is this" don't need to import
 * the wider `StatusGovernance` shape just for the literal union. */
export type SortMode = "manual" | "status" | "alphabetical" | "modified" | "time-added";

/** The sort-relevant facts about one rendered row, gathered once per render pass — never cached
 * across renders, since `mtime`/`placedAt` can change between any two renders. `name` is only
 * ever read under `"alphabetical"`, `mtime` only under `"modified"` — computing either for a mode
 * that doesn't need it is wasted work the caller (`sortKeyFor` in `explorer-view.ts`) skips. */
export interface SortKey {
	name: string;
	/** File-modified time in ms, or `null` for "no time" (G9: meta Folders, API rows, missing
	 * refs, modules with no interface note). */
	mtime: number | null;
	/** `ViewNode.placedAt`, or `null` for "no stamp" (G10: a node from a pre-this-feature
	 * `data.json`, E8, or any other row that was never placed with a stamp — e.g. an API row). */
	placedAt: number | null;
}

/** G8: case-insensitive, natural number order ("Item 2" before "Item 10") — `Intl.Collator`'s
 * `numeric` option already implements exactly this, and `sensitivity: "base"` folds case (and
 * accents) the same way a plain `.toLowerCase()` comparison would, so there's no reason to hand-
 * roll either rule. Module-level: collator construction isn't free, and comparisons happen a lot
 * during a sort — reused across every call instead of rebuilt per comparison. */
const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** G8/G9/G10/G11/G21/E10: compares two rows under one mode + direction. `Array.prototype.sort` is
 * stable (guaranteed since ES2019), so returning `0` for a genuine tie — or for "both have no
 * time/stamp" — is enough to keep those rows in their existing (manual) relative order; no
 * explicit tie-break index is needed. The "no time"/"no stamp" branches return a fixed `1`/`-1`
 * *before* `reverse` is ever consulted, so an unstamped/timeless row sorts last under both
 * directions (G10/G21) rather than flipping to first under Reverse. Returns `0` (no reordering)
 * for `"manual"`/`"status"` — this function only ever runs for the three new modes; the existing
 * `"status"` comparator in `explorer-view.ts` is untouched and never calls this. */
export function compareSortKeys(mode: SortMode, reverse: boolean, a: SortKey, b: SortKey): number {
	switch (mode) {
		case "alphabetical": {
			const cmp = COLLATOR.compare(a.name, b.name);
			return reverse ? -cmp : cmp;
		}
		case "modified": {
			if (a.mtime === null && b.mtime === null) return 0;
			if (a.mtime === null) return 1;
			if (b.mtime === null) return -1;
			const cmp = b.mtime - a.mtime; // newest first
			return reverse ? -cmp : cmp;
		}
		case "time-added": {
			if (a.placedAt === null && b.placedAt === null) return 0;
			if (a.placedAt === null) return 1;
			if (b.placedAt === null) return -1;
			const cmp = b.placedAt - a.placedAt; // newest first
			return reverse ? -cmp : cmp;
		}
		default:
			return 0;
	}
}

/** True only for the three modes this file's comparator actually handles — `"manual"`/`"status"`
 * (absent/undefined included) fall through to the existing render path untouched. Used by
 * `explorer-view.ts`'s render pass to decide whether the *direct* parent/view-root governor (never
 * an inherited one, F6) should drive this list's order. */
export function isDirectSortMode(mode: SortMode | undefined): mode is "alphabetical" | "modified" | "time-added" {
	return mode === "alphabetical" || mode === "modified" || mode === "time-added";
}

/** G6/G7/G11/F4: the menu's exact choices, in display order — shared by every row menu and the
 * Bucket header's own menu (`addSortMenuItem`, `explorer-view.ts`) so the four can't drift apart
 * or grow a fifth (size/tag/property) by accident between call sites. PR-2 adds "Status" here. */
export const SORT_MODE_CHOICES: { mode: SortMode; label: string }[] = [
	{ mode: "manual", label: "Manual" },
	{ mode: "alphabetical", label: "A-Z" },
	{ mode: "modified", label: "Modified" },
	{ mode: "time-added", label: "Time added" },
];

/** Reads back `StatusGovernance.sortMode`, defaulting absent/unrecognized to `"manual"` — the
 * same "no setting yet" reading the render pass and the menu's ticked-item check share, so a
 * governor that's never been touched (or one loaded from a pre-this-feature `data.json`, E8)
 * renders, and is offered in the menu, identically to one explicitly set to Manual. */
export function currentSortMode(governance: Pick<StatusGovernance, "sortMode">): SortMode {
	return governance.sortMode ?? "manual";
}

/** G8/G9/E12: the key used to break ties under A-Z — the row's *displayed* name: a meta Folder's
 * label, or (for a unit) whatever text the caller already resolved for it (block title/first
 * line, file name, module name, or a missing ref's last-known name — `resolveRef` already falls
 * back to that last case on its own). */
export function displayNameFor(node: ViewNode, resolvedText: string | undefined): string {
	if (node.type === "meta") return node.label ?? "";
	return resolvedText ?? "";
}
