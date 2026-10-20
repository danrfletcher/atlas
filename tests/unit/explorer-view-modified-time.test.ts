/** PR-1 (G9): `AtlasExplorerView.modifiedTimeForRef` — the real file-mtime lookup `sortMode:
 * "modified"` uses, exercised directly against the real (mocked) vault rather than stubbed out,
 * since this is the behavior under test. */
import { describe, expect, it } from "vitest";
import { App, TFile, TFolder } from "../../tests/mocks/obsidian";
import { AtlasExplorerView } from "../../src/explorer-view";
import { DEFAULT_SETTINGS } from "../../src/settings";
import type { UnitRef } from "../../src/types";

const proto = AtlasExplorerView.prototype as unknown as { modifiedTimeForRef: (ref: UnitRef) => number | null };

function fakeFor(app: App) {
	return { plugin: { app, settings: DEFAULT_SETTINGS } };
}

describe("PR-1 G9 — modifiedTimeForRef", () => {
	it("a file ref returns its own file's mtime", () => {
		const app = new App();
		const file = app.vault.seedFile("Note.md");
		file.stat.mtime = 12345;
		expect(proto.modifiedTimeForRef.call(fakeFor(app), { kind: "file", path: "Note.md" })).toBe(12345);
	});

	it("a block ref returns the mtime of the file it lives in", () => {
		const app = new App();
		const file = app.vault.seedFile("Note.md");
		file.stat.mtime = 999;
		expect(proto.modifiedTimeForRef.call(fakeFor(app), { kind: "block", path: "Note.md", subpath: "^abc" })).toBe(999);
	});

	it("a folder ref with an interface note returns the note's own mtime, not the folder itself", () => {
		const app = new App();
		app.vault.seedFolder("Project");
		const note = app.vault.seedFile("Project/Project.md");
		note.stat.mtime = 777;
		expect(proto.modifiedTimeForRef.call(fakeFor(app), { kind: "folder", path: "Project" })).toBe(777);
	});

	it("a folder ref with no interface note returns null — \"no time\" (G9)", () => {
		const app = new App();
		app.vault.seedFolder("Project");
		expect(proto.modifiedTimeForRef.call(fakeFor(app), { kind: "folder", path: "Project" })).toBeNull();
	});

	it("a ref that no longer resolves to a real vault file returns null", () => {
		const app = new App();
		expect(proto.modifiedTimeForRef.call(fakeFor(app), { kind: "file", path: "Gone.md" })).toBeNull();
	});

	it("a folder path that resolves to a file, not a TFolder, returns null rather than throwing", () => {
		const app = new App();
		app.vault.seedFile("NotAFolder");
		expect(proto.modifiedTimeForRef.call(fakeFor(app), { kind: "folder", path: "NotAFolder" })).toBeNull();
	});
});

// Keep TFile/TFolder imported so a future reader can see exactly which mock types this exercises.
void TFile;
void TFolder;
