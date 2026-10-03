import { describe, expect, it } from "vitest";
import { App } from "obsidian";
import AtlasPlugin from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
import { ViewsManager } from "../../src/views";
import { StatusesManager } from "../../src/statuses";
import type { AddedItem, UnitRef } from "../../src/types";

/** Bypasses `AtlasPlugin`'s constructor (which needs a real Obsidian `app`/`manifest`) so these
 * tests can call `loadFromData`/`persistNow` directly against a minimal stub, per R1. */
function makePlugin(): AtlasPlugin {
	return Object.create(AtlasPlugin.prototype) as AtlasPlugin;
}

describe("AtlasPlugin.loadFromData", () => {
	it("loads a data.json missing dismissedByView/dismissedGlobal/addedItems without throwing, defaulting to empty", () => {
		const plugin = makePlugin();
		// Shaped like a pre-PR-2 data.json (tests/fixtures/data-v0.2.1.json): the three new fields
		// are entirely absent, not just empty.
		const preExistingData = {
			settings: DEFAULT_SETTINGS,
			manualPromotions: [],
			views: [],
			activeViewId: "default",
			expandedModuleFolders: [],
			statusSets: [],
			colorPalette: ["#ff0000"],
		};

		expect(() => (plugin as unknown as { loadFromData(d: unknown): void }).loadFromData(preExistingData)).not.toThrow();

		const loaded = plugin as unknown as { dismissedByView: unknown; dismissedGlobal: unknown; addedItems: unknown };
		expect(loaded.dismissedByView).toEqual({});
		expect(loaded.dismissedGlobal).toEqual([]);
		expect(loaded.addedItems).toEqual([]);
	});
});

describe("AtlasPlugin.persistNow", () => {
	it("includes dismissedByView, dismissedGlobal and addedItems in the saved shape", async () => {
		const plugin = makePlugin();
		const app = new App();
		const ref: UnitRef = { kind: "file", path: "Foo.md" };
		const addedItem: AddedItem = { ref, tag: "added" };
		const unitIndex = new UnitIndex(app, DEFAULT_SETTINGS, [], { v1: [ref] }, [], [addedItem]);
		const viewsManager = new ViewsManager(app, [], "default", () => {});
		const statusesManager = new StatusesManager([], [], () => {});

		const saved: unknown[] = [];
		Object.assign(plugin, {
			settings: DEFAULT_SETTINGS,
			unitIndex,
			viewsManager,
			statusesManager,
			expandedModuleFolders: new Set<string>(),
			saveData: async (data: unknown) => {
				saved.push(data);
			},
		});

		await (plugin as unknown as { persistNow(): Promise<void> }).persistNow();

		expect(saved).toHaveLength(1);
		const data = saved[0] as { dismissedByView: unknown; dismissedGlobal: unknown; addedItems: unknown };
		expect(data.dismissedByView).toEqual({ v1: [ref] });
		expect(data.dismissedGlobal).toEqual([]);
		expect(data.addedItems).toEqual([addedItem]);
	});
});
