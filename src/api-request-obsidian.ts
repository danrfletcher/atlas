import { requestUrl } from "obsidian";
import { RequestFn } from "./api-http";

/**
 * R1: the real, production `RequestFn` — backed by Obsidian's `requestUrl`, which runs outside the
 * renderer's `app://` origin and so isn't subject to CORS or the OPTIONS preflight a plain `fetch`
 * would trigger for an `Authorization` header. Kept in its own file (rather than `api-http.ts`
 * itself) purely so every other API-source module stays free of a runtime `obsidian` import and
 * therefore testable under plain Node/vitest — this file is only ever imported from wiring code that
 * already depends on the real Obsidian runtime (`explorer-view.ts`, `api-source-modal.ts`).
 */
export const obsidianRequestImpl: RequestFn = async ({ url, method, headers }) => {
	const response = await requestUrl({ url, method, headers, throw: false });
	return { status: response.status, text: response.text };
};
