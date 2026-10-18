import { describe, expect, it, vi } from "vitest";
import { ApiItemState, ViewNode } from "../../src/types";
import { callRenderNodeList, folderGovernor, makeFakeExplorer, makeStatusesManager, realNode, rowOrder, view } from "./explorer-view-sort-truncate-helpers";

function apiItem(id: string, explicitStatusId?: string): ApiItemState {
	return { id, label: id, explicitStatusId };
}

describe("G25 — sort: API item rows share the one sort pass real units get", () => {
	it("sortMode manual (default): real children first, then apiItemOrder, both kinds in their own build order", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "manual" });
		folder.apiItemState = { "api-1": apiItem("api-1", "doing"), "api-2": apiItem("api-2", "todo") };
		folder.apiItemOrder = ["api-1", "api-2"];
		const real1 = realNode("real-1", { explicitStatusId: "done" });
		const real2 = realNode("real-2", { explicitStatusId: "todo" });

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [real1, real2], container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["real-1", "real-2", "api-1", "api-2"]);
	});

	it("sortMode status, ascending: real units and API items interleave by resolved rank, ties keep build order", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "status" });
		// ranks (index into STATUS_SET.statuses): todo=0, doing=1, done=2
		folder.apiItemState = { "api-1": apiItem("api-1", "doing"), "api-2": apiItem("api-2", "todo") };
		folder.apiItemOrder = ["api-1", "api-2"];
		const real1 = realNode("real-1", { explicitStatusId: "done" }); // rank 2
		const real2 = realNode("real-2", { explicitStatusId: "todo" }); // rank 0, tied with api-2

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [real1, real2], container, view, 1, [folder], folder);

		// rank 0 tie (real-2 before api-2, build order), then rank 1 (api-1), then rank 2 (real-1).
		expect(rowOrder(container)).toEqual(["real-2", "api-2", "api-1", "real-1"]);
	});

	it("sortReverse inverts the combined order for both unit types together, without reordering within a tie", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "status", sortReverse: true });
		folder.apiItemState = { "api-1": apiItem("api-1", "doing"), "api-2": apiItem("api-2", "todo") };
		folder.apiItemOrder = ["api-1", "api-2"];
		const real1 = realNode("real-1", { explicitStatusId: "done" });
		const real2 = realNode("real-2", { explicitStatusId: "todo" });

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [real1, real2], container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["real-1", "api-1", "real-2", "api-2"]);
	});

	it("re-rendering an unchanged tie never thrashes order (stable sort, deterministic across renders)", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "status" });
		folder.apiItemState = { "api-1": apiItem("api-1", "todo") };
		folder.apiItemOrder = ["api-1"];
		const real1 = realNode("real-1", { explicitStatusId: "todo" }); // same rank as api-1

		const first = (async () => {
			const fake = makeFakeExplorer(sm);
			const container = document.createElement("div");
			await callRenderNodeList(fake, [real1], container, view, 1, [folder], folder);
			return rowOrder(container);
		})();
		const second = (async () => {
			const fake = makeFakeExplorer(sm);
			const container = document.createElement("div");
			await callRenderNodeList(fake, [real1], container, view, 1, [folder], folder);
			return rowOrder(container);
		})();

		const [a, b] = await Promise.all([first, second]);
		expect(a).toEqual(["real-1", "api-1"]);
		expect(b).toEqual(["real-1", "api-1"]);
	});

	it("a folder with only API items (no real units) still sorts correctly via the shared pass", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "status", sortReverse: true });
		folder.apiItemState = { "api-1": apiItem("api-1", "todo"), "api-2": apiItem("api-2", "done") };
		folder.apiItemOrder = ["api-1", "api-2"];

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [], container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["api-2", "api-1"]);
	});

	it("a folder with only real units (no apiOwner) renders exactly as before the fix — additive, not a rewrite", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "status" });
		const real1 = realNode("real-1", { explicitStatusId: "done" });
		const real2 = realNode("real-2", { explicitStatusId: "todo" });

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [real1, real2], container, view, 1, [folder]); // no apiOwner

		expect(rowOrder(container)).toEqual(["real-2", "real-1"]);
		expect(fake.renderApiItemRow).not.toHaveBeenCalled();
	});

	it("a stale apiItemOrder id with no matching apiItemState entry is skipped, not a crash", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "manual" });
		folder.apiItemState = { "api-1": apiItem("api-1", "todo") };
		folder.apiItemOrder = ["api-1", "ghost-id"]; // "ghost-id" has no matching state entry

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await expect(callRenderNodeList(fake, [], container, view, 1, [folder], folder)).resolves.toBeUndefined();

		expect(rowOrder(container)).toEqual(["api-1"]);
	});
});

// PR-1 (G6-G21): A-Z / Modified / Time added — read straight off the list's own direct governor
// (`ancestors[0]`), never inherited past it (unlike sortMode: "status" above).
describe("PR-1 — sort children: alphabetical / modified / time-added", () => {
	it("alphabetical sorts by the resolved display name, case-insensitively", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "alphabetical" });
		const a = realNode("a", { ref: { kind: "file", path: "A.md" } });
		const b = realNode("b", { ref: { kind: "file", path: "B.md" } });

		const fake = makeFakeExplorer(sm, {
			resolveRef: vi.fn(async (ref: { path: string }) => ({
				text: ref.path === "A.md" ? "zebra" : "Apple",
				icon: "file",
				promoted: false,
				added: false,
				missing: false,
			})),
		});
		const container = document.createElement("div");
		await callRenderNodeList(fake, [a, b], container, view, 1, [folder]);

		// "Apple" (b's resolved text) sorts before "zebra" (a's) regardless of original build order.
		expect(rowOrder(container)).toEqual(["b", "a"]);
	});

	it("alphabetical + Reverse flips the direction", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "alphabetical", sortReverse: true });
		const a = realNode("a", { ref: { kind: "file", path: "A.md" } });
		const b = realNode("b", { ref: { kind: "file", path: "B.md" } });

		const fake = makeFakeExplorer(sm, {
			resolveRef: vi.fn(async (ref: { path: string }) => ({
				text: ref.path === "A.md" ? "Apple" : "Banana",
				icon: "file",
				promoted: false,
				added: false,
				missing: false,
			})),
		});
		const container = document.createElement("div");
		await callRenderNodeList(fake, [a, b], container, view, 1, [folder]);

		expect(rowOrder(container)).toEqual(["b", "a"]);
	});

	it("modified sorts newest file-modified-time first, via the row's own modifiedTimeForRef", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "modified" });
		const older = realNode("older", { ref: { kind: "file", path: "Old.md" } });
		const newer = realNode("newer", { ref: { kind: "file", path: "New.md" } });

		const fake = makeFakeExplorer(sm, {
			modifiedTimeForRef: vi.fn((ref: { path: string }) => (ref.path === "Old.md" ? 100 : 200)),
		});
		const container = document.createElement("div");
		await callRenderNodeList(fake, [older, newer], container, view, 1, [folder]);

		expect(rowOrder(container)).toEqual(["newer", "older"]);
		// G9: "modified" never resolves display text — only mtime is needed.
		expect(fake.resolveRef).not.toHaveBeenCalled();
	});

	it("modified: a row with no time (e.g. a meta Folder, G9) sorts last, even under Reverse", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "modified", sortReverse: true });
		const timed = realNode("timed", { ref: { kind: "file", path: "T.md" } });
		const metaChild: ViewNode = { id: "meta-child", type: "meta", label: "Sub", children: [] };

		const fake = makeFakeExplorer(sm, { modifiedTimeForRef: vi.fn(() => 500) });
		const container = document.createElement("div");
		await callRenderNodeList(fake, [metaChild, timed], container, view, 1, [folder]);

		// Even reversed, the no-time meta folder stays last, not first.
		expect(rowOrder(container)).toEqual(["timed", "meta-child"]);
	});

	it("time-added sorts newest placedAt first and never calls resolveRef or modifiedTimeForRef", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "time-added" });
		const older = realNode("older", { placedAt: 100 });
		const newer = realNode("newer", { placedAt: 200 });

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [older, newer], container, view, 1, [folder]);

		expect(rowOrder(container)).toEqual(["newer", "older"]);
		expect(fake.resolveRef).not.toHaveBeenCalled();
		expect(fake.modifiedTimeForRef).not.toHaveBeenCalled();
	});

	it("time-added: a node with no placedAt (e.g. loaded from a pre-feature data.json, E8) sorts last under Reverse too", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "time-added", sortReverse: true });
		const stamped = realNode("stamped", { placedAt: 500 });
		const unstamped = realNode("unstamped"); // no placedAt at all

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [stamped, unstamped], container, view, 1, [folder]);

		expect(rowOrder(container)).toEqual(["stamped", "unstamped"]);
	});

	it("ties keep their existing (manual) relative order and are not flipped by Reverse (stable sort)", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "time-added", sortReverse: true });
		const first = realNode("first", { placedAt: 100 });
		const second = realNode("second", { placedAt: 100 });

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [first, second], container, view, 1, [folder]);

		expect(rowOrder(container)).toEqual(["first", "second"]);
	});

	it("API rows sort alphabetically by label, and count as no time for modified/time-added (G18)", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "alphabetical" });
		folder.apiItemState = { "api-1": apiItem("api-1"), "api-2": apiItem("api-2") };
		folder.apiItemOrder = ["api-1", "api-2"];
		// Override the labels directly rather than relying on apiItem()'s id-as-label default.
		folder.apiItemState["api-1"].label = "Zeta";
		folder.apiItemState["api-2"].label = "Alpha";

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [], container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["api-2", "api-1"]);
	});

	it("never inherited past the direct parent (F6) — a sort mode set on a grandparent governor has no effect here", async () => {
		const sm = makeStatusesManager();
		// The immediate parent (ancestors[0]) sets nothing; a further ancestor sets alphabetical.
		const directParent = folderGovernor({ id: "direct", sortMode: undefined });
		const grandparent = folderGovernor({ id: "grand", sortMode: "alphabetical" });
		const a = realNode("a", { ref: { kind: "file", path: "A.md" } });
		const b = realNode("b", { ref: { kind: "file", path: "B.md" } });

		const fake = makeFakeExplorer(sm, {
			resolveRef: vi.fn(async (ref: { path: string }) => ({
				text: ref.path === "A.md" ? "zebra" : "Apple",
				icon: "file",
				promoted: false,
				added: false,
				missing: false,
			})),
		});
		const container = document.createElement("div");
		await callRenderNodeList(fake, [a, b], container, view, 2, [directParent, grandparent]);

		// Build order preserved, not alphabetical — the grandparent's setting never reaches here.
		expect(rowOrder(container)).toEqual(["a", "b"]);
	});

	it("sortMode manual is a no-op even with sortReverse left set from a prior mode", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "manual", sortReverse: true });
		const a = realNode("a", { placedAt: 100 });
		const b = realNode("b", { placedAt: 200 });

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [a, b], container, view, 1, [folder]);

		expect(rowOrder(container)).toEqual(["a", "b"]);
	});
});
