import { describe, expect, it } from "vitest";
import { API_ROW_CAP, canSaveApiSource, findArrayFields, isMapError, mapResponseRows, mapSampleRows, sampleFieldsForArrayField } from "../../src/api-mapping";
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
