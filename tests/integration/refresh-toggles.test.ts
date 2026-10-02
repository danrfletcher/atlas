import { describe, expect, it, vi } from "vitest";
import { AtlasExplorerView } from "../../src/explorer-view";
import { MIN_REFRESH_MINUTES, RefreshEveryTimers, RefreshTimerDeps } from "../../src/api-refresh-timer";
import { ApiSourceConfig, FolderSourceConfig, View, ViewNode } from "../../src/types";

/** G10: "Folder source honors refresh-on-view-load and refresh-every-N-minutes toggles identically
 * to API sources, reusing the same scheduler/hook." Exercises `AtlasExplorerView`'s private
 * `refreshApiSourcesOnViewLoad`/`syncRefreshTimers` directly via the same `(prototype as
 * ...).method.call(fake, ...)` pattern as `explorer-view-sort-truncate-helpers.ts`, since both
 * methods are the actual "hook" the spec refers to and neither is reachable through a public API. */

type ProtoMethods = Record<string, (...args: unknown[]) => unknown>;
const proto = AtlasExplorerView.prototype as unknown as ProtoMethods;

/** A fully fake clock/scheduler — mirrors `tests/unit/refresh-timer.test.ts`'s `FakeClock` so this
 * suite needs zero real elapsed time regardless of how many minutes of "Refresh every X minutes" it
 * exercises. */
class FakeClock implements RefreshTimerDeps {
	private nowMs = 0;
	private nextHandle = 1;
	private timers = new Map<number, { fireAt: number; cb: () => void }>();

	now = (): number => this.nowMs;

	setTimeoutFn = (cb: () => void, ms: number): unknown => {
		const handle = this.nextHandle++;
		this.timers.set(handle, { fireAt: this.nowMs + ms, cb });
		return handle;
	};

	clearTimeoutFn = (handle: unknown): void => {
		this.timers.delete(handle as number);
	};

	advance(ms: number): void {
		this.nowMs += ms;
		for (;;) {
			const due = [...this.timers.entries()].filter(([, t]) => t.fireAt <= this.nowMs).sort((a, b) => a[1].fireAt - b[1].fireAt);
			if (due.length === 0) return;
			const [handle, timer] = due[0];
			this.timers.delete(handle);
			timer.cb();
		}
	}

	pendingCount(): number {
		return this.timers.size;
	}
}

function apiSource(overrides: Partial<ApiSourceConfig> = {}): ApiSourceConfig {
	return {
		url: "https://example.com",
		method: "GET",
		mapping: { idField: "id", labelField: "label" },
		mode: "append",
		refreshOnViewLoad: false,
		...overrides,
	};
}

function folderSource(overrides: Partial<FolderSourceConfig> = {}): FolderSourceConfig {
	return {
		location: "inside",
		path: "Projects",
		showFiles: true,
		showFolders: true,
		refreshOnViewLoad: false,
		...overrides,
	};
}

function metaNode(id: string, overrides: Partial<ViewNode> = {}): ViewNode {
	return { id, type: "meta", label: id, children: [], ...overrides };
}

interface Fake {
	plugin: { viewsManager: { getActiveView: () => View } };
	refreshEveryTimers: RefreshEveryTimers;
	collectApiSourceNodes: (...args: unknown[]) => unknown;
	collectFolderSourceNodes: (...args: unknown[]) => unknown;
	collectCsvSourceNodes: (...args: unknown[]) => unknown;
	collectMarkdownTableSourceNodes: (...args: unknown[]) => unknown;
	refreshApiSource: ReturnType<typeof vi.fn>;
	refreshFolderSource: ReturnType<typeof vi.fn>;
	refreshCsvSource: ReturnType<typeof vi.fn>;
	refreshMarkdownTableSource: ReturnType<typeof vi.fn>;
}

function makeFake(view: View, clock: FakeClock): Fake {
	return {
		plugin: { viewsManager: { getActiveView: () => view } },
		refreshEveryTimers: new RefreshEveryTimers(clock),
		collectApiSourceNodes: proto.collectApiSourceNodes,
		collectFolderSourceNodes: proto.collectFolderSourceNodes,
		collectCsvSourceNodes: proto.collectCsvSourceNodes,
		collectMarkdownTableSourceNodes: proto.collectMarkdownTableSourceNodes,
		refreshApiSource: vi.fn(),
		refreshFolderSource: vi.fn(),
		refreshCsvSource: vi.fn(),
		refreshMarkdownTableSource: vi.fn(),
	};
}

function callRefreshOnViewLoad(fake: Fake): void {
	(proto.refreshApiSourcesOnViewLoad as (this: Fake) => void).call(fake);
}

function callSyncRefreshTimers(fake: Fake, view: View): void {
	(proto.syncRefreshTimers as (this: Fake, v: View) => void).call(fake, view);
}

const SOURCE_TYPES: { label: string; build: (overrides?: Record<string, unknown>) => ViewNode }[] = [
	{
		label: "api",
		build: (overrides = {}) => metaNode("n1", { apiSource: apiSource(overrides as Partial<ApiSourceConfig>) }),
	},
	{
		label: "folder",
		build: (overrides = {}) => metaNode("n1", { folderSource: folderSource(overrides as Partial<FolderSourceConfig>) }),
	},
];

describe.each(SOURCE_TYPES)("G10 — refresh-on-view-load honored identically for $label sources", ({ label, build }) => {
	it(`fires exactly one refresh when ${label}Source.refreshOnViewLoad is on`, () => {
		const clock = new FakeClock();
		const node = build({ refreshOnViewLoad: true });
		const view: View = { id: "v1", name: "Default", inboxMode: "view", root: [node] };
		const fake = makeFake(view, clock);

		callRefreshOnViewLoad(fake);

		if (label === "api") {
			expect(fake.refreshApiSource).toHaveBeenCalledTimes(1);
			expect(fake.refreshFolderSource).not.toHaveBeenCalled();
		} else {
			expect(fake.refreshFolderSource).toHaveBeenCalledTimes(1);
			expect(fake.refreshApiSource).not.toHaveBeenCalled();
		}
	});

	it(`does not refresh when ${label}Source.refreshOnViewLoad is off`, () => {
		const clock = new FakeClock();
		const node = build({ refreshOnViewLoad: false });
		const view: View = { id: "v1", name: "Default", inboxMode: "view", root: [node] };
		const fake = makeFake(view, clock);

		callRefreshOnViewLoad(fake);

		expect(fake.refreshApiSource).not.toHaveBeenCalled();
		expect(fake.refreshFolderSource).not.toHaveBeenCalled();
	});
});

describe.each(SOURCE_TYPES)("G10 — refresh-every-N-minutes honored identically for $label sources, via the same RefreshEveryTimers scheduler", ({ label, build }) => {
	it(`a never-refreshed ${label}Source with the toggle on fires one immediate catch-up refresh`, () => {
		const clock = new FakeClock();
		const node = build({ refreshEveryMinutesEnabled: true, refreshEveryMinutes: MIN_REFRESH_MINUTES });
		const view: View = { id: "v1", name: "Default", inboxMode: "view", root: [node] };
		const fake = makeFake(view, clock);

		callSyncRefreshTimers(fake, view);
		clock.advance(0);

		if (label === "api") {
			expect(fake.refreshApiSource).toHaveBeenCalledTimes(1);
		} else {
			expect(fake.refreshFolderSource).toHaveBeenCalledTimes(1);
		}
	});

	it(`re-syncing the same ${label}Source interval does not double-fire`, () => {
		const clock = new FakeClock();
		const node = build({ refreshEveryMinutesEnabled: true, refreshEveryMinutes: MIN_REFRESH_MINUTES });
		const view: View = { id: "v1", name: "Default", inboxMode: "view", root: [node] };
		const fake = makeFake(view, clock);

		callSyncRefreshTimers(fake, view);
		clock.advance(0);
		callSyncRefreshTimers(fake, view);

		const spy = label === "api" ? fake.refreshApiSource : fake.refreshFolderSource;
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it(`fires again after the configured interval elapses for ${label}Source`, () => {
		const clock = new FakeClock();
		const node = build({ refreshEveryMinutesEnabled: true, refreshEveryMinutes: MIN_REFRESH_MINUTES });
		const view: View = { id: "v1", name: "Default", inboxMode: "view", root: [node] };
		const fake = makeFake(view, clock);

		callSyncRefreshTimers(fake, view);
		clock.advance(0);
		clock.advance(MIN_REFRESH_MINUTES * 60 * 1000);

		const spy = label === "api" ? fake.refreshApiSource : fake.refreshFolderSource;
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it(`toggling refresh-every-N-minutes off stops the ${label}Source's timer`, () => {
		const clock = new FakeClock();
		const onNode = build({ refreshEveryMinutesEnabled: true, refreshEveryMinutes: MIN_REFRESH_MINUTES });
		const view: View = { id: "v1", name: "Default", inboxMode: "view", root: [onNode] };
		const fake = makeFake(view, clock);
		callSyncRefreshTimers(fake, view);
		clock.advance(0);
		expect(fake.refreshEveryTimers.isScheduled("n1")).toBe(true);

		const offNode = build({ refreshEveryMinutesEnabled: false });
		const offView: View = { id: "v1", name: "Default", inboxMode: "view", root: [offNode] };
		callSyncRefreshTimers(fake, offView);

		expect(fake.refreshEveryTimers.isScheduled("n1")).toBe(false);
	});
});
