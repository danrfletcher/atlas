import { describe, expect, it } from "vitest";
import { App } from "obsidian";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
import { seedRoot } from "../helpers";
import type { AddedItem, UnitRef } from "../../src/types";

function makeIndex(
	files: string[],
	folders: string[] = [],
	manualPromotions: UnitRef[] = [],
	dismissedByView: Record<string, UnitRef[]> = {},
	dismissedGlobal: UnitRef[] = [],
	addedItems: AddedItem[] = [],
): { app: App; index: UnitIndex } {
	const app = new App();
	seedRoot(app, files, folders);
	const index = new UnitIndex(app, DEFAULT_SETTINGS, manualPromotions, dismissedByView, dismissedGlobal, addedItems);
	index.rebuild();
	return { app, index };
}

/** Mirrors what `main.ts` wires on load: dismiss/added paths move in lockstep with manual promotions. */
function wireRename(app: App, index: UnitIndex): void {
	app.vault.on("rename", (f, oldPath) => index.onVaultRename(f, oldPath));
}

const file = (path: string): UnitRef => ({ kind: "file", path });

describe("UnitIndex dismiss/added-state — round trip", () => {
	it("dismissing a path view-scope reads true for that view and false for global", () => {
		const { index } = makeIndex(["Foo.md"]);
		const ref = file("Foo.md");
		index.setDismissed(ref, "view", true, "v1");
		expect(index.isDismissed(ref, "view", "v1")).toBe(true);
		expect(index.isDismissed(ref, "global")).toBe(false);
	});

	it("dismissing a path globally reads as dismissed from every view's perspective without a per-view entry", () => {
		const { index } = makeIndex(["Foo.md"]);
		const ref = file("Foo.md");
		index.setDismissed(ref, "global", true);
		expect(index.isDismissed(ref, "view", "v1")).toBe(true);
		expect(index.isDismissed(ref, "view", "some-other-view")).toBe(true);
		expect(index.isDismissed(ref, "global")).toBe(true);
		// The "one global entry, not enumerated per view" shape, asserted directly on the persisted structure.
		expect(index.getDismissedByView()).toEqual({});
		expect(index.getDismissedGlobal()).toEqual([ref]);
	});

	it("un-dismissing removes the entry rather than leaving a false-valued one", () => {
		const { index } = makeIndex(["Foo.md"]);
		const ref = file("Foo.md");
		index.setDismissed(ref, "view", true, "v1");
		index.setDismissed(ref, "view", false, "v1");
		expect(index.isDismissed(ref, "view", "v1")).toBe(false);
		expect(index.getDismissedByView()).toEqual({});
	});

	it("marking a path added is readable via isAdded and tagged \"added\", distinguishable from a manual promotion", () => {
		const { index } = makeIndex(["Foo.md"], [], [file("Foo.md")]);
		const ref = file("Foo.md");
		index.markAdded(ref);
		expect(index.isAdded(ref)).toBe(true);
		expect(index.getAddedItems()).toEqual([{ ref, tag: "added" }]);
		// Same path has both a manualPromotions entry and an addedItems entry; the two collections stay distinct.
		expect(index.getManualPromotions()).toEqual([ref]);
	});

	it("marking an already-added path again is a no-op (no duplicate entries)", () => {
		const { index } = makeIndex(["Foo.md"]);
		const ref = file("Foo.md");
		index.markAdded(ref);
		index.markAdded(ref);
		expect(index.getAddedItems()).toEqual([{ ref, tag: "added" }]);
	});
});

describe("UnitIndex dismiss/added-state — E2 rename", () => {
	it("renaming a view-scope dismissed file rewrites the entry to the new path", async () => {
		const { app, index } = makeIndex(["Foo.md"]);
		wireRename(app, index);
		index.setDismissed(file("Foo.md"), "view", true, "v1");

		const entry = app.vault.getAbstractFileByPath("Foo.md")!;
		await app.vault.rename(entry, "Bar.md");

		expect(index.isDismissed(file("Bar.md"), "view", "v1")).toBe(true);
		expect(index.isDismissed(file("Foo.md"), "view", "v1")).toBe(false);
	});

	it("renaming a globally-dismissed file rewrites the global entry, and renaming an added file rewrites its marker", async () => {
		const { app, index } = makeIndex(["Foo.md", "Added.md"]);
		wireRename(app, index);
		index.setDismissed(file("Foo.md"), "global", true);
		index.markAdded(file("Added.md"));

		await app.vault.rename(app.vault.getAbstractFileByPath("Foo.md")!, "Bar.md");
		await app.vault.rename(app.vault.getAbstractFileByPath("Added.md")!, "AddedRenamed.md");

		expect(index.isDismissed(file("Bar.md"), "global")).toBe(true);
		expect(index.isDismissed(file("Foo.md"), "global")).toBe(false);
		expect(index.isAdded(file("AddedRenamed.md"))).toBe(true);
		expect(index.isAdded(file("Added.md"))).toBe(false);
	});

	it("renaming a folder containing a dismissed file reflects the new folder prefix", async () => {
		const { app, index } = makeIndex(["ModuleA/Inside.md"], ["ModuleA"]);
		wireRename(app, index);
		index.setDismissed(file("ModuleA/Inside.md"), "view", true, "v1");

		await app.vault.rename(app.vault.getAbstractFileByPath("ModuleA")!, "ModuleB");

		expect(index.isDismissed(file("ModuleB/Inside.md"), "view", "v1")).toBe(true);
		expect(index.isDismissed(file("ModuleA/Inside.md"), "view", "v1")).toBe(false);
	});
});

describe("UnitIndex dismiss/added-state — E3 delete is inert", () => {
	it("deleting a dismissed path leaves its dismiss entry untouched and does not throw", () => {
		const { app, index } = makeIndex(["Foo.md"]);
		const ref = file("Foo.md");
		index.setDismissed(ref, "view", true, "v1");
		index.setDismissed(ref, "global", true);

		expect(() => index.onVaultDelete("Foo.md")).not.toThrow();

		expect(index.isDismissed(ref, "view", "v1")).toBe(true);
		expect(index.isDismissed(ref, "global")).toBe(true);
		expect(app.vault.calls).not.toContain("delete"); // onVaultDelete is the incremental-index handler, not a vault call
	});
});

describe("UnitIndex.getUnits() — added-file merge and dedup (PR-3 G3, E4)", () => {
	it("an added item for a path not covered by any other classification surfaces as an added-file unit", () => {
		const { index } = makeIndex(["Areas/Career/Notes.md"], ["Areas", "Areas/Career"], [], {}, [], [{ ref: file("Areas/Career/Notes.md"), tag: "added" }]);
		const added = index.getUnits().filter((u) => u.type === "added-file");
		expect(added).toEqual([{ type: "added-file", path: "Areas/Career/Notes.md" }]);
	});

	it("R3: an added item whose path is also a manual/auto-promoted unit is not duplicated — the \"added\" classification surfaces, not \"promoted\" (added is terminal, per spec edge case)", () => {
		const { index } = makeIndex(
			["ModuleA/Both.md"],
			["ModuleA"],
			[file("ModuleA/Both.md")],
			{},
			[],
			[{ ref: file("ModuleA/Both.md"), tag: "added" }],
		);
		const units = index.getUnits().filter((u) => u.path === "ModuleA/Both.md");
		expect(units).toHaveLength(1);
		expect(units[0].type).toBe("added-file");
	});

	it("an added item for a vault-root file (already a root-file unit) is not duplicated", () => {
		const { index } = makeIndex(["RootFile.md"], [], [], {}, [], [{ ref: file("RootFile.md"), tag: "added" }]);
		const units = index.getUnits().filter((u) => u.path === "RootFile.md");
		expect(units).toHaveLength(1);
		expect(units[0].type).toBe("root-file");
	});
});

describe("UnitIndex dismiss/added-state — F6 fence regression", () => {
	it("a dismiss/add/un-dismiss cycle never mutates manualPromotions", () => {
		const promotions = [file("Promoted.md")];
		const { index } = makeIndex(["Promoted.md", "Foo.md"], [], promotions);
		const before = index.getManualPromotions();
		const snapshot = JSON.parse(JSON.stringify(before));

		const ref = file("Foo.md");
		index.setDismissed(ref, "view", true, "v1");
		index.setDismissed(ref, "global", true);
		index.markAdded(ref);
		index.setDismissed(ref, "view", false, "v1");

		expect(index.getManualPromotions()).toBe(before);
		expect(index.getManualPromotions()).toEqual(snapshot);
	});
});
