import { describe, expect, it } from "vitest";
import { ApiHeadersStore } from "../../src/api-headers-store";
import { ViewsManager } from "../../src/views";
import { ApiSourceConfig, View } from "../../src/types";
import type { App } from "obsidian";

/** In-memory stand-in for Obsidian's real per-device `loadLocalStorage`/`saveLocalStorage` — good
 * enough to prove `ApiHeadersStore`'s own keying/round-trip behavior without needing the real plugin. */
class FakeLocalStorageHost {
	private store = new Map<string, unknown>();
	loadLocalStorage(key: string): unknown {
		return this.store.get(key) ?? null;
	}
	saveLocalStorage(key: string, data: unknown): void {
		this.store.set(key, data);
	}
}

const SECRET = "Bearer super-secret-token-xyz";

function makeSource(url = "https://api.example.com/items"): ApiSourceConfig {
	return { url, method: "GET", mapping: { idField: "id", labelField: "name" }, mode: "merge", refreshOnViewLoad: false };
}

describe("ApiHeadersStore — G13: device-local only, keyed per Folder", () => {
	it("round-trips headers for a given node id", () => {
		const store = new ApiHeadersStore(new FakeLocalStorageHost());
		store.set("node-a", [{ key: "Authorization", value: SECRET }]);
		expect(store.get("node-a")).toEqual([{ key: "Authorization", value: SECRET }]);
	});

	it("returns an empty list for a node with no headers set", () => {
		const store = new ApiHeadersStore(new FakeLocalStorageHost());
		expect(store.get("unknown")).toEqual([]);
	});

	it("keeps headers isolated per node — setting one node's headers never leaks into another's", () => {
		const store = new ApiHeadersStore(new FakeLocalStorageHost());
		store.set("node-a", [{ key: "X-A", value: "a" }]);
		store.set("node-b", [{ key: "X-B", value: "b" }]);
		expect(store.get("node-a")).toEqual([{ key: "X-A", value: "a" }]);
		expect(store.get("node-b")).toEqual([{ key: "X-B", value: "b" }]);
	});

	it("E6: delete removes exactly that node's entry", () => {
		const store = new ApiHeadersStore(new FakeLocalStorageHost());
		store.set("node-a", [{ key: "X-A", value: "a" }]);
		store.set("node-b", [{ key: "X-B", value: "b" }]);
		store.delete("node-a");
		expect(store.get("node-a")).toEqual([]);
		expect(store.get("node-b")).toEqual([{ key: "X-B", value: "b" }]);
	});
});

describe("Persisted view data — G13: headers never appear in the synced shape", () => {
	function makeViewsManager(persist: () => void = () => {}) {
		const views: View[] = [];
		return new ViewsManager({} as App, views, "", persist);
	}

	it("source/cache/itemState are plain fields on the node, present in what would be saved to data.json", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "API folder")!;
		vm.setApiSource(view.id, folder.id, makeSource());

		const node = vm.getNode(view.id, folder.id)!;
		node.apiCache = { fetchedAt: 123, ok: true, error: null, rows: [{ id: "1", label: "One" }], skippedCount: 0, truncated: false };

		const persistedJson = JSON.stringify(vm.getViews());
		expect(persistedJson).toContain("api.example.com");
		expect(persistedJson).toContain("\"fetchedAt\":123");
	});

	it("the device-local header value never appears anywhere in the persisted view data", () => {
		const headersStore = new ApiHeadersStore(new FakeLocalStorageHost());
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "API folder")!;
		vm.setApiSource(view.id, folder.id, makeSource());
		headersStore.set(folder.id, [{ key: "Authorization", value: SECRET }]);

		const persistedJson = JSON.stringify(vm.getViews());
		expect(persistedJson).not.toContain(SECRET);
	});
});

describe("E7 — rename/move leave a Folder's API source untouched", () => {
	function makeViewsManager() {
		return new ViewsManager({} as App, [], "", () => {});
	}

	it("renaming a Folder does not touch its apiSource/cache", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "API folder")!;
		vm.setApiSource(view.id, folder.id, makeSource());
		vm.renameMetaFolder(view.id, folder.id, "Renamed folder");

		const node = vm.getNode(view.id, folder.id)!;
		expect(node.label).toBe("Renamed folder");
		expect(node.apiSource).toEqual(makeSource());
	});

	it("moving (promoting) a Folder elsewhere in the tree keeps its apiSource intact", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const target = vm.addMetaFolder(view.id, null, "Target")!;
		const folder = vm.addMetaFolder(view.id, null, "API folder")!;
		vm.setApiSource(view.id, folder.id, makeSource());

		vm.moveNode(view.id, folder.id, target.id, 0);

		const node = vm.getNode(view.id, folder.id)!;
		expect(node.apiSource).toEqual(makeSource());
	});
});

describe("E6 — deleting a Folder removes its source/cache and (via the caller) its headers", () => {
	it("deleteMetaFolder discards the node's own apiSource/cache/itemState", () => {
		const vm = new ViewsManager({} as App, [], "", () => {});
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "API folder")!;
		vm.setApiSource(view.id, folder.id, makeSource());

		vm.deleteMetaFolder(view.id, folder.id);

		expect(vm.getNode(view.id, folder.id)).toBeNull();
	});

	it("the delete flow (headers store + deleteMetaFolder) leaves no trace of the headers either", () => {
		const headersStore = new ApiHeadersStore(new FakeLocalStorageHost());
		const vm = new ViewsManager({} as App, [], "", () => {});
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "API folder")!;
		vm.setApiSource(view.id, folder.id, makeSource());
		headersStore.set(folder.id, [{ key: "Authorization", value: SECRET }]);

		// Mirrors explorer-view.ts's own delete-folder handler: the headers store has no home inside
		// ViewsManager's own data, so the caller clears it explicitly alongside the node itself.
		headersStore.delete(folder.id);
		vm.deleteMetaFolder(view.id, folder.id);

		expect(headersStore.get(folder.id)).toEqual([]);
		expect(vm.getNode(view.id, folder.id)).toBeNull();
	});
});
