import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// PR-1.F1 fence checks (F1, F4, F5, G8), following the `explorer-header-fence.test.ts` pattern: a
// source scan for the behaviour-preserving fences, plus a styles.css check that `.is-active` and
// `.is-selected` stay on separate properties so a row that is both shows both (G8) without either
// declaration order or specificity making one silently lose.
const root = resolve(__dirname, "..");
const explorerSrc = readFileSync(resolve(root, "src/explorer-view.ts"), "utf8");
const css = readFileSync(resolve(root, "styles.css"), "utf8");

/** Text from `start` up to (not including) the next class member after it. */
function methodBody(src: string, start: string): string {
	const from = src.indexOf(start);
	expect(from, `${start} exists`).toBeGreaterThan(-1);
	const next = src.indexOf("\n\tprivate ", from + start.length);
	return src.slice(from, next === -1 ? undefined : next);
}

/** Pulls a rule body out of the raw stylesheet text by selector, e.g. `.atlas-row.is-active { ... }`. */
function ruleBody(selector: string): string {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
	if (!match) throw new Error(`No CSS rule found for ${selector}`);
	return match[1];
}

describe("PR-1.F1 fence", () => {
	it("F1: updateActiveHighlight never scrolls, folds/unfolds, switches view, or shows a Notice", () => {
		const body = methodBody(explorerSrc, "private updateActiveHighlight(");
		expect(body).not.toMatch(/scrollTop\s*=/);
		expect(body).not.toMatch(/\.scrollTo\(/);
		expect(body).not.toMatch(/setNodeCollapsed/);
		expect(body).not.toMatch(/setActiveView|setActiveLeaf/);
		expect(body).not.toMatch(/new Notice\(/);
	});

	it("F2: the \"Reveal active file\" command isn't touched by this PR — it lives entirely in f10-commands.ts", () => {
		const f10Src = readFileSync(resolve(root, "src/f10-commands.ts"), "utf8");
		expect(f10Src).toMatch(/id:\s*"reveal-active-file"/);
	});

	it("F5: updateActiveHighlight reads only — no vault write, no saveData/flushSave call", () => {
		const body = methodBody(explorerSrc, "private updateActiveHighlight(");
		expect(body).not.toMatch(/\.modify\(|\.create\(|\.rename\(|\.delete\(/);
		expect(body).not.toMatch(/saveData|flushSave|saveSettings/);
	});

	it("F4: .is-selected and :hover are untouched — only background/box-shadow for the selection ring, nothing shared with .is-active's own declarations", () => {
		const selected = ruleBody(".atlas-row.is-selected");
		expect(selected.replace(/\s+/g, " ").trim()).toBe("box-shadow: inset 0 0 0 1px var(--interactive-accent);");
		const hover = ruleBody(".atlas-row:hover");
		expect(hover.replace(/\s+/g, " ").trim()).toBe("background: var(--background-modifier-hover);");
	});

	it("G8/E7: .is-active fills with a nav-active background and draws its bar via a separate declaration (not box-shadow), so it can never clobber .is-selected's ring", () => {
		const active = ruleBody(".atlas-row.is-active");
		expect(active).toMatch(/background\s*:\s*var\(--nav-item-background-active\)/);
		expect(active).not.toMatch(/box-shadow/);
		const activeBefore = ruleBody(".atlas-row.is-active::before");
		expect(activeBefore).toMatch(/background\s*:\s*var\(--interactive-accent\)/);
	});
});
