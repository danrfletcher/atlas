import { mergeApiItems, MergeResult } from "./api-merge";
import { ApiItemState, ApiMappedRow } from "./types";

export interface RefreshPlanInput {
	prevState: Record<string, ApiItemState>;
	prevOrder: string[];
	rows: ApiMappedRow[];
	mode: "append" | "merge" | "overwrite";
	truncated: boolean;
	nowIso: string;
	/** G6b(i), already resolved to its default (on unless explicitly `false`) by the caller. Ignored
	 * outside Overwrite. */
	keepOnEmpty: boolean;
	/** G6b(ii), already resolved to its default (on unless explicitly `false`) by the caller. Ignored
	 * outside Overwrite. */
	confirmBeforeDelete: boolean;
}

export interface RefreshPlan {
	/** True only for an Overwrite refresh that would delete one or more rows with the confirm guard
	 * on — the caller must obtain a "confirmed" answer before persisting `result`. */
	needsConfirmation: boolean;
	/** How many existing rows this refresh would delete if applied (0 for Append/Merge, always). */
	deletedCount: number;
	/** The reconciled outcome if this plan is applied as-is. For G6b(i)'s "keep on empty" case this is
	 * simply the unchanged previous state/order (nothing to apply). */
	result: MergeResult;
	/** True when applying this plan is a genuine no-op — nothing to persist beyond the refresh's own
	 * cache bookkeeping (fetchedAt/ok). Only ever true for G6b(i)'s keep-on-empty case. */
	noChange: boolean;
}

/**
 * G6/G6b/G6c/E1/E2/E4: the pure decision layer above `mergeApiItems` — figures out *whether* a refresh
 * needs confirmation and how many rows it would delete, without knowing anything about how (or
 * whether) that confirmation gets asked. `ApiSourceController` is the only caller; kept separate and
 * pure so mode × response × guard combinations are unit-testable without any async/modal machinery.
 */
export function planApiRefresh(input: RefreshPlanInput): RefreshPlan {
	const { prevState, prevOrder, rows, mode, truncated, nowIso } = input;

	if (mode !== "overwrite") {
		const result = mergeApiItems(prevState, prevOrder, rows, mode, { truncated, nowIso });
		return { needsConfirmation: false, deletedCount: 0, result, noChange: false };
	}

	// G6b(i): an empty response under Overwrite, with "keep on empty" on, leaves everything untouched
	// — the diff below is never even computed, so a Folder that's merely between polls of a
	// legitimately-sometimes-empty API doesn't lose its rows.
	if (rows.length === 0 && input.keepOnEmpty) {
		return {
			needsConfirmation: false,
			deletedCount: 0,
			result: { itemState: { ...prevState }, order: [...prevOrder] },
			noChange: true,
		};
	}

	const result = mergeApiItems(prevState, prevOrder, rows, "overwrite", { truncated, nowIso });
	// E2/E4: rows dropped from `result.itemState` relative to `prevState` are exactly the ones this
	// Overwrite would genuinely delete — truncation-exempted survivors are already kept by
	// `mergeApiItems` itself, so they never show up here as deletions.
	const deletedCount = prevOrder.filter((id) => id in prevState && !(id in result.itemState)).length;
	const needsConfirmation = deletedCount > 0 && input.confirmBeforeDelete;
	return { needsConfirmation, deletedCount, result, noChange: false };
}
