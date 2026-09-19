import { ViewNode } from "./types";

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
	/** A set may have more than one completed status. Hidden via PR 16/18's "hide completed" toggle. */
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

/** PR 15: picks black or white so a "Retain icons" icon stays legible against an arbitrary
 * user-chosen status dot color, the same contrast heuristic the reference plugin uses. */
export function contrastingTextColor(hex: string): "#000000" | "#ffffff" {
	const normalized = normalizeHexColor(hex).replace("#", "");
	const full = normalized.length === 3 ? normalized.split("").map((ch) => ch + ch).join("") : normalized;
	const r = parseInt(full.substring(0, 2), 16);
	const g = parseInt(full.substring(2, 4), 16);
	const b = parseInt(full.substring(4, 6), 16);
	const luminance = (r * 299 + g * 587 + b * 114) / 1000;
	return luminance > 150 ? "#000000" : "#ffffff";
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

	/** PR 15: resolves the status a *governing* node assigns to its direct children — `node` here is
	 * the parent being checked, not the row being rendered (Dan's own spec: "the statuses apply to
	 * the first direct children under that item", never to the item itself). `null` means "the
	 * caller's row shows its normal icon, unaffected" (no governing parent, disabled, no set chosen,
	 * the set was since deleted, or the set has no statuses to fall back to). No inheritance beyond
	 * one level yet (PR 16+): a grandchild never shows a status just because a grandparent has one.
	 * Defaults to the set's own `defaultStatusId` since PR 15 has no per-child "which specific
	 * status" picker yet, just "which set". */
	resolveNodeStatus(node: ViewNode): StatusDefinition | null {
		if (!node.statusEnabled || !node.statusSetId) return null;
		const set = this.getStatusSet(node.statusSetId);
		if (!set || set.statuses.length === 0) return null;
		return set.statuses.find((s) => s.id === set.defaultStatusId) ?? set.statuses[0];
	}
}
