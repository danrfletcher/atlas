import { describe, expect, it } from "vitest";
import { compareSortKeys, currentSortMode, displayNameFor, isDirectSortMode, SORT_MODE_CHOICES } from "../../src/sort";
import type { SortKey } from "../../src/sort";
import type { ViewNode } from "../../src/types";

const key = (over: Partial<SortKey> = {}): SortKey => ({ name: "", mtime: null, placedAt: null, ...over });

describe("PR-1 sort.ts — compareSortKeys", () => {
	describe("alphabetical", () => {
		it("is case-insensitive", () => {
			expect(compareSortKeys("alphabetical", false, key({ name: "apple" }), key({ name: "Banana" }))).toBeLessThan(0);
			expect(compareSortKeys("alphabetical", false, key({ name: "APPLE" }), key({ name: "apple" }))).toBe(0);
		});

		it("orders embedded numbers naturally, not lexicographically (G8)", () => {
			expect(compareSortKeys("alphabetical", false, key({ name: "Item 2" }), key({ name: "Item 10" }))).toBeLessThan(0);
		});

		it("reverse flips the direction", () => {
			expect(compareSortKeys("alphabetical", true, key({ name: "apple" }), key({ name: "Banana" }))).toBeGreaterThan(0);
		});
	});

	describe("modified", () => {
		it("sorts newest first", () => {
			expect(compareSortKeys("modified", false, key({ mtime: 200 }), key({ mtime: 100 }))).toBeLessThan(0);
		});

		it("reverse sorts oldest first", () => {
			expect(compareSortKeys("modified", true, key({ mtime: 200 }), key({ mtime: 100 }))).toBeGreaterThan(0);
		});

		it("a row with no time (null) always sorts last, including under Reverse (G9/G21)", () => {
			expect(compareSortKeys("modified", false, key({ mtime: null }), key({ mtime: 100 }))).toBeGreaterThan(0);
			expect(compareSortKeys("modified", true, key({ mtime: null }), key({ mtime: 100 }))).toBeGreaterThan(0);
			expect(compareSortKeys("modified", true, key({ mtime: 100 }), key({ mtime: null }))).toBeLessThan(0);
		});

		it("two rows both with no time tie (0) regardless of direction", () => {
			expect(compareSortKeys("modified", false, key({ mtime: null }), key({ mtime: null }))).toBe(0);
			expect(compareSortKeys("modified", true, key({ mtime: null }), key({ mtime: null }))).toBe(0);
		});
	});

	describe("time-added", () => {
		it("sorts newest placedAt first, and a null stamp always sorts last under either direction (G10/G21)", () => {
			expect(compareSortKeys("time-added", false, key({ placedAt: 200 }), key({ placedAt: 100 }))).toBeLessThan(0);
			expect(compareSortKeys("time-added", true, key({ placedAt: null }), key({ placedAt: 100 }))).toBeGreaterThan(0);
			expect(compareSortKeys("time-added", false, key({ placedAt: null }), key({ placedAt: 100 }))).toBeGreaterThan(0);
		});
	});

	it("manual/status (or any other value) never reorders — this comparator is only ever consulted for the three new modes", () => {
		expect(compareSortKeys("manual", false, key({ name: "b" }), key({ name: "a" }))).toBe(0);
		expect(compareSortKeys("status", false, key({ name: "b" }), key({ name: "a" }))).toBe(0);
	});
});

describe("PR-1 sort.ts — isDirectSortMode / currentSortMode", () => {
	it("isDirectSortMode is true only for the three new modes", () => {
		expect(isDirectSortMode("alphabetical")).toBe(true);
		expect(isDirectSortMode("modified")).toBe(true);
		expect(isDirectSortMode("time-added")).toBe(true);
		expect(isDirectSortMode("manual")).toBe(false);
		expect(isDirectSortMode("status")).toBe(false);
		expect(isDirectSortMode(undefined)).toBe(false);
	});

	it("currentSortMode defaults an absent/undefined sortMode to manual", () => {
		expect(currentSortMode({})).toBe("manual");
		expect(currentSortMode({ sortMode: "alphabetical" })).toBe("alphabetical");
	});
});

describe("PR-1 sort.ts — SORT_MODE_CHOICES", () => {
	it("is exactly Manual, A-Z, Modified, Time added, in that order (G6/F4)", () => {
		expect(SORT_MODE_CHOICES.map((c) => c.mode)).toEqual(["manual", "alphabetical", "modified", "time-added"]);
		expect(SORT_MODE_CHOICES.map((c) => c.label)).toEqual(["Manual", "A-Z", "Modified", "Time added"]);
	});
});

describe("PR-1 sort.ts — displayNameFor", () => {
	it("uses a meta folder's own label", () => {
		const node: ViewNode = { id: "f", type: "meta", label: "My Folder", children: [] };
		expect(displayNameFor(node, "ignored")).toBe("My Folder");
	});

	it("uses the caller-resolved text for a unit (including a missing ref's fallback name)", () => {
		const node: ViewNode = { id: "u", type: "unit", ref: { kind: "file", path: "X.md" }, children: [] };
		expect(displayNameFor(node, "X")).toBe("X");
		expect(displayNameFor(node, undefined)).toBe("");
	});
});
