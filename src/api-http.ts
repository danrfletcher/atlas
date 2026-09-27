/** E3: requests slower than this fail as unreachable. */
export const HTTP_TIMEOUT_MS = 15000;

export type FetchFn = typeof fetch;

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
 * `fetchImpl` is injectable so callers (and tests) can supply a fake clock/stub instead of a real
 * network call.
 */
export async function httpGetJson(
	url: string,
	headers: Record<string, string>,
	opts: { fetchImpl?: FetchFn; timeoutMs?: number } = {}
): Promise<HttpResult> {
	const fetchImpl = opts.fetchImpl ?? fetch;
	const timeoutMs = opts.timeoutMs ?? HTTP_TIMEOUT_MS;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await fetchImpl(url, { method: "GET", headers, signal: controller.signal });
		if (response.status === 401 || response.status === 403) {
			return { ok: false, error: { kind: "http", message: "auth failed", status: response.status } };
		}
		const text = await response.text();
		if (!response.ok) {
			return { ok: false, error: { kind: "http", message: `HTTP ${response.status}`, status: response.status } };
		}
		let json: unknown;
		try {
			json = text.length > 0 ? JSON.parse(text) : null;
		} catch {
			return { ok: false, error: { kind: "non-json", message: "Response is not valid JSON" } };
		}
		return { ok: true, status: response.status, json };
	} catch {
		// Covers both the abort-on-timeout path and a genuine network failure (Mac asleep, DNS
		// failure, connection refused) — both read as "unreachable" to the rest of the plugin (E3/GP10).
		return { ok: false, error: { kind: controller.signal.aborted ? "timeout" : "network", message: "unreachable" } };
	} finally {
		clearTimeout(timer);
	}
}
