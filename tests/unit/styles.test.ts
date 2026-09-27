import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(__dirname, "..", "..", "styles.css"), "utf8");

/** Pulls a rule body out of the raw stylesheet text by selector, e.g. `.atlas-row-text { ... }`. */
function ruleBody(selector: string): string {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
	if (!match) throw new Error(`No CSS rule found for ${selector}`);
	return match[1];
}

describe("styles.css — API row rendering (T1/T2/T3)", () => {
	it("T1/T3: defines the API connection dot and every dot state as a visible shape", () => {
		const dot = ruleBody(".atlas-api-connection-dot");
		expect(dot).toMatch(/width\s*:/);
		expect(dot).toMatch(/height\s*:/);
		expect(dot).toMatch(/border-radius\s*:/);

		for (const state of ["green", "grey", "red"]) {
			const stateRule = ruleBody(`.atlas-api-dot-${state}`);
			expect(stateRule).toMatch(/background(-color)?\s*:/);
		}
	});

	it("T2: gives the row label a shrink floor so it can't be squeezed to zero width", () => {
		const text = ruleBody(".atlas-row-text");
		expect(text).toMatch(/min-width\s*:\s*(?!0\b)/);
	});

	it("T2: constrains the secondary span(s) so they share the shrink instead of hogging space", () => {
		const secondary = ruleBody(".atlas-row-secondary");
		expect(secondary).toMatch(/min-width\s*:/);
		expect(secondary).toMatch(/(max-width|overflow)\s*:/);
	});
});
