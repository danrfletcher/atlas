import type { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveOutsidePath } from "../../src/folder-source-outside";
import { FolderSourceOutsideWatchers } from "../../src/folder-source-outside-watcher";
import { ViewsManager } from "../../src/views";
import { FolderSourceConfig, ViewNode, unitRefKey } from "../../src/types";

/** PR-2 (G6/G9, GP5): end to end against a real temp folder and the real `fs.watch`. Events are async, so
 * these tests wait on the real debounce (about 1 s) rather than faking timers. Only the rows are
 * asserted, with the same `ViewsManager` the plugin uses. */

const WAIT_MS = 6000;

/** T3/T4 (PR-1.B1): under load from the rest of the suite, a real `fs.watch`/FSEvents change was
 * observed not just late but never delivered at all — a wait exhausted its whole window with no sign
 * the OS ever told us about the write. Raising the timeout alone doesn't fix a dropped event. Per the
 * documented fix for this exact risk ("retry within a bound"), `retryingTrigger` re-runs the same,
 * idempotent filesystem action a few times if the assertion hasn't settled yet. If the first run of
 * `action` was the one that got lost, a later run is a fresh, genuine OS event the watcher can catch;
 * if the original event was merely slow, the first attempt's own `vi.waitFor` already succeeds and
 * `action` never runs again. Every call site below passes an `action` that is safe to repeat: it
 * either writes the same path again or checks the filesystem before touching it. */
async function retryingTrigger(action: () => void, assertion: () => void, attempts = 3, perAttemptMs = 5000): Promise<void> {
	let lastErr: unknown;
	for (let attempt = 0; attempt < attempts; attempt++) {
		action();
		try {
			await vi.waitFor(assertion, { timeout: perAttemptMs });
			return;
		} catch (err) {
			lastErr = err;
		}
	}
	throw lastErr;
}
const RETRY_TEST_TIMEOUT_MS = 35000;

/** Forces a fresh, real `fs.watch` event on `dir` without changing which rows should exist. Used as the
 * `action` for a retry whose actual filesystem step (a rename or a delete) is already done and can't be
 * repeated — e.g. the file to rename or delete no longer exists. `start.pdf` is written once per test by
 * `beforeEach` and never touched by the tests that use this helper, so it's always there to poke. */
function pokeDir(): void {
	const now = new Date();
	fs.utimesSync(path.join(dir, "start.pdf"), now, now);
}

let dir: string;
let vm: ViewsManager;
let registry: FolderSourceOutsideWatchers;
let rescans: string[];

function ownerNode(): ViewNode {
	const folderSource: FolderSourceConfig = { type: "folder", location: "outside", path: "", showFiles: true, showFolders: true, mode: "merge" };
	return { id: "owner", type: "meta", label: "Invoices", children: [], folderSource };
}

function rowNames(): string[] {
	const owner = vm.getViews()[0].root[0];
	return owner.children.map((c) => (c.ref ? c.ref.path : c.id));
}

function findRow(name: string): ViewNode | undefined {
	return vm.getViews()[0].root[0].children.find((c) => c.ref?.path === name);
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-outside-live-"));
	fs.writeFileSync(path.join(dir, "start.pdf"), "x");
	rescans = [];
	vm = new ViewsManager({} as App, [{ id: "v1", name: "Default", inboxMode: "view" as const, root: [ownerNode()] }], "v1", () => {});
	vm.refreshFolderSource("v1", "owner", dir);
	registry = new FolderSourceOutsideWatchers({
		isResolved: (p) => resolveOutsidePath(p),
		onRescan: (nodeId) => {
			rescans.push(nodeId);
			vm.refreshFolderSource("v1", nodeId, dir);
		},
	});
	registry.sync(new Map([["owner", dir]]));
});

afterEach(() => {
	registry.closeAll();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("outside folder live refresh, end to end (GP5)", () => {
	it("a new PDF dropped into the folder appears as a row within about two seconds", async () => {
		const started = Date.now();
		let attempts = 0;
		await retryingTrigger(
			() => {
				attempts++;
				fs.writeFileSync(path.join(dir, "new.pdf"), "x");
			},
			() => expect(rowNames()).toContain("new.pdf")
		);
		// The "within about two seconds" budget only holds when the first real fs.watch event actually
		// arrives; a retry means it was lost once under load (see T3/T4), at which point only "it shows
		// up eventually" is being asserted, not the speed.
		if (attempts === 1) expect(Date.now() - started).toBeLessThan(3000);
	}, RETRY_TEST_TIMEOUT_MS);

	it("a rename keeps the same row and follows the new name", async () => {
		await retryingTrigger(
			() => fs.writeFileSync(path.join(dir, "old.pdf"), "x"),
			() => expect(rowNames()).toContain("old.pdf")
		);
		const row = findRow("old.pdf");

		await retryingTrigger(
			() => {
				if (fs.existsSync(path.join(dir, "old.pdf"))) fs.renameSync(path.join(dir, "old.pdf"), path.join(dir, "renamed.pdf"));
				else pokeDir();
			},
			() => expect(rowNames()).toContain("renamed.pdf")
		);
		expect(findRow("renamed.pdf")).toBe(row);
		expect(rowNames()).not.toContain("old.pdf");
	}, RETRY_TEST_TIMEOUT_MS);

	it("a deleted file is demoted to a merge placeholder, and the row is gone", async () => {
		await retryingTrigger(
			() => fs.writeFileSync(path.join(dir, "gone.pdf"), "x"),
			() => expect(rowNames()).toContain("gone.pdf")
		);

		await retryingTrigger(
			() => {
				if (fs.existsSync(path.join(dir, "gone.pdf"))) fs.rmSync(path.join(dir, "gone.pdf"));
				else pokeDir();
			},
			() => expect(rowNames()).not.toContain("gone.pdf")
		);
		const owner = vm.getViews()[0].root[0];
		expect(owner.apiItemState?.[unitRefKey({ kind: "file", path: "gone.pdf" })]?.notFound).toBe(true);
	}, RETRY_TEST_TIMEOUT_MS);

	it("two sources on the same folder share one watcher and each rescans once for one change", async () => {
		const second: ViewNode = { ...ownerNode(), id: "owner-2" };
		vm.getViews()[0].root.push(second);
		registry.sync(
			new Map([
				["owner", dir],
				["owner-2", dir],
			])
		);

		await retryingTrigger(
			() => fs.writeFileSync(path.join(dir, "shared.pdf"), "x"),
			() => expect(rescans.length).toBe(2)
		);
		expect([...rescans].sort()).toEqual(["owner", "owner-2"]);
	}, RETRY_TEST_TIMEOUT_MS);
});

describe("outside folder live refresh — what must never trigger a rescan", () => {
	it("a change below the direct children (an ancestor of a vault, E7) does not rescan", async () => {
		fs.mkdirSync(path.join(dir, "Vault"));
		await new Promise((resolve) => setTimeout(resolve, 1500));
		rescans.length = 0;
		fs.writeFileSync(path.join(dir, "Vault", "deep.md"), "x");
		await new Promise((resolve) => setTimeout(resolve, 2500));
		expect(rescans).toEqual([]);
	}, 10000);

	it("editing an existing file fires an event, but the listing is unchanged, so nothing is saved", async () => {
		await retryingTrigger(
			() => fs.writeFileSync(path.join(dir, "keep.pdf"), "x"),
			() => expect(rowNames()).toContain("keep.pdf")
		);
		const persist = vi.fn();
		vm = new ViewsManager({} as App, [{ id: "v1", name: "Default", inboxMode: "view" as const, root: [ownerNode()] }], "v1", persist);
		vm.refreshFolderSource("v1", "owner", dir);
		persist.mockClear();
		rescans.length = 0;

		let editCount = 0;
		await retryingTrigger(
			() => fs.writeFileSync(path.join(dir, "keep.pdf"), `edited-${editCount++}`),
			() => expect(rescans).toEqual(["owner"])
		);
		expect(persist).not.toHaveBeenCalled();
	}, RETRY_TEST_TIMEOUT_MS);
});

/** F3: every entry under `root` with its size, change times and content, so any write Atlas made would show. */
function snapshotFolder(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const full = path.join(dir, entry.name);
			const st = fs.statSync(full);
			const content = entry.isDirectory() ? "" : fs.readFileSync(full, "utf8");
			out.push(`${path.relative(root, full)}|${entry.isDirectory() ? "dir" : "file"}|${st.size}|${st.mtimeMs}|${st.ctimeMs}|${content}`);
			if (entry.isDirectory()) walk(full);
		}
	};
	walk(root);
	return out;
}

describe("outside folder is only ever read (F3)", () => {
	it("Atlas's rescans of a changing folder leave its contents unchanged", async () => {
		fs.mkdirSync(path.join(dir, "Sub"));
		fs.writeFileSync(path.join(dir, "Sub", "inner.md"), "inner");
		// The test makes every change; Atlas only reads. The snapshot is taken after the last change.
		fs.writeFileSync(path.join(dir, "new.pdf"), "x");
		fs.renameSync(path.join(dir, "start.pdf"), path.join(dir, "moved.pdf"));
		const afterTestWrites = snapshotFolder(dir);

		// The rows reach the final state only once Atlas has rescanned past every change.
		await vi.waitFor(() => expect(rowNames()).toEqual(expect.arrayContaining(["new.pdf", "moved.pdf"])), { timeout: WAIT_MS });
		expect(rowNames()).not.toContain("start.pdf");
		expect(rescans.length).toBeGreaterThan(0);
		// Let any late event fire its rescan before the final comparison.
		await new Promise((resolve) => setTimeout(resolve, 1500));

		expect(snapshotFolder(dir)).toEqual(afterTestWrites);
	}, WAIT_MS * 2 + 2000);
});
