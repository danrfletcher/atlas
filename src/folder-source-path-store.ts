const STORAGE_KEY = "atlas-folder-source-outside-paths";

interface LocalStorageHost {
	loadLocalStorage(key: string): unknown;
	saveLocalStorage(key: string, data: unknown): void;
}

/**
 * G6/F6: an Outside-Vault Folder source's absolute filesystem path is stored device-local, never
 * inside `data.json` — which syncs across devices — via Obsidian's own per-device `localStorage`
 * helpers. Keyed by the owning Folder (meta node)'s own `id`, exactly like `ApiHeadersStore`, but
 * under its own distinct storage key so the two stores never collide or interact.
 */
export class FolderSourcePathStore {
	constructor(private host: LocalStorageHost) {}

	private readAll(): Record<string, string> {
		return (this.host.loadLocalStorage(STORAGE_KEY) as Record<string, string> | null) ?? {};
	}

	get(nodeId: string): string {
		return this.readAll()[nodeId] ?? "";
	}

	set(nodeId: string, path: string): void {
		const all = this.readAll();
		all[nodeId] = path;
		this.host.saveLocalStorage(STORAGE_KEY, all);
	}

	delete(nodeId: string): void {
		const all = this.readAll();
		if (!(nodeId in all)) return;
		delete all[nodeId];
		this.host.saveLocalStorage(STORAGE_KEY, all);
	}
}
