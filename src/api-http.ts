/** E3: requests slower than this fail as unreachable. */
export const HTTP_TIMEOUT_MS = 15000;

/** Shape of a single request, deliberately mirroring Obsidian's own `RequestUrlParam` (url, method,
 * headers) rather than the browser `fetch` signature — kept minimal so a caller can trivially adapt
 * either Obsidian's `requestUrl` (production, R1) or a test stub to it. `method` is always "GET" in
 * this PR (F1) — the field exists so this stays a faithful request shape, not because any caller
 * ever sends anything else. */
export interface RequestParams {
	url: string;
	method: "GET";
	headers: Record<string, string>;
}

export interface RequestResult {
	status: number;
	text: string;
}

/** Issues one request, resolving with its status/body or rejecting on a genuine network failure
 * (DNS, connection refused, Mac asleep). Never throws for a non-2xx status — that's the caller's job
 * to interpret, same as Obsidian's `requestUrl` called with `throw: false`. */
export type RequestFn = (params: RequestParams) => Promise<RequestResult>;

/** Schedules `onTimeout` to fire after `ms` and returns a canceller. Real `setTimeout`/`clearTimeout`
 * by default; tests inject a fake so E3 never needs a real (even short, fake-15s) wait — see R1. */
export type ScheduleTimeout = (ms: number, onTimeout: () => void) => () => void;

const defaultScheduleTimeout: ScheduleTimeout = (ms, onTimeout) => {
	const timer = setTimeout(onTimeout, ms);
	return () => clearTimeout(timer);
};

export interface HttpError {
	/** "http" covers 401/403 (surfaced as "auth failed", E8) and any other non-2xx status. */
	kind: "timeout" | "network" | "non-json" | "http";
	message: string;
	status?: number;
}

export type HttpResult = { ok: true; status: number; json: unknown } | { ok: false; error: HttpError };

/**
 * G1/G13/E1/E3/E8: a plain GET with headers, timing out (not hanging forever) after `timeoutMs`.
 * No pagination, OAuth or secret-store handling exists here or anywhere else in this PR (F4) — a
 * paginated-looking response is simply treated as one flat list by the mapping layer downstream.
 *
 * R1: `requestImpl` is required, not defaulted to the renderer's `fetch` — `fetch` from Obsidian's
 * `app://` origin is subject to CORS, and sending an `Authorization` header triggers an OPTIONS
 * preflight that a GET-only service (like the PR-1 Mac service) answers with 501 and no
 * `Access-Control-*` headers, so every real request reads as "unreachable". Production callers pass
 * an adapter around Obsidian's `requestUrl` (which has no such restriction); tests pass their own
 * stub. The 15s timeout races `requestImpl` via `Promise.race` against an injectable `scheduleTimeout`
 * rather than an `AbortController`, since `requestUrl` has no abort signal to hook into.
 */
export async function httpGetJson(
	url: string,
	headers: Record<string, string>,
	opts: { requestImpl: RequestFn; timeoutMs?: number; scheduleTimeout?: ScheduleTimeout }
): Promise<HttpResult> {
	const timeoutMs = opts.timeoutMs ?? HTTP_TIMEOUT_MS;
	const scheduleTimeout = opts.scheduleTimeout ?? defaultScheduleTimeout;

	let cancelTimeout: () => void = () => {};
	const timeoutResult: Promise<HttpResult> = new Promise((resolve) => {
		cancelTimeout = scheduleTimeout(timeoutMs, () =>
			// Covers both a genuine hang and a real network failure the underlying transport never
			// rejects promptly for — both read as "unreachable" to the rest of the plugin (E3/GP10).
			resolve({ ok: false, error: { kind: "timeout", message: "unreachable" } })
		);
	});

	const requestResult: Promise<HttpResult> = (async () => {
		try {
			// F1: always GET, regardless of anything a caller might otherwise pass — no request method
			// other than GET is ever issued by this plugin.
			const response = await opts.requestImpl({ url, method: "GET", headers });
			if (response.status === 401 || response.status === 403) {
				return { ok: false, error: { kind: "http", message: "auth failed", status: response.status } };
			}
			if (response.status < 200 || response.status >= 300) {
				return { ok: false, error: { kind: "http", message: `HTTP ${response.status}`, status: response.status } };
			}
			let json: unknown;
			try {
				json = response.text.length > 0 ? JSON.parse(response.text) : null;
			} catch {
				return { ok: false, error: { kind: "non-json", message: "Response is not valid JSON" } };
			}
			return { ok: true, status: response.status, json };
		} catch {
			// A genuine network failure (Mac asleep, DNS failure, connection refused).
			return { ok: false, error: { kind: "network", message: "unreachable" } };
		}
	})();

	try {
		return await Promise.race([requestResult, timeoutResult]);
	} finally {
		cancelTimeout();
	}
}
