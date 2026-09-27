import { describe, expect, it } from "vitest";
import { isMapError, mapResponseRows } from "../../src/api-mapping";
import { compileJsMapper, generateJsFromMapping, runJsMapping } from "../../src/api-js-mapping";
import { ApiFieldMapping } from "../../src/types";

const objectWithArrayField = { total: 2, items: [{ id: "1", name: "One", email: "a@b.com" }, { id: "2", name: "Two" }] };
const bareList = [{ id: "1", name: "One", email: "a@b.com" }, { id: "2", name: "Two" }];

async function runGenerated(mapping: ApiFieldMapping, response: unknown) {
	const source = generateJsFromMapping(mapping);
	const compiled = compileJsMapper(source);
	expect(compiled.ok).toBe(true);
	return runJsMapping(source, response);
}

describe("generateJsFromMapping — G3: pre-filled code round-trips against the drag mapping it came from", () => {
	it("compiles without a syntax error", () => {
		const source = generateJsFromMapping({ idField: "id", labelField: "name" });
		expect(compileJsMapper(source).ok).toBe(true);
	});

	it("matches mapResponseRows's own output for a bare list, full mapping (id + label + secondary)", async () => {
		const mapping: ApiFieldMapping = { idField: "id", labelField: "name", secondaryField: "email" };
		const dragResult = mapResponseRows(bareList, mapping);
		const jsResult = await runGenerated(mapping, bareList);
		expect(isMapError(dragResult)).toBe(false);
		expect(isMapError(jsResult)).toBe(false);
		if (!isMapError(dragResult) && !isMapError(jsResult)) {
			expect(jsResult.rows).toEqual(dragResult.rows.map((row) => ({ ...row, extra: {} })));
		}
	});

	it("matches mapResponseRows's own output for an object response with an arrayField picked", async () => {
		const mapping: ApiFieldMapping = { idField: "id", labelField: "name", secondaryField: "email", arrayField: "items" };
		const dragResult = mapResponseRows(objectWithArrayField, mapping);
		const jsResult = await runGenerated(mapping, objectWithArrayField);
		expect(isMapError(dragResult)).toBe(false);
		expect(isMapError(jsResult)).toBe(false);
		if (!isMapError(dragResult) && !isMapError(jsResult)) {
			expect(jsResult.rows).toEqual(dragResult.rows.map((row) => ({ ...row, extra: {} })));
		}
	});

	it("matches mapResponseRows's own output for a partial mapping — only id + label set, no secondary/arrayField", async () => {
		const mapping: ApiFieldMapping = { idField: "id", labelField: "name" };
		const dragResult = mapResponseRows(bareList, mapping);
		const jsResult = await runGenerated(mapping, bareList);
		expect(isMapError(dragResult)).toBe(false);
		expect(isMapError(jsResult)).toBe(false);
		if (!isMapError(dragResult) && !isMapError(jsResult)) {
			expect(jsResult.rows).toEqual(dragResult.rows.map((row) => ({ ...row, extra: {} })));
			expect(jsResult.rows.every((row) => row.secondary === undefined)).toBe(true);
		}
	});

	it("always emits a literal empty extra object — PR-4 has no drag-mapping extra-field UI to pre-fill from", async () => {
		const mapping: ApiFieldMapping = { idField: "id", labelField: "name" };
		const jsResult = await runGenerated(mapping, bareList);
		expect(isMapError(jsResult)).toBe(false);
		if (!isMapError(jsResult)) {
			for (const row of jsResult.rows) expect(row.extra).toEqual({});
		}
	});

	it("an object response with no arrayField picked yields zero rows, matching drag mode's own error case being unreachable from generated code (items is undefined, mapped to [])", async () => {
		const mapping: ApiFieldMapping = { idField: "id", labelField: "name" };
		const jsResult = await runGenerated(mapping, objectWithArrayField);
		expect(isMapError(jsResult)).toBe(false);
		if (!isMapError(jsResult)) expect(jsResult.rows).toEqual([]);
	});
});
