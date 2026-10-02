import { describe, expect, it } from "vitest";
import {
	API_ROW_CAP,
	apiItemMatchesFilter,
	canSaveApiSource,
	findArrayFields,
	formatLocalDateFromIso,
	isMapError,
	mapResponseRows,
	mapSampleRows,
	sampleFieldsForArrayField,
} from "../../src/api-mapping";
import { parseCsv } from "../../src/csv-parsing";
import { ApiFieldMapping } from "../../src/types";

const mapping: ApiFieldMapping = { idField: "id", labelField: "name" };

describe("findArrayFields", () => {
	it("lists top-level fields whose value is an array", () => {
		expect(findArrayFields({ items: [1], total: 5, nested: { a: [1] } })).toEqual(["items"]);
	});

	it("returns nothing for a response that is itself an array", () => {
		expect(findArrayFields([1, 2, 3])).toEqual([]);
	});

	it("returns nothing for a non-object response", () => {
		expect(findArrayFields(null)).toEqual([]);
		expect(findArrayFields("plain string")).toEqual([]);
	});
});

describe("mapResponseRows — G2/E1: array-field selection", () => {
	it("maps a bare JSON list directly", () => {
		const result = mapResponseRows([{ id: "1", name: "One" }], mapping);
		expect(isMapError(result)).toBe(false);
		if (!isMapError(result)) expect(result.rows).toEqual([{ id: "1", label: "One" }]);
	});

	it("reads rows from the chosen array field when the response is an object", () => {
		const result = mapResponseRows({ items: [{ id: "1", name: "One" }], total: 1 }, { ...mapping, arrayField: "items" });
		expect(isMapError(result)).toBe(false);
		if (!isMapError(result)) expect(result.rows).toEqual([{ id: "1", label: "One" }]);
	});

	it("errors when the response is an object with no arrayField picked", () => {
		const result = mapResponseRows({ items: [{ id: "1", name: "One" }] }, mapping);
		expect(isMapError(result)).toBe(true);
	});

	it("errors when the response is a plain scalar", () => {
		expect(isMapError(mapResponseRows("not a list", mapping))).toBe(true);
		expect(isMapError(mapResponseRows(42, mapping))).toBe(true);
	});
});

describe("mapSampleRows — E2: missing/duplicate ids", () => {
	it("skips an item missing the id field, counts it", () => {
		const result = mapSampleRows([{ name: "No id" }, { id: "1", name: "One" }], mapping);
		expect(result.rows).toEqual([{ id: "1", label: "One" }]);
		expect(result.skippedCount).toBe(1);
	});

	it("skips an item with a blank id", () => {
		const result = mapSampleRows([{ id: "", name: "Blank" }, { id: "1", name: "One" }], mapping);
		expect(result.rows).toHaveLength(1);
		expect(result.skippedCount).toBe(1);
	});

	it("keeps the first of a duplicate id, skips and counts the rest", () => {
		const result = mapSampleRows(
			[
				{ id: "1", name: "First" },
				{ id: "1", name: "Second" },
			],
			mapping
		);
		expect(result.rows).toEqual([{ id: "1", label: "First" }]);
		expect(result.skippedCount).toBe(1);
	});

	it("skips a non-object item, counts it", () => {
		const result = mapSampleRows(["just a string", { id: "1", name: "One" }], mapping);
		expect(result.rows).toHaveLength(1);
		expect(result.skippedCount).toBe(1);
	});

	it("maps an optional secondary field when present", () => {
		const result = mapSampleRows([{ id: "1", name: "One", email: "a@b.com" }], { ...mapping, secondaryField: "email" });
		expect(result.rows).toEqual([{ id: "1", label: "One", secondary: "a@b.com" }]);
	});

	it("omits secondary when the field is absent on that item", () => {
		const result = mapSampleRows([{ id: "1", name: "One" }], { ...mapping, secondaryField: "email" });
		expect(result.rows[0].secondary).toBeUndefined();
	});

	it("an empty item list is valid input and yields zero rows", () => {
		const result = mapSampleRows([], mapping);
		expect(result).toEqual({ rows: [], skippedCount: 0, truncated: false });
	});
});

describe("mapSampleRows — E4: 5,000-row cap", () => {
	it("keeps exactly API_ROW_CAP rows and sets truncated when there are more", () => {
		const items = Array.from({ length: API_ROW_CAP + 10 }, (_, i) => ({ id: String(i), name: `Item ${i}` }));
		const result = mapSampleRows(items, mapping);
		expect(result.rows).toHaveLength(API_ROW_CAP);
		expect(result.truncated).toBe(true);
	});

	it("does not truncate when there are exactly API_ROW_CAP rows", () => {
		const items = Array.from({ length: API_ROW_CAP }, (_, i) => ({ id: String(i), name: `Item ${i}` }));
		const result = mapSampleRows(items, mapping);
		expect(result.rows).toHaveLength(API_ROW_CAP);
		expect(result.truncated).toBe(false);
	});
});

describe("canSaveApiSource — G1: required targets before Save is enabled", () => {
	it("requires a non-blank URL", () => {
		expect(canSaveApiSource("", mapping)).toBe(false);
		expect(canSaveApiSource("   ", mapping)).toBe(false);
		expect(canSaveApiSource("https://api.example.com", mapping)).toBe(true);
	});

	it("requires both id and label mapped, but not secondary", () => {
		expect(canSaveApiSource("https://x", { idField: "", labelField: "name" })).toBe(false);
		expect(canSaveApiSource("https://x", { idField: "id", labelField: "" })).toBe(false);
		expect(canSaveApiSource("https://x", { idField: "id", labelField: "name" })).toBe(true);
		expect(canSaveApiSource("https://x", { idField: "id", labelField: "name", secondaryField: undefined })).toBe(true);
	});

	it("treats a whitespace-only id or label as not mapped", () => {
		expect(canSaveApiSource("https://x", { idField: "  ", labelField: "name" })).toBe(false);
	});
});

describe("sampleFieldsForArrayField — R2: fields come from the array's own items, not the wrapper object", () => {
	it("derives fields from the first item of a bare JSON list", () => {
		expect(sampleFieldsForArrayField([{ id: "1", name: "One" }, { id: "2", name: "Two" }])).toEqual(["id", "name"]);
	});

	it("derives fields from the chosen array field's first item, not the top-level object's own keys", () => {
		const response = { total: 2, items: [{ id: "1", name: "One" }] };
		// Previously this bug returned Object.keys(response) — ["total", "items"] — instead of the
		// array's own item shape.
		expect(sampleFieldsForArrayField(response, "items")).toEqual(["id", "name"]);
	});

	it("returns nothing when no array field is picked yet for an object response", () => {
		expect(sampleFieldsForArrayField({ total: 2, items: [{ id: "1" }] })).toEqual([]);
	});

	it("returns nothing when the chosen array field's list is empty", () => {
		expect(sampleFieldsForArrayField({ items: [] }, "items")).toEqual([]);
	});

	it("re-derives fields correctly after switching which array field is chosen", () => {
		const response = { users: [{ id: "1", name: "One" }], groups: [{ gid: "g1", title: "Group" }] };
		expect(sampleFieldsForArrayField(response, "users")).toEqual(["id", "name"]);
		expect(sampleFieldsForArrayField(response, "groups")).toEqual(["gid", "title"]);
	});
});

describe("apiItemMatchesFilter — R18: API rows respect the explorer filter like any other row", () => {
	it("matches everything when the filter is empty or blank", () => {
		expect(apiItemMatchesFilter("", "Docker", "4.34")).toBe(true);
		expect(apiItemMatchesFilter("   ", "Docker", "4.34")).toBe(true);
	});

	it("matches case-insensitively against the label", () => {
		expect(apiItemMatchesFilter("docker", "Docker", undefined)).toBe(true);
		expect(apiItemMatchesFilter("DOCKER", "Docker", undefined)).toBe(true);
	});

	it("matches against the secondary text when the label doesn't match", () => {
		expect(apiItemMatchesFilter("4.34", "Docker", "4.34")).toBe(true);
	});

	it("does not match when neither label nor secondary contain the filter", () => {
		expect(apiItemMatchesFilter("brew", "Docker", "4.34")).toBe(false);
	});

	it("does not match on secondary when secondary is absent", () => {
		expect(apiItemMatchesFilter("4.34", "Docker", undefined)).toBe(false);
	});
});

describe("formatLocalDateFromIso — R19: local calendar date, not the UTC one", () => {
	it("formats a UTC-midday timestamp the same in any timezone", () => {
		expect(formatLocalDateFromIso("2026-09-25T12:00:00.000Z")).toBe("2026-09-25");
	});

	it("pads single-digit months and days", () => {
		expect(formatLocalDateFromIso("2026-01-05T12:00:00.000Z")).toBe("2026-01-05");
	});

	it("R19: near a day boundary, reports the *local* calendar date, which the old `.slice(0, 10)` on the raw UTC string would have gotten wrong", () => {
		const originalTz = process.env.TZ;
		process.env.TZ = "Pacific/Kiritimati"; // UTC+14 — always a calendar day ahead of UTC
		try {
			// A row last seen at 2026-09-24T23:30Z is already 2026-09-25 local in this timezone —
			// `"2026-09-24T23:30:00.000Z".slice(0, 10)` would wrongly report "2026-09-24".
			expect(formatLocalDateFromIso("2026-09-24T23:30:00.000Z")).toBe("2026-09-25");
		} finally {
			process.env.TZ = originalTz;
		}
	});
});

describe("mapSampleRows — PR-7: CSV row-object compatibility", () => {
	it("maps CSV-parsed row objects exactly like any other flat-array response, unmodified", () => {
		const parsed = parseCsv("id,name,secondary\n1,One,alpha\n2,Two,beta\n");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const result = mapSampleRows(parsed.rows, { idField: "id", labelField: "name", secondaryField: "secondary" });
		expect(result.rows).toEqual([
			{ id: "1", label: "One", secondary: "alpha" },
			{ id: "2", label: "Two", secondary: "beta" },
		]);
		expect(result.skippedCount).toBe(0);
		expect(result.truncated).toBe(false);
	});

	it("skips a CSV row missing its id/label field exactly like it would for any other source (E2)", () => {
		const parsed = parseCsv("id,name\n1,One\n,NoId\n");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const result = mapSampleRows(parsed.rows, mapping);
		expect(result.rows).toEqual([{ id: "1", label: "One" }]);
		expect(result.skippedCount).toBe(1);
	});

	it("R3(b): dedupes CSV rows by id exactly like any other source — first wins, later duplicates skipped (E2)", () => {
		const parsed = parseCsv("id,name\n1,One\n1,Duplicate\n2,Two\n");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const result = mapSampleRows(parsed.rows, mapping);
		expect(result.rows).toEqual([
			{ id: "1", label: "One" },
			{ id: "2", label: "Two" },
		]);
		expect(result.skippedCount).toBe(1);
	});

	it("R3(b): extraFields pull named CSV columns through onto each row's `extra`, same as any other source", () => {
		const parsed = parseCsv("id,name,status,owner\n1,One,open,alice\n2,Two,closed,bob\n");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const result = mapSampleRows(parsed.rows, { idField: "id", labelField: "name", extraFields: { state: "status", who: "owner" } });
		expect(result.rows).toEqual([
			{ id: "1", label: "One", extra: { state: "open", who: "alice" } },
			{ id: "2", label: "Two", extra: { state: "closed", who: "bob" } },
		]);
	});

	it("R3(a): the 5,000-row cap and truncation behave identically for CSV input as for any other source (E4)", () => {
		const header = "id,name\n";
		const lines = Array.from({ length: API_ROW_CAP + 10 }, (_, i) => `${i},Row ${i}`).join("\n");
		const parsed = parseCsv(header + lines + "\n");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.rows.length).toBe(API_ROW_CAP + 10);

		const result = mapSampleRows(parsed.rows, mapping);
		expect(result.rows.length).toBe(API_ROW_CAP);
		expect(result.truncated).toBe(true);
		expect(result.rows[0]).toEqual({ id: "0", label: "Row 0" });
		expect(result.rows[API_ROW_CAP - 1]).toEqual({ id: `${API_ROW_CAP - 1}`, label: `Row ${API_ROW_CAP - 1}` });
	});
});
