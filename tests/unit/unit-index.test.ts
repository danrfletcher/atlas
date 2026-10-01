import { describe, expect, it } from "vitest";
import { App, TFile } from "obsidian";
import type { CachedMetadata } from "obsidian";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
import { seedRoot } from "../helpers";
import type { UnitRef } from "../../src/types";

/** Wires `getFileCache`/`getFirstLinkpathDest` so `computePromotions()`'s link-scanning loop sees
 * exactly the caches and resolved destinations given here, independent of path-resolution rules. */
function stubLinks(
	app: App,
	caches: Record<string, CachedMetadata>,
	resolve: Record<string, string>, // linkpath -> resolved destPath
): void {
	app.metadataCache.getFileCache = ((file: TFile) => caches[file.path] ?? null) as App["metadataCache"]["getFileCache"];
	app.metadataCache.getFirstLinkpathDest = ((linkpath: string) => {
		const destPath = resolve[linkpath];
		return destPath ? (app.vault.getAbstractFileByPath(destPath) as TFile) : null;
	}) as App["metadataCache"]["getFirstLinkpathDest"];
}

function makeIndex(
	files: string[],
	folders: string[],
	caches: Record<string, CachedMetadata>,
	resolve: Record<string, string>,
	manualPromotions: UnitRef[] = [],
): { app: App; index: UnitIndex } {
	const app = new App();
	seedRoot(app, files, folders);
	stubLinks(app, caches, resolve);
	const index = new UnitIndex(app, { ...DEFAULT_SETTINGS }, manualPromotions);
	index.rebuild();
	return { app, index };
}

const promotedBlockPaths = (index: UnitIndex) =>
	index
		.getUnits()
		.filter((u) => u.type === "promoted-block")
		.map((u) => `${u.path}#${(u as { subpath: string }).subpath}`)
		.sort();

const promotedFilePaths = (index: UnitIndex) =>
	index
		.getUnits()
		.filter((u) => u.type === "promoted-file")
		.map((u) => u.path)
		.sort();

const promotedFolderPaths = (index: UnitIndex) =>
	index
		.getUnits()
		.filter((u) => u.type === "promoted-folder")
		.map((u) => u.path)
		.sort();

describe("UnitIndex.computePromotions — block/heading references (bug 1, E5/E5a)", () => {
	it("E5: a block reference from inside the same top-level module does not promote the block", () => {
		const { index } = makeIndex(
			["ModuleA/Source.md", "ModuleA/Other.md"],
			["ModuleA"],
			{
				"ModuleA/Source.md": {
					links: [{ link: "Other#^abc123", original: "[[Other#^abc123]]" } as never],
				},
			},
			{ Other: "ModuleA/Other.md" },
		);
		expect(promotedBlockPaths(index)).toEqual([]);
	});

	it("E5a: a block reference from a different top-level module still promotes the block", () => {
		const { index } = makeIndex(
			["ModuleA/Source.md", "ModuleB/Other.md"],
			["ModuleA", "ModuleB"],
			{
				"ModuleA/Source.md": {
					links: [{ link: "Other#^abc123", original: "[[Other#^abc123]]" } as never],
				},
			},
			{ Other: "ModuleB/Other.md" },
		);
		expect(promotedBlockPaths(index)).toEqual(["ModuleB/Other.md#^abc123"]);
	});
});

describe("UnitIndex.computePromotions — plain markdown links (bug 2, E6/E6a)", () => {
	it("E6: a plain markdown link from inside the same top-level module does not promote the file", () => {
		const { index } = makeIndex(
			["ModuleA/Source.md", "ModuleA/Other.md"],
			["ModuleA"],
			{
				"ModuleA/Source.md": {
					links: [{ link: "Other.md", original: "[text](Other.md)", displayText: "text" } as never],
				},
			},
			{ "Other.md": "ModuleA/Other.md" },
		);
		expect(promotedFilePaths(index)).toEqual([]);
	});

	it("E6a: a plain markdown link from a different top-level module still promotes the file", () => {
		const { index } = makeIndex(
			["ModuleA/Source.md", "ModuleB/Other.md"],
			["ModuleA", "ModuleB"],
			{
				"ModuleA/Source.md": {
					links: [{ link: "Other.md", original: "[text](Other.md)", displayText: "text" } as never],
				},
			},
			{ "Other.md": "ModuleB/Other.md" },
		);
		expect(promotedFilePaths(index)).toEqual(["ModuleB/Other.md"]);
	});
});

describe("UnitIndex.computePromotions — fence regressions", () => {
	it("F5: topLevelFolderFor/isExcluded behavior (as observed via promotion results) is unchanged — cross-module file link still promotes, root-level link never promotes", () => {
		const { index } = makeIndex(
			["Root.md", "ModuleA/Source.md", "ModuleB/Target.md"],
			["ModuleA", "ModuleB"],
			{
				"ModuleA/Source.md": {
					links: [{ link: "Target", original: "[[Target]]" } as never],
				},
				"Root.md": {
					links: [{ link: "Target", original: "[[Target]]" } as never],
				},
			},
			{ Target: "ModuleB/Target.md" },
		);
		// Root.md is at vault root (topLevelFolderFor -> null for the source), so its own module
		// status doesn't matter; what F5 checks is that the target's module is still correctly
		// derived and distinct from "no module" / "root" cases.
		expect(promotedFilePaths(index)).toEqual(["ModuleB/Target.md"]);
	});

	it("interface-note promotion is unaffected by either fix — still only reached via the subpath-less branch, after the module check", () => {
		// The linked interface note (`Sub/Sub.md`) is nested inside ModuleA, distinct from ModuleA
		// itself, so promoting it (as a folder) is observable — unlike linking a module's own
		// top-level interface note, which is already a base folder-unit and promotes nothing.
		const { index } = makeIndex(
			["ModuleB/Source.md", "ModuleA/Sub/Sub.md"],
			["ModuleA", "ModuleB", "ModuleA/Sub"],
			{
				"ModuleB/Source.md": {
					links: [{ link: "Sub", original: "[[Sub]]" } as never],
				},
			},
			{ Sub: "ModuleA/Sub/Sub.md" },
		);
		expect(promotedFolderPaths(index)).toEqual(["ModuleA/Sub"]);
		expect(promotedFilePaths(index)).toEqual([]);
	});

	it("manual promotions are unaffected by module — they bypass the link-scanning loop entirely", () => {
		const { index } = makeIndex(
			["ModuleA/Source.md", "ModuleA/Other.md"],
			["ModuleA"],
			{},
			{},
			[{ kind: "file", path: "ModuleA/Other.md" }],
		);
		expect(promotedFilePaths(index)).toEqual(["ModuleA/Other.md"]);
	});
});
