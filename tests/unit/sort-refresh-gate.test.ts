import { describe, expect, it } from "vitest";
import { SortRefreshGate } from "../../src/sort";

// PR-2 (G9/E4): `SortRefreshGate` is the pure decision of *when* a Modified-sorted list's cached
// file mtimes may be recomputed. These are unit tests of the gate class itself — no DOM, no vault,
// no explorer-view involved — covering the trigger/no-trigger/drag-defers rules the doc comment on
// `SortRefreshGate` and the spec's G9/E4 both describe. The actual wiring of the four trigger
// points into `src/explorer-view.ts` is covered separately (by exercising the real render path).
describe("SortRefreshGate (G9/E4)", () => {
	it("starts dirty: the very first consume() (an unconditioned view's first render) returns true", () => {
		const gate = new SortRefreshGate();
		expect(gate.consume(false)).toBe(true);
	});

	it("a render with no new trigger since the last consume() does not recompute again", () => {
		const gate = new SortRefreshGate();
		expect(gate.consume(false)).toBe(true); // first render consumes the initial dirty flag
		expect(gate.consume(false)).toBe(false); // a plain re-render (e.g. unrelated vault `modify`) does not
		expect(gate.consume(false)).toBe(false);
	});

	it("markDirty() makes exactly the next consume() return true, then it's consumed again", () => {
		const gate = new SortRefreshGate();
		gate.consume(false); // clear the initial dirty flag first
		gate.markDirty();
		expect(gate.consume(false)).toBe(true);
		expect(gate.consume(false)).toBe(false);
	});

	it("markDirty() called twice before a consume() behaves the same as once (idempotent)", () => {
		const gate = new SortRefreshGate();
		gate.consume(false);
		gate.markDirty();
		gate.markDirty();
		expect(gate.consume(false)).toBe(true);
		expect(gate.consume(false)).toBe(false);
	});

	it("a trigger firing while a drag is in progress is deferred: consume(true) never recomputes and never clears the flag", () => {
		const gate = new SortRefreshGate();
		gate.consume(false); // clear the initial dirty flag
		gate.markDirty();
		expect(gate.consume(true)).toBe(false); // dragging — deferred, not consumed
		expect(gate.consume(true)).toBe(false); // still dragging, still deferred
		expect(gate.consume(false)).toBe(true); // drag ends — the deferred trigger fires on the first render after
		expect(gate.consume(false)).toBe(false); // and only that one render
	});

	it("dragging with no pending trigger at all stays false once the drag ends too (dragging never itself sets dirty)", () => {
		const gate = new SortRefreshGate();
		gate.consume(false); // clear the initial dirty flag
		expect(gate.consume(true)).toBe(false);
		expect(gate.consume(false)).toBe(false);
	});
});
