import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "styles.css"), "utf8");

/** jsdom can't compute the real cascade, so this pins the selector the visual check depends on. */
describe("File filters key-invalid styles", () => {
	it("outlines an empty-key rule with more specificity than Obsidian's input[type=text] rule", () => {
		// Obsidian: input[type=text] { outline: none } is (0,1,1); ours must beat it and its hover/focus rules.
		expect(css).toMatch(/input\.atlas-yaml-key-invalid\[type="text"\]:not\(:disabled\)\s*\{[^}]*outline:\s*1px solid var\(--text-error/);
		expect(css).not.toMatch(/(^|[\s,}])\.atlas-yaml-key-invalid\s*\{/);
	});
});

/** PR-1 R2 fix: the inline YAML-key suggestion list had no CSS at all, so up to 50 matches pushed
 * every rule row below it down by the same amount while the field had focus. jsdom can't lay this
 * out for real, so this pins the bounded height the tester's live check depends on, scoped to the
 * modifier class only (the other `atlas-folder-suggest-list` pickers are untouched). */
describe("File filters YAML-key suggestion list styles", () => {
	it("bounds the inline suggestion list's height and scrolls instead of growing without limit", () => {
		const match = css.match(/\.atlas-yaml-key-suggest\s*\{([^}]*)\}/);
		expect(match).not.toBeNull();
		const body = match![1];
		expect(body).toMatch(/max-height\s*:/);
		expect(body).toMatch(/overflow-y\s*:\s*auto/);
	});

	it("leaves the other atlas-folder-suggest-list pickers (CSV/folder/API path) without a height cap", () => {
		expect(css).not.toMatch(/(^|[\s,}])\.atlas-folder-suggest-list\s*\{[^}]*max-height/);
	});
});
