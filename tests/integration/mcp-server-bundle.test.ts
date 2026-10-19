// @vitest-environment node
// T1: esbuild itself relies on a native, un-patched `TextEncoder` to satisfy an internal
// invariant check. The suite's default jsdom environment (vitest.config.ts) polyfills
// `TextEncoder` in a way that trips that check, so this file opts back into the plain Node
// environment — it needs nothing jsdom provides anyway (no DOM, no Obsidian mock).
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import esbuild from "esbuild";
import builtins from "builtin-modules";

/**
 * T1: every other test in this suite runs under vitest/Node, where a dynamic `import("node:http")`
 * works natively. The real desktop app runs the esbuild-bundled `main.js` inside Electron's
 * renderer instead, which routes a literal runtime `import("node:http")` through its ES module
 * loader — that loader enforces CORS-like scheme restrictions and always rejects it with "Failed
 * to fetch dynamically imported module: node:http", so `McpServer.start()` can never bind a
 * listener live even though it passes under Node. No prior test in this suite could catch that
 * because none of them ever produced an actual esbuild bundle and inspected it; this one does,
 * mirroring `esbuild.config.mjs`'s own bundle options (format cjs, Node builtins external) so a
 * future regression back to `import("node:http")` — or any other dynamic import of a Node
 * builtin anywhere in `attemptStart()`'s call path — fails here, not just live in a container.
 */
describe("the real esbuild bundle (T1: node:http must not become a literal dynamic import)", () => {
	it("bundles McpServer's node:http access to a CommonJS require(), never a runtime import()", async () => {
		const root = join(__dirname, "../..");
		const result = await esbuild.build({
			entryPoints: [join(root, "src/main.ts")],
			bundle: true,
			write: false,
			format: "cjs",
			target: "es2022",
			// Matches the production build's own `minify: prod` (esbuild.config.mjs): strips
			// comments, so a doc comment that merely *mentions* `import("node:http")` (as this
			// file's own history does, describing what the bug used to look like) can't produce a
			// false positive here — only a real, compiled `import("node:http")` expression would.
			minify: true,
			external: [
				"obsidian",
				"electron",
				"@codemirror/autocomplete",
				"@codemirror/collab",
				"@codemirror/commands",
				"@codemirror/language",
				"@codemirror/lint",
				"@codemirror/search",
				"@codemirror/state",
				"@codemirror/view",
				"@lezer/common",
				"@lezer/highlight",
				"@lezer/lr",
				...builtins,
			],
			define: { __ATLAS_TEST__: "false" },
		});
		const bundle = result.outputFiles[0].text;

		// The exact failure mode T1 reported: a literal runtime dynamic import of a Node builtin,
		// which Electron's renderer refuses to fetch.
		expect(bundle).not.toContain('import("node:http")');
		expect(bundle).not.toContain("import('node:http')");

		// The fix: a plain CommonJS require call, the same shape folder-source-outside.ts already
		// uses successfully for "fs" — Electron's renderer handles this natively.
		expect(bundle).toContain('require("node:http")');
	});
});
