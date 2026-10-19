import { Notice } from "obsidian";

/** PR-2.F3 (G10): the one helper every "Add under…" kind calls once its own create-and-nest flow
 * has finished, with the explorer's own re-render already kicked off. Wired into the Folder path
 * (PR-2.F2's `runAddUnderFolder`) now; PR-3.F1-F3 reuse this unchanged for Block, File and Module —
 * hence a signature that mentions no Folder-specific type.
 *
 * Awaits the caller's own render-settling step, then decides whether the new row actually has a
 * rendered element — a collapsed ancestor doesn't count as hidden; children always render in the
 * DOM regardless of fold state (E-G10h, see `renderFoldableChildren`'s own doc comment on why) —
 * and, if it doesn't, names the one reason that applies: the active filter, a truncated status
 * group, or the bucket's current sort/grouping (a hidden-completed/-cancelled status), in that
 * priority order (E-G10e: filter named first on a tie). Filter text, sort mode, status groups and
 * truncation state are only ever read here — this module never writes any of them. */

export interface AddUnderHiddenNoticeSignals {
	/** True when a filter string is currently active in the bucket's search box. Checked first
	 * (E-G10e): a filter active at the moment a new row doesn't render is named as the reason, even
	 * when a second cause (e.g. truncation) would also explain it. */
	filterActive: boolean;
	/** The label of the truncated status group the new row folded into — set only when the
	 * governing status set has truncation enabled for the new row's resolved status, 2+ siblings
	 * (now including the new row) share it, and that group isn't currently expanded. `null`/
	 * `undefined` when no such group applies. */
	truncatedGroupLabel?: string | null;
	/** True when the new row's own resolved status is hidden outright by its governor's
	 * `hideCompleted`/`hideCancelled` setting — the catch-all "current sort or grouping" reason
	 * (E-G10d). */
	hiddenBySortOrGrouping?: boolean;
}

export interface AddUnderHiddenNoticeState extends AddUnderHiddenNoticeSignals {
	/** Awaited first, before anything else here runs (E-G10f: the check must never fire while the
	 * row is still being drawn). Typically `() => this.awaitRenderSettled()`, called after the
	 * caller has already kicked a `void this.render()` — following whichever render turns out to be
	 * the most recently *started* one, the same overlapping-render guarantee `runAddUnderFolder`
	 * already relies on for Folder (PR-2.F2 R2). */
	render(): Promise<void>;
	/** Called only once `render()` above has resolved, so a caller whose own list element gets
	 * reassigned mid-render (a fresh element per render pass) always reads the current one, never
	 * one captured before the wait began. Returning `null` (the bucket isn't showing) is treated the
	 * same as "row not found". */
	getBucketListEl(): HTMLElement | null;
}

/** The one reason string to show, or `null` when none of the signals apply. Exposed separately
 * from `noticeIfAddedRowHidden` so the reason logic itself is table-testable without a real DOM
 * element or an async render step. */
export function classifyHiddenReason(signals: AddUnderHiddenNoticeSignals): string | null {
	if (signals.filterActive) return "the current filter";
	if (signals.truncatedGroupLabel) return `the truncated "${signals.truncatedGroupLabel}" group`;
	if (signals.hiddenBySortOrGrouping) return "the current sort or grouping";
	return null;
}

/** G10's one Notice, fired at most once per add-under call. No-op when the new row actually
 * rendered (an element exists at `data-select-key="<nodeId>"` inside `state.getBucketListEl()`) —
 * per G10/E-G10b, a visible row gets no extra Notice at all. Also a no-op when the row didn't
 * render but none of `state`'s signals explain why (shouldn't happen in practice; never invents a
 * reason). Touches nothing but `state.render()`/`state.getBucketListEl()` and, at most, one
 * `new Notice(...)` call: the selection, filter text, sort settings, `truncatedStatuses` and
 * `expandedTruncationGroups` are all untouched (E5, fence). */
export async function noticeIfAddedRowHidden(nodeId: string, label: string, parentLabel: string, state: AddUnderHiddenNoticeState): Promise<void> {
	await state.render();
	const visible = !!state.getBucketListEl()?.querySelector(`[data-select-key="${CSS.escape(nodeId)}"]`);
	if (visible) return;
	const reason = classifyHiddenReason(state);
	if (!reason) return;
	new Notice(`Atlas: Added ${label} under ${parentLabel} (hidden by ${reason})`);
}
