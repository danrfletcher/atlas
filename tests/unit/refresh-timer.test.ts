import { describe, expect, it } from "vitest";
import { clampRefreshMinutes, MAX_REFRESH_MINUTES, MIN_REFRESH_MINUTES, RefreshEveryTimers, RefreshTimerDeps, RefreshTimerNode, validateRefreshMinutes } from "../../src/api-refresh-timer";

describe("validateRefreshMinutes — G5b inline validation", () => {
	it("rejects blank input", () => {
		const result = validateRefreshMinutes("");
		expect(result.ok).toBe(false);
	});

	it("rejects whitespace-only input", () => {
		const result = validateRefreshMinutes("   ");
		expect(result.ok).toBe(false);
	});

	it("rejects non-numeric input", () => {
		const result = validateRefreshMinutes("abc");
		expect(result.ok).toBe(false);
	});

	it("rejects a fractional number", () => {
		const result = validateRefreshMinutes("5.5");
		expect(result.ok).toBe(false);
	});

	it("rejects zero", () => {
		const result = validateRefreshMinutes("0");
		expect(result.ok).toBe(false);
	});

	it("rejects a negative number", () => {
		const result = validateRefreshMinutes("-5");
		expect(result.ok).toBe(false);
	});

	it("rejects a value below the minimum", () => {
		const result = validateRefreshMinutes(String(MIN_REFRESH_MINUTES - 1));
		expect(result.ok).toBe(false);
	});

	it("accepts exactly the minimum", () => {
		const result = validateRefreshMinutes(String(MIN_REFRESH_MINUTES));
		expect(result).toEqual({ ok: true, minutes: MIN_REFRESH_MINUTES });
	});

	it("accepts a value above the minimum, tolerating surrounding whitespace", () => {
		const result = validateRefreshMinutes(` ${MIN_REFRESH_MINUTES + 10} `);
		expect(result).toEqual({ ok: true, minutes: MIN_REFRESH_MINUTES + 10 });
	});

	it("R2: rejects a value above the maximum — anything higher would overflow setTimeout's 32-bit ms limit", () => {
		const result = validateRefreshMinutes(String(MAX_REFRESH_MINUTES + 1));
		expect(result.ok).toBe(false);
	});

	it("R2: accepts exactly the maximum", () => {
		const result = validateRefreshMinutes(String(MAX_REFRESH_MINUTES));
		expect(result).toEqual({ ok: true, minutes: MAX_REFRESH_MINUTES });
	});
});

describe("clampRefreshMinutes — load-time safety net for a hand-edited data.json", () => {
	it("leaves a valid value untouched", () => {
		expect(clampRefreshMinutes(MIN_REFRESH_MINUTES + 5)).toBe(MIN_REFRESH_MINUTES + 5);
	});

	it("clamps a below-minimum value up to the minimum, rather than rejecting it", () => {
		expect(clampRefreshMinutes(1)).toBe(MIN_REFRESH_MINUTES);
	});

	it("clamps zero up to the minimum", () => {
		expect(clampRefreshMinutes(0)).toBe(MIN_REFRESH_MINUTES);
	});

	it("R2: clamps a value above the maximum down, rather than letting it overflow setTimeout's 32-bit ms limit", () => {
		expect(clampRefreshMinutes(MAX_REFRESH_MINUTES + 100000)).toBe(MAX_REFRESH_MINUTES);
	});

	it("R2: leaves exactly the maximum untouched", () => {
		expect(clampRefreshMinutes(MAX_REFRESH_MINUTES)).toBe(MAX_REFRESH_MINUTES);
	});
});

/** A fully fake clock/scheduler — every timer here fires only when the test explicitly advances the
 * clock and flushes due callbacks, so this suite has zero real elapsed time regardless of how many
 * minutes of "Refresh every X minutes" it exercises (mirrors the existing E3 pattern in
 * api-source-refresh.test.ts of injecting a fake `scheduleTimeout` rather than waiting for real time). */
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

	/** Advances the clock and fires every timer whose time has come, including ones newly scheduled by
	 * a callback that just fired (the real interval timer's own next tick), in the order they're due. */
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

function node(id: string, overrides: Partial<RefreshTimerNode> = {}): RefreshTimerNode {
	return { id, enabled: true, minutes: MIN_REFRESH_MINUTES, lastFetchedAt: null, ...overrides };
}

describe("RefreshEveryTimers — G5b/F3", () => {
	it("a value below the minimum is clamped up before scheduling, not rejected", () => {
		const clock = new FakeClock();
		const timers = new RefreshEveryTimers(clock);
		const fired: string[] = [];
		timers.sync([node("n1", { minutes: 1, lastFetchedAt: 0 })], (id) => fired.push(id));
		// lastFetchedAt: 0 at time 0 is not stale yet under the clamped 5-minute interval.
		clock.advance(MIN_REFRESH_MINUTES * 60 * 1000 - 1);
		expect(fired).toEqual([]);
		clock.advance(1);
		expect(fired).toEqual(["n1"]);
	});

	it("starts a timer only for a Folder that's enabled", () => {
		const clock = new FakeClock();
		const timers = new RefreshEveryTimers(clock);
		timers.sync([node("n1", { enabled: false })], () => {
			throw new Error("must not fire for a disabled Folder");
		});
		expect(timers.isScheduled("n1")).toBe(false);
	});

	it("a never-refreshed Folder (lastFetchedAt null) fires one immediate catch-up refresh", () => {
		const clock = new FakeClock();
		const timers = new RefreshEveryTimers(clock);
		const fired: string[] = [];
		timers.sync([node("n1", { lastFetchedAt: null })], (id) => fired.push(id));
		clock.advance(0);
		expect(fired).toEqual(["n1"]);
	});

	it("a Folder stale by more than its own interval fires one immediate catch-up, then resumes the normal interval — never a burst", () => {
		const clock = new FakeClock();
		const timers = new RefreshEveryTimers(clock);
		const fired: string[] = [];
		const intervalMs = MIN_REFRESH_MINUTES * 60 * 1000;
		// Last fetched 10 intervals ago — a naive re-fire-every-missed-tick timer would burst 10 times.
		timers.sync([node("n1", { lastFetchedAt: -10 * intervalMs })], (id) => fired.push(id));
		clock.advance(0);
		expect(fired).toEqual(["n1"]);
		// Resumes its normal interval from *now*, not from the missed schedule — no second fire until a
		// full interval passes again.
		clock.advance(intervalMs - 1);
		expect(fired).toEqual(["n1"]);
		clock.advance(1);
		expect(fired).toEqual(["n1", "n1"]);
	});

	it("a Folder that's not yet stale waits out the remainder of its interval before firing, with no catch-up", () => {
		const clock = new FakeClock();
		const timers = new RefreshEveryTimers(clock);
		const fired: string[] = [];
		const intervalMs = MIN_REFRESH_MINUTES * 60 * 1000;
		timers.sync([node("n1", { lastFetchedAt: 0 })], (id) => fired.push(id));
		clock.advance(intervalMs - 1);
		expect(fired).toEqual([]);
		clock.advance(1);
		expect(fired).toEqual(["n1"]);
	});

	it("re-syncing with an unchanged interval leaves the existing timer untouched — no reset, no double-fire", () => {
		const clock = new FakeClock();
		const timers = new RefreshEveryTimers(clock);
		const fired: string[] = [];
		const intervalMs = MIN_REFRESH_MINUTES * 60 * 1000;
		timers.sync([node("n1", { lastFetchedAt: 0 })], (id) => fired.push(id));
		clock.advance(intervalMs / 2);
		// A second sync (e.g. after an unrelated render) with the same minutes must not restart the clock.
		timers.sync([node("n1", { lastFetchedAt: 0 })], (id) => fired.push(id));
		clock.advance(intervalMs / 2);
		expect(fired).toEqual(["n1"]);
	});

	it("re-syncing with a changed interval reschedules cleanly from now, not from the old schedule", () => {
		const clock = new FakeClock();
		const timers = new RefreshEveryTimers(clock);
		const fired: string[] = [];
		const intervalMs = MIN_REFRESH_MINUTES * 60 * 1000;
		timers.sync([node("n1", { minutes: MIN_REFRESH_MINUTES, lastFetchedAt: 0 })], (id) => fired.push(id));
		clock.advance(intervalMs / 2);
		const newMinutes = MIN_REFRESH_MINUTES * 3;
		timers.sync([node("n1", { minutes: newMinutes, lastFetchedAt: 0 })], (id) => fired.push(id));
		// The old interval's original due time has now passed, but the reschedule must not fire early.
		clock.advance(intervalMs / 2);
		expect(fired).toEqual([]);
		clock.advance(newMinutes * 60 * 1000 - intervalMs);
		expect(fired).toEqual(["n1"]);
	});

	it("a Folder no longer eligible (toggle turned off) has its timer stopped by the next sync", () => {
		const clock = new FakeClock();
		const timers = new RefreshEveryTimers(clock);
		const fired: string[] = [];
		timers.sync([node("n1", { lastFetchedAt: 0 })], (id) => fired.push(id));
		expect(timers.isScheduled("n1")).toBe(true);
		timers.sync([node("n1", { enabled: false, lastFetchedAt: 0 })], (id) => fired.push(id));
		expect(timers.isScheduled("n1")).toBe(false);
		clock.advance(MIN_REFRESH_MINUTES * 60 * 1000 * 5);
		expect(fired).toEqual([]);
	});

	it("a Folder removed entirely from the synced list (source removed/deleted) stops its timer too", () => {
		const clock = new FakeClock();
		const timers = new RefreshEveryTimers(clock);
		timers.sync([node("n1", { lastFetchedAt: 0 })], () => {});
		expect(timers.isScheduled("n1")).toBe(true);
		timers.sync([], () => {});
		expect(timers.isScheduled("n1")).toBe(false);
		expect(clock.pendingCount()).toBe(0);
	});

	it("stop() cancels one Folder's timer without disturbing another's", () => {
		const clock = new FakeClock();
		const timers = new RefreshEveryTimers(clock);
		const fired: string[] = [];
		timers.sync(
			[node("n1", { lastFetchedAt: 0 }), node("n2", { lastFetchedAt: 0 })],
			(id) => fired.push(id)
		);
		timers.stop("n1");
		expect(timers.isScheduled("n1")).toBe(false);
		expect(timers.isScheduled("n2")).toBe(true);
	});

	it("stopAll() cancels every scheduled Folder — mirrors the Atlas view's onClose (F3: nothing runs once the view is closed)", () => {
		const clock = new FakeClock();
		const timers = new RefreshEveryTimers(clock);
		timers.sync(
			[node("n1", { lastFetchedAt: 0 }), node("n2", { lastFetchedAt: 0 })],
			() => {}
		);
		timers.stopAll();
		expect(timers.isScheduled("n1")).toBe(false);
		expect(timers.isScheduled("n2")).toBe(false);
		expect(clock.pendingCount()).toBe(0);
	});

	it("multiple independent Folders each keep their own interval and firing schedule", () => {
		const clock = new FakeClock();
		const timers = new RefreshEveryTimers(clock);
		const fired: string[] = [];
		timers.sync(
			[node("fast", { minutes: MIN_REFRESH_MINUTES, lastFetchedAt: 0 }), node("slow", { minutes: MIN_REFRESH_MINUTES * 2, lastFetchedAt: 0 })],
			(id) => fired.push(id)
		);
		clock.advance(MIN_REFRESH_MINUTES * 60 * 1000);
		expect(fired).toEqual(["fast"]);
		clock.advance(MIN_REFRESH_MINUTES * 60 * 1000);
		expect(fired.filter((id) => id === "fast")).toHaveLength(2);
		expect(fired.filter((id) => id === "slow")).toHaveLength(1);
	});
});
