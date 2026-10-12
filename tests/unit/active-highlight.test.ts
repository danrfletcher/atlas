import { describe, expect, it } from "vitest";
import { matchesActiveFile, ActiveHighlightQuery } from "../../src/active-highlight";
import { UnitRef } from "../../src/types";

/** PR-1.F1: table-driven coverage of `matchesActiveFile`, the matching rule extracted out of
 * `updateActiveHighlight`. Every row is a plain `ActiveHighlightQuery` -> expected boolean, so this
 * never touches the DOM, the App, or the real `findInterfaceNote` lookup. */

const fileRef = (path: string): UnitRef => ({ kind: "file", path });
const folderRef = (path: string): UnitRef => ({ kind: "folder", path });
const blockRef = (path: string, subpath: string): UnitRef => ({ kind: "block", path, subpath });

const base: ActiveHighlightQuery = {
	activeFilePath: null,
	ref: null,
	interfaceNotePath: null,
	isOutsideManaged: false,
};

describe("matchesActiveFile — PR-1.F1 matching rule", () => {
	it("G1: a file ref matches the open file by path", () => {
		expect(matchesActiveFile({ ...base, activeFilePath: "Quarry drones.md", ref: fileRef("Quarry drones.md") })).toBe(true);
	});

	it("G1: a file ref for a different path never matches", () => {
		expect(matchesActiveFile({ ...base, activeFilePath: "Notes.md", ref: fileRef("Quarry drones.md") })).toBe(false);
	});

	it("G3: a ref resolved from a Folder/Table/API item row's attachment matches the same way as a plain file row", () => {
		expect(matchesActiveFile({ ...base, activeFilePath: "Ideas.md", ref: fileRef("Ideas.md") })).toBe(true);
	});

	it("G4: a module (folder) ref matches only through its resolved interface note path, never its own folder path", () => {
		expect(
			matchesActiveFile({ ...base, activeFilePath: "Projects/Projects.md", ref: folderRef("Projects"), interfaceNotePath: "Projects/Projects.md" })
		).toBe(true);
		// The open note equals the folder's own path string (impossible in practice, but the rule
		// itself must never take that shortcut) — only the interface note path is compared.
		expect(matchesActiveFile({ ...base, activeFilePath: "Projects", ref: folderRef("Projects"), interfaceNotePath: "Projects/Projects.md" })).toBe(false);
	});

	it("G4/Added: a module with no interface note (null) never matches, and never throws", () => {
		expect(matchesActiveFile({ ...base, activeFilePath: "Projects/Projects.md", ref: folderRef("Projects"), interfaceNotePath: null })).toBe(false);
	});

	it("G5: a block ref matches on the file the block lives in, independent of its subpath", () => {
		expect(matchesActiveFile({ ...base, activeFilePath: "Ideas.md", ref: blockRef("Ideas.md", "^abc123") })).toBe(true);
		expect(matchesActiveFile({ ...base, activeFilePath: "Notes.md", ref: blockRef("Ideas.md", "^abc123") })).toBe(false);
	});

	it("G6: a row with no ref at all (a meta/Folder row) never matches", () => {
		expect(matchesActiveFile({ ...base, activeFilePath: "Notes.md", ref: null })).toBe(false);
	});

	it("F6: an Outside-Vault-managed row never matches, even when its path reads the same as the open vault note", () => {
		expect(matchesActiveFile({ ...base, activeFilePath: "Quarry drones.md", ref: fileRef("Quarry drones.md"), isOutsideManaged: true })).toBe(false);
	});

	it("F6: an Outside-Vault-managed module row never matches either, even with a resolved interface note path", () => {
		expect(
			matchesActiveFile({
				...base,
				activeFilePath: "Projects/Projects.md",
				ref: folderRef("Projects"),
				interfaceNotePath: "Projects/Projects.md",
				isOutsideManaged: true,
			})
		).toBe(false);
	});

	it("E1: the open note is in no view — never throws, just no match for any ref the view happens to hold", () => {
		expect(matchesActiveFile({ ...base, activeFilePath: "Untracked.md", ref: fileRef("Quarry drones.md") })).toBe(false);
	});

	it("E2: no file open at all (null path) never matches, regardless of ref", () => {
		expect(matchesActiveFile({ ...base, activeFilePath: null, ref: fileRef("Quarry drones.md") })).toBe(false);
	});

	it("E8: a non-markdown open file (image/PDF/canvas) matches the same way as a note, by plain path equality", () => {
		expect(matchesActiveFile({ ...base, activeFilePath: "Scans/plan.pdf", ref: fileRef("Scans/plan.pdf") })).toBe(true);
		expect(matchesActiveFile({ ...base, activeFilePath: "Board.canvas", ref: fileRef("Board.canvas") })).toBe(true);
	});

	it("Added: a path with regex/selector characters matches by plain string equality, no escaping needed", () => {
		const tricky = 'Draft [v2] "final" #1.md';
		expect(matchesActiveFile({ ...base, activeFilePath: tricky, ref: fileRef(tricky) })).toBe(true);
		expect(matchesActiveFile({ ...base, activeFilePath: tricky, ref: fileRef("Draft [v2] (not it).md") })).toBe(false);
	});

	it("R4/Added: a block ref matches on a path containing '#', the same way as any other path (the bug this guards against lives in parseUnitRefKey's own split, not here — see tests/unit/types.test.ts)", () => {
		const tricky = "Draft #1.md";
		expect(matchesActiveFile({ ...base, activeFilePath: tricky, ref: blockRef(tricky, "^abc") })).toBe(true);
		expect(matchesActiveFile({ ...base, activeFilePath: "Other.md", ref: blockRef(tricky, "^abc") })).toBe(false);
	});
});
