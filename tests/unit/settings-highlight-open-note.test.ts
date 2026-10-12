import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import AtlasPlugin from "../../src/main";
import { DEFAULT_SETTINGS, normalizeHighlightOpenNote } from "../../src/settings";

/** Bypasses `AtlasPlugin`'s constructor (which needs a real Obsidian `app`/`manifest`) so these
 * tests can call `loadFromData` directly against a minimal stub, per the pattern already used in
 * `tests/unit/main-persistence.test.ts`. */
function makePlugin(): AtlasPlugin {
	return Object.create(AtlasPlugin.prototype) as AtlasPlugin;
}

function loadFromData(plugin: AtlasPlugin, data: unknown): void {
	(plugin as unknown as { loadFromData(d: unknown): void }).loadFromData(data);
}

function settingsOf(plugin: AtlasPlugin): { highlightOpenNote: unknown } {
	return (plugin as unknown as { settings: { highlightOpenNote: unknown } }).settings;
}

describe("PR-1.F2 — DEFAULT_SETTINGS.highlightOpenNote", () => {
	it("defaults to true", () => {
		expect(DEFAULT_SETTINGS.highlightOpenNote).toBe(true);
	});
});

describe("PR-1.F2 — AtlasPlugin.loadFromData / highlightOpenNote", () => {
	it("a data.json whose settings object lacks the key loads as on (Object.assign against DEFAULT_SETTINGS)", () => {
		const plugin = makePlugin();
		loadFromData(plugin, { settings: { poolFolder: "_pool" } });
		expect(settingsOf(plugin).highlightOpenNote).toBe(true);
	});

	it("a data.json with no settings object at all loads as on", () => {
		const plugin = makePlugin();
		loadFromData(plugin, {});
		expect(settingsOf(plugin).highlightOpenNote).toBe(true);
	});

	it("a stored false loads as off", () => {
		const plugin = makePlugin();
		loadFromData(plugin, { settings: { poolFolder: "_pool", highlightOpenNote: false } });
		expect(settingsOf(plugin).highlightOpenNote).toBe(false);
	});

	it("a stored true loads as on", () => {
		const plugin = makePlugin();
		loadFromData(plugin, { settings: { poolFolder: "_pool", highlightOpenNote: true } });
		expect(settingsOf(plugin).highlightOpenNote).toBe(true);
	});

	it("tests/fixtures/data-v0.2.1.json (no highlightOpenNote key at all) loads as on, with no migration", () => {
		const plugin = makePlugin();
		const fixture = JSON.parse(readFileSync(join(__dirname, "../fixtures/data-v0.2.1.json"), "utf8"));
		expect(fixture.settings.highlightOpenNote).toBeUndefined(); // the fixture predates this key
		loadFromData(plugin, fixture);
		expect(settingsOf(plugin).highlightOpenNote).toBe(true);
	});

	it.each([
		["the string \"yes\"", "yes"],
		["the number 0", 0],
		["null", null],
	] as const)("a hand-edited non-boolean value (%s) does not throw and falls back to the default (on)", (_label, raw) => {
		const plugin = makePlugin();
		expect(() => loadFromData(plugin, { settings: { poolFolder: "_pool", highlightOpenNote: raw } })).not.toThrow();
		expect(settingsOf(plugin).highlightOpenNote).toBe(true);
	});
});

describe("PR-1.F2 — normalizeHighlightOpenNote", () => {
	it("passes real booleans through unchanged", () => {
		expect(normalizeHighlightOpenNote(true)).toBe(true);
		expect(normalizeHighlightOpenNote(false)).toBe(false);
	});

	it("falls back to true for anything that isn't a boolean", () => {
		expect(normalizeHighlightOpenNote("yes")).toBe(true);
		expect(normalizeHighlightOpenNote(0)).toBe(true);
		expect(normalizeHighlightOpenNote(null)).toBe(true);
		expect(normalizeHighlightOpenNote(undefined)).toBe(true);
	});
});
