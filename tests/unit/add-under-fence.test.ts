import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function read(path: string): string {
	return readFileSync(resolve(__dirname, "../../", path), "utf8");
}

// Same static-text check fence-checks.test.ts uses for its own F5 checks; kept as a plain local
// copy rather than an import since fence-checks.test.ts doesn't export it.
const DISK_WRITE_CALL = /\.(create|createFolder|createBinary|modify|modifyBinary|append|delete|trash|rename|copy)\s*\(|renameFile\s*\(|fileManager\s*\./;

/** F2 static check: this PR adds a menu item and a no-op seam only — no command, hotkey or
 * toolbar button, and no disk write anywhere in the new module. */
describe("PR-2.F1 F2 — no command, hotkey or toolbar change; add-under.ts writes nothing to disk", () => {
	it("src/main.ts has no new addCommand call or hotkey", () => {
		const body = read("src/main.ts");
		expect(body).not.toMatch(/addCommand\(/);
		expect(body).not.toMatch(/hotkeys\s*:/);
	});

	it("src/explorer-view.ts has no new addCommand call or hotkey", () => {
		const body = read("src/explorer-view.ts");
		expect(body).not.toMatch(/addCommand\(/);
		expect(body).not.toMatch(/hotkeys\s*:/);
	});

	it("the toolbar's create section (Add block/file/module/folder) still has exactly four buttons", () => {
		const body = read("src/explorer-view.ts");
		const start = body.indexOf("// --- section 2: create");
		const end = body.indexOf("// --- section 3: view controls");
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		const section = body.slice(start, end);
		const count = (section.match(/this\.toolbarButton\(/g) ?? []).length;
		expect(count).toBe(4);
	});

	it("src/add-under.ts contains no disk-write call", () => {
		expect(read("src/add-under.ts")).not.toMatch(DISK_WRITE_CALL);
	});
});
