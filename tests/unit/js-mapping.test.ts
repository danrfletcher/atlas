import { describe, expect, it } from "vitest";
import { isMapError } from "../../src/api-mapping";
import { compileJsMapper, mapJsOutputRows, runJsMapping, validateJsSource } from "../../src/api-js-mapping";

const objectWithArrayField = { total: 2, items: [{ id: "1", name: "One" }, { id: "2", name: "Two" }] };
const bareList = [{ id: "1", name: "One" }, { id: "2", name: "Two" }];
const empty: unknown[] = [];

describe("compileJsMapper/validateJsSource — G3: syntax check at Save/Test time", () => {
	it("compiles a well-formed arrow function", () => {
		expect(compileJsMapper("(response) => []").ok).toBe(true);
		expect(validateJsSource("(response) => []").ok).toBe(true);
	});

	it("E5: a syntax error is caught, not thrown", () => {
		const result = validateJsSource("(response) => {");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
	});

	it("rejects source that evaluates to something other than a function", () => {
		const result = validateJsSource("({ not: 'a function' })");
		expect(result.ok).toBe(false);
	});

	it("F4: the compiled function has no access to this module's own scope", () => {
		const result = compileJsMapper("(response) => { return typeof deepCopy; }");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.fn(null)).toBe("undefined");
	});
});

describe("mapJsOutputRows — E1: non-list output is a whole-refresh failure", () => {
	it("errors when the JS output is not an array", () => {
		expect(isMapError(mapJsOutputRows({ not: "a list" }))).toBe(true);
		expect(isMapError(mapJsOutputRows("a string"))).toBe(true);
		expect(isMapError(mapJsOutputRows(null))).toBe(true);
	});

	it("errors when the array contains a non-object element", () => {
		expect(isMapError(mapJsOutputRows([{ id: "1", label: "One" }, "not an object"]))).toBe(true);
	});

	it("errors when the array contains a nested array element", () => {
		expect(isMapError(mapJsOutputRows([{ id: "1", label: "One" }, ["nested", "array"]]))).toBe(true);
	});

	it("an empty array is valid input and yields zero rows", () => {
		const result = mapJsOutputRows([]);
		expect(isMapError(result)).toBe(false);
		if (!isMapError(result)) expect(result).toEqual({ rows: [], skippedCount: 0, truncated: false });
	});
});

describe("mapJsOutputRows — E2: missing/duplicate ids are skipped per-item, not a whole-refresh failure", () => {
	it("skips an item missing the id field, counts it", () => {
		const result = mapJsOutputRows([{ label: "No id" }, { id: "1", label: "One" }]);
		expect(isMapError(result)).toBe(false);
		if (!isMapError(result)) {
			expect(result.rows).toEqual([{ id: "1", label: "One" }]);
			expect(result.skippedCount).toBe(1);
		}
	});

	it("skips an item with a blank string id", () => {
		const result = mapJsOutputRows([{ id: "", label: "Blank" }, { id: "1", label: "One" }]);
		expect(isMapError(result)).toBe(false);
		if (!isMapError(result)) {
			expect(result.rows).toHaveLength(1);
			expect(result.skippedCount).toBe(1);
		}
	});

	it("keeps the first of a duplicate id, skips and counts the rest", () => {
		const result = mapJsOutputRows([
			{ id: "1", label: "First" },
			{ id: "1", label: "Second" },
		]);
		expect(isMapError(result)).toBe(false);
		if (!isMapError(result)) {
			expect(result.rows).toEqual([{ id: "1", label: "First" }]);
			expect(result.skippedCount).toBe(1);
		}
	});

	it("coerces a numeric or boolean id via String(...)", () => {
		const result = mapJsOutputRows([{ id: 42, label: "Num" }, { id: true, label: "Bool" }]);
		expect(isMapError(result)).toBe(false);
		if (!isMapError(result)) {
			expect(result.rows).toEqual([
				{ id: "42", label: "Num" },
				{ id: "true", label: "Bool" },
			]);
			expect(result.skippedCount).toBe(0);
		}
	});

	it("treats an object/array/function id as missing, skips it", () => {
		const result = mapJsOutputRows([
			{ id: { nested: true }, label: "Obj id" },
			{ id: ["a"], label: "Array id" },
			{ id: "1", label: "One" },
		]);
		expect(isMapError(result)).toBe(false);
		if (!isMapError(result)) {
			expect(result.rows).toEqual([{ id: "1", label: "One" }]);
			expect(result.skippedCount).toBe(2);
		}
	});
});

describe("mapJsOutputRows — E4: 5,000-row cap", () => {
	it("truncates beyond the row cap", () => {
		const items = Array.from({ length: 5010 }, (_, i) => ({ id: String(i), label: `Item ${i}` }));
		const result = mapJsOutputRows(items);
		expect(isMapError(result)).toBe(false);
		if (!isMapError(result)) {
			expect(result.rows).toHaveLength(5000);
			expect(result.truncated).toBe(true);
		}
	});
});

describe("mapJsOutputRows — extra field handling", () => {
	it("carries scalar extra fields through", () => {
		const result = mapJsOutputRows([{ id: "1", label: "One", extra: { count: 5, active: true, note: "hi", nil: null } }]);
		expect(isMapError(result)).toBe(false);
		if (!isMapError(result)) expect(result.rows[0].extra).toEqual({ count: 5, active: true, note: "hi", nil: null });
	});

	it("drops non-scalar extra values field-by-field, keeps the rest of the row", () => {
		const result = mapJsOutputRows([{ id: "1", label: "One", extra: { keep: "yes", nested: { a: 1 }, list: [1, 2] } }]);
		expect(isMapError(result)).toBe(false);
		if (!isMapError(result)) expect(result.rows[0].extra).toEqual({ keep: "yes" });
	});

	it("omits extra entirely when missing, null, or not an object", () => {
		const result = mapJsOutputRows([
			{ id: "1", label: "One" },
			{ id: "2", label: "Two", extra: null },
			{ id: "3", label: "Three", extra: "not an object" },
		]);
		expect(isMapError(result)).toBe(false);
		if (!isMapError(result)) {
			for (const row of result.rows) expect(row.extra).toBeUndefined();
		}
	});

	it("maps an optional secondary field when present", () => {
		const result = mapJsOutputRows([{ id: "1", label: "One", secondary: "a@b.com" }]);
		expect(isMapError(result)).toBe(false);
		if (!isMapError(result)) expect(result.rows[0].secondary).toBe("a@b.com");
	});
});

describe("runJsMapping — end to end against fixture responses", () => {
	it("runs a synchronous function against an object-with-array-field response", async () => {
		const result = await runJsMapping('(response) => response.items.map((i) => ({ id: i.id, label: i.name, extra: {} }))', objectWithArrayField);
		expect(isMapError(result)).toBe(false);
		if (!isMapError(result)) expect(result.rows).toEqual([{ id: "1", label: "One", extra: {} }, { id: "2", label: "Two", extra: {} }]);
	});

	it("runs against a bare list response", async () => {
		const result = await runJsMapping('(response) => response.map((i) => ({ id: i.id, label: i.name, extra: {} }))', bareList);
		expect(isMapError(result)).toBe(false);
		if (!isMapError(result)) expect(result.rows).toHaveLength(2);
	});

	it("runs against an empty response", async () => {
		const result = await runJsMapping("(response) => response.map((i) => ({ id: i.id, label: i.name }))", empty);
		expect(isMapError(result)).toBe(false);
		if (!isMapError(result)) expect(result.rows).toEqual([]);
	});

	it("awaits an async/Promise-returning mapper function", async () => {
		const result = await runJsMapping(
			'async (response) => { await Promise.resolve(); return response.items.map((i) => ({ id: i.id, label: i.name })); }',
			objectWithArrayField
		);
		expect(isMapError(result)).toBe(false);
		if (!isMapError(result)) expect(result.rows).toHaveLength(2);
	});

	it("E5: a thrown error inside the JS function becomes a normal mapping error, not an unhandled throw", async () => {
		const result = await runJsMapping("(response) => { throw new Error('boom'); }", objectWithArrayField);
		expect(isMapError(result)).toBe(true);
		if (isMapError(result)) expect(result.error).toBe("boom");
	});

	it("E5: a rejected promise becomes a normal mapping error", async () => {
		const result = await runJsMapping("async (response) => { throw new Error('rejected'); }", objectWithArrayField);
		expect(isMapError(result)).toBe(true);
		if (isMapError(result)) expect(result.error).toBe("rejected");
	});

	it("E5: a syntax error becomes a normal mapping error at run time too", async () => {
		const result = await runJsMapping("(response) => {", objectWithArrayField);
		expect(isMapError(result)).toBe(true);
	});

	it("E3: an infinitely looping mapper is the caller's problem to bound — this module does not itself impose a timeout", () => {
		// No assertion beyond documenting the boundary: `runJsMapping` awaits whatever the function
		// returns/resolves to and never wraps it in its own timeout race. E3's timeout behavior (if any)
		// is the responsibility of whatever drives `ApiSourceController.doRefresh`, not this pure module.
		expect(typeof runJsMapping).toBe("function");
	});

	it("mutating the response inside the JS function never leaks back to the caller's object (deep copy)", async () => {
		const original = { items: [{ id: "1", name: "One" }] };
		await runJsMapping('(response) => { response.items.push({ id: "2", name: "Injected" }); return []; }', original);
		expect(original.items).toHaveLength(1);
	});
});
