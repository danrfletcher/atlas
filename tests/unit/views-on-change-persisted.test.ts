import { describe, expect, it } from "vitest";
import type { App, TFile } from "obsidian";
import { App as MockApp } from "../mocks/obsidian";
import { ViewsManager } from "../../src/views";
import { FolderSourceConfig } from "../../src/types";

/** PR-2 (R3): `ViewsManager.onChange`'s callback is given a `persisted` flag — `true` only for a
 * call that went through `save()` (a real, written structural/sort change), `false` for a bare
 * `notifyChange()` (a render-only nudge with nothing in the tree actually changed). This is what
 * lets a listener that must fire only on "the tree changes" (the G9 Modified-sort refresh gate in
 * `explorer-view.ts`) tell the two apart, instead of re-sorting at every plain autosave. */
describe("ViewsManager.onChange — R3: persisted distinguishes a real save from a render-only notify", () => {
	it("a save()-driven mutation (placeUnit) notifies listeners with persisted=true", () => {
		const vm = new ViewsManager({} as App, [], "", () => {});
		const viewId = vm.getViews()[0].id;
		const calls: boolean[] = [];
		vm.onChange((persisted) => calls.push(persisted));

		vm.placeUnit(viewId, { kind: "file", path: "A.md" }, null);

		expect(calls).toEqual([true]);
	});

	it("a later metadataCache resolve with an active Folder-source YAML rule and nothing actually changed notifies with persisted=false — this is the exact autosave path that must not re-sort", () => {
		const app = new MockApp();
		app.vault.seedFolder("Jobs");
		app.vault.seedFile("Jobs/acme.md");
		app.metadataCache.getFileCache = ((_file: TFile) => ({ frontmatter: { status: "active" } })) as unknown as typeof app.metadataCache.getFileCache;

		const vm = new ViewsManager(app as unknown as App, [], "", () => {});
		const viewId = vm.getViews()[0].id;
		const folder = vm.addMetaFolder(viewId, null, "Jobs")!;
		const source: FolderSourceConfig = {
			type: "folder",
			location: "inside",
			path: "Jobs",
			showFiles: true,
			showFolders: false,
			mode: "merge",
			filters: { files: { yaml: { rules: [{ key: "status", value: "active" }] } } },
		};
		vm.setFolderSource(viewId, folder.id, source);

		// The first resolve adds the matching file — a real, persisted change, but that happens
		// before the listener below is registered, so it's irrelevant to what we're proving here.
		vm.onMetadataResolved();

		const calls: boolean[] = [];
		vm.onChange((persisted) => calls.push(persisted));

		// A later resolve with nothing newly hidden/unhidden: `hasActiveFolderSourceRules()` is true
		// (so the explorer still repaints in case a row's match state silently changed), but nothing
		// was actually written to the tree.
		vm.onMetadataResolved();

		expect(calls).toEqual([false]);
	});

	it("a later metadataCache resolve with no active Folder-source rules anywhere notifies nothing at all", () => {
		const app = new MockApp();
		const vm = new ViewsManager(app as unknown as App, [], "", () => {});
		vm.onMetadataResolved(); // first resolve

		const calls: boolean[] = [];
		vm.onChange((persisted) => calls.push(persisted));
		vm.onMetadataResolved(); // later resolve, no rule-filtered source exists at all

		expect(calls).toEqual([]);
	});
});
