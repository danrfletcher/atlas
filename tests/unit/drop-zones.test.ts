/** PR-3 (G1/G2/G20/Q7): the pure drop-zone maths, isolated from the DOM — covers the 25/50/25
 * split, the expanded-row-with-no-bottom-zone exception, and the boundary/degenerate cases the
 * spec calls out explicitly. */
import { describe, expect, it } from "vitest";
import { DropDecision, resolveDropDecision, resolveDropZone } from "../../src/drop-zones";
import { EffectiveSort } from "../../src/sort";

describe("PR-3 G1/G2 — the plain 25/50/25 split (hasBottomZone: true)", () => {
	it("below 25% is before", () => {
		expect(resolveDropZone(0, 100, true)).toBe("before");
		expect(resolveDropZone(24, 100, true)).toBe("before");
	});

	it("25% to 75% inclusive is nest", () => {
		expect(resolveDropZone(25, 100, true)).toBe("nest");
		expect(resolveDropZone(50, 100, true)).toBe("nest");
		expect(resolveDropZone(75, 100, true)).toBe("nest");
	});

	it("above 75% is after", () => {
		expect(resolveDropZone(76, 100, true)).toBe("after");
		expect(resolveDropZone(100, 100, true)).toBe("after");
	});
});

describe("PR-3 G1/Q7 — an expanded row with children has no bottom-edge zone: after is replaced by nest", () => {
	it("above 75% resolves to nest, not after, when hasBottomZone is false", () => {
		expect(resolveDropZone(76, 100, false)).toBe("nest");
		expect(resolveDropZone(100, 100, false)).toBe("nest");
	});

	it("below 25% is still before regardless of hasBottomZone (only the bottom zone is affected)", () => {
		expect(resolveDropZone(0, 100, false)).toBe("before");
		expect(resolveDropZone(24, 100, false)).toBe("before");
	});

	it("the 25%-75% band is unaffected by hasBottomZone", () => {
		expect(resolveDropZone(50, 100, false)).toBe("nest");
	});
});

describe("PR-3 — collapsed rows and childless rows keep the bottom-edge zone (hasBottomZone: true is the caller's job to pass correctly, this just confirms the true branch behaves)", () => {
	it("hasBottomZone true still yields after above 75%", () => {
		expect(resolveDropZone(90, 100, true)).toBe("after");
	});
});

describe("PR-3 — boundaries: 0, 25, 75 and 100 percent", () => {
	it.each([
		[0, "before"],
		[25, "nest"],
		[74.999, "nest"],
		[75, "nest"],
		[75.001, "after"],
		[100, "after"],
	] as const)("offset %s%% of a 100px row resolves to %s", (pct, expected) => {
		expect(resolveDropZone(pct, 100, true)).toBe(expected);
	});

	it("is deterministic across repeated calls with the exact same inputs", () => {
		const results = new Set<string>();
		for (let i = 0; i < 5; i++) results.add(resolveDropZone(25, 100, true));
		expect(results.size).toBe(1);
		for (let i = 0; i < 5; i++) results.add(resolveDropZone(75, 100, true));
	});
});

describe("PR-3 — a very short row height", () => {
	it("a 4px row still splits deterministically at its own 25%/75%", () => {
		expect(resolveDropZone(0, 4, true)).toBe("before");
		expect(resolveDropZone(0.9, 4, true)).toBe("before"); // < 1 (25% of 4)
		expect(resolveDropZone(1, 4, true)).toBe("nest");
		expect(resolveDropZone(2, 4, true)).toBe("nest");
		expect(resolveDropZone(3, 4, true)).toBe("nest");
		expect(resolveDropZone(3.1, 4, true)).toBe("after"); // > 3 (75% of 4)
	});

	it("a 1px row resolves every offset deterministically", () => {
		expect(resolveDropZone(0, 1, true)).toBe("before");
		expect(resolveDropZone(0.5, 1, true)).toBe("nest");
		expect(resolveDropZone(1, 1, true)).toBe("after");
	});

	it("a zero-height row never throws and resolves deterministically", () => {
		expect(() => resolveDropZone(0, 0, true)).not.toThrow();
		expect(resolveDropZone(0, 0, true)).toBe(resolveDropZone(0, 0, true));
	});
});

// PR-4 (G4/G5/G22): resolveDropDecision -- the pure function a sorted-folder edge/nest drop
// reduces to, given the zone, the drag's source parent, the target's parent, and the target
// list's own effective sort. Covers the spec's own three rules directly, independent of any DOM
// or ViewsManager plumbing (that end-to-end wiring lives in explorer-view.test.ts instead).
describe("PR-4 G4/G5/G22 — resolveDropDecision: the pure sorted-drop decision table", () => {
	const SORTS: EffectiveSort[] = [
		{ mode: "alphabetical", reverse: false },
		{ mode: "alphabetical", reverse: true },
		{ mode: "modified", reverse: false },
		{ mode: "modified", reverse: true },
		{ mode: "time-added", reverse: false },
		{ mode: "time-added", reverse: true },
		{ mode: "status", reverse: false },
		{ mode: "status", reverse: true },
	];

	it("a middle (nest) zone always nests, regardless of sort, source or target parent", () => {
		for (const sort of [...SORTS, null]) {
			expect(resolveDropDecision("nest", "a", "a", sort)).toBe<DropDecision>("nest");
			expect(resolveDropDecision("nest", "a", "b", sort)).toBe<DropDecision>("nest");
			expect(resolveDropDecision("nest", undefined, null, sort)).toBe<DropDecision>("nest");
		}
	});

	it("an effectively-Manual target (null effectiveSort) always reorders on an edge zone, regardless of source parent", () => {
		expect(resolveDropDecision("before", "folder", "folder", null)).toBe<DropDecision>("reorder");
		expect(resolveDropDecision("after", "folder", "folder", null)).toBe<DropDecision>("reorder");
		expect(resolveDropDecision("before", undefined, "folder", null)).toBe<DropDecision>("reorder");
		expect(resolveDropDecision("before", "other", "folder", null)).toBe<DropDecision>("reorder");
		expect(resolveDropDecision("before", null, null, null)).toBe<DropDecision>("reorder"); // the Bucket root, Manual
	});

	it("refuses an edge zone when the source parent equals the target parent, under every sorted mode and direction", () => {
		for (const sort of SORTS) {
			expect(resolveDropDecision("before", "folder", "folder", sort)).toBe<DropDecision>("refuse");
			expect(resolveDropDecision("after", "folder", "folder", sort)).toBe<DropDecision>("refuse");
		}
	});

	it("refuses an edge zone at the sorted Bucket root (both parents null) the same way as any sorted Folder", () => {
		expect(resolveDropDecision("before", null, null, { mode: "alphabetical", reverse: false })).toBe<DropDecision>("refuse");
	});

	it("gives sorted-insert for an edge zone from any other parent (a different folder, or undefined for the inbox/a mixed batch with no in-folder row), under every sorted mode", () => {
		for (const sort of SORTS) {
			expect(resolveDropDecision("before", "elsewhere", "folder", sort)).toBe<DropDecision>("sorted-insert");
			expect(resolveDropDecision("after", undefined, "folder", sort)).toBe<DropDecision>("sorted-insert"); // e.g. the Inbox
			expect(resolveDropDecision("before", null, "folder", sort)).toBe<DropDecision>("sorted-insert"); // dragged up out of the Bucket root
			expect(resolveDropDecision("before", "folder", null, sort)).toBe<DropDecision>("sorted-insert"); // dragged up into the sorted Bucket root
		}
	});

	it("explicit Manual (effectiveSort null) always reorders even when dragged within the exact same sorted-looking ids, since the caller never passes a sorted effectiveSort for it", () => {
		// activeSortFor's own "explicit Manual overrides an inherited status sort" rule (sort.ts)
		// is what ever produces a null effectiveSort here for a governed folder -- resolveDropDecision
		// itself only ever sees the already-resolved EffectiveSort, so this just pins that a null
		// input (whatever produced it) reorders, not refuses.
		expect(resolveDropDecision("before", "folder", "folder", null)).toBe<DropDecision>("reorder");
	});
});
