import { describe, expect, it } from "vitest";
import { detectMarkdownTables, needsTableIndexPrompt, selectMarkdownTable } from "../../src/markdown-table-mapping";

describe("detectMarkdownTables — table-detection rule", () => {
	it("detects a single standard pipe table", () => {
		const text = "| id | name |\n|---|---|\n| 1 | One |\n| 2 | Two |\n";
		const tables = detectMarkdownTables(text);
		expect(tables.length).toBe(1);
		expect(tables[0].headers).toEqual(["id", "name"]);
		expect(tables[0].rows).toEqual([
			{ id: "1", name: "One" },
			{ id: "2", name: "Two" },
		]);
	});

	it("detects two separate tables in the same file, in source order", () => {
		const text = "| id | name |\n|---|---|\n| 1 | One |\n\nsome prose between\n\n| sku | qty |\n|---|---|\n| a | 5 |\n";
		const tables = detectMarkdownTables(text);
		expect(tables.length).toBe(2);
		expect(tables[0].headers).toEqual(["id", "name"]);
		expect(tables[1].headers).toEqual(["sku", "qty"]);
	});

	it("never mistakes YAML front matter's own --- lines for a table", () => {
		const text = "---\ntitle: Test\n---\n\n| id | name |\n|---|---|\n| 1 | One |\n";
		const tables = detectMarkdownTables(text);
		expect(tables.length).toBe(1);
		expect(tables[0].headers).toEqual(["id", "name"]);
	});

	it("never mistakes prose containing a stray pipe for a table", () => {
		const text = "This sentence has a | pipe in it but no separator row after it.\n\nMore prose.\n";
		const tables = detectMarkdownTables(text);
		expect(tables.length).toBe(0);
	});

	it("returns an empty array, not an error, for a file with zero tables", () => {
		const text = "Just some plain prose.\n\nNo tables at all here.\n";
		expect(detectMarkdownTables(text)).toEqual([]);
	});
});

describe("selectMarkdownTable — index-selection rule", () => {
	const text =
		"| id | name |\n|---|---|\n| 1 | One |\n\nprose\n\n| sku | qty | note |\n|---|---|---|\n| a | 5 | fresh |\n| b | 2 | stale |\n";

	it("index 0 returns only the first table's rows keyed by its own header", () => {
		const tables = detectMarkdownTables(text);
		const table = selectMarkdownTable(tables, 0);
		expect(table.headers).toEqual(["id", "name"]);
		expect(table.rows).toEqual([{ id: "1", name: "One" }]);
	});

	it("index 1 returns only the second table's rows keyed by its own (wider) header, independent of table 0's width", () => {
		const tables = detectMarkdownTables(text);
		const table = selectMarkdownTable(tables, 1);
		expect(table.headers).toEqual(["sku", "qty", "note"]);
		expect(table.rows).toEqual([
			{ sku: "a", qty: "5", note: "fresh" },
			{ sku: "b", qty: "2", note: "stale" },
		]);
	});

	it("an out-of-range index selects a safe empty table rather than throwing", () => {
		const tables = detectMarkdownTables(text);
		const table = selectMarkdownTable(tables, 5);
		expect(table).toEqual({ headers: [], rows: [], skippedCount: 0 });
	});
});

describe("detectMarkdownTables — malformed-row rule (G22/E3)", () => {
	it("skips rows whose cell count doesn't match the header's and counts them via skippedCount, keeping the well-formed rows", () => {
		const text = "| id | name |\n|---|---|\n| 1 | One |\n| 2 |\n| 3 | Three | extra |\n| 4 | Four |\n";
		const tables = detectMarkdownTables(text);
		expect(tables.length).toBe(1);
		expect(tables[0].rows).toEqual([
			{ id: "1", name: "One" },
			{ id: "4", name: "Four" },
		]);
		expect(tables[0].skippedCount).toBe(2);
	});
});

describe("detectMarkdownTables — no-drift-detection regression (G24/F9)", () => {
	it("re-parsing after a table is inserted before the configured index reads whatever is NOW at that index, with no error or warning", () => {
		const originalText = "| id | name |\n|---|---|\n| 1 | One |\n";
		const originalTables = detectMarkdownTables(originalText);
		// Configure against index 0 — "the id/name table".
		const configuredIndex = 0;
		const originalSelection = selectMarkdownTable(originalTables, configuredIndex);
		expect(originalSelection.headers).toEqual(["id", "name"]);

		// The file is edited later: a new table is inserted *before* the one at index 0.
		const editedText = "| sku | qty |\n|---|---|\n| a | 5 |\n\n| id | name |\n|---|---|\n| 1 | One |\n";
		const editedTables = detectMarkdownTables(editedText);

		// Re-reading with the same stored index now silently reads the new table at that position —
		// no drift detection, no warning, no event, no thrown error.
		const reselection = selectMarkdownTable(editedTables, configuredIndex);
		expect(reselection.headers).toEqual(["sku", "qty"]);
		expect(reselection.rows).toEqual([{ sku: "a", qty: "5" }]);
	});

	it("re-parsing after the configured index's table is removed entirely reads the safe empty fallback, with no error or warning", () => {
		const configuredIndex = 1;
		const editedText = "| id | name |\n|---|---|\n| 1 | One |\n";
		const editedTables = detectMarkdownTables(editedText);
		const reselection = selectMarkdownTable(editedTables, configuredIndex);
		expect(reselection).toEqual({ headers: [], rows: [], skippedCount: 0 });
	});
});

describe("detectMarkdownTables — front-matter-and-prose rule", () => {
	it("parses only the real table content when front matter, prose before, and prose after are all present", () => {
		const text = "---\ntitle: Doc\n---\n\nSome intro prose.\n\n| id | name |\n|---|---|\n| 1 | One |\n\nSome trailing prose.\n";
		const tables = detectMarkdownTables(text);
		expect(tables.length).toBe(1);
		expect(tables[0].headers).toEqual(["id", "name"]);
		expect(tables[0].rows).toEqual([{ id: "1", name: "One" }]);
	});

	it("parses the table when only prose before is present (no front matter)", () => {
		const text = "Intro prose.\n\n| id | name |\n|---|---|\n| 1 | One |\n";
		const tables = detectMarkdownTables(text);
		expect(tables.length).toBe(1);
		expect(tables[0].rows).toEqual([{ id: "1", name: "One" }]);
	});

	it("parses the table when only prose after is present (no front matter)", () => {
		const text = "| id | name |\n|---|---|\n| 1 | One |\n\nTrailing prose.\n";
		const tables = detectMarkdownTables(text);
		expect(tables.length).toBe(1);
		expect(tables[0].rows).toEqual([{ id: "1", name: "One" }]);
	});

	it("parses the table when only front matter is present (no surrounding prose)", () => {
		const text = "---\ntitle: Doc\n---\n| id | name |\n|---|---|\n| 1 | One |\n";
		const tables = detectMarkdownTables(text);
		expect(tables.length).toBe(1);
		expect(tables[0].rows).toEqual([{ id: "1", name: "One" }]);
	});
});

describe("needsTableIndexPrompt — single-table-no-prompt rule", () => {
	it("never prompts when the file has exactly one table", () => {
		const tables = detectMarkdownTables("| id | name |\n|---|---|\n| 1 | One |\n");
		expect(tables.length).toBe(1);
		expect(needsTableIndexPrompt(tables)).toBe(false);
	});

	it("never prompts when the file has zero tables", () => {
		expect(needsTableIndexPrompt([])).toBe(false);
	});

	it("prompts when the file has more than one table", () => {
		const text = "| id | name |\n|---|---|\n| 1 | One |\n\n| sku | qty |\n|---|---|\n| a | 5 |\n";
		const tables = detectMarkdownTables(text);
		expect(tables.length).toBe(2);
		expect(needsTableIndexPrompt(tables)).toBe(true);
	});
});
