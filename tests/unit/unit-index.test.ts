import { describe, expect, it } from "vitest";
import { App, TFile } from "obsidian";
import type { CachedMetadata } from "obsidian";
import { DEFAULT_SETTINGS } from "../../src/settings";
import type { AtlasSettings } from "../../src/settings";
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
	settingsOverride: Partial<AtlasSettings> = {},
): { app: App; index: UnitIndex } {
	const app = new App();
	seedRoot(app, files, folders);
	stubLinks(app, caches, resolve);
	const index = new UnitIndex(app, { ...DEFAULT_SETTINGS, ...settingsOverride }, manualPromotions);
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

// R1/R2: "bug 2" was reported as a plain markdown link ([custom content type parsers]
// (./ContentTypeParser.md)) wrongly promoting its same-module target. Live CDP instrumentation
// against a real Obsidian 1.13.7 instance (vault: alnwick-3-vault, plugin: atlas-explorer) against
// the actual repro pair in agy-proxy/node_modules/fastify/docs/Reference/ confirmed:
//  - the real `cache.links` entry for that link is
//    { link: "./ContentTypeParser.md", original: "[custom content type parsers](./ContentTypeParser.md)",
//      displayText: "custom content type parsers" } — note the preserved "./" prefix on `link`,
//    which the previous E6/E6a mocks (bare "Other.md") didn't reflect.
//  - `getFirstLinkpathDest("./ContentTypeParser.md", sourcePath)` resolves correctly to
//    agy-proxy/.../ContentTypeParser.md; there is no resolution bug.
//  - with both the pre-bug-1-fix and post-bug-1-fix code, this exact link NEVER promoted
//    ContentTypeParser.md into `promotedFiles` — the plain-file branch's module check was always
//    correctly positioned ahead of the file-promotion logic, before this PR started.
//  - what DID reproduce, pre-fix only, was a *block* promotion: Server.md (same module) links
//    `[here](./ContentTypeParser.md#usage)` — a plain markdown link with a heading anchor, which
//    takes the subpath/block branch, not the plain-file branch. That's bug 1 (the subpath branch's
//    missing module check) manifesting through markdown-link-with-anchor syntax rather than the
//    `[[Note#^id]]` wikilink syntax E5 already covered — not an independent "bug 2" code path.
//    Bug 1's fix (reordering the module check ahead of the subpath branch) already suppresses it;
//    confirmed live by swapping the built plugin back to the post-fix commit and observing
//    `promotedBlocks` for ContentTypeParser.md drop from 1 entry (`#usage`) to 0.
// So GP2/E6's acceptance criterion (same-module plain link doesn't promote the file) was already
// met going into this PR; the tests below use the real `./`-prefixed link shape for both the
// plain-file case and the heading-anchor case that was the actual pre-fix regression.
describe("UnitIndex.computePromotions — plain markdown links (bug 2, E6/E6a)", () => {
	it("E6: a plain markdown link (real cache.links shape, './'-prefixed) from inside the same top-level module does not promote the file", () => {
		const { index } = makeIndex(
			["ModuleA/Source.md", "ModuleA/Other.md"],
			["ModuleA"],
			{
				"ModuleA/Source.md": {
					links: [{ link: "./Other.md", original: "[text](./Other.md)", displayText: "text" } as never],
				},
			},
			{ "./Other.md": "ModuleA/Other.md" },
		);
		expect(promotedFilePaths(index)).toEqual([]);
	});

	it("E6a: a plain markdown link (real cache.links shape) from a different top-level module still promotes the file", () => {
		const { index } = makeIndex(
			["ModuleA/Source.md", "ModuleB/Other.md"],
			["ModuleA", "ModuleB"],
			{
				"ModuleA/Source.md": {
					links: [{ link: "./Other.md", original: "[text](./Other.md)", displayText: "text" } as never],
				},
			},
			{ "./Other.md": "ModuleB/Other.md" },
		);
		expect(promotedFilePaths(index)).toEqual(["ModuleB/Other.md"]);
	});

	it("E6b: a same-module plain markdown link with a heading anchor (the real pre-fix regression, via Server.md's [here](./ContentTypeParser.md#usage)) does not promote the block", () => {
		const { index } = makeIndex(
			["ModuleA/Source.md", "ModuleA/Other.md"],
			["ModuleA"],
			{
				"ModuleA/Source.md": {
					links: [{ link: "./Other.md#usage", original: "[here](./Other.md#usage)", displayText: "here" } as never],
				},
			},
			{ "./Other.md": "ModuleA/Other.md" },
		);
		expect(promotedBlockPaths(index)).toEqual([]);
	});

	it("a cross-module plain markdown link with a heading anchor still promotes the block (regression)", () => {
		const { index } = makeIndex(
			["ModuleA/Source.md", "ModuleB/Other.md"],
			["ModuleA", "ModuleB"],
			{
				"ModuleA/Source.md": {
					links: [{ link: "./Other.md#usage", original: "[here](./Other.md#usage)", displayText: "here" } as never],
				},
			},
			{ "./Other.md": "ModuleB/Other.md" },
		);
		expect(promotedBlockPaths(index)).toEqual(["ModuleB/Other.md#usage"]);
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
