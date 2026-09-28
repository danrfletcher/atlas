import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "styles.css"), "utf8");

/** jsdom can't compute the real cascade, so these pin the rules the visual checks depend on. */
describe("name dialog styles", () => {
	it("colours the border with more specificity than Obsidian's input hover/focus rules", () => {
		// Obsidian: input[type=text]:not(:disabled):hover is (0,3,1); ours must beat it.
		expect(css).toMatch(/input\.atlas-name-input\.atlas-name-valid\[type="text"\]:not\(:disabled\)\s*\{[^}]*--color-green/);
		expect(css).toMatch(/input\.atlas-name-input\.atlas-name-invalid\[type="text"\]:not\(:disabled\)\s*\{[^}]*--color-red/);
	});

	it("hides the message with visibility and reserves its line, so validity doesn't shift the layout", () => {
		expect(css).toMatch(/\.atlas-name-message\.atlas-hidden\s*\{\s*visibility:\s*hidden;\s*\}/);
		expect(css).toMatch(/\.atlas-name-message\s*\{[^}]*min-height:/);
		expect(css).not.toMatch(/\.atlas-name-message\.atlas-hidden\s*\{[^}]*display:\s*none/);
	});
});
