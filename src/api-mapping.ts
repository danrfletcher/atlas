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

function toStringField(obj: Record<string, unknown>, field: string): string {
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
