import path from "node:path";
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
	resolve: {
		alias: { obsidian: fileURLToPath(new URL("./tests/mocks/obsidian.ts", import.meta.url)) },
	},
	define: { __ATLAS_TEST__: "false" },
	test: {
		environment: "jsdom",
		include: ["tests/**/*.test.ts"],
	},
	resolve: {
		alias: {
			// The real "obsidian" package is types-only (empty `main`), so it can't be resolved at
			// test runtime at all. Point it at a resolvable stub so a per-test `vi.mock("obsidian", ...)`
			// can intercept it — see tests/mocks/obsidian-stub.ts.
			obsidian: path.resolve(__dirname, "tests/mocks/obsidian-stub.ts"),
		},
	},
});
