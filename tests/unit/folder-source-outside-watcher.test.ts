import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import * as os from "node:os";
import { EventEmitter } from "node:events";
import { FolderSourceOutsideWatchers, OUTSIDE_WATCH_DEBOUNCE_MS, isIgnoredOutsideEvent } from "../../src/folder-source-outside-watcher";

/** PR-1 R1: the module under test imports the `"fs"` specifier (not `"node:fs"`), so mocking it here
 * leaves the test file's own `"node:fs"` imports (`mkdtempSync` etc.) untouched. */
const realpathSyncSpy = vi.fn();
vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs")>();
	return {
		...actual,
		realpathSync: Object.assign(
			(...args: Parameters<typeof actual.realpathSync>) => {
				realpathSyncSpy(...args);
				return (actual.realpathSync as (...a: typeof args) => unknown)(...args);
			},
			actual.realpathSync
		),
	};
});

/** A small EventEmitter standing in for the `FSWatcher` `fs.watch` returns. */
class MockWatcher extends EventEmitter {
	close = vi.fn();
	on(event: "error", listener: () => void): this {
		return super.on(event, listener);
	}
	emitChange(filename: string | null): void {
		this.emit("change", "rename", filename);
	}
}

function setup(opts: { resolved?: (path: string) => boolean } = {}) {
	const watchers: { path: string; watcher: MockWatcher }[] = [];
	const watch = vi.fn((path: string, listener: (eventType: string, filename: string | null) => void) => {
		const watcher = new MockWatcher();
		watcher.on("change", (eventType: string, filename: string | null) => listener(eventType, filename));
		watchers.push({ path, watcher });
		return watcher;
	});
	const onRescan = vi.fn();
	const registry = new FolderSourceOutsideWatchers({
		watch,
		isResolved: opts.resolved ?? (() => true),
		onRescan,
	});
	return { registry, watch, onRescan, watchers };
}

const latest = (watchers: { watcher: MockWatcher }[]) => watchers[watchers.length - 1].watcher;

describe("folder-source-outside-watcher — one non-recursive watch per folder (G6)", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("opens one fs.watch per resolved folder, however many sources point at it", () => {
		const { registry, watch } = setup();
		registry.sync(new Map([["node-a", "/Docs/Invoices"]]));
		expect(watch).toHaveBeenCalledTimes(1);
		expect(watch.mock.calls[0][0]).toBe("/Docs/Invoices");
	});

	it("sends each event to a single debounce, so a burst costs one rescan", () => {
		const { registry, onRescan, watchers } = setup();
		registry.sync(new Map([["node-a", "/Docs/Invoices"]]));
		const watcher = latest(watchers);
		for (let i = 0; i < 500; i++) watcher.emitChange(`file-${i}.pdf`);
		vi.advanceTimersByTime(OUTSIDE_WATCH_DEBOUNCE_MS - 1);
		expect(onRescan).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(onRescan).toHaveBeenCalledTimes(1);
		expect(onRescan).toHaveBeenCalledWith("node-a");
	});

	it("rescans about 1 s after the last event, and never later than 2 s after the first", () => {
		const { registry, onRescan, watchers } = setup();
		registry.sync(new Map([["node-a", "/Docs/Invoices"]]));
		const watcher = latest(watchers);

		// A quiet single event: due 1 s later.
		watcher.emitChange("a.pdf");
		vi.advanceTimersByTime(999);
		expect(onRescan).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(onRescan).toHaveBeenCalledTimes(1);

		// A continuous stream (an event every 500 ms) still rescans by the 2 s maximum wait.
		onRescan.mockClear();
		for (let i = 0; i < 4; i++) {
			watcher.emitChange(`b-${i}.pdf`);
			vi.advanceTimersByTime(500);
		}
		expect(onRescan).toHaveBeenCalledTimes(1);
	});

	it("ignores .DS_Store and dotfiles, but rescans for a normal name", () => {
		const { registry, onRescan, watchers } = setup();
		registry.sync(new Map([["node-a", "/Docs/Invoices"]]));
		const watcher = latest(watchers);
		watcher.emitChange(".DS_Store");
		watcher.emitChange(".hidden");
		vi.advanceTimersByTime(OUTSIDE_WATCH_DEBOUNCE_MS * 2);
		expect(onRescan).not.toHaveBeenCalled();

		watcher.emitChange("Invoice.pdf");
		vi.advanceTimersByTime(OUTSIDE_WATCH_DEBOUNCE_MS);
		expect(onRescan).toHaveBeenCalledTimes(1);
	});

	it("treats a null filename (an unnamed or overflowed event) as a change worth one rescan", () => {
		const { registry, onRescan, watchers } = setup();
		registry.sync(new Map([["node-a", "/Docs/Invoices"]]));
		latest(watchers).emitChange(null);
		vi.advanceTimersByTime(OUTSIDE_WATCH_DEBOUNCE_MS);
		expect(onRescan).toHaveBeenCalledTimes(1);
	});

	it("isIgnoredOutsideEvent drops dotfiles and keeps everything else", () => {
		expect(isIgnoredOutsideEvent(".DS_Store")).toBe(true);
		expect(isIgnoredOutsideEvent(".obsidian")).toBe(true);
		expect(isIgnoredOutsideEvent("Invoice.pdf")).toBe(false);
		expect(isIgnoredOutsideEvent(null)).toBe(false);
	});
});

describe("folder-source-outside-watcher — two sources, one watcher (E4 guard, G9)", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("two sources on the same folder share one watcher and each refreshes once per change", () => {
		const { registry, watch, onRescan, watchers } = setup();
		registry.sync(
			new Map([
				["node-a", "/Docs/Invoices"],
				["node-b", "/Docs/Invoices"],
			])
		);
		expect(watch).toHaveBeenCalledTimes(1);
		latest(watchers).emitChange("new.pdf");
		vi.advanceTimersByTime(OUTSIDE_WATCH_DEBOUNCE_MS);
		expect(onRescan.mock.calls.map((c) => c[0]).sort()).toEqual(["node-a", "node-b"]);
	});

	it("reference-counts per source: the watcher stays open until its last source leaves", () => {
		const { registry, watchers } = setup();
		registry.sync(
			new Map([
				["node-a", "/Docs/Invoices"],
				["node-b", "/Docs/Invoices"],
			])
		);
		const watcher = latest(watchers);
		registry.sync(new Map([["node-b", "/Docs/Invoices"]]));
		expect(watcher.close).not.toHaveBeenCalled();
		registry.sync(new Map());
		expect(watcher.close).toHaveBeenCalledTimes(1);
	});

	it("closing the last reference removes the entry, so the next sync opens a fresh watcher", () => {
		const { registry, watch, watchers } = setup();
		registry.sync(new Map([["node-a", "/Docs/Invoices"]]));
		registry.sync(new Map());
		registry.sync(new Map([["node-a", "/Docs/Invoices"]]));
		expect(watch).toHaveBeenCalledTimes(2);
		expect(watchers[0].watcher.close).toHaveBeenCalledTimes(1);
	});

	it("a source re-pointed at another folder moves its reference across", () => {
		const { registry, watch, watchers } = setup();
		registry.sync(new Map([["node-a", "/Docs/Invoices"]]));
		registry.sync(new Map([["node-a", "/Docs/Receipts"]]));
		expect(watch.mock.calls.map((c) => c[0])).toEqual(["/Docs/Invoices", "/Docs/Receipts"]);
		expect(watchers[0].watcher.close).toHaveBeenCalledTimes(1);
	});
});

describe("folder-source-outside-watcher — PR-2 R5: keyed by resolved path, not raw text (G9)", () => {
	let dir: string;
	let alias: string | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
		dir = mkdtempSync(join(os.tmpdir(), "atlas-outside-watcher-"));
		alias = undefined;
	});

	afterEach(() => {
		vi.useRealTimers();
		rmSync(dir, { recursive: true, force: true });
		// PR-1 R4 fix: cleaning this up here, not inline after the test's own `expect`, means a failing
		// assertion still removes the alias instead of leaking it in tmpdir.
		if (alias) rmSync(alias, { force: true });
	});

	it("a trailing slash on one source's path is still the same folder as the other's — one watcher, not two", () => {
		const { registry, watch } = setup();
		registry.sync(
			new Map([
				["node-a", dir],
				["node-b", `${dir}/`],
			])
		);
		expect(watch).toHaveBeenCalledTimes(1);
	});

	it("a symlinked alias of the same real folder shares the one watcher its target already has", () => {
		alias = `${dir}-alias`;
		symlinkSync(dir, alias, "dir");
		const { registry, watch } = setup();

		registry.sync(
			new Map([
				["node-a", dir],
				["node-b", alias],
			])
		);

		expect(watch).toHaveBeenCalledTimes(1);
	});
});

describe("folder-source-outside-watcher — PR-1 R1: path normalization is cached per source (G9)", () => {
	let dir: string;
	let other: string | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
		dir = mkdtempSync(join(os.tmpdir(), "atlas-outside-watcher-"));
		other = undefined;
		realpathSyncSpy.mockClear();
	});

	afterEach(() => {
		vi.useRealTimers();
		rmSync(dir, { recursive: true, force: true });
		// R2 fix: cleaning this up here, not inline after the test's own `expect`, means a failing
		// assertion still removes the tmpdir instead of leaking it, matching the PR-1 R4 fix above.
		if (other) rmSync(other, { recursive: true, force: true });
	});

	it("a source whose raw path is unchanged across sync() calls is not re-resolved/re-realpath'd", () => {
		const { registry } = setup();

		registry.sync(new Map([["node-a", dir]]));
		expect(realpathSyncSpy).toHaveBeenCalledTimes(1);

		registry.sync(new Map([["node-a", dir]]));
		registry.sync(new Map([["node-a", dir]]));
		expect(realpathSyncSpy).toHaveBeenCalledTimes(1);
	});

	it("a source whose raw path changes is re-resolved, and the new value still opens one watcher", () => {
		other = mkdtempSync(join(os.tmpdir(), "atlas-outside-watcher-"));
		const { registry, watch } = setup();

		registry.sync(new Map([["node-a", dir]]));
		expect(realpathSyncSpy).toHaveBeenCalledTimes(1);

		registry.sync(new Map([["node-a", other]]));
		expect(realpathSyncSpy).toHaveBeenCalledTimes(2);
		// R3 fix: the registry keys/watches the realpath, not the raw tmpdir path, so compare against
		// realpathSync(dir)/realpathSync(other) — on a stock macOS TMPDIR (/var/folders/... symlinked to
		// /private/var/folders/...) the raw and real paths differ, and asserting the raw paths flaked there.
		expect(watch.mock.calls.map((c) => c[0])).toEqual([realpathSync(dir), realpathSync(other)]);
	});

	it("a source stuck on the textual fallback keeps re-resolving every sync until the target exists", () => {
		const missing = join(dir, "not-yet");
		const { registry } = setup();

		registry.sync(new Map([["node-a", missing]]));
		expect(realpathSyncSpy).toHaveBeenCalledTimes(1);

		// Still missing: a real fix must keep re-resolving, not cache the textual fallback.
		registry.sync(new Map([["node-a", missing]]));
		registry.sync(new Map([["node-a", missing]]));
		expect(realpathSyncSpy).toHaveBeenCalledTimes(3);

		mkdirSync(missing);

		// Now that it resolves, this (and only this) sync should re-realpath it, and the result caches.
		registry.sync(new Map([["node-a", missing]]));
		expect(realpathSyncSpy).toHaveBeenCalledTimes(4);
		registry.sync(new Map([["node-a", missing]]));
		expect(realpathSyncSpy).toHaveBeenCalledTimes(4);
	});

	it("a not-yet-existing symlinked source re-keys onto the realpath another source already has, once its target is created (R1)", () => {
		const target = join(dir, "target");
		const alias = join(dir, "alias");
		symlinkSync(target, alias, "dir");
		const { registry, watch, onRescan, watchers } = setup();

		// The target doesn't exist yet: node-a falls back to the textual alias path.
		registry.sync(new Map([["node-a", alias]]));
		expect(watch).toHaveBeenCalledTimes(1);
		expect(watch.mock.calls[0][0]).toBe(alias);

		mkdirSync(target);

		// node-b now points straight at the real folder. node-a's raw path (`alias`) hasn't changed,
		// but its last normalization failed, so it must still re-resolve here instead of staying keyed
		// to the stale textual path — otherwise the two sources split one real folder across two
		// watchers, against G9. Merging onto one watcher (not growing to two) is what proves the re-key.
		registry.sync(
			new Map([
				["node-a", alias],
				["node-b", target],
			])
		);
		expect(watch).toHaveBeenCalledTimes(2);
		expect(watch.mock.calls[1][0]).not.toBe(alias);

		latest(watchers).emitChange("new.pdf");
		vi.advanceTimersByTime(OUTSIDE_WATCH_DEBOUNCE_MS);
		expect(onRescan.mock.calls.map((c) => c[0]).sort()).toEqual(["node-a", "node-b"]);

		// It's cached now: a further sync with the same raw paths re-resolves neither source.
		realpathSyncSpy.mockClear();
		registry.sync(
			new Map([
				["node-a", alias],
				["node-b", target],
			])
		);
		expect(realpathSyncSpy).not.toHaveBeenCalled();
	});
});

describe("folder-source-outside-watcher — failure, close and retry (G7, E3)", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("an 'error' event closes that watcher", () => {
		const { registry, watchers } = setup();
		registry.sync(new Map([["node-a", "/Docs/Invoices"]]));
		const watcher = latest(watchers);
		watcher.emit("error", new Error("EPERM"));
		expect(watcher.close).toHaveBeenCalledTimes(1);
	});

	it("focus retry reopens a closed watcher once its path resolves again", () => {
		let resolved = true;
		const { registry, watch, watchers } = setup({ resolved: () => resolved });
		registry.sync(new Map([["node-a", "/Volumes/Drive/Docs"]]));
		latest(watchers).emit("error", new Error("unplugged"));

		resolved = false;
		registry.retry();
		expect(watch).toHaveBeenCalledTimes(1);

		resolved = true;
		registry.retry();
		expect(watch).toHaveBeenCalledTimes(2);
	});

	it("a change event while the path no longer resolves closes the watcher, so focus retry reopens it (G7, Linux)", () => {
		let resolved = true;
		const { registry, watch, onRescan, watchers } = setup({ resolved: () => resolved });
		registry.sync(new Map([["node-a", "/Volumes/Drive/Docs"]]));
		const first = latest(watchers);

		// The folder is removed: Linux reports the change but never emits 'error'.
		resolved = false;
		first.emitChange("Docs");
		expect(first.close).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(OUTSIDE_WATCH_DEBOUNCE_MS);
		expect(onRescan).toHaveBeenCalledWith("node-a");

		// Still gone: retry does nothing. Back again: retry reopens a fresh watcher.
		registry.retry();
		expect(watch).toHaveBeenCalledTimes(1);
		resolved = true;
		registry.retry();
		expect(watch).toHaveBeenCalledTimes(2);
		expect(latest(watchers)).not.toBe(first);
		latest(watchers).emitChange("new.pdf");
		vi.advanceTimersByTime(OUTSIDE_WATCH_DEBOUNCE_MS);
		expect(onRescan).toHaveBeenCalledTimes(2);
	});

	it("a change event while the path still resolves keeps the watcher open", () => {
		const { registry, watch, watchers } = setup();
		registry.sync(new Map([["node-a", "/Docs/Invoices"]]));
		latest(watchers).emitChange("new.pdf");
		expect(latest(watchers).close).not.toHaveBeenCalled();
		registry.retry();
		expect(watch).toHaveBeenCalledTimes(1);
	});

	it("a retry while the watcher is still open never opens a second one", () => {
		const { registry, watch } = setup();
		registry.sync(new Map([["node-a", "/Docs/Invoices"]]));
		registry.retry();
		registry.retry();
		expect(watch).toHaveBeenCalledTimes(1);
	});

	it("a synchronous throw from fs.watch is caught and treated as a failed watcher", () => {
		const watch = vi.fn(() => {
			throw new Error("ENOENT");
		});
		const registry = new FolderSourceOutsideWatchers({ watch, isResolved: () => true, onRescan: vi.fn() });
		expect(() => registry.sync(new Map([["node-a", "/Docs/Invoices"]]))).not.toThrow();
		registry.retry();
		expect(watch).toHaveBeenCalledTimes(2);
	});

	it("never opens a watcher for a blank or unresolved path", () => {
		const { registry, watch } = setup({ resolved: (path) => path === "/Docs/Real" });
		registry.sync(
			new Map([
				["node-blank", "   "],
				["node-gone", "/Docs/Gone"],
				["node-real", "/Docs/Real"],
			])
		);
		expect(watch.mock.calls.map((c) => c[0])).toEqual(["/Docs/Real"]);
	});

	it("closeAll closes every watcher, and calling it again is safe", () => {
		const { registry, watchers } = setup();
		registry.sync(
			new Map([
				["node-a", "/Docs/Invoices"],
				["node-b", "/Docs/Receipts"],
			])
		);
		registry.closeAll();
		registry.closeAll();
		expect(watchers[0].watcher.close).toHaveBeenCalledTimes(1);
		expect(watchers[1].watcher.close).toHaveBeenCalledTimes(1);
	});

	it("closeAll drops a pending rescan without firing it", () => {
		const { registry, onRescan, watchers } = setup();
		registry.sync(new Map([["node-a", "/Docs/Invoices"]]));
		latest(watchers).emitChange("late.pdf");
		registry.closeAll();
		vi.advanceTimersByTime(OUTSIDE_WATCH_DEBOUNCE_MS * 3);
		expect(onRescan).not.toHaveBeenCalled();
	});

	it("an old handle's late 'error' cannot close a watcher that retry has since reopened", () => {
		let resolved = true;
		const { registry, watchers } = setup({ resolved: () => resolved });
		registry.sync(new Map([["node-a", "/Docs/Invoices"]]));
		const first = latest(watchers);
		first.emit("error", new Error("first"));
		resolved = true;
		registry.retry();
		const second = latest(watchers);
		first.emit("error", new Error("late"));
		expect(second.close).not.toHaveBeenCalled();
	});
});

describe("folder-source-outside-watcher — fence checks on the module's own source", () => {
	const src = readFileSync(join(__dirname, "../..", "src/folder-source-outside-watcher.ts"), "utf8");

	it("contains no write API, so the watched folder is only ever read (F3)", () => {
		expect(src).not.toMatch(/\b(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync|rename|renameSync|copyFile|copyFileSync|cp|cpSync|truncate|truncateSync|symlink|symlinkSync|chmod|chmodSync|utimes|utimesSync|createWriteStream)\s*\(/);
	});

	it("schedules no timer of its own: its only timer is the shared debounce", () => {
		expect(src).not.toMatch(/\bsetTimeout\b|\bsetInterval\b/);
	});
});
