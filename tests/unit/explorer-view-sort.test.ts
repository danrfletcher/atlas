import { describe, expect, it } from "vitest";
import { ApiItemState } from "../../src/types";
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
