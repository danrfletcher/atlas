import { describe, expect, it } from "vitest";
import { ApiItemState } from "../../src/types";
import { callRenderNodeList, folderGovernor, makeFakeExplorer, makeStatusesManager, realNode, rowOrder, view } from "./explorer-view-sort-truncate-helpers";

function apiItem(id: string, explicitStatusId?: string): ApiItemState {
	return { id, label: id, explicitStatusId };
}

describe("G25 — fence: unconfigured governance is a no-op for both unit kinds, same as before the fix", () => {
	it("no sortMode, no truncatedStatuses: real units and API items render in plain build order, no new code path triggers", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor(); // sortMode/truncatedStatuses both absent
		folder.apiItemState = { "api-1": apiItem("api-1", "done"), "api-2": apiItem("api-2", "todo") };
		folder.apiItemOrder = ["api-1", "api-2"];
		const real1 = realNode("real-1", { explicitStatusId: "todo" });
		const real2 = realNode("real-2", { explicitStatusId: "done" });

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [real1, real2], container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["real-1", "real-2", "api-1", "api-2"]);
		expect(fake.renderTruncationGroupHeader).not.toHaveBeenCalled();
	});

	it("sortMode explicitly 'manual' with no truncatedStatuses behaves identically to governance being entirely absent", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "manual" });
		folder.apiItemState = { "api-1": apiItem("api-1", "done") };
		folder.apiItemOrder = ["api-1"];
		const real1 = realNode("real-1", { explicitStatusId: "todo" });

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [real1], container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["real-1", "api-1"]);
		expect(fake.renderTruncationGroupHeader).not.toHaveBeenCalled();
	});

	it("statusEnabled off entirely: no governor resolves, no status, no sort/truncate for either unit kind", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ statusEnabled: false, truncatedStatuses: { todo: { enabled: true } }, sortMode: "status" });
		folder.apiItemState = { "api-1": apiItem("api-1", "todo"), "api-2": apiItem("api-2", "todo") };
		folder.apiItemOrder = ["api-1", "api-2"];
		const real1 = realNode("real-1", { explicitStatusId: "todo" });
		const real2 = realNode("real-2", { explicitStatusId: "todo" });

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [real1, real2], container, view, 1, [folder], folder);

		// statusEnabled: false means findGoverningAncestor/findSortGovernor never resolve this
		// governor, so no status, no sort, and no truncation count — build order, untouched.
		expect(rowOrder(container)).toEqual(["real-1", "real-2", "api-1", "api-2"]);
		expect(fake.renderTruncationGroupHeader).not.toHaveBeenCalled();
	});

	it("a folder with no apiOwner at all (real-unit-only call site) is unaffected by any of this — pre-existing real-unit semantics untouched", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ truncatedStatuses: { todo: { enabled: true } } });
		const real1 = realNode("real-1", { explicitStatusId: "todo" });
		const real2 = realNode("real-2", { explicitStatusId: "todo" });

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [real1, real2], container, view, 1, [folder]); // no apiOwner

		expect(rowOrder(container)).toEqual(["group:node:folder:todo"]);
		expect(fake.renderApiItemRow).not.toHaveBeenCalled();
	});
});
