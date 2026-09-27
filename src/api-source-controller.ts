import { isMapError, mapResponseRows } from "./api-mapping";
import { mergeApiItems } from "./api-merge";
import { httpGetJson, HTTP_TIMEOUT_MS, RequestFn, ScheduleTimeout } from "./api-http";
import { ApiCache, ApiHeader, ApiSourceConfig, ViewNode } from "./types";

export interface RefreshDeps {
	/** R1: how to actually issue the request — production wiring supplies an adapter around
	 * Obsidian's `requestUrl` (see `api-request-obsidian.ts`); tests supply their own stub. Required,
	 * not defaulted to `fetch`, so nothing here can silently fall back to a CORS-subject request. */
	requestImpl: RequestFn;
	timeoutMs?: number;
	scheduleTimeout?: ScheduleTimeout;
	now?: () => number;
}

export type DotState = "green" | "grey" | "red";

/** G11: green = last refresh ok; grey = never refreshed; red = last refresh failed. */
export function dotStateFor(cache: ApiCache | undefined): DotState {
	if (!cache || cache.fetchedAt === null) return "grey";
	return cache.ok ? "green" : "red";
}

function relativeTime(fromMs: number, nowMs: number): string {
	const diffMs = Math.max(0, nowMs - fromMs);
	const hours = Math.floor(diffMs / (1000 * 60 * 60));
	if (hours >= 1) return `${hours} h ago`;
	const minutes = Math.floor(diffMs / (1000 * 60));
	if (minutes >= 1) return `${minutes} m ago`;
	return "just now";
}

/** G11 tooltip: error + time of last success. E2/E4: also surfaces skipped/truncated counts. */
export function dotTooltip(cache: ApiCache | undefined, nowMs: number): string {
	if (!cache || cache.fetchedAt === null) return "Never refreshed";
	const parts: string[] = [];
	if (cache.ok) {
		parts.push(`Last refresh ok, ${relativeTime(cache.fetchedAt, nowMs)}`);
	} else {
		const lastSuccess =
			cache.lastSuccessAt !== undefined
				? `last updated ${relativeTime(cache.lastSuccessAt, nowMs)}`
				: "never refreshed successfully";
		parts.push(`${cache.error ?? "unreachable"}, ${lastSuccess}`);
	}
	if (cache.skippedCount > 0) parts.push(`${cache.skippedCount} item(s) skipped (missing/duplicate id)`);
	if (cache.truncated) parts.push("Response truncated at 5,000 rows");
	return parts.join(" — ");
}

function emptyCache(prev: ApiCache | undefined, fetchedAt: number, error: string): ApiCache {
	return {
		fetchedAt,
		ok: false,
		error,
		rows: prev?.rows ?? [],
		skippedCount: prev?.skippedCount ?? 0,
		truncated: prev?.truncated ?? false,
		// R3: a failed attempt's own time must never overwrite the time of the *last success* — that's
		// what the dot's tooltip ("unreachable, last updated 3 h ago") actually reports.
		lastSuccessAt: prev?.lastSuccessAt,
	};
}

/**
 * PR-2: owns the "one request per Folder at a time" guard (E9: a refresh while one's already in
 * flight for the same node collapses into the same promise, rather than firing a second request)
 * and the actual fetch → map → merge → persist pipeline. A fresh instance has no memory of anything
 * in flight, so tests don't leak state between cases the way a module-level singleton would.
 */
export class ApiSourceController {
	private inFlight = new Map<string, { promise: Promise<void>; sourceKey: string }>();

	/**
	 * R15: the in-flight guard used to be keyed only by node.id, so a save that changed the URL/
	 * mapping/headers while a refresh for the *old* config was still in flight would collapse into
	 * that stale request — the new config was never fetched. Now the guard also tracks which config
	 * a request was built from: a matching config still collapses into the same request, but a
	 * changed one queues exactly one follow-up refresh (with the new config) to run once the in-flight
	 * one finishes, instead of firing concurrently or being dropped.
	 */
	refresh(node: ViewNode, source: ApiSourceConfig, headers: ApiHeader[], persist: () => void, deps: RefreshDeps): Promise<void> {
		const sourceKey = ApiSourceController.sourceKeyFor(source, headers);
		const existing = this.inFlight.get(node.id);
		if (existing) {
			if (existing.sourceKey === sourceKey) return existing.promise;
			const queued = existing.promise.then(() => this.runRefresh(node, source, headers, persist, deps, sourceKey));
			this.inFlight.set(node.id, { promise: queued, sourceKey });
			return queued;
		}
		return this.runRefresh(node, source, headers, persist, deps, sourceKey);
	}

	private runRefresh(node: ViewNode, source: ApiSourceConfig, headers: ApiHeader[], persist: () => void, deps: RefreshDeps, sourceKey: string): Promise<void> {
		const run = this.doRefresh(node, source, headers, persist, deps);
		this.inFlight.set(node.id, { promise: run, sourceKey });
		void run.finally(() => {
			if (this.inFlight.get(node.id)?.promise === run) this.inFlight.delete(node.id);
		});
		return run;
	}

	private static sourceKeyFor(source: ApiSourceConfig, headers: ApiHeader[]): string {
		return JSON.stringify({ source, headers });
	}

	private async doRefresh(node: ViewNode, source: ApiSourceConfig, headers: ApiHeader[], persist: () => void, deps: RefreshDeps): Promise<void> {
		const now = deps.now ?? (() => Date.now());
		const headerRecord: Record<string, string> = {};
		for (const header of headers) if (header.key) headerRecord[header.key] = header.value;

		const result = await httpGetJson(source.url, headerRecord, {
			requestImpl: deps.requestImpl,
			timeoutMs: deps.timeoutMs ?? HTTP_TIMEOUT_MS,
			scheduleTimeout: deps.scheduleTimeout,
		});

		if (!result.ok) {
			node.apiCache = emptyCache(node.apiCache, now(), result.error.message);
			persist();
			return;
		}

		const mapped = mapResponseRows(result.json, source.mapping);
		if (isMapError(mapped)) {
			node.apiCache = emptyCache(node.apiCache, now(), mapped.error);
			persist();
			return;
		}

		const fetchedAt = now();
		const merged = mergeApiItems(node.apiItemState ?? {}, node.apiItemOrder ?? [], mapped.rows, source.mode, {
			truncated: mapped.truncated,
			nowIso: new Date(fetchedAt).toISOString(),
		});

		node.apiItemState = merged.itemState;
		node.apiItemOrder = merged.order;
		node.apiCache = {
			fetchedAt,
			ok: true,
			error: null,
			rows: mapped.rows,
			skippedCount: mapped.skippedCount,
			truncated: mapped.truncated,
			lastSuccessAt: fetchedAt,
		};
		persist();
	}
}

/**
 * G5a: "Refresh when Atlas view loads" fires on opening or returning to an Atlas view — not on
 * every re-render the view does for unrelated reasons (a status change, a drag, a filter keystroke),
 * and not a second time while the view stays continuously active. One instance per open explorer
 * leaf; `activate()`/`deactivate()` bracket a real "the leaf became active" / "the leaf stopped being
 * active" transition (wired to `workspace.on("active-leaf-change")` by the caller).
 */
export class ViewLoadTrigger {
	private active = false;

	/** Returns true only on the transition into active — the caller should refresh then, and only then. */
	activate(): boolean {
		if (this.active) return false;
		this.active = true;
		return true;
	}

	deactivate(): void {
		this.active = false;
	}
}
