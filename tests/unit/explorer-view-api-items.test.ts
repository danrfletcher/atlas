import { describe, expect, it } from "vitest";
import { ApiItemState } from "../../src/types";
import {
	callRenderApiItemRow,
	callRenderNodeList,
	folderGovernor,
	makeFakeExplorer,
	makeStatusesManager,
	proto,
	view,
} from "./explorer-view-sort-truncate-helpers";

describe("G25 — regression: renderApiItemRow output is unchanged by the merged sort/truncate pass", () => {
	it("row content/icon/click wiring is byte-identical called directly vs. via the merged renderNodeList path", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "status" });
		const item: ApiItemState = { id: "api-1", label: "My Item", secondary: "extra", explicitStatusId: "doing" };
		folder.apiItemState = { "api-1": item };
		folder.apiItemOrder = ["api-1"];

		const directFake = makeFakeExplorer(sm);
		const directContainer = document.createElement("div");
		callRenderApiItemRow(directFake, item, directContainer, view, folder, 1, [folder]);

		const mergedFake = makeFakeExplorer(sm, { renderApiItemRow: proto.renderApiItemRow });
		const mergedContainer = document.createElement("div");
		await callRenderNodeList(mergedFake, [], mergedContainer, view, 1, [folder], folder);

		expect(mergedContainer.innerHTML).toBe(directContainer.innerHTML);
	});

	it("a 'not found' item's last-seen text and icon are unchanged via the merged path", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ sortMode: "status" });
		const item: ApiItemState = { id: "api-1", label: "Gone", explicitStatusId: "todo", notFound: true, lastSeenAt: "2026-09-25T10:00:00.000Z" };
		folder.apiItemState = { "api-1": item };
		folder.apiItemOrder = ["api-1"];

		const directFake = makeFakeExplorer(sm);
		const directContainer = document.createElement("div");
		callRenderApiItemRow(directFake, item, directContainer, view, folder, 1, [folder]);

		const mergedFake = makeFakeExplorer(sm, { renderApiItemRow: proto.renderApiItemRow });
		const mergedContainer = document.createElement("div");
		await callRenderNodeList(mergedFake, [], mergedContainer, view, 1, [folder], folder);

		expect(mergedContainer.innerHTML).toBe(directContainer.innerHTML);
		expect(mergedContainer.textContent).toContain("not found, last seen 2026-09-25");
	});

	it("an item with no explicit status falls back to the fallback 'plug' icon identically via either path", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor({ statusEnabled: false, statusSetId: undefined, sortMode: "status" });
		const item: ApiItemState = { id: "api-1", label: "No status" };
		folder.apiItemState = { "api-1": item };
		folder.apiItemOrder = ["api-1"];

		const directFake = makeFakeExplorer(sm);
		const directContainer = document.createElement("div");
		callRenderApiItemRow(directFake, item, directContainer, view, folder, 1, [folder]);

		const mergedFake = makeFakeExplorer(sm, { renderApiItemRow: proto.renderApiItemRow });
		const mergedContainer = document.createElement("div");
		await callRenderNodeList(mergedFake, [], mergedContainer, view, 1, [folder], folder);

		expect(mergedContainer.innerHTML).toBe(directContainer.innerHTML);
	});
});
