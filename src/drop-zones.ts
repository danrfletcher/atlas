/** PR-3: the pure geometry behind "drag to reorder" — turns a pointer's vertical offset inside a
 * row, plus that row's own height, into one of three drop zones. Kept free of the DOM/Obsidian so
 * the 25/50/25 split (and the one exception to it, G1/Q7) is unit-testable with plain numbers; the
 * caller (`AtlasExplorerView.wireRowDrop`, `explorer-view.ts`) is the only thing that ever reads a
 * real `getBoundingClientRect()`/`clientY`. */
export type DropZone = "before" | "nest" | "after";

/** G1/G2/G20/Q7: resolves a pointer's offset within a row (0 at the top, `rowHeight` at the
 * bottom) into a zone:
 * - below 25% of the row's height -> `"before"` (insert as a sibling above the row)
 * - 25% to 75% (inclusive both ends) -> `"nest"` (append as the row's last child)
 * - above 75% -> `"after"` (insert as a sibling below the row) — but only when `hasBottomZone` is
 *   true. An expanded row that's already showing its own real children immediately underneath it
 *   (Q7) has no visual gap there for an "insert after" line to sit against, so its lower quarter
 *   folds into the nest zone instead (nesting then covers 75% of that row) — the next row's own
 *   top edge is where "insert after this expanded row" lives instead. A collapsed row, and a
 *   childless row (nothing rendered below it either way), both keep the plain 25/50/25 split.
 *
 * Deterministic at the 25%/75% boundaries themselves, and for a degenerate (zero- or
 * near-zero-height) row: every comparison is a plain `<`/`>` against a fixed fraction of
 * `rowHeight`, so the same `(offsetY, rowHeight)` pair always resolves to the same zone, with no
 * floating-point-order or event-timing dependence. */
export function resolveDropZone(offsetY: number, rowHeight: number, hasBottomZone: boolean): DropZone {
	const topEdge = rowHeight * 0.25;
	const bottomEdge = rowHeight * 0.75;
	if (offsetY < topEdge) return "before";
	if (hasBottomZone && offsetY > bottomEdge) return "after";
	return "nest";
}
