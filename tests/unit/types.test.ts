import { describe, expect, it } from "vitest";
import { ApiSourceConfig, DataSourceConfig, DataSourceType, UnitRef, parseUnitRefKey, rewriteRefKeyPath, unitRefKey } from "../../src/types";

describe("PR-3 — DataSourceConfig type discriminant", () => {
	it("config shape includes type discriminant and narrows correctly for api type", () => {
		const types: DataSourceType[] = ["api", "folder", "markdown-table", "csv"];
		expect(types).toEqual(["api", "folder", "markdown-table", "csv"]);

		const apiSource: ApiSourceConfig = {
			type: "api",
			url: "https://api.example.com/items",
			method: "GET",
			mapping: { idField: "id", labelField: "name" },
			mode: "merge",
		};

		const config: DataSourceConfig = apiSource;
		if (config.type === "api") {
			// Narrowed to ApiSourceConfig — its api-only fields are accessible without a cast.
			expect(config.url).toBe("https://api.example.com/items");
			expect(config.method).toBe("GET");
		} else {
			throw new Error("expected config.type to narrow to \"api\"");
		}

		// A pre-PR-3 config with no `type` at all still satisfies ApiSourceConfig (optional field) —
		// existing persisted sources without a type keep loading as before this PR.
		const legacyApiSource: ApiSourceConfig = {
			url: "https://legacy.example.com/items",
			method: "GET",
			mapping: { idField: "id", labelField: "name" },
			mode: "merge",
		};
		expect(legacyApiSource.type).toBeUndefined();

		// The stub sibling shapes carry only their own discriminant, as this PR intentionally leaves
		// them with no real config — PR-4 through PR-8 grow these into full shapes.
		const folderStub: DataSourceConfig = { type: "folder" };
		const tableStub: DataSourceConfig = { type: "markdown-table" };
		const csvStub: DataSourceConfig = { type: "csv" };
		expect(folderStub.type).toBe("folder");
		expect(tableStub.type).toBe("markdown-table");
		expect(csvStub.type).toBe("csv");
	});
});

describe("PR-1.F1 — parseUnitRefKey: the inverse of unitRefKey", () => {
	it("round-trips a file ref", () => {
		const ref: UnitRef = { kind: "file", path: "Quarry drones.md" };
		expect(parseUnitRefKey(unitRefKey(ref))).toEqual(ref);
	});

	it("round-trips a folder ref", () => {
		const ref: UnitRef = { kind: "folder", path: "Projects" };
		expect(parseUnitRefKey(unitRefKey(ref))).toEqual(ref);
	});

	it("round-trips a block ref", () => {
		const ref: UnitRef = { kind: "block", path: "Ideas.md", subpath: "^abc123" };
		expect(parseUnitRefKey(unitRefKey(ref))).toEqual(ref);
	});

	it("round-trips a path with special characters (selector/regex metacharacters)", () => {
		const ref: UnitRef = { kind: "file", path: 'Draft [v2] "final".md' };
		expect(parseUnitRefKey(unitRefKey(ref))).toEqual(ref);
	});

	it("returns null for an unrecognised kind, a key with no colon, and a block key with no #", () => {
		expect(parseUnitRefKey("widget:foo")).toBeNull();
		expect(parseUnitRefKey("no-colon-here")).toBeNull();
		expect(parseUnitRefKey("block:Ideas.md")).toBeNull();
	});

	it("R4: round-trips a block ref whose path itself contains '#' — must split at the last '#', not the first", () => {
		const ref: UnitRef = { kind: "block", path: "Draft #1.md", subpath: "^abc" };
		const key = unitRefKey(ref);
		expect(key).toBe("block:Draft #1.md#^abc");
		// The first '#' in the key belongs to the path, not the path/subpath separator — splitting
		// there (the pre-fix bug) would misparse to path "Draft " + subpath "1.md#^abc".
		expect(parseUnitRefKey(key)).toEqual(ref);
	});

	it("R5: a block key whose subpath itself contains '#' (a nested-heading link, [[Ideas#H1#H2]]) is inherently ambiguous to split blindly — this is a known limitation, not a round-trip guarantee", () => {
		const ref: UnitRef = { kind: "block", path: "Ideas.md", subpath: "H1#H2" };
		const key = unitRefKey(ref);
		expect(key).toBe("block:Ideas.md#H1#H2");
		// Splitting at the last '#' (this function's choice) reads this as path "Ideas.md#H1" +
		// subpath "H2" — the wrong half of the ambiguity, by design: neither split position is
		// correct for both this case and R4's "Draft #1.md" case, so this function alone doesn't
		// round-trip a key like this. Callers that need the real answer (updateActiveHighlight,
		// rewriteRefKeyPath) settle it with their own extra context instead — see types.ts's comment.
		expect(parseUnitRefKey(key)).toEqual({ kind: "block", path: "Ideas.md#H1", subpath: "H2" });
	});
});

describe("PR-1.F1/R5 — rewriteRefKeyPath: settles the block path/subpath boundary via the known oldPath, not a blind '#' split", () => {
	it("rewrites a plain block key on an exact file rename", () => {
		expect(rewriteRefKeyPath("block:Ideas.md#^abc", "Ideas.md", "Renamed.md")).toBe("block:Renamed.md#^abc");
	});

	it("R4: still rewrites a block key whose path contains '#' ('Draft #1.md')", () => {
		expect(rewriteRefKeyPath("block:Draft #1.md#^abc", "Draft #1.md", "Renamed.md")).toBe("block:Renamed.md#^abc");
	});

	it("R5: rewrites a block key whose subpath itself contains '#' (a nested-heading link) — the bug this guards against", () => {
		// Splitting at the last '#' (the R4-era behaviour) would read the path as 'Ideas.md#H1' and
		// never match 'Ideas.md', leaving the key unrewritten. Matching `oldPath` by prefix instead
		// gets this right regardless of how many '#'s the subpath holds.
		expect(rewriteRefKeyPath("block:Ideas.md#H1#H2", "Ideas.md", "Renamed.md")).toBe("block:Renamed.md#H1#H2");
	});

	it("rewrites a block key for a descendant of a renamed folder", () => {
		expect(rewriteRefKeyPath("block:Projects/Ideas.md#H1#H2", "Projects", "Archive")).toBe("block:Archive/Ideas.md#H1#H2");
	});

	it("leaves a block key untouched when its path neither equals nor descends from oldPath", () => {
		expect(rewriteRefKeyPath("block:Other.md#^abc", "Ideas.md", "Renamed.md")).toBe("block:Other.md#^abc");
	});

	it("leaves a file/folder key's existing behaviour unchanged", () => {
		expect(rewriteRefKeyPath("file:Projects/a.md", "Projects", "Archive")).toBe("file:Archive/a.md");
		expect(rewriteRefKeyPath("folder:Projects", "Projects", "Archive")).toBe("folder:Archive");
	});
});
