import { describe, expect, it } from "vitest";
import { McpTokenStore } from "../../src/mcp-token-store";

/** In-memory stand-in for Obsidian's real per-device `loadLocalStorage`/`saveLocalStorage` —
 * same shape as the fixture `ApiHeadersStore`'s own tests use. */
class FakeLocalStorageHost {
	store = new Map<string, unknown>();
	loadLocalStorage(key: string): unknown {
		return this.store.get(key) ?? null;
	}
	saveLocalStorage(key: string, data: unknown): void {
		this.store.set(key, data);
	}
}

describe("McpTokenStore — Q1/G1/F6: device-local port + token for this vault on this device", () => {
	it("get() creates and returns credentials the first time, with the documented default port", () => {
		const store = new McpTokenStore(new FakeLocalStorageHost());
		const credentials = store.get();
		expect(credentials.port).toBe(27202);
		expect(typeof credentials.token).toBe("string");
		expect(credentials.token.length).toBeGreaterThan(0);
	});

	it("get() is stable across calls once created", () => {
		const store = new McpTokenStore(new FakeLocalStorageHost());
		const first = store.get();
		const second = store.get();
		expect(second).toEqual(first);
	});

	it("set() round-trips a chosen port/token pair", () => {
		const store = new McpTokenStore(new FakeLocalStorageHost());
		store.set({ port: 9999, token: "hand-set-token" });
		expect(store.get()).toEqual({ port: 9999, token: "hand-set-token" });
	});

	it("regenerate() returns a new token and the store never matches the previous one afterward", () => {
		const store = new McpTokenStore(new FakeLocalStorageHost());
		const before = store.get().token;
		const returned = store.regenerate();
		const after = store.get().token;
		expect(returned).toBe(after);
		expect(after).not.toBe(before);
		expect(store.get().token).not.toBe(before);
	});

	it("regenerate() leaves the port untouched", () => {
		const store = new McpTokenStore(new FakeLocalStorageHost());
		store.set({ port: 12345, token: "old-token" });
		store.regenerate();
		expect(store.get().port).toBe(12345);
	});

	it("regenerate() called twice in a row never repeats a token", () => {
		const store = new McpTokenStore(new FakeLocalStorageHost());
		const first = store.regenerate();
		const second = store.regenerate();
		expect(second).not.toBe(first);
	});

	it("two independent stores against the same host see the same credentials", () => {
		const host = new FakeLocalStorageHost();
		const a = new McpTokenStore(host);
		const b = new McpTokenStore(host);
		const created = a.get();
		expect(b.get()).toEqual(created);
	});

	it("uses its own storage key, distinct from ApiHeadersStore's and FolderSourcePathStore's — none of the three collide", () => {
		const host = new FakeLocalStorageHost();
		const mcp = new McpTokenStore(host);
		mcp.get();

		// The same host, used the way ApiHeadersStore/FolderSourcePathStore use it, under their own
		// documented keys — asserting those keys are untouched proves McpTokenStore wrote under a
		// third, distinct key.
		expect(host.loadLocalStorage("atlas-api-headers")).toBeNull();
		expect(host.loadLocalStorage("atlas-folder-source-outside-paths")).toBeNull();
		expect(host.loadLocalStorage("atlas-mcp-server")).not.toBeNull();

		// And the reverse: writing under those two other keys never shows up through McpTokenStore.
		host.saveLocalStorage("atlas-api-headers", { "node-a": [{ key: "X", value: "y" }] });
		host.saveLocalStorage("atlas-folder-source-outside-paths", { "node-a": "/tmp" });
		const mcp2 = new McpTokenStore(host);
		expect(mcp2.get()).toEqual(mcp.get());
	});
});
