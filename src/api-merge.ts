import { ApiItemState, ApiMappedRow, PLACEHOLDER_ROW_KIND } from "./types";

export interface MergeResult {
	itemState: Record<string, ApiItemState>;
	/** Display order for `itemState`'s keys — rows currently reported by the API keep the API's own
	 * order; a row not currently reported (kept per G6/G6 Append) trails behind in its previous
	 * relative order. The spec doesn't dictate ordering beyond "kept" — this is the judgement call
	 * taken where it's silent. */
	order: string[];
}

export interface MergeOptions {
	/** E4: the response this refresh was truncated at the row cap — "not found" marking is skipped
	 * entirely for this refresh so unseen ids aren't falsely flagged. */
	truncated: boolean;
	nowIso: string;
}

/**
 * G6/G6c/G8/E1: reconciles a Folder's durable per-id item state against this refresh's freshly
 * mapped rows.
 *
 * - Append: adds new ids only; a row no longer reported is kept exactly as it was, never marked.
 * - Merge: matches by id; a row no longer reported is kept and marked "not found, last seen …"
 *   (skipped this refresh if `options.truncated`); a row that reappears becomes normal again.
 * - Overwrite (PR-3): a row no longer reported is deleted outright — its `itemState` entry is dropped
 *   from the result entirely, not just marked, so a later reappearance is a fresh, untriaged row
 *   (G6c) — same truncation exception as Merge (E4: skipped this refresh if `options.truncated`, so a
 *   row merely pushed past the row cap isn't mistaken for genuinely vanished). Callers decide
 *   *whether* an Overwrite reconciliation should run at all this refresh (G6b's guards — confirmation,
 *   keep-on-empty) before calling this; this function only computes what the outcome would be.
 * - Every mode: label/secondary text always follow the latest API values for a row that IS currently
 *   reported; status (`explicitStatusId`) and the attached note (`noteRef`) are carried over untouched
 *   in every branch — refresh never assigns or changes either (G8, F5).
 */
export function mergeApiItems(
	prevState: Record<string, ApiItemState>,
	prevOrder: string[],
	rows: ApiMappedRow[],
	mode: "append" | "merge" | "overwrite",
	options: MergeOptions
): MergeResult {
	const nextState: Record<string, ApiItemState> = {};
	const nextOrder: string[] = [];
	const seenNow = new Set(rows.map((row) => row.id));

	for (const row of rows) {
		const prev = prevState[row.id];
		// R13: `lastSeenAt` is stamped here, on every refresh that actually reports the row present —
		// not down in the "vanished" branch below, which used to stamp the time of the refresh that
		// found the row *missing*. That made "not found, last seen <date>" report the wrong date
		// (the day it was noticed gone, not the day it was last confirmed present).
		nextState[row.id] = prev
			? { ...prev, label: row.label, secondary: row.secondary, notFound: false, lastSeenAt: options.nowIso }
			: { id: row.id, label: row.label, kind: PLACEHOLDER_ROW_KIND, secondary: row.secondary, lastSeenAt: options.nowIso };
		nextOrder.push(row.id);
	}

	for (const id of prevOrder) {
		if (seenNow.has(id)) continue;
		const prev = prevState[id];
		if (!prev) continue;
		if (mode === "append" || options.truncated) {
			nextState[id] = prev;
		} else if (mode === "merge") {
			// Carry the existing `lastSeenAt` (stamped the last time this row was actually reported)
			// forward untouched — this refresh only learned the row is gone, not when it was last seen.
			nextState[id] = prev.notFound ? prev : { ...prev, notFound: true };
		} else {
			// Overwrite: genuinely vanished (not merely truncated) — drop it, deliberately, itemState
			// and all (G6, E2's "not silently deleted twice" holds since `rows` was already deduped by
			// id before this ever runs).
			continue;
		}
		nextOrder.push(id);
	}

	return { itemState: nextState, order: nextOrder };
}
