import { describe, expect, it } from "vitest";
import { ApiItemState } from "../../src/types";
import {
	callRenderApiItemRow,
	callRenderNodeList,
	folderGovernor,
	makeFakeExplorer,
	makeStatusesManager,
	proto,
	realNode,
	rowOrder,
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

describe("PR-6 R3 fix: a Folder-source-demoted row renders back at its recorded position among real children", () => {
	it("a row demoted from the middle slot re-renders between the two real children that were either side of it", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor();
		const demoted: ApiItemState = { id: "demoted-b", label: "b", kind: "placeholder", notFound: true, lastSeenAt: "2026-01-01T00:00:00.000Z", folderSourceDeleted: true, position: 1 };
		folder.apiItemState = { "demoted-b": demoted };
		folder.apiItemOrder = ["demoted-b"];
		const realChildren = [realNode("a-real"), realNode("c-real")];

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, realChildren, container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["a-real", "demoted-b", "c-real"]);
	});

	it("a genuine API row (no folderSourceDeleted marker) still always renders after every real child, unaffected by this fix", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor();
		const genuine: ApiItemState = { id: "api-1", label: "Genuine API row" };
		folder.apiItemState = { "api-1": genuine };
		folder.apiItemOrder = ["api-1"];
		const realChildren = [realNode("a-real"), realNode("c-real")];

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, realChildren, container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["a-real", "c-real", "api-1"]);
	});

	it("a position past the end of the current real children clamps to the end instead of throwing or dropping the row", async () => {
		const sm = makeStatusesManager();
		const folder = folderGovernor();
		const demoted: ApiItemState = { id: "demoted-z", label: "z", kind: "placeholder", notFound: true, lastSeenAt: "2026-01-01T00:00:00.000Z", folderSourceDeleted: true, position: 99 };
		folder.apiItemState = { "demoted-z": demoted };
		folder.apiItemOrder = ["demoted-z"];
		const realChildren = [realNode("a-real")];

		const fake = makeFakeExplorer(sm);
		const container = document.createElement("div");
		await callRenderNodeList(fake, realChildren, container, view, 1, [folder], folder);

		expect(rowOrder(container)).toEqual(["a-real", "demoted-z"]);
	});
});
