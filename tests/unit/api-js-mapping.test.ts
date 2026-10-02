import { describe, expect, it } from "vitest";
import { isMapError, mapResponseRows } from "../../src/api-mapping";
import { compileJsMapper, runJsMapping, validateJsSource } from "../../src/api-js-mapping";
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

	it("R3(d): validateJsSource accepts a mapper written against parsed CSV rows, no code changes needed", () => {
		expect(validateJsSource("(response) => response.map((row) => ({ id: row.id, label: row.name }))")).toEqual({ ok: true });
	});

	it("R3(d): validateJsSource reports the same error shape for a broken mapper run against CSV rows", () => {
		const result = validateJsSource("not valid js (((");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
	});

	it("R3(d): compileJsMapper's compiled function runs directly against parsed CSV rows with no mapping-pipeline wrapper", () => {
		const parsed = parseCsv("id,name\n1,One\n2,Two\n");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const compiled = compileJsMapper("(response) => response.map((row) => ({ id: row.id, label: row.name }))");
		expect(compiled.ok).toBe(true);
		if (!compiled.ok) return;
		expect(compiled.fn(parsed.rows)).toEqual([
			{ id: "1", label: "One" },
			{ id: "2", label: "Two" },
		]);
	});
});
