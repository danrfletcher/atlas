import { ApplyToConfig, StatusGovernance, ViewNode } from "./types";

/**
 * PR 14 — foundation for the File Folder Status Sets port (ported from
 * `danrfletcher/obsidian-file-folder-status-icons`, adapted to Atlas's own persistence/CRUD style
 * rather than reused as a dependency). Data model + settings-panel CRUD only in PR 14 — PR 15 adds
 * `resolveNodeStatus` below for the minimal per-node rendering/assignment mechanism.
 */

export interface StatusDefinition {
	/** Stable id, independent of label so renaming a status doesn't orphan assignments made against it later. */
	id: string;
	label: string;
	/** Hex color, e.g. "#e03131". */
	color: string;
	/** A set may have more than one completed status. Hidden via PR 17/19's "hide completed" toggle. */
	isCompleted?: boolean;
	/** Same idea as `isCompleted`, a separate axis — hidden via "hide cancelled" instead. */
	isCancelled?: boolean;
}

export interface StatusSet {
	id: string;
	name: string;
	/** Order here is both display order and sort precedence (index 0 = highest rank). */
	statuses: StatusDefinition[];
	/** The status a new assignment against this set starts from. Not necessarily `statuses[0]` —
	 * it starts there when the set is first created, but stays put on reorder; only an explicit
	 * "Make default" moves it. Empty string only while the set has no statuses at all yet. */
	defaultStatusId: string;
}

/** A pleasant default pastel palette, offered alongside a fully custom color picker — ported from
 * the reference plugin's own default. */
export const DEFAULT_COLOR_PALETTE: string[] = [
	"#FFADAD",
	"#FFD6A5",
	"#FDFFB6",
	"#CAFFBF",
	"#9BF6FF",
	"#A0C4FF",
	"#BDB2FF",
	"#FFC6FF",
	"#E2E2E2",
];

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isValidHexColor(value: string): boolean {
	return HEX_RE.test(value.trim());
}

export function normalizeHexColor(value: string, fallback = "#888888"): string {
	const v = value.trim();
	return isValidHexColor(v) ? v : fallback;
}


function generateStatusId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Owns status-set/color-palette CRUD, mirroring `ViewsManager`'s shape (constructor-injected
 * persist callback, mutate-then-save methods) for consistency with the rest of the plugin. */
export class StatusesManager {
	private statusSets: StatusSet[];
	private colorPalette: string[];

	constructor(initialStatusSets: StatusSet[], initialColorPalette: string[], private persist: () => void) {
		this.statusSets = initialStatusSets;
		this.colorPalette = initialColorPalette.length > 0 ? initialColorPalette : [...DEFAULT_COLOR_PALETTE];
	}

	private save(): void {
		this.persist();
	}

	getStatusSets(): StatusSet[] {
		return this.statusSets;
	}

	getStatusSet(id: string): StatusSet | undefined {
		return this.statusSets.find((s) => s.id === id);
	}

	createStatusSet(name: string): StatusSet {
		const set: StatusSet = { id: generateStatusId("set"), name: name.trim() || "New status set", statuses: [], defaultStatusId: "" };
		this.statusSets.push(set);
		this.save();
		return set;
	}

	renameStatusSet(id: string, name: string): void {
		const set = this.getStatusSet(id);
		if (!set) return;
		set.name = name.trim() || set.name;
		this.save();
	}

	deleteStatusSet(id: string): void {
		this.statusSets = this.statusSets.filter((s) => s.id !== id);
		this.save();
	}

	addStatus(setId: string, label: string, color: string): StatusDefinition | null {
		const set = this.getStatusSet(setId);
		if (!set) return null;
		const status: StatusDefinition = { id: generateStatusId("status"), label: label.trim() || "New status", color: normalizeHexColor(color) };
		set.statuses.push(status);
		// First status added to an empty set becomes its default automatically — otherwise a
		// brand-new set would have no valid default until the user thinks to set one explicitly.
		if (!set.defaultStatusId) set.defaultStatusId = status.id;
		this.save();
		return status;
	}

	updateStatus(setId: string, statusId: string, patch: { label?: string; color?: string }): void {
		const status = this.findStatus(setId, statusId);
		if (!status) return;
		if (patch.label !== undefined) status.label = patch.label.trim() || status.label;
		if (patch.color !== undefined) status.color = normalizeHexColor(patch.color);
		this.save();
	}

	removeStatus(setId: string, statusId: string): void {
		const set = this.getStatusSet(setId);
		if (!set) return;
		set.statuses = set.statuses.filter((s) => s.id !== statusId);
		if (set.defaultStatusId === statusId) set.defaultStatusId = set.statuses[0]?.id ?? "";
		this.save();
	}

	reorderStatuses(setId: string, orderedIds: string[]): void {
		const set = this.getStatusSet(setId);
		if (!set) return;
		const byId = new Map(set.statuses.map((s) => [s.id, s]));
		const reordered = orderedIds.map((id) => byId.get(id)).filter((s): s is StatusDefinition => s !== undefined);
		// Guard against a stale/partial id list silently dropping statuses — fall back to the
		// existing order rather than truncating the set if anything doesn't line up.
		if (reordered.length !== set.statuses.length) return;
		set.statuses = reordered;
		this.save();
	}

	setDefaultStatus(setId: string, statusId: string): void {
		const set = this.getStatusSet(setId);
		if (!set || !set.statuses.some((s) => s.id === statusId)) return;
		set.defaultStatusId = statusId;
		this.save();
	}

	setStatusCompleted(setId: string, statusId: string, value: boolean): void {
		const status = this.findStatus(setId, statusId);
		if (!status) return;
		if (value) status.isCompleted = true;
		else delete status.isCompleted;
		this.save();
	}

	setStatusCancelled(setId: string, statusId: string, value: boolean): void {
		const status = this.findStatus(setId, statusId);
		if (!status) return;
		if (value) status.isCancelled = true;
		else delete status.isCancelled;
		this.save();
	}

	private findStatus(setId: string, statusId: string): StatusDefinition | undefined {
		return this.getStatusSet(setId)?.statuses.find((s) => s.id === statusId);
	}

	getColorPalette(): string[] {
		return this.colorPalette;
	}

	addPaletteColor(hex: string): void {
		const normalized = normalizeHexColor(hex);
		if (!this.colorPalette.includes(normalized)) this.colorPalette.push(normalized);
		this.save();
	}

	removePaletteColor(hex: string): void {
		this.colorPalette = this.colorPalette.filter((c) => c !== hex);
		this.save();
	}

	/** PR 15/16/17: resolves the status a row should display by walking its ancestor chain —
	 * `ancestors[0]` is the nearest (direct parent, or the view root for a top-level item),
	 * `ancestors[ancestors.length - 1]` the furthest. The *nearest* ancestor that's actually a
	 * governor (`statusEnabled` + `statusSetId` set) wins — same "closest ancestor with an explicit
	 * value" precedence an inherited CSS property would have. A non-governing ancestor is skipped
	 * over while walking (it might just not have "Statuses" turned on at all), but once a real
	 * governor is found, the walk stops there regardless of whether it actually reaches `child` —
	 * an ancestor beyond it never gets a chance to "reach past" a closer governor that declined to
	 * inherit. The direct parent (index 0) always reaches its own children by definition; anything
	 * further up only reaches if *that specific governor* has `inheritToSubfolders` on (PR 17).
	 *
	 * `child` is the actual row: checked for its own `explicitStatusId` (PR 16 — "change this one
	 * task's status") before falling back to the governor set's own `defaultStatusId`, and checked
	 * against the winning governor's `applyTo` filter (PR 17 — block/file/module/meta-folder) before
	 * anything is returned at all.
	 *
	 * `null` means "the caller's row shows its normal icon, unaffected": no governor found, the
	 * nearest one doesn't reach this depth, `child`'s own kind is excluded via `applyTo`, no set
	 * chosen, the set was since deleted, or the set has no statuses to fall back to. A stale
	 * `explicitStatusId` (status removed, or the governor switched to a different set entirely)
	 * degrades gracefully to the set's default rather than erroring — same as every other "was this
	 * deleted out from under us" case in this file. */
	resolveNodeStatus(ancestors: StatusGovernance[], child: ViewNode): StatusDefinition | null {
		const governor = this.findGoverningAncestor(ancestors, child);
		if (!governor?.statusSetId) return null;
		const set = this.getStatusSet(governor.statusSetId);
		if (!set || set.statuses.length === 0) return null;
		if (child.explicitStatusId) {
			const explicit = set.statuses.find((s) => s.id === child.explicitStatusId);
			if (explicit) return explicit;
		}
		return set.statuses.find((s) => s.id === set.defaultStatusId) ?? set.statuses[0];
	}

	/** PR 17: the same ancestor walk `resolveNodeStatus` uses, stopping at "which governor wins"
	 * rather than continuing on to resolve an actual status — exposed separately so the click-to-
	 * change-status popup (PR 16) can show *that* governor's status set, not just the nearest
	 * ancestor unconditionally (which might not actually be the one in effect, if it doesn't reach
	 * this depth or excludes this child's kind via `applyTo`). */
	findGoverningAncestor(ancestors: StatusGovernance[], child: ViewNode): StatusGovernance | null {
		for (let i = 0; i < ancestors.length; i++) {
			const governor = ancestors[i];
			if (!governor.statusEnabled || !governor.statusSetId) continue;
			if (i > 0 && !governor.inheritToSubfolders) return null;
			if (!appliesToKind(governor.applyTo, child)) return null;
			return governor;
		}
		return null;
	}

	/** PR 22: same ancestor walk as `findGoverningAncestor`, deliberately *without* the per-child
	 * `applyTo` gate — sort orders an entire rendered sibling list at once (one shared decision for
	 * everyone in it), not "does this one child get a status dot," so it needs "which governor
	 * reaches this level" on its own, independent of any individual child's kind. */
	findSortGovernor(ancestors: StatusGovernance[]): StatusGovernance | null {
		for (let i = 0; i < ancestors.length; i++) {
			const governor = ancestors[i];
			if (!governor.statusEnabled || !governor.statusSetId) continue;
			if (i > 0 && !governor.inheritToSubfolders) return null;
			return governor;
		}
		return null;
	}

	/** PR 22: `status`'s rank within status set `setId` for sort-by-status — ascending, index 0 =
	 * highest rank. `null` if the status doesn't belong to that set at all (a governor's own status
	 * set can change out from under an already-resolved child's status reference — degrades the
	 * same "stale reference, don't error" way everything else in this file does; the caller treats
	 * `null` as unranked, sorting last). */
	rankOf(setId: string, statusId: string): number | null {
		const set = this.getStatusSet(setId);
		if (!set) return null;
		const idx = set.statuses.findIndex((s) => s.id === statusId);
		return idx === -1 ? null : idx;
	}
}

/** PR 19: default truncated-group placeholder label when the governor hasn't set a custom one,
 * e.g. "Idea" -> "Ideas" — ported from the reference plugin's own `pluralizeStatusLabel` (same
 * name, same "Items" fallback for a blank status label, same naive "already ends in s" check). */
export function pluralizeStatusLabel(label: string): string {
	const trimmed = label.trim();
	if (trimmed === "") return "Items";
	return trimmed.toLowerCase().endsWith("s") ? trimmed : `${trimmed}s`;
}

/** PR 17: an unset `applyTo`, or an unset individual field within it, defaults to `true` — matches
 * the reference plugin's own default (`applyToFiles`/`applyToFolders` both on) — so a governor
 * created before this PR existed keeps applying to everything it always did, not silently
 * narrowing. "Module" = a real on-disk folder; "metaFolder" = the organizational, no-disk-presence
 * kind — genuinely different things in Atlas (see `ApplyToConfig`'s own doc comment). */
function appliesToKind(applyTo: ApplyToConfig | undefined, child: ViewNode): boolean {
	if (child.type === "meta") return applyTo?.metaFolder ?? true;
	switch (child.ref?.kind) {
		case "block":
			return applyTo?.block ?? true;
		case "file":
			return applyTo?.file ?? true;
		case "folder":
			return applyTo?.module ?? true;
		default:
			return true;
	}
}
