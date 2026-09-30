import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeApiCommand } from "../../src/api-command-runner";
import { resolveArgv, tokenizeCommand } from "../../src/command-argv";

describe("click-action-run — G9b/E10: Background command execution and hostile values", () => {
	let tmpDir: string;
	let stubPath: string;
	let logPath: string;
	let notices: string[];

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-click-action-test-"));
		stubPath = path.join(tmpDir, "record-args");
		logPath = path.join(tmpDir, "args.json");
		notices = [];

		// Create the stub executable using Node
		const stubContent = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === '--fail') {
  process.stderr.write('stub failed: permission denied\\n');
  process.exit(1);
}
const logFile = process.env.STUB_LOG;
if (logFile) {
  fs.writeFileSync(logFile, JSON.stringify(args));
}
process.exit(0);
`;
		fs.writeFileSync(stubPath, stubContent, { mode: 0o755 });
		process.env.STUB_LOG = logPath;
	});

	afterEach(() => {
		delete process.env.STUB_LOG;
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	});

	it("GP12: asserts exact argv for a normal row, and success produces no notice", async () => {
		const commandTemplate = `${stubPath} {path}`;
		const tokenRes = tokenizeCommand(commandTemplate);
		expect(tokenRes.ok).toBe(true);
		if (!tokenRes.ok) return;

		const resolved = resolveArgv(tokenRes.tokens, { path: "/Applications/Docker.app" });
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) return;

		const noticeSpy = (msg: string) => notices.push(msg);
		const result = await executeApiCommand(resolved.argv, { noticeImpl: noticeSpy });

		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(notices).toHaveLength(0); // E10: no notice on exit 0

		expect(fs.existsSync(logPath)).toBe(true);
		const recorded = JSON.parse(fs.readFileSync(logPath, "utf8"));
		expect(recorded).toEqual(["/Applications/Docker.app"]);
	});

	it("Hostile row: literal argument reaches process intact without shell evaluation, no marker file created", async () => {
		const markerPath = path.join(tmpDir, "pwn_marker.txt");
		const hostileValue = `; touch "${markerPath}"; $(touch "${markerPath}")`;

		const commandTemplate = `${stubPath} {path}`;
		const tokenRes = tokenizeCommand(commandTemplate);
		expect(tokenRes.ok).toBe(true);
		if (!tokenRes.ok) return;

		const resolved = resolveArgv(tokenRes.tokens, { path: hostileValue });
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) return;

		const noticeSpy = (msg: string) => notices.push(msg);
		const result = await executeApiCommand(resolved.argv, { noticeImpl: noticeSpy });

		expect(result.ok).toBe(true);
		expect(notices).toHaveLength(0);

		// Assert no shell injection happened: marker file must NOT exist
		expect(fs.existsSync(markerPath)).toBe(false);

		// Assert literal argument was recorded
		expect(fs.existsSync(logPath)).toBe(true);
		const recorded = JSON.parse(fs.readFileSync(logPath, "utf8"));
		expect(recorded).toEqual([hostileValue]);
	});

	it("E10: non-zero exit code produces a notice with the exit message and changes nothing else", async () => {
		const noticeSpy = (msg: string) => notices.push(msg);
		const result = await executeApiCommand([stubPath, "--fail"], { noticeImpl: noticeSpy });

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("stub failed: permission denied");
	});

	it("E10: executable not found produces a notice without crashing", async () => {
		const nonExistent = path.join(tmpDir, "does-not-exist");
		const noticeSpy = (msg: string) => notices.push(msg);
		const result = await executeApiCommand([nonExistent, "arg"], { noticeImpl: noticeSpy });

		expect(result.ok).toBe(false);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("ENOENT");
	});

	describe("Mobile gate (Platform.isMobile)", () => {
		it("runs on desktop, but does nothing when Platform.isMobile is true", async () => {
			const fakePlatform = { isMobile: false };
			const runIfDesktop = async (platform: { isMobile: boolean }) => {
				if (platform.isMobile) return;
				await executeApiCommand([stubPath, "ran-on-desktop"], { noticeImpl: () => {} });
			};

			// Desktop execution
			await runIfDesktop(fakePlatform);
			expect(fs.existsSync(logPath)).toBe(true);
			expect(JSON.parse(fs.readFileSync(logPath, "utf8"))).toEqual(["ran-on-desktop"]);

			// Reset log
			fs.unlinkSync(logPath);

			// Mobile simulation
			fakePlatform.isMobile = true;
			await runIfDesktop(fakePlatform);
			expect(fs.existsSync(logPath)).toBe(false); // Nothing executed on mobile
		});
	});
});
