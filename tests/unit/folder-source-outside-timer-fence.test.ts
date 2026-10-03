import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listOutsideChildren, resolveOutsidePath } from "../../src/folder-source-outside";
import { FolderSourcePathStore } from "../../src/folder-source-path-store";
import { AtlasExplorerView } from "../../src/explorer-view";
import { buildFolderSourceChildren } from "../../src/folder-source";
import { View, ViewNode } from "../../src/types";
import { meta } from "../integration/create-from-meta-fixtures";

/** F10: "connection checks happen only on load and on focus-regain — never via a timer or poll."
 * Mirrors `tests/unit/fence-checks.test.ts`'s static-source-text + behavioral pattern (F5's disk-write
 * fence), swapped to a timer/poll construct and scoped to every file PR-5's Outside-Vault work touches:
 * the two new dedicated modules in full, plus the specific Outside-Vault slices added to the four
 * existing files they wire into. The narrower spot-check in `folder-source-outside-indicator.test.ts`
 * covers two of these same slices already — this file is the full dedicated sweep the spec calls for,
 * so some overlap with it is expected rather than a sign of redundant coverage elsewhere. */

const root = join(__dirname, "../..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

const TIMER_CONSTRUCT = /\b(setInterval|setTimeout|requestAnimationFrame|requestIdleCallback|queueMicrotask|FileSystemWatcher|fs\.watch|fs\.watchFile|setImmediate)\b/;

function slice(file: string, startMarker: string, endMarker: string): string {
	const src = read(file);
	const start = src.indexOf(startMarker);
	expect(start, `${startMarker} not found in ${file}`).toBeGreaterThanOrEqual(0);
	const end = src.indexOf(endMarker, start + startMarker.length);
	expect(end, `${endMarker} not found after ${startMarker} in ${file}`).toBeGreaterThan(start);
	return src.slice(start, end);
}

describe("F10 static sweep — the two new Outside-Vault modules have no timer/poll construct anywhere", () => {
	it("src/folder-source-outside.ts (path resolution + listing) is fully clean", () => {
		expect(read("src/folder-source-outside.ts")).not.toMatch(TIMER_CONSTRUCT);
	});

	it("src/folder-source-path-store.ts (device-local storage) is fully clean", () => {
		expect(read("src/folder-source-path-store.ts")).not.toMatch(TIMER_CONSTRUCT);
	});
});

describe("F10 static sweep — the Outside-Vault-specific additions to existing files have no timer/poll construct", () => {
	it("folder-source.ts's buildOutsideFolderChildren (E8 reconciliation) is clean", () => {
		const body = slice("src/folder-source.ts", "function buildOutsideFolderChildren(", "\n/** G16/E1:");
		expect(body).not.toMatch(TIMER_CONSTRUCT);
	});

	it("views.ts's refreshFolderSource (the outsidePath-aware reconcile call site) is clean", () => {
		const body = slice("src/views.ts", "refreshFolderSource(viewId: string", "\n\t}");
		expect(body).not.toMatch(TIMER_CONSTRUCT);
	});

	it("views.ts's collectOutsideFolderSourceNodeIdPairs (duplicate-node path copying) is clean", () => {
		const body = slice("src/views.ts", "export function collectOutsideFolderSourceNodeIdPairs(", "\n}");
		expect(body).not.toMatch(TIMER_CONSTRUCT);
	});

	it("explorer-view.ts's refreshApiSourcesOnViewLoad (recheck-on-load, including the Outside-mandatory branch) is clean", () => {
		const body = slice("src/explorer-view.ts", "private refreshApiSourcesOnViewLoad(): void {", "\n\t}");
		expect(body).not.toMatch(TIMER_CONSTRUCT);
	});

	it("explorer-view.ts's refreshOutsideFolderSourcesOnFocus (recheck-on-focus-regain) is clean", () => {
		const body = slice("src/explorer-view.ts", "private refreshOutsideFolderSourcesOnFocus(): void {", "\n\t}");
		expect(body).not.toMatch(TIMER_CONSTRUCT);
	});

	it("explorer-view.ts's renderNode (the row-level indicator dot plus drag/nest/rename gating) is clean", () => {
		const body = slice("src/explorer-view.ts", "private async renderNode(node: ViewNode", "\n\t// --- inbox");
		expect(body).not.toMatch(TIMER_CONSTRUCT);
	});

	it("api-source-modal.ts's renderOutsidePathField (the modal's own live indicator) is clean", () => {
		const body = slice("src/api-source-modal.ts", "private renderOutsidePathField(contentEl: HTMLElement): void {", "\n\t}");
		expect(body).not.toMatch(TIMER_CONSTRUCT);
	});
});

describe("F10 behavioral check — driving every Outside-Vault connection-check path never schedules a timer", () => {
	let tmpDir: string;
	let setIntervalSpy: ReturnType<typeof vi.spyOn>;
	let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-outside-timer-fence-"));
		setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		setIntervalSpy.mockRestore();
		setTimeoutSpy.mockRestore();
	});

	it("resolveOutsidePath and listOutsideChildren never schedule a timer", () => {
		resolveOutsidePath(tmpDir);
		resolveOutsidePath("/definitely/does/not/exist");
		listOutsideChildren(tmpDir, { showFiles: true, showFolders: true });

		expect(setIntervalSpy).not.toHaveBeenCalled();
		expect(setTimeoutSpy).not.toHaveBeenCalled();
	});

	it("FolderSourcePathStore get/set/delete never schedule a timer", () => {
		const store = new FolderSourcePathStore({
			loadLocalStorage: vi.fn(() => null),
			saveLocalStorage: vi.fn(),
		});
		store.set("node-a", tmpDir);
		store.get("node-a");
		store.delete("node-a");

		expect(setIntervalSpy).not.toHaveBeenCalled();
		expect(setTimeoutSpy).not.toHaveBeenCalled();
	});

	it("buildFolderSourceChildren's Outside-Vault branch never schedules a timer, resolved or unresolved", () => {
		const source = { location: "outside" as const, path: "", showFiles: true, showFolders: true, refreshOnViewLoad: false };
		buildFolderSourceChildren({ getAbstractFileByPath: () => null }, source, [], (ref) => ({ id: "x", type: "unit", ref, children: [] }), undefined, tmpDir);
		buildFolderSourceChildren({ getAbstractFileByPath: () => null }, source, [], (ref) => ({ id: "x", type: "unit", ref, children: [] }), undefined, "/nowhere");

		expect(setIntervalSpy).not.toHaveBeenCalled();
		expect(setTimeoutSpy).not.toHaveBeenCalled();
	});

	it("refreshOutsideFolderSourcesOnFocus (the real focus-regain handler) never schedules a timer", () => {
		const outside = meta("outside-x", "Folder");
		outside.folderSource = { location: "outside", path: "", showFiles: true, showFolders: true, refreshOnViewLoad: false };
		const view: View = { id: "v1", name: "Default", inboxMode: "view", root: [outside] };
		const proto = AtlasExplorerView.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
		const fake = {
			plugin: {
				viewsManager: { getActiveView: () => view, refreshFolderSource: vi.fn() },
				folderSourcePathStore: { get: vi.fn(() => tmpDir) },
			},
			collectFolderSourceNodes: proto.collectFolderSourceNodes,
			refreshFolderSource: proto.refreshFolderSource,
			render: vi.fn(),
		};

		proto.refreshOutsideFolderSourcesOnFocus.call(fake as unknown as Record<string, unknown>);

		expect(setIntervalSpy).not.toHaveBeenCalled();
		expect(setTimeoutSpy).not.toHaveBeenCalled();
	});

	it("resolving a node that doesn't exist on disk still never schedules a retry timer (no backoff/poll-until-found behavior)", () => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		const result = resolveOutsidePath(tmpDir);

		expect(result).toBe(false);
		expect(setIntervalSpy).not.toHaveBeenCalled();
		expect(setTimeoutSpy).not.toHaveBeenCalled();
	});
});
