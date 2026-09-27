import { describe, expect, it } from "vitest";
import { mergeApiItems } from "../../src/api-merge";
import { ApiItemState, ApiMappedRow } from "../../src/types";

const NOW = "2026-01-01T00:00:00.000Z";
const opts = { truncated: false, nowIso: NOW };

function row(id: string, label = id): ApiMappedRow {
	return { id, label };
}

function state(overrides: Partial<ApiItemState> & { id: string }): ApiItemState {
	return { label: overrides.id, ...overrides };
}

describe("mergeApiItems — G6: Append mode", () => {
	it("adds new ids on first refresh", () => {
		const result = mergeApiItems({}, [], [row("1"), row("2")], "append", opts);
		expect(result.order).toEqual(["1", "2"]);
		expect(result.itemState["1"]).toEqual({ id: "1", label: "1", secondary: undefined });
	});

	it("keeps a vanished item exactly as it was, never marks it not found", () => {
		const prevState = { "1": state({ id: "1", explicitStatusId: "done" }) };
		const result = mergeApiItems(prevState, ["1"], [], "append", opts);
		expect(result.itemState["1"]).toEqual(prevState["1"]);
		expect(result.itemState["1"].notFound).toBeUndefined();
		expect(result.order).toEqual(["1"]);
	});

	it("updates label/secondary for a currently-reported row, but never touches status or note", () => {
		const prevState = { "1": state({ id: "1", label: "Old label", explicitStatusId: "done", noteRef: { kind: "block", path: "p", subpath: "s" } }) };
		const result = mergeApiItems(prevState, ["1"], [row("1", "New label")], "append", opts);
		expect(result.itemState["1"].label).toBe("New label");
		expect(result.itemState["1"].explicitStatusId).toBe("done");
		expect(result.itemState["1"].noteRef).toEqual({ kind: "block", path: "p", subpath: "s" });
	});

	it("an empty response list is valid input — keeps every existing item untouched, adds nothing", () => {
		const prevState = { "1": state({ id: "1", explicitStatusId: "done" }) };
		const result = mergeApiItems(prevState, ["1"], [], "append", opts);
		expect(result.itemState).toEqual(prevState);
		expect(result.order).toEqual(["1"]);
	});

	it("an empty response list on a Folder with no prior items produces empty state, not an error", () => {
		const result = mergeApiItems({}, [], [], "append", opts);
		expect(result.itemState).toEqual({});
		expect(result.order).toEqual([]);
	});
});

describe("mergeApiItems — G6c: Merge mode", () => {
	it("marks a vanished item not found with a timestamp, keeps its status/note", () => {
		const prevState = { "1": state({ id: "1", explicitStatusId: "done" }) };
		const result = mergeApiItems(prevState, ["1"], [], "merge", opts);
		expect(result.itemState["1"].notFound).toBe(true);
		expect(result.itemState["1"].lastSeenAt).toBe(NOW);
		expect(result.itemState["1"].explicitStatusId).toBe("done");
	});

	it("does not re-stamp lastSeenAt on an item already marked not found", () => {
		const prevState = { "1": state({ id: "1", notFound: true, lastSeenAt: "2020-01-01T00:00:00.000Z" }) };
		const result = mergeApiItems(prevState, ["1"], [], "merge", opts);
		expect(result.itemState["1"].lastSeenAt).toBe("2020-01-01T00:00:00.000Z");
	});

	it("a reappearing item clears notFound/lastSeenAt and keeps its status/note", () => {
		const prevState = { "1": state({ id: "1", notFound: true, lastSeenAt: NOW, explicitStatusId: "done" }) };
		const result = mergeApiItems(prevState, ["1"], [row("1", "Back")], "merge", opts);
		expect(result.itemState["1"].notFound).toBe(false);
		expect(result.itemState["1"].lastSeenAt).toBeUndefined();
		expect(result.itemState["1"].label).toBe("Back");
		expect(result.itemState["1"].explicitStatusId).toBe("done");
	});

	it("an empty response list marks every previously-known item not found", () => {
		const prevState = { "1": state({ id: "1" }), "2": state({ id: "2" }) };
		const result = mergeApiItems(prevState, ["1", "2"], [], "merge", opts);
		expect(result.itemState["1"].notFound).toBe(true);
		expect(result.itemState["2"].notFound).toBe(true);
	});
});

describe("mergeApiItems — E4: truncated refresh skips not-found marking", () => {
	it("keeps a vanished item untouched (not marked) when this refresh was truncated, even in Merge mode", () => {
		const prevState = { "1": state({ id: "1", explicitStatusId: "done" }) };
		const result = mergeApiItems(prevState, ["1"], [], "merge", { truncated: true, nowIso: NOW });
		expect(result.itemState["1"]).toEqual(prevState["1"]);
		expect(result.itemState["1"].notFound).toBeUndefined();
	});

	it("a later, untruncated refresh where the item is still genuinely absent marks it not found normally", () => {
		const prevState = { "1": state({ id: "1", explicitStatusId: "done" }) };
		// First refresh (truncated) leaves it untouched, per the case above.
		const afterTruncated = mergeApiItems(prevState, ["1"], [], "merge", { truncated: true, nowIso: "2025-01-01T00:00:00.000Z" });
		expect(afterTruncated.itemState["1"].notFound).toBeUndefined();
		// Truncation only suppresses marking for the refresh that was itself truncated — an ordinary
		// (untruncated) refresh afterward where "1" is still absent must mark it, same as any other
		// vanished item.
		const afterNormal = mergeApiItems(afterTruncated.itemState, afterTruncated.order, [], "merge", { truncated: false, nowIso: NOW });
		expect(afterNormal.itemState["1"].notFound).toBe(true);
		expect(afterNormal.itemState["1"].lastSeenAt).toBe(NOW);
		expect(afterNormal.itemState["1"].explicitStatusId).toBe("done");
	});
});

describe("mergeApiItems — itemState keyed by id", () => {
	it("new items are keyed by their own id, not array position", () => {
		const result = mergeApiItems({}, [], [row("b"), row("a")], "merge", opts);
		expect(Object.keys(result.itemState).sort()).toEqual(["a", "b"]);
		expect(result.order).toEqual(["b", "a"]);
	});
});
