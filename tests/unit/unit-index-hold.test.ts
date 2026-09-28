import { describe, expect, it, vi } from "vitest";
import { App } from "obsidian";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
import { seedRoot } from "../helpers";

function makeIndex(): { app: App; index: UnitIndex } {
	const app = new App();
	seedRoot(app, ["Existing.md"], ["Folder"]);
	const index = new UnitIndex(app, { ...DEFAULT_SETTINGS }, []);
	index.rebuild();
	return { app, index };
}
const paths = (index: UnitIndex) => index.getUnits().map((u) => u.path).sort();

describe("UnitIndex.holdUnit", () => {
	it("hides the unit until released, then lists it and tells listeners once", () => {
		const { index } = makeIndex();
		const listener = vi.fn();
		index.onChange(listener);
		const release = index.holdUnit("Folder");
		expect(paths(index)).toEqual(["Existing.md"]);
		expect(listener).not.toHaveBeenCalled();
		release();
		release();
		expect(paths(index)).toEqual(["Existing.md", "Folder"]);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("keeps updating from vault events while held (a folder created under hold shows on release)", async () => {
		const { app, index } = makeIndex();
		app.vault.on("create", (f) => index.onVaultCreate(f));
		const release = index.holdUnit("New");
		await app.vault.createFolder("New");
		expect(paths(index)).not.toContain("New");
		release();
		expect(paths(index)).toContain("New");
	});

	it("overlapping holds on one path stay hidden until every one is released", () => {
		const { index } = makeIndex();
		const a = index.holdUnit("Folder");
		const b = index.holdUnit("Folder");
		a();
		expect(paths(index)).not.toContain("Folder");
		b();
		expect(paths(index)).toContain("Folder");
	});
});
