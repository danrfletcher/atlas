import { describe, expect, it, vi } from "vitest";
import type { App, TFile } from "obsidian";
import { App as MockApp } from "../mocks/obsidian";
import { ViewsManager } from "../../src/views";
import { FolderSourceConfig } from "../../src/types";
import { YamlFilterRule } from "../../src/folder-filter";

/** PR-1 (S1 R3 / F2 R3): `onMetadataResolved`'s own batching contract, not yet pinned down by a test
 * — the first resolve does one save for N filtered sources and skips outside sources entirely, and a
 * later resolve notifies only when some inside source actually has active rules. */
type CacheEntry = { frontmatter?: Record<string, unknown> } | null;

function source(location: "inside" | "outside", rules?: YamlFilterRule[], path = "Jobs"): FolderSourceConfig {
	return {
		type: "folder",
		location,
		path,
		showFiles: true,
		showFolders: false,
		mode: "merge",
		...(rules ? { filters: { files: { yaml: { rules } } } } : {}),
	};
}

function setup(files: Record<string, CacheEntry>, cacheIdle = false) {
	const app = new MockApp();
	app.vault.seedFolder("Jobs");
	if (cacheIdle) (app.metadataCache as unknown as { inProgressTaskCount: number }).inProgressTaskCount = 0;
	const cache = new Map<string, CacheEntry>(Object.entries(files));
	for (const path of cache.keys()) app.vault.seedFile(path);
	app.metadataCache.getFileCache = ((file: TFile) => cache.get(file.path) ?? null) as unknown as typeof app.metadataCache.getFileCache;
	const persist = vi.fn();
	const vm = new ViewsManager(app as unknown as App, [], "", persist);
	const onChange = vi.fn();
	vm.onChange(onChange);
	return { app, vm, viewId: vm.getViews()[0].id, persist, onChange };
}

const FILES: Record<string, CacheEntry> = {
	"Jobs/acme.md": { frontmatter: { status: "active" } },
	"Jobs/beta.md": { frontmatter: { status: "done" } },
};

describe("PR-1 (S1 R3): the first resolve batches every filtered inside source into one save", () => {
	it("one save and one notify for two filtered inside sources, and an outside source is skipped entirely", () => {
		const f = setup(FILES);
		const active = f.vm.addMetaFolder(f.viewId, null, "Active")!;
		f.vm.setFolderSource(f.viewId, active.id, source("inside", [{ key: "status", value: "active" }]));
		const done = f.vm.addMetaFolder(f.viewId, null, "Done")!;
		f.vm.setFolderSource(f.viewId, done.id, source("inside", [{ key: "status", value: "done" }]));
		// Gets rules too, so the only thing that can exclude it from the batch is the `location ===
		// "inside"` check — `refreshFolderSource` itself is a no-op for an outside source with no
		// `outsidePath`, so asserting on `outside`'s children alone can't tell "skipped" from "ran and
		// did nothing"; spying on `refreshFolderSource` below can.
		const outside = f.vm.addMetaFolder(f.viewId, null, "Outside")!;
		f.vm.setFolderSource(f.viewId, outside.id, source("outside", [{ key: "status", value: "active" }], "/does/not/exist"));

		const refreshSpy = vi.spyOn(f.vm, "refreshFolderSource");
		f.persist.mockClear();
		f.onChange.mockClear();

		f.vm.onMetadataResolved();

		const calledNodeIds = refreshSpy.mock.calls.map((call) => call[1]);
		expect(calledNodeIds.filter((id) => id === active.id)).toHaveLength(1);
		expect(calledNodeIds.filter((id) => id === done.id)).toHaveLength(1);
		expect(calledNodeIds.filter((id) => id === outside.id)).toHaveLength(0);
		expect(refreshSpy).toHaveBeenCalledTimes(2);

		expect(f.persist).toHaveBeenCalledTimes(1);
		expect(f.onChange).toHaveBeenCalledTimes(1);

		expect(f.vm.getNode(f.viewId, active.id)!.children.map((c) => c.ref?.path)).toEqual(["Jobs/acme.md"]);
		expect(f.vm.getNode(f.viewId, done.id)!.children.map((c) => c.ref?.path)).toEqual(["Jobs/beta.md"]);
		expect(f.vm.getNode(f.viewId, outside.id)!.children).toEqual([]);
	});

	it("first resolve with a filtered inside source whose rules match nothing: no save, exactly one notify", () => {
		// PR-1 R2: the save branch (filtered sources that actually change something) was already
		// covered above, but the sibling notify-only branch — filtered sources exist, yet none of
		// them changes anything — was not. A rule matching no file keeps this source's children empty
		// both before and after the resolve, so `refreshFolderSource` reports `changed: false` for it.
		const f = setup(FILES);
		const noMatch = f.vm.addMetaFolder(f.viewId, null, "NoMatch")!;
		f.vm.setFolderSource(f.viewId, noMatch.id, source("inside", [{ key: "status", value: "archived" }]));

		f.persist.mockClear();
		f.onChange.mockClear();

		f.vm.onMetadataResolved();

		expect(f.vm.getNode(f.viewId, noMatch.id)!.children).toEqual([]);
		expect(f.persist).not.toHaveBeenCalled();
		expect(f.onChange).toHaveBeenCalledTimes(1);
	});

	it("no filtered inside source anywhere: no save, no notify", () => {
		const f = setup(FILES);
		const plain = f.vm.addMetaFolder(f.viewId, null, "Plain")!;
		f.vm.setFolderSource(f.viewId, plain.id, source("inside"));

		f.persist.mockClear();
		f.onChange.mockClear();

		f.vm.onMetadataResolved();

		expect(f.persist).not.toHaveBeenCalled();
		expect(f.onChange).not.toHaveBeenCalled();
	});
});

describe("PR-1 (F2 R3): a later resolve notifies only when some inside source has active rules", () => {
	it("no inside source has active rules: no save, no notify", () => {
		const f = setup(FILES, true);
		const plain = f.vm.addMetaFolder(f.viewId, null, "Unfiltered")!;
		f.vm.setFolderSource(f.viewId, plain.id, source("inside"));
		// An outside source's own rules are irrelevant to this check: the gate reads location, not
		// whether `filters` happens to be set in memory.
		const outside = f.vm.addMetaFolder(f.viewId, null, "Outside")!;
		f.vm.setFolderSource(f.viewId, outside.id, source("outside", [{ key: "status", value: "active" }], "/does/not/exist"));

		f.persist.mockClear();
		f.onChange.mockClear();

		f.vm.onMetadataResolved();

		expect(f.persist).not.toHaveBeenCalled();
		expect(f.onChange).not.toHaveBeenCalled();
	});

	it("an inside source with active rules still notifies, even with nothing to clear", () => {
		const f = setup(FILES, true);
		const active = f.vm.addMetaFolder(f.viewId, null, "Active")!;
		f.vm.setFolderSource(f.viewId, active.id, source("inside", [{ key: "status", value: "active" }]));
		f.vm.refreshFolderSource(f.viewId, active.id);

		f.persist.mockClear();
		f.onChange.mockClear();

		f.vm.onMetadataResolved();

		expect(f.persist).not.toHaveBeenCalled();
		expect(f.onChange).toHaveBeenCalledTimes(1);
	});
});
