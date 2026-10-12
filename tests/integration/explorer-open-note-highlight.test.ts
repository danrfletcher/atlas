import { afterEach, describe, expect, it, vi } from "vitest";
import { AtlasExplorerView } from "../../src/explorer-view";
import { fileUnits, keyAt, makeHarness, stubLayout } from "../unit/explorer-view-scroll-helpers";

/** PR-1.F2 (G2/E6): the virtualised inbox window must carry the open-note highlight on every row it
 * draws, including a row the window draws later purely because the user scrolled — from that row's
 * very first paint, with no separate unhighlighted frame, and without dropping the highlight on rows
 * that stay in the window across a redraw. Exercises the real `updateActiveHighlight` (not the
 * no-op stub the rest of the PR-1.S1 scroll suite uses) against the real `renderInboxRow`/
 * `drawWindow`, via `makeHarness(..., { useRealHighlight: true })`. */

const ROW = 28;
const OVER = 8;

let restoreLayout: (() => void) | null = null;

afterEach(() => {
	document.body.replaceChildren();
	restoreLayout?.();
	restoreLayout = null;
	vi.restoreAllMocks();
});

function setup(units = fileUnits(2000), layout = { viewportHeight: 280, bucketHeight: 0 }) {
	restoreLayout = stubLayout(layout);
	return makeHarness(units, layout, { useRealHighlight: true });
}

async function render(explorer: AtlasExplorerView): Promise<void> {
	await (explorer as unknown as { render: () => Promise<void> }).render();
}

function scrollTo(h: ReturnType<typeof makeHarness>, top: number): void {
	h.scrollBody().scrollTop = top;
	h.scrollBody().dispatchEvent(new Event("scroll"));
}

function isActive(h: ReturnType<typeof makeHarness>, key: string): boolean {
	return !!h.panel().querySelector<HTMLElement>(`.atlas-inbox [data-ref-key="${key}"]`)?.classList.contains("is-active");
}

describe("PR-1.F2 — G2/E6: the inbox scroll window re-applies the open-note highlight on every redraw", () => {
	it("G2: a row outside the initial window gets the highlight the moment it scrolls into view and is drawn", async () => {
		const units = fileUnits(2000);
		const h = setup(units);
		const targetKey = keyAt(units, 500);
		h.setActiveFile(units[500].path);

		await render(h.explorer);
		// Not drawn yet at scrollTop 0 — the initial window is nowhere near row 500.
		expect(h.inboxRowKeys()).not.toContain(targetKey);

		scrollTo(h, ROW * 500);
		// No second render() call, no extra frame beyond the scroll handler's own rAF (stubbed to
		// run synchronously by stubLayout) — the row must already carry the class on this redraw.
		expect(h.inboxRowKeys()).toContain(targetKey);
		expect(isActive(h, targetKey)).toBe(true);
	});

	it("E6: a redraw triggered by further scrolling keeps the highlight on a row that stays in the window", async () => {
		const units = fileUnits(2000);
		const h = setup(units);
		const targetKey = keyAt(units, 500);
		h.setActiveFile(units[500].path);

		await render(h.explorer);
		scrollTo(h, ROW * 500);
		expect(isActive(h, targetKey)).toBe(true);

		// A small scroll whose window still includes row 500 (the overscan keeps it in range).
		scrollTo(h, ROW * 500 + 10);
		expect(h.inboxRowKeys()).toContain(targetKey);
		expect(isActive(h, targetKey)).toBe(true);
	});

	it("setting off, then scrolling: freshly drawn rows are not highlighted", async () => {
		const units = fileUnits(2000);
		const h = setup(units);
		const targetKey = keyAt(units, 500);
		h.setActiveFile(units[500].path);
		h.settings.highlightOpenNote = false;

		await render(h.explorer);
		scrollTo(h, ROW * 500);

		expect(h.inboxRowKeys()).toContain(targetKey);
		expect(isActive(h, targetKey)).toBe(false);
		expect(h.panel().querySelectorAll(".atlas-row.is-active")).toHaveLength(0);
	});

	it("turning the setting back on re-applies the highlight to whatever the window currently has drawn, with no extra scroll", async () => {
		const units = fileUnits(2000);
		const h = setup(units);
		const targetKey = keyAt(units, 500);
		h.setActiveFile(units[500].path);
		h.settings.highlightOpenNote = false;

		await render(h.explorer);
		scrollTo(h, ROW * 500);
		expect(isActive(h, targetKey)).toBe(false);

		h.settings.highlightOpenNote = true;
		// Directly re-invoking the real method, exactly what `refreshExplorerViews()` -> `refresh()`
		// -> the next render's own call (or a settings-tab toggle) would trigger — no scroll needed.
		(h.explorer as unknown as { updateActiveHighlight(): void }).updateActiveHighlight();
		expect(isActive(h, targetKey)).toBe(true);
	});

	it("the kept-alive dragged row keeps its highlight state across a window redraw", async () => {
		const units = fileUnits(2000);
		const h = setup(units);
		const targetKey = keyAt(units, 500);
		h.setActiveFile(units[500].path);

		await render(h.explorer);
		scrollTo(h, ROW * 500);
		const draggedRow = h.panel().querySelector<HTMLElement>(`.atlas-inbox [data-ref-key="${targetKey}"]`)!;
		expect(draggedRow.classList.contains("is-active")).toBe(true);
		(h.explorer as unknown as { inboxDragRowEl: HTMLElement | null }).inboxDragRowEl = draggedRow;

		// Scroll far enough that row 500 would normally fall out of the window — the dragged row is
		// kept alive (hidden) instead of being torn down and rebuilt.
		scrollTo(h, ROW * 1500);
		expect(h.panel().contains(draggedRow)).toBe(true);
		expect(draggedRow.classList.contains("is-active")).toBe(true);
	});
});
