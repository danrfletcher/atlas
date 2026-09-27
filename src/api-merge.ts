import { ApiItemState, ApiMappedRow } from "./types";

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
 * - Either mode: label/secondary text always follow the latest API values for a row that IS
 *   currently reported; status (`explicitStatusId`) and the attached note (`noteRef`) are carried
 *   over untouched in every branch — refresh never assigns or changes either (G8, F5).
 */
export function mergeApiItems(
	prevState: Record<string, ApiItemState>,
	prevOrder: string[],
	rows: ApiMappedRow[],
	mode: "append" | "merge",
	options: MergeOptions
): MergeResult {
	const nextState: Record<string, ApiItemState> = {};
	const nextOrder: string[] = [];
	const seenNow = new Set(rows.map((row) => row.id));

	for (const row of rows) {
		const prev = prevState[row.id];
		nextState[row.id] = prev
			? { ...prev, label: row.label, secondary: row.secondary, notFound: false, lastSeenAt: undefined }
			: { id: row.id, label: row.label, secondary: row.secondary };
		nextOrder.push(row.id);
	}

	for (const id of prevOrder) {
		if (seenNow.has(id)) continue;
		const prev = prevState[id];
		if (!prev) continue;
		if (mode === "append" || options.truncated) {
			nextState[id] = prev;
		} else {
			nextState[id] = prev.notFound ? prev : { ...prev, notFound: true, lastSeenAt: options.nowIso };
		}
		nextOrder.push(id);
	}

	return { itemState: nextState, order: nextOrder };
}
