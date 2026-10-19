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

/** PR-2: the effective (mode, direction) a list actually renders by, once "absent falls back to
 * an inherited status sort" (G19) is resolved. `null` means effectively Manual — no icon (G13),
 * no sort pass. */
export interface EffectiveSort {
	mode: SortMode;
	reverse: boolean;
}

/** PR-2 (G12/G19/E5): combines a list's own direct governor (`ownGovernance` — a `ViewNode` or the
 * `View` root; never an inherited one, F6) with the nearest reachable status governor
 * (`statusGovernor`, from `StatusesManager.findSortGovernor`) into the one effective sort this
 * list actually renders by. An explicit own `sortMode` — any value, including `"manual"` — always
 * wins outright; only an *absent* own setting ever falls through to an inherited status sort.
 * Shared by the render pass's own status-sort activation, the "Sort children…" menu's Status
 * tick/label and the G13 sort indicator, so the three can't drift apart on what "currently sorted
 * by status" means. */
export function activeSortFor(
	ownGovernance: Pick<StatusGovernance, "sortMode" | "sortReverse">,
	statusGovernor: Pick<StatusGovernance, "sortMode" | "sortReverse"> | null
): EffectiveSort | null {
	const ownMode = ownGovernance.sortMode;
	if (ownMode !== undefined) {
		if (ownMode === "manual") return null;
		return { mode: ownMode, reverse: !!ownGovernance.sortReverse };
	}
	if (statusGovernor?.sortMode === "status") {
		return { mode: "status", reverse: !!statusGovernor.sortReverse };
	}
	return null;
}

/** PR-2 (G13/G21): the mode+direction phrase for the sort indicator's tooltip ("Sorted: <this>").
 * A-Z's reverse has its own name (Z-A) rather than "A-Z, reversed"; every other mode mirrors the
 * explicit "Modified, newest/oldest first" wording from the spec's own example strings. */
export function sortModeLabel(mode: SortMode, reverse: boolean): string {
	switch (mode) {
		case "alphabetical":
			return reverse ? "Z-A" : "A-Z";
		case "modified":
			return `Modified, ${reverse ? "oldest" : "newest"} first`;
		case "time-added":
			return `Time added, ${reverse ? "oldest" : "newest"} first`;
		case "status":
			return reverse ? "Status, reversed" : "Status";
		default:
			return "Manual";
	}
}

/** PR-2 (G21): the icon per mode for the "Sort children…" item and the G13 sort indicator. No
 * icon is ever shown for `"manual"` (an effectively-Manual list shows no indicator at all).
 *
 * PR-2 (T1): the alphabetical id is `"arrow-down-az"`, not the hyphenated `"arrow-down-a-z"` the
 * spec's prose uses — the installed Obsidian build (1.14.4) only registers the Lucide icon under
 * `arrow-down-az`; `arrow-down-a-z` doesn't exist, so `setIcon()` silently no-ops and the
 * indicator renders as an empty 0x0 element. Confirmed by grepping `resources/obsidian.asar` in
 * that build. */
export const SORT_MODE_ICONS: Record<SortMode, string> = {
	manual: "",
	alphabetical: "arrow-down-az",
	modified: "clock",
	"time-added": "calendar-plus",
	status: "list-ordered",
};

/** PR-2 (G9/E4): governs *when* a Modified-sorted list's file-mtime snapshot may be refreshed —
 * "the next time the explorer refreshes" means one of four triggers (pane regains focus, view
 * loads, a sort changes, the tree changes), never a plain autosave/vault `modify`, and never while
 * a drag is in progress (deferred until the drag ends, per the edge case). Holds no reference to
 * the mtimes themselves — the caller (`AtlasExplorerView`) owns that cache; this only decides
 * *when* it's allowed to recompute, so it's testable with no DOM/vault involved at all. Starts
 * dirty: a view's very first render is itself "the view loads". */
export class SortRefreshGate {
	private dirty = true;

	/** Call from any of the four trigger points. Idempotent — marking dirty twice before the next
	 * `consume()` behaves the same as marking it once. */
	markDirty(): void {
		this.dirty = true;
	}

	/** Call once per render pass. Returns true exactly when this render should recompute
	 * sort-relevant data (a trigger fired since the last successful refresh) and no drag is
	 * currently in progress — consuming the pending flag only when it returns true, so a render
	 * that's skipped only because a drag is active leaves the flag set for the first render after
	 * the drag ends. */
	consume(dragging: boolean): boolean {
		if (dragging || !this.dirty) return false;
		this.dirty = false;
		return true;
	}
}
