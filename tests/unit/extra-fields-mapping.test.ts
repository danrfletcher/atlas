import { describe, expect, it } from "vitest";
import {
	addExtraField,
	canSaveApiSource,
	isValidExtraFieldName,
	mapResponseRows,
	mapSampleRows,
	removeExtraField,
	renameExtraField,
} from "../../src/api-mapping";
import { ApiFieldMapping, ApiMappedRow } from "../../src/types";

describe("extra-fields-mapping — G2: Extra named mapping fields", () => {
	describe("Extra field naming (isValidExtraFieldName)", () => {
		it("accepts valid names composed of letters, digits, and underscores", () => {
			expect(isValidExtraFieldName("path")).toBe(true);
			expect(isValidExtraFieldName("bundle_id")).toBe(true);
			expect(isValidExtraFieldName("version1")).toBe(true);
			expect(isValidExtraFieldName("_internal")).toBe(true);
			expect(isValidExtraFieldName("CamelCase_123")).toBe(true);
		});

		it("rejects invalid names with spaces, dashes, or punctuation", () => {
			expect(isValidExtraFieldName("")).toBe(false);
			expect(isValidExtraFieldName("field with space")).toBe(false);
			expect(isValidExtraFieldName("field-with-dash")).toBe(false);
			expect(isValidExtraFieldName("field.dot")).toBe(false);
			expect(isValidExtraFieldName("field$var")).toBe(false);
			expect(isValidExtraFieldName("@special")).toBe(false);
			expect(isValidExtraFieldName("foo/bar")).toBe(false);
		});
	});

	describe("Extra field management (add, rename, remove, uniqueness)", () => {
		it("adds extra fields with valid names", () => {
			const mapping: ApiFieldMapping = { idField: "id", labelField: "name" };
			expect(addExtraField(mapping, "path", "app_path")).toBe(true);
			expect(mapping.extraFields).toEqual({ path: "app_path" });

			expect(addExtraField(mapping, "version", "ver")).toBe(true);
			expect(mapping.extraFields).toEqual({ path: "app_path", version: "ver" });
		});

		it("rejects adding an extra field with an invalid name", () => {
			const mapping: ApiFieldMapping = { idField: "id", labelField: "name" };
			expect(addExtraField(mapping, "invalid name", "app_path")).toBe(false);
			expect(mapping.extraFields).toBeUndefined();
		});

		it("renames an extra field preserving the mapped source field", () => {
			const mapping: ApiFieldMapping = {
				idField: "id",
				labelField: "name",
				extraFields: { path: "raw_path", other: "val" },
			};
			expect(renameExtraField(mapping, "path", "app_path")).toBe(true);
			expect(mapping.extraFields).toEqual({ app_path: "raw_path", other: "val" });
		});

		it("rejects renaming to an existing extra field name (uniqueness)", () => {
			const mapping: ApiFieldMapping = {
				idField: "id",
				labelField: "name",
				extraFields: { path: "raw_path", other: "val" },
			};
			expect(renameExtraField(mapping, "path", "other")).toBe(false);
			// Original remains intact
			expect(mapping.extraFields).toEqual({ path: "raw_path", other: "val" });
		});

		it("rejects renaming a non-existent extra field", () => {
			const mapping: ApiFieldMapping = {
				idField: "id",
				labelField: "name",
				extraFields: { path: "raw_path" },
			};
			expect(renameExtraField(mapping, "missing", "new_name")).toBe(false);
		});

		it("removes an extra field", () => {
			const mapping: ApiFieldMapping = {
				idField: "id",
				labelField: "name",
				extraFields: { path: "raw_path", other: "val" },
			};
			expect(removeExtraField(mapping, "path")).toBe(true);
			expect(mapping.extraFields).toEqual({ other: "val" });
			expect(removeExtraField(mapping, "nonexistent")).toBe(false);
		});
	});

	describe("Required ID and Label, optional extras (canSaveApiSource)", () => {
		it("allows saving with valid URL, ID, and Label, with no extras", () => {
			expect(canSaveApiSource("https://api.example.com", { idField: "id", labelField: "name" })).toBe(true);
		});

		it("allows saving when extras are present", () => {
			const mapping: ApiFieldMapping = {
				idField: "id",
				labelField: "name",
				extraFields: { path: "app_path" },
			};
			expect(canSaveApiSource("https://api.example.com", mapping)).toBe(true);
		});

		it("blocks saving when ID or Label is missing", () => {
			expect(canSaveApiSource("https://api.example.com", { idField: "", labelField: "name" })).toBe(false);
			expect(canSaveApiSource("https://api.example.com", { idField: "id", labelField: "" })).toBe(false);
			expect(canSaveApiSource("", { idField: "id", labelField: "name" })).toBe(false);
		});
	});

	describe("Caching of extras in rows", () => {
		const sampleItems = [
			{ id: "1", name: "App 1", raw_path: "/Applications/App1.app", bundle: "com.app1" },
			{ id: "2", name: "App 2", raw_path: "/Applications/App2.app", bundle: "com.app2" },
		];

		it("populates row.extra for each mapped extra field", () => {
			const mapping: ApiFieldMapping = {
				idField: "id",
				labelField: "name",
				extraFields: { path: "raw_path", bundle_id: "bundle" },
			};
			const res = mapSampleRows(sampleItems, mapping);
			expect(res.rows).toEqual([
				{ id: "1", label: "App 1", extra: { path: "/Applications/App1.app", bundle_id: "com.app1" } },
				{ id: "2", label: "App 2", extra: { path: "/Applications/App2.app", bundle_id: "com.app2" } },
			]);
		});

		it("does not populate row.extra when no extra fields are mapped", () => {
			const mapping: ApiFieldMapping = { idField: "id", labelField: "name" };
			const res = mapSampleRows(sampleItems, mapping);
			expect(res.rows).toEqual([
				{ id: "1", label: "App 1" },
				{ id: "2", label: "App 2" },
			]);
			expect(res.rows[0].extra).toBeUndefined();
		});

		it("handles response objects through mapResponseRows", () => {
			const response = {
				items: sampleItems,
			};
			const mapping: ApiFieldMapping = {
				idField: "id",
				labelField: "name",
				arrayField: "items",
				extraFields: { path: "raw_path" },
			};
			const res = mapResponseRows(response, mapping);
			expect("rows" in res).toBe(true);
			if ("rows" in res) {
				expect(res.rows).toEqual([
					{ id: "1", label: "App 1", extra: { path: "/Applications/App1.app" } },
					{ id: "2", label: "App 2", extra: { path: "/Applications/App2.app" } },
				]);
			}
		});

		it("preserves extras across JSON serialization (surviving cache reload)", () => {
			const mapping: ApiFieldMapping = {
				idField: "id",
				labelField: "name",
				extraFields: { path: "raw_path" },
			};
			const res = mapSampleRows(sampleItems, mapping);
			const serialized = JSON.stringify(res.rows);
			const reloaded: ApiMappedRow[] = JSON.parse(serialized);
			expect(reloaded).toEqual(res.rows);
			expect(reloaded[0].extra?.path).toBe("/Applications/App1.app");
		});
	});
});
