import { ApiHeader } from "./types";

const STORAGE_KEY = "atlas-api-headers";

interface LocalStorageHost {
	loadLocalStorage(key: string): unknown;
	saveLocalStorage(key: string, data: unknown): void;
}

/**
 * G13: request headers (including any bearer token) are stored device-local, never inside
 * `data.json` — which syncs across devices — via Obsidian's own per-device `localStorage` helpers.
 * Keyed by the owning Folder (meta node)'s own `id`; a node's headers have no meaning detached from
 * it, and deleting the Folder (E6) removes its entry here too.
 */
export class ApiHeadersStore {
	constructor(private host: LocalStorageHost) {}

	private readAll(): Record<string, ApiHeader[]> {
		return (this.host.loadLocalStorage(STORAGE_KEY) as Record<string, ApiHeader[]> | null) ?? {};
	}

	get(nodeId: string): ApiHeader[] {
		return this.readAll()[nodeId] ?? [];
	}

	set(nodeId: string, headers: ApiHeader[]): void {
		const all = this.readAll();
		all[nodeId] = headers;
		this.host.saveLocalStorage(STORAGE_KEY, all);
	}

	delete(nodeId: string): void {
		const all = this.readAll();
		if (!(nodeId in all)) return;
		delete all[nodeId];
		this.host.saveLocalStorage(STORAGE_KEY, all);
	}
}
