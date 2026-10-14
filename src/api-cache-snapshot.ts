import { ViewNode } from "./types";

/** PR-1 R3 fix: shared by `CsvSourceController` and `MarkdownTableSourceController` — previously
 * duplicated verbatim in both. Everything a refresh can write that matters for "did anything
 * actually change": `fetchedAt`/`lastSuccessAt` are deliberately excluded, since they stamp every
 * refresh (including a no-op one) by design and would make every refresh look "changed". Per-row
 * `lastSeenAt` is the same kind of bookkeeping stamp (`mergeApiItems` touches it on every present
 * row, every refresh — R13), so it's stripped from each entry before comparing too. `notFound` is
 * normalized to a real boolean: `mergeApiItems` leaves it absent on a row's first-ever appearance
 * but writes an explicit `false` once the row has a `prev` to spread (R13's
 * `{ ...prev, notFound: false, ... }`) — same meaning, different JSON shape, which would otherwise
 * read as a change on every second refresh. */
export function cacheSnapshot(node: ViewNode): string {
	const itemState = node.apiItemState;
	const comparableItemState = itemState
		? Object.fromEntries(
				Object.entries(itemState).map(([id, item]) => [id, { ...item, lastSeenAt: undefined, notFound: item.notFound ?? false }])
			)
		: itemState;
	return JSON.stringify([
		node.apiCache?.ok,
		node.apiCache?.error,
		node.apiCache?.rows,
		node.apiCache?.skippedCount,
		node.apiCache?.truncated,
		comparableItemState,
		node.apiItemOrder,
		node.apiAwaitingConfirmation,
	]);
}
