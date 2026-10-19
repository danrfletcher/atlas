import { describe, expect, it } from "vitest";
import { ApiItemState } from "../../src/types";
import { callRenderNodeList, folderGovernor, makeFakeExplorer, makeStatusesManager, realNode, rowOrder, view } from "./explorer-view-sort-truncate-helpers";

function apiItem(id: string, explicitStatusId?: string): ApiItemState {
	return { id, label: id, explicitStatusId };
}

describe("G25 — truncate: API item rows share the one truncation-group count real units get", () => {
	it("a truncated status shared by one real unit and one API item groups them into a single '2 X' header", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ truncatedStatuses: { todo: { enabled: true } } });
		folder.apiItemState = { "api-1": apiItem("api-1", "todo") };
		folder.apiItemOrder = ["api-1"];
		const real1 = realNode("real-1", { explicitStatusId: "todo" });

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [real1], container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["group:node:folder:todo"]);
		expect(fake.renderTruncationGroupHeader).toHaveBeenCalledTimes(1);
		expect(fake.renderTruncationGroupHeader.mock.calls[0][5]).toBe(2); // count
		expect(fake.renderNode).not.toHaveBeenCalled();
		expect(fake.renderApiItemRow).not.toHaveBeenCalled();
	});

	it("a status used only by API items still truncates once 2+ API items share it", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ truncatedStatuses: { doing: { enabled: true } } });
		folder.apiItemState = { "api-1": apiItem("api-1", "doing"), "api-2": apiItem("api-2", "doing") };
		folder.apiItemOrder = ["api-1", "api-2"];
		const real1 = realNode("real-1", { explicitStatusId: "todo" }); // different status, untouched

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [real1], container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["real-1", "group:node:folder:doing"]);
		expect(fake.renderTruncationGroupHeader.mock.calls[0][5]).toBe(2);
	});

	it("a status used only by real units still truncates once 2+ real units share it, API items untouched", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ truncatedStatuses: { done: { enabled: true } } });
		const real1 = realNode("real-1", { explicitStatusId: "done" });
		const real2 = realNode("real-2", { explicitStatusId: "done" });
		folder.apiItemState = { "api-1": apiItem("api-1", "todo") };
		folder.apiItemOrder = ["api-1"];

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [real1, real2], container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["group:node:folder:done", "api-1"]);
		expect(fake.renderTruncationGroupHeader.mock.calls[0][5]).toBe(2);
	});

	it("expanding the group reveals both real units and API items together, in sorted order", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ truncatedStatuses: { todo: { enabled: true } } });
		folder.apiItemState = { "api-1": apiItem("api-1", "todo") };
		folder.apiItemOrder = ["api-1"];
		const real1 = realNode("real-1", { explicitStatusId: "todo" });

		const fake = makeFakeExplorer(sm);
		fake.expandedTruncationGroups.add("node:folder:todo");
		const container = document.createElement("div");
		await callRenderNodeList(fake, [real1], container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["group:node:folder:todo", "real-1", "api-1"]);
	});

	it("hideCompleted wins outright over truncation and excludes both real units and API items from the count", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ hideCompleted: true, truncatedStatuses: { done: { enabled: true } } });
		folder.apiItemState = { "api-1": apiItem("api-1", "done"), "api-2": apiItem("api-2", "done") };
		folder.apiItemOrder = ["api-1", "api-2"];
		const real1 = realNode("real-1", { explicitStatusId: "done" });
		const real2 = realNode("real-2", { explicitStatusId: "todo" });

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [real1, real2], container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["real-2"]);
		expect(fake.renderTruncationGroupHeader).not.toHaveBeenCalled();
	});

	it("hideCancelled behaves the same way for API items as it does for real units", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ hideCancelled: true });
		folder.apiItemState = { "api-1": apiItem("api-1", "cancelled") };
		folder.apiItemOrder = ["api-1"];
		const real1 = realNode("real-1", { explicitStatusId: "cancelled" });
		const real2 = realNode("real-2", { explicitStatusId: "todo" });

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [real1, real2], container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["real-2"]);
	});

	it("a status absent from truncatedStatuses config falls back to always-shown for both unit kinds", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ truncatedStatuses: { done: { enabled: true } } }); // "todo" not configured
		folder.apiItemState = { "api-1": apiItem("api-1", "todo"), "api-2": apiItem("api-2", "todo") };
		folder.apiItemOrder = ["api-1", "api-2"];
		const real1 = realNode("real-1", { explicitStatusId: "todo" });
		const real2 = realNode("real-2", { explicitStatusId: "todo" });

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [real1, real2], container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["real-1", "real-2", "api-1", "api-2"]);
		expect(fake.renderTruncationGroupHeader).not.toHaveBeenCalled();
	});

	it("a single matching item (no sibling sharing the status) never collapses into a group of one", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ truncatedStatuses: { todo: { enabled: true } } });
		folder.apiItemState = { "api-1": apiItem("api-1", "todo") };
		folder.apiItemOrder = ["api-1"];
		const real1 = realNode("real-1", { explicitStatusId: "done" });

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [real1], container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["real-1", "api-1"]);
		expect(fake.renderTruncationGroupHeader).not.toHaveBeenCalled();
	});

	it("a stale apiItemOrder id degrades gracefully and does not corrupt the group count", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ truncatedStatuses: { todo: { enabled: true } } });
		folder.apiItemState = { "api-1": apiItem("api-1", "todo") };
		folder.apiItemOrder = ["api-1", "ghost-id"];
		const real1 = realNode("real-1", { explicitStatusId: "todo" });

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [real1], container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["group:node:folder:todo"]);
		expect(fake.renderTruncationGroupHeader.mock.calls[0][5]).toBe(2);
	});
});

// PR-2.F3 (G10) regression: the "Add under…" hidden-row helper decides whether a new row rendered
// by looking for an element carrying its id in the bucket's DOM — production code tags each real
// row with `data-select-key`, this fixture's stubbed `renderNode` tags it `data-id` instead, but
// the underlying invariant the helper depends on is the same either way: a node folded into a
// truncated group gets no element of its own at all, under any attribute name.
describe("PR-2.F3 (G10) regression — a node folded into a truncated group has no element, matching the hidden-row helper's own DOM check", () => {
	it("the third same-status sibling (standing in for one just added under the group) renders no element of its own", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ truncatedStatuses: { todo: { enabled: true } } });
		const real1 = realNode("real-1", { explicitStatusId: "todo" });
		const real2 = realNode("real-2", { explicitStatusId: "todo" }); // stands in for the newly added-under row

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, [real1, real2], container, view, 1, [folder], folder);

		expect(container.querySelector('[data-id="real-2"]')).toBeNull();
		expect(rowOrder(container)).toEqual(["group:node:folder:todo"]);
	});
});
