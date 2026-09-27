import { ApiFieldMapping, ApiMappedRow } from "./types";

/** E4: more than this many valid rows are truncated, first-kept. */
export const API_ROW_CAP = 5000;

/** G2: when the raw response is a plain object rather than a list, the user picks which top-level
 * field is the array to read rows from — these are the candidates offered in the mapping UI. */
export function findArrayFields(response: unknown): string[] {
	if (!response || typeof response !== "object" || Array.isArray(response)) return [];
	return Object.entries(response as Record<string, unknown>)
		.filter(([, value]) => Array.isArray(value))
		.map(([key]) => key);
}

function extractArray(response: unknown, arrayField?: string): unknown[] | null {
	if (Array.isArray(response)) return response;
	if (response && typeof response === "object" && arrayField) {
		const value = (response as Record<string, unknown>)[arrayField];
		if (Array.isArray(value)) return value;
	}
	return null;
}

export interface MapResult {
	rows: ApiMappedRow[];
	/** E2: missing/duplicate-id items skipped, first wins. */
	skippedCount: number;
	/** E4. */
	truncated: boolean;
}

export function toStringField(obj: Record<string, unknown>, field: string): string {
	const value = obj[field];
	return value === undefined || value === null ? "" : String(value);
}

/** G2/E1/E2/E4: maps a flat list of raw items against `mapping`. An item that isn't itself an
 * object, or whose id is missing/blank/a duplicate of one already kept, is skipped (first wins) and
 * counted in `skippedCount`. Stops (and sets `truncated`) once `API_ROW_CAP` valid rows are kept —
 * an empty `items` list is valid input and simply produces zero rows. */
export function mapSampleRows(items: unknown[], mapping: ApiFieldMapping): MapResult {
	const seenIds = new Set<string>();
	const rows: ApiMappedRow[] = [];
	let skippedCount = 0;
	let truncated = false;

	for (const raw of items) {
		if (rows.length >= API_ROW_CAP) {
			truncated = true;
			break;
		}
		if (!raw || typeof raw !== "object") {
			skippedCount++;
			continue;
		}
		const obj = raw as Record<string, unknown>;
		const id = toStringField(obj, mapping.idField);
		if (!id || seenIds.has(id)) {
			skippedCount++;
			continue;
		}
		seenIds.add(id);

		const row: ApiMappedRow = { id, label: toStringField(obj, mapping.labelField) };
		if (mapping.secondaryField) {
			const secondaryValue = obj[mapping.secondaryField];
			if (secondaryValue !== undefined && secondaryValue !== null) row.secondary = String(secondaryValue);
		}
		rows.push(row);
	}

	return { rows, skippedCount, truncated };
}

/** R2: derives the sample-field chip list from the chosen array (or the top-level list, when the
 * response already is one) — the same derivation `ApiSourceModal.fetchSample`'s initial fetch already
 * does (first object item's own keys), pulled out here so the array-field dropdown's `onChange` can
 * reuse it instead of the old, wrong `Object.keys(topLevelResponse)`, and so it's unit-testable
 * without the modal's own `obsidian` runtime dependency. */
export function sampleFieldsForArrayField(response: unknown, arrayField?: string): string[] {
	const items = extractArray(response, arrayField);
	if (items === null) return [];
	const first = items.find((item) => item && typeof item === "object") as Record<string, unknown> | undefined;
	return first ? Object.keys(first) : [];
}

/** G1: whether a data-source config has everything required to save (a URL, and required id/label
 * mapping targets) — the modal's Save-button enablement delegates here rather than duplicating the
 * rule, so R10 can unit-test it without the modal's own `obsidian` runtime dependency. */
export function canSaveApiSource(url: string, mapping: Pick<ApiFieldMapping, "idField" | "labelField">): boolean {
	return url.trim().length > 0 && mapping.idField.trim().length > 0 && mapping.labelField.trim().length > 0;
}

/** R18: does this API row match the explorer's free-text filter? Applied to `label` and, if present,
 * `secondary` — the same fields a unit row's own resolved display text is filtered on — so a Folder's
 * API rows behave "like any Folder with its own children" (G12) instead of always showing regardless
 * of the filter. An empty filter matches everything, same as `matchesFilter` elsewhere. */
export function apiItemMatchesFilter(filterText: string, label: string, secondary?: string): boolean {
	const needle = filterText.trim().toLowerCase();
	if (!needle) return true;
	return label.toLowerCase().includes(needle) || (!!secondary && secondary.toLowerCase().includes(needle));
}

/** R19: `lastSeenAt` is a UTC ISO string (`api-source-controller.ts`'s `doRefresh`); naively slicing
 * its first 10 characters shows the UTC calendar date, which can be a day off from the user's local
 * calendar date near midnight (e.g. 00:30 local BST on the 25th is stored as 23:30 UTC on the 24th).
 * Formats using the local Y/M/D fields instead, so "not found, last seen <date>" always matches what
 * the user's own clock would call that day. */
export function formatLocalDateFromIso(iso: string): string {
	const d = new Date(iso);
	const year = d.getFullYear();
	const month = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

export type MapResponseResult = MapResult | { error: string };

export function isMapError(result: MapResponseResult): result is { error: string } {
	return "error" in result;
}

/** E1: a response that isn't a JSON list (and, for an object response, has no valid `arrayField`
 * picked) is an error — the caller keeps the last good cache and shows a red dot. */
export function mapResponseRows(response: unknown, mapping: ApiFieldMapping): MapResponseResult {
	const items = extractArray(response, mapping.arrayField);
	if (items === null) return { error: "Response is not a JSON list" };
	return mapSampleRows(items, mapping);
}
