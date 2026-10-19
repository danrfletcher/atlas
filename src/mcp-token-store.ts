/** The MCP server's device-local identity for this vault on this device: which port it listens
 * on, and the bearer token every request must present. */
export interface McpCredentials {
	port: number;
	token: string;
}

/** Plan N's settled default (°): matches the port Titan is told to call in the golden path. */
export const DEFAULT_MCP_PORT = 27202;

interface LocalStorageHost {
	loadLocalStorage(key: string): unknown;
	saveLocalStorage(key: string, data: unknown): void;
}

const STORAGE_KEY = "atlas-mcp-server";

/**
 * Q1/G1/F6: the MCP server's port and bearer token are stored device-local, never inside
 * `data.json` — which syncs across devices — via Obsidian's own per-device `localStorage`
 * helpers, the same pattern as `ApiHeadersStore`/`FolderSourcePathStore`. Unlike those two, this
 * store isn't keyed by node id: there is exactly one MCP server per vault per device, so one
 * entry is enough. Its own storage key (distinct from both of theirs) means none of the three
 * stores can ever collide.
 */
export class McpTokenStore {
	constructor(private host: LocalStorageHost) {}

	private read(): McpCredentials | null {
		const raw = this.host.loadLocalStorage(STORAGE_KEY) as Partial<McpCredentials> | null;
		if (!raw || typeof raw.token !== "string" || raw.token.length === 0 || typeof raw.port !== "number") return null;
		return { port: raw.port, token: raw.token };
	}

	/** Returns the current port+token, generating them (the default port, a fresh random token)
	 * the first time this device sees this vault. Never returns a partial/corrupt stored value. */
	get(): McpCredentials {
		const existing = this.read();
		if (existing) return existing;
		const created: McpCredentials = { port: DEFAULT_MCP_PORT, token: generateToken() };
		this.host.saveLocalStorage(STORAGE_KEY, created);
		return created;
	}

	set(credentials: McpCredentials): void {
		this.host.saveLocalStorage(STORAGE_KEY, credentials);
	}

	/** G1: writes a fresh token immediately — every request reads the current value straight from
	 * this store, so the old token is rejected by the very next request, with no extra plumbing
	 * needed to "revoke" it. */
	regenerate(): string {
		const current = this.get();
		const token = generateToken();
		this.set({ ...current, token });
		return token;
	}
}

/** 24 random bytes (192 bits) as hex — plenty for a device-local bearer token, and cheap to
 * compare/copy/display as a plain string. Uses the Web Crypto `getRandomValues` global rather
 * than `node:crypto` (R8): this module is imported statically from `main.ts`, so a top-level
 * `require("node:crypto")` would run on every platform the plugin loads on, mobile included,
 * where Node builtins don't exist and a failed require would stop the whole plugin loading — the
 * opposite of F5. `getRandomValues` is a standard global in both Obsidian's desktop (Electron
 * renderer) and mobile (Capacitor/WebView) runtimes, and in the Node test environment. */
function generateToken(): string {
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
