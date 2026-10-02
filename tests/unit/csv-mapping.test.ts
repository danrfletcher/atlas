import { describe, expect, it } from "vitest";
import { parseCsv } from "../../src/csv-parsing";

describe("parseCsv — G19: header row, zero-row cases", () => {
	it("treats a truly empty file as zero rows, not an error", () => {
		const result = parseCsv("");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.rows).toEqual([]);
			expect(result.skippedCount).toBe(0);
		}
	});

	it("treats a header-only file as zero rows, not an error", () => {
		const result = parseCsv("id,name\n");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.rows).toEqual([]);
	});

	it("maps the first row as headers for every subsequent row — no toggle", () => {
		const result = parseCsv("id,name\n1,One\n2,Two\n");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.rows).toEqual([
				{ id: "1", name: "One" },
				{ id: "2", name: "Two" },
			]);
		}
	});
});

describe("parseCsv — quoted fields", () => {
	it("keeps a comma inside a quoted field as part of the value", () => {
		const result = parseCsv('id,name\n1,"Smith, Jane"\n');
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.rows).toEqual([{ id: "1", name: "Smith, Jane" }]);
	});

	it("keeps a newline inside a quoted field as part of the value", () => {
		const result = parseCsv('id,note\n1,"line one\nline two"\n2,plain\n');
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.rows).toEqual([
				{ id: "1", note: "line one\nline two" },
				{ id: "2", note: "plain" },
			]);
		}
	});

	it("unescapes a doubled quote inside a quoted field", () => {
		const result = parseCsv('id,name\n1,"She said ""hi"""\n');
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.rows).toEqual([{ id: "1", name: 'She said "hi"' }]);
	});
});

describe("parseCsv — ragged rows (not malformed)", () => {
	it("pads a short row's missing trailing fields with empty strings", () => {
		const result = parseCsv("id,name,note\n1,One\n");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.rows).toEqual([{ id: "1", name: "One", note: "" }]);
			expect(result.skippedCount).toBe(0);
		}
	});

	it("truncates a long row's extra fields beyond the header count", () => {
		const result = parseCsv("id,name\n1,One,extra,more\n");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.rows).toEqual([{ id: "1", name: "One" }]);
			expect(result.skippedCount).toBe(0);
		}
	});
});

describe("parseCsv — G22: malformed-row skip vs. whole-parse failure", () => {
	it("skips a later row with an unterminated quote and reports it via skippedCount", () => {
		const result = parseCsv('id,name\n1,One\n2,"unterminated\n');
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.rows).toEqual([{ id: "1", name: "One" }]);
			expect(result.skippedCount).toBe(1);
		}
	});

	it("fails the whole parse when the header row itself never closes its quote", () => {
		const result = parseCsv('"unterminated header\n1,One\n');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
	});

	it("fails the whole parse on binary (non-CSV) content", () => {
		const result = parseCsv("id,name\n1,\u0000\u0001\u0002binary\n");
		expect(result.ok).toBe(false);
	});
});

describe("parseCsv — encoding and header edge cases", () => {
	it("strips a leading UTF-8 BOM before reading headers", () => {
		const result = parseCsv("﻿id,name\n1,One\n");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.rows).toEqual([{ id: "1", name: "One" }]);
	});

	it("tolerates a missing trailing newline on the last row", () => {
		const result = parseCsv("id,name\n1,One");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.rows).toEqual([{ id: "1", name: "One" }]);
	});

	it("tolerates CRLF line endings", () => {
		const result = parseCsv("id,name\r\n1,One\r\n2,Two\r\n");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.rows).toEqual([
				{ id: "1", name: "One" },
				{ id: "2", name: "Two" },
			]);
		}
	});

	it("dedupes a duplicate header so both columns survive under distinct keys", () => {
		const result = parseCsv("id,name,name\n1,One,Uno\n");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.rows).toEqual([{ id: "1", name: "One", name_2: "Uno" }]);
	});

	it("falls back blank headers to a stable, deduped placeholder name", () => {
		const result = parseCsv("id,,\n1,a,b\n");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.rows).toEqual([{ id: "1", column: "a", column_2: "b" }]);
	});
});
