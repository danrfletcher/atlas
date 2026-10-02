import { describe, expect, it } from "vitest";
import { isMapError, mapResponseRows } from "../../src/api-mapping";
import { runJsMapping } from "../../src/api-js-mapping";
import { parseCsv } from "../../src/csv-parsing";

describe("runJsMapping — PR-7: CSV row-object compatibility", () => {
	it("treats parsed CSV rows exactly like a top-level-array API response (unmodified mapper)", async () => {
		const parsed = parseCsv("id,name\n1,One\n2,Two\n");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const result = await runJsMapping(
			"(response) => response.map((row) => ({ id: row.id, label: row.name }))",
			parsed.rows
		);
		expect(isMapError(result)).toBe(false);
		if (!isMapError(result)) expect(result.rows).toEqual([
			{ id: "1", label: "One" },
			{ id: "2", label: "Two" },
		]);
	});

	it("matches mapResponseRows' own result for the same CSV rows and mapping, under the JS mapper's equivalent logic", async () => {
		const parsed = parseCsv("id,name\n1,One\n2,Two\n");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const mapping = { idField: "id", labelField: "name" };
		const dragResult = mapResponseRows(parsed.rows, mapping);
		const jsResult = await runJsMapping(
			"(response) => response.map((row) => ({ id: row.id, label: row.name }))",
			parsed.rows
		);
		expect(isMapError(dragResult)).toBe(false);
		expect(isMapError(jsResult)).toBe(false);
		if (!isMapError(dragResult) && !isMapError(jsResult)) expect(jsResult.rows).toEqual(dragResult.rows);
	});
});
