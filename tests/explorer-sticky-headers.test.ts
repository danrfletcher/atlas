import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stuckScrollTarget } from "../src/explorer-view";
import { makeSectionHarness, SectionHarness } from "./explorer-header-fixtures";

// PR-1.B1: the JS pinning emulation (`computeStickyHeaders`, `updateStickyHeaders`, the scroll
// listener, the per-header `translateY` transforms and `scroll-padding-top`/`-bottom`) is gone, so
// the two `describe("computeStickyHeaders ...")` blocks and the three `*.style.transform` /
// `*.style.scrollPadding*` assertions from the old version of this file are removed — pinning is now
// a native CSS `position: sticky` rule read from the stylesheet below, not a value this test can
// compute. `stuckScrollTarget` (G5, G7) is unchanged and kept as-is.
//
// Geometry: 28px headers and rows, a 60-row bucket (so the inbox starts at 28 + 60*28 = 1708), a
// 25-row inbox, and a 300px viewport. Content ends at 2436, so the largest scrollTop is 2136.
const HEADER = 28;
const ROW = 28;
const VIEWPORT = 300;
const INBOX_TOP = HEADER + 60 * ROW; // 1708
const MAX_SCROLL = HEADER + 60 * ROW + HEADER + 25 * ROW - VIEWPORT; // 2136

describe("stuckScrollTarget (G5, G7)", () => {
	it.each([
		// [label, headerTop, stackOffset, maxScrollTop, expected]
		["bucket at the top of the body", 0, 0, MAX_SCROLL, 0],
		["inbox header lands directly under the stacked bucket header", INBOX_TOP, HEADER, MAX_SCROLL, INBOX_TOP - HEADER],
		["target past the end is clamped to the maximum scroll", 2400, HEADER, MAX_SCROLL, MAX_SCROLL],
		["header above the top never yields a negative scroll", 10, HEADER, MAX_SCROLL, 0],
		["content shorter than the view scrolls nowhere", INBOX_TOP, HEADER, -50, 0],
	])("%s", (_label, headerTop, stackOffset, maxScrollTop, expected) => {
		expect(stuckScrollTarget(headerTop, stackOffset, maxScrollTop)).toBe(expected);
	});
});

describe("rendered headers: no JS transform or scroll-padding (GP2-GP5, E1)", () => {
	let h: SectionHarness | null = null;
	afterEach(() => {
		h?.teardown();
		h = null;
	});

	it("never sets a transform or scroll-padding on either label at any scroll position", async () => {
		h = makeSectionHarness();
		await h.render();
		for (const top of [0, 1, 1000, 1435, 1436, 1500, 1680, 1681, MAX_SCROLL]) {
			h.scrollTo(top);
			expect(h.bucketHeader().style.transform).toBe("");
			expect(h.inboxHeader().style.transform).toBe("");
			expect(h.body().style.scrollPaddingTop).toBe("");
			expect(h.body().style.scrollPaddingBottom).toBe("");
		}
	});

	it("adds no scroll listener or requestAnimationFrame beyond the inbox virtualisation's own (F5)", async () => {
		const addSpy = vi.spyOn(HTMLElement.prototype, "addEventListener");
		const rafSpy = vi.spyOn(window, "requestAnimationFrame");
		h = makeSectionHarness();
		await h.render();
		h.scrollTo(1000);
		// The inbox's row-virtualisation redraw keeps its own `scroll` listener (unrelated to sticky
		// headers, see `renderVirtualizedInboxRows`); the sticky-header code adds no listener of its own.
		const scrollListeners = addSpy.mock.calls.filter((call, i) => call[0] === "scroll" && addSpy.mock.contexts[i] === h!.body());
		expect(scrollListeners.length).toBe(1);
		expect(rafSpy).not.toHaveBeenCalled();
	});
});

describe("--atlas-bucket-label-h stays in sync with the bucket header (E5, F2)", () => {
	let h: SectionHarness | null = null;
	afterEach(() => {
		h?.teardown();
		h = null;
	});

	it("is set to the bucket header's height after render, and follows a header height change on resize", async () => {
		h = makeSectionHarness();
		await h.render();
		expect(h.body().style.getPropertyValue("--atlas-bucket-label-h")).toBe(`${HEADER}px`);

		h.setHeaderHeight(40);
		h.fireResize();
		expect(h.body().style.getPropertyValue("--atlas-bucket-label-h")).toBe("40px");
	});
});

describe("short-panel guard (E2)", () => {
	let h: SectionHarness | null = null;
	afterEach(() => {
		h?.teardown();
		h = null;
	});

	// Fit threshold: bucket header + inbox header + one row = 84px.
	const minFit = HEADER + HEADER + ROW;

	it.each([
		["exactly fits: sticky stays enabled", minFit, false],
		["one px short: sticky is disabled", minFit - 1, true],
		["one px taller than the short case: sticky re-enables", minFit, false],
	])("%s", async (_label, viewportHeight, expectDisabled) => {
		h = makeSectionHarness();
		await h.render();
		h.setViewportHeight(viewportHeight);
		h.fireResize();
		expect(h.body().classList.contains("atlas-sticky-disabled")).toBe(expectDisabled);
	});

	it("re-enables without a reload: one guard toggles both directions on the same instance", async () => {
		h = makeSectionHarness();
		await h.render();

		h.setViewportHeight(minFit - 1);
		h.fireResize();
		expect(h.body().classList.contains("atlas-sticky-disabled")).toBe(true);

		h.setViewportHeight(minFit);
		h.fireResize();
		expect(h.body().classList.contains("atlas-sticky-disabled")).toBe(false);
	});
});

describe("structure: labels are siblings of a display:contents wrapper (F2, F3, F4)", () => {
	let h: SectionHarness | null = null;
	afterEach(() => {
		h?.teardown();
		h = null;
	});

	it("keeps the bucket and inbox headers as the first child of their (display:contents) section", async () => {
		h = makeSectionHarness();
		await h.render();
		expect(h.bucketHeader().parentElement?.classList.contains("atlas-bucket")).toBe(true);
		expect(h.inboxHeader().parentElement?.classList.contains("atlas-inbox")).toBe(true);
		expect(h.bucketHeader().nextElementSibling).toBe(h.bucketWrap());
		expect(h.inboxHeader().nextElementSibling).toBe(h.inboxWrap());
	});
});

describe("empty sections keep the remaining label sticky (E4)", () => {
	let h: SectionHarness | null = null;
	afterEach(() => {
		h?.teardown();
		h = null;
	});

	it("an empty bucket still renders the inbox header directly under the bucket header's slot", async () => {
		h = makeSectionHarness({ bucketRows: 0 });
		await h.render();
		expect(h.bucketHeader()).toBeTruthy();
		expect(h.inboxHeader()).toBeTruthy();
		expect(h.body().style.getPropertyValue("--atlas-bucket-label-h")).toBe(`${HEADER}px`);
		expect(h.body().classList.contains("atlas-sticky-disabled")).toBe(false);
	});

	it("an empty inbox still renders the bucket header, with no overlap or crash", async () => {
		h = makeSectionHarness({ inboxRows: 0 });
		await h.render();
		expect(h.bucketHeader()).toBeTruthy();
		expect(h.inboxHeader()).toBeTruthy();
		expect(h.body().style.getPropertyValue("--atlas-bucket-label-h")).toBe(`${HEADER}px`);
	});
});

describe("collapse leaves the sticky state consistent (E3)", () => {
	let h: SectionHarness | null = null;
	afterEach(() => {
		h?.teardown();
		h = null;
	});

	it("collapsing a section while scrolled keeps --atlas-bucket-label-h and the disabled class stable", async () => {
		h = makeSectionHarness();
		await h.render();
		h.scrollTo(1000);
		const before = h.body().style.getPropertyValue("--atlas-bucket-label-h");
		const disabledBefore = h.body().classList.contains("atlas-sticky-disabled");

		h.bucketChevron().click();

		expect(h.body().style.getPropertyValue("--atlas-bucket-label-h")).toBe(before);
		expect(h.body().classList.contains("atlas-sticky-disabled")).toBe(disabledBefore);
	});
});

describe("stylesheet: .atlas-section-header is a native sticky rule (F1, F2, F3, E6)", () => {
	const css = readFileSync(join(__dirname, "..", "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
	const rules = Array.from(css.matchAll(/([^{}]+)\{([^}]*)\}/g), (m) => ({ selectors: m[1].trim(), body: m[2] }));

	it(".atlas-section is display: contents, so a sticky header's containing block is the scroll body", () => {
		const rule = rules.find((r) => r.selectors === ".atlas-section");
		expect(rule).toBeDefined();
		expect(rule!.body).toMatch(/display\s*:\s*contents/);
	});

	it(".atlas-section-header is position: sticky with an opaque background, and no leftover position: relative", () => {
		const rule = rules.find((r) => r.selectors === ".atlas-section-header");
		expect(rule).toBeDefined();
		expect(rule!.body).toMatch(/position\s*:\s*sticky/);
		expect(rule!.body).toMatch(/background\s*:\s*var\(--background-primary\)/);
		expect(rule!.body).not.toMatch(/position\s*:\s*relative/);
	});

	it("the bucket label pins to the top", () => {
		const rule = rules.find((r) => r.selectors === ".atlas-bucket > .atlas-section-header");
		expect(rule).toBeDefined();
		expect(rule!.body).toMatch(/top\s*:\s*0/);
	});

	it("the inbox label sets both top (stacked under the bucket) and bottom (pinned while below the fold)", () => {
		const rule = rules.find((r) => r.selectors === ".atlas-inbox > .atlas-section-header");
		expect(rule).toBeDefined();
		expect(rule!.body).toMatch(/top\s*:\s*var\(--atlas-bucket-label-h/);
		expect(rule!.body).toMatch(/bottom\s*:\s*0/);
	});

	it("the short-panel guard class takes both labels out of position: sticky", () => {
		const rule = rules.find((r) => r.selectors === ".atlas-explorer-scroll.atlas-sticky-disabled .atlas-section-header");
		expect(rule).toBeDefined();
		expect(rule!.body).toMatch(/position\s*:\s*static/);
	});

	it("only the sticking properties changed on .atlas-section-header: padding, font, colour and height stay as on origin/main", () => {
		const rule = rules.find((r) => r.selectors === ".atlas-section-header")!;
		expect(rule.body).toMatch(/padding\s*:\s*4px 8px/);
		expect(rule.body).toMatch(/font-weight\s*:\s*600/);
		expect(rule.body).toMatch(/color\s*:\s*var\(--text-muted\)/);
		expect(rule.body).toMatch(/text-transform\s*:\s*uppercase/);
		expect(rule.body).toMatch(/font-size\s*:\s*var\(--font-ui-smaller\)/);
	});
});
