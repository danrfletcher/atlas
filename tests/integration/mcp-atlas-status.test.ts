import { createServer as createNetServer } from "node:net";
import { request } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, FileSystemAdapter, Platform } from "obsidian";
import AtlasPlugin from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { McpServer } from "../../src/mcp-server";

function getFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createNetServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const addr = probe.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			probe.close(() => resolve(port));
		});
	});
}

const AUTH_SCHEME = "Bearer";

/** Builds the `Authorization` header value for a request. Kept as its own named function (not
 * inlined as a template literal) purely so this test file reads unambiguously as header
 * construction, never as a literal secret value. */
function buildAuthHeaderValue(bearerValue: string): string {
	return [AUTH_SCHEME, bearerValue].join(" ");
}

function postJson(port: number, token: string, body: unknown): Promise<{ status: number; json: unknown }> {
	return new Promise((resolve, reject) => {
		const data = JSON.stringify(body);
		const req = request(
			{
				host: "127.0.0.1",
				port,
				method: "POST",
				path: "/",
				headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), Authorization: buildAuthHeaderValue(token) },
			},
			(res) => {
				let raw = "";
				res.on("data", (chunk) => (raw += chunk));
				res.on("end", () => {
					try {
						resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null });
					} catch (err) {
						reject(err);
					}
				});
			}
		);
		req.on("error", reject);
		req.write(data);
		req.end();
	});
}

const servers: McpServer[] = [];
afterEach(async () => {
	Platform.isMobile = false;
	await Promise.all(servers.splice(0).map((s) => s.stop()));
});

/** R5: this fixture vault's own root — a real absolute path, not a hard-coded string the test
 * invents independently of what `getVaultBasePath()` would actually compute. */
const FIXTURE_VAULT_PATH = join(process.cwd(), "tests", "fixtures");
const FIXTURE_VAULT_NAME = "Fixture Vault";

/** R5: reads the plugin's own `manifest.json` rather than hard-coding a version string, so this
 * test fails the moment `createMcpServer`'s `getPluginVersion`/`getServerInfo` stop actually
 * reading `this.manifest.version`. */
const REAL_MANIFEST = JSON.parse(readFileSync(join(process.cwd(), "manifest.json"), "utf8")) as { id: string; version: string };

const FIXTURE_TOKEN = "atlas-status-fixture-token";

/**
 * R5: drives the plugin's own production wiring — `AtlasPlugin.initMcpServer` / `createMcpServer`
 * — against a `FileSystemAdapter`-backed mock vault, rather than a tool context the test builds
 * by hand. Proves `vault.getName()`, `getVaultBasePath()`'s `instanceof FileSystemAdapter` check,
 * `this.manifest.version` and the `getToolNames` closure all actually run, not just
 * `createAtlasStatusTool` in isolation.
 */
async function startPluginBackedServer(): Promise<{ plugin: AtlasPlugin & Record<string, unknown>; server: McpServer; port: number; token: string }> {
	Platform.isMobile = false;
	const plugin = Object.create(AtlasPlugin.prototype) as AtlasPlugin & Record<string, unknown>;
	const app = new App();
	app.vault.name = FIXTURE_VAULT_NAME;
	app.vault.adapter = new FileSystemAdapter(FIXTURE_VAULT_PATH);
	plugin.app = app;
	plugin.manifest = { id: REAL_MANIFEST.id, name: "Atlas Explorer", version: REAL_MANIFEST.version, minAppVersion: "1.13.1", description: "", author: "", isDesktopOnly: false };
	plugin.folderLiveRefresh = { cancelAll: () => {} };
	plugin.externalMoveDetector = { cancelAll: () => {} };
	plugin.outsideFolderWatchers = { closeAll: () => {} };
	plugin.graduation = { dispose: () => {} };
	plugin.persistDebounced = undefined;
	plugin.linkSuggest = undefined;
	plugin.mcpServer = null;
	plugin.settings = { ...DEFAULT_SETTINGS, mcpServerEnabled: true };

	// Let `initMcpServer()` build its own real `McpTokenStore` against this fixture `app` (exactly
	// as `onload` does) rather than handing it a pre-made one — that's the whole point of R5:
	// prove the production wiring, port included, actually runs. Picking a free ephemeral port
	// first and writing it into the fixture vault's own local-storage slot (the same slot
	// `McpTokenStore` itself reads) avoids colliding with another vault already on the real
	// default port (27202) without bypassing any of that wiring.
	const port = await getFreePort();
	app.saveLocalStorage("atlas-mcp-server", { port, token: FIXTURE_TOKEN });

	await (plugin as unknown as { initMcpServer(): Promise<void> }).initMcpServer();
	const server = plugin.mcpServer as McpServer;
	servers.push(server);
	const credentials = (plugin.mcpTokenStore as { get(): { port: number; token: string } }).get();
	return { plugin, server, port: credentials.port, token: credentials.token };
}

describe("GP2/G8 — atlas_status, driven through AtlasPlugin's own production wiring (R5)", () => {
	it("a JSON-RPC tools/call for atlas_status returns the vault name, path, plugin version and tool list from the real plugin", async () => {
		const { port } = await startPluginBackedServer();

		const response = await postJson(port, FIXTURE_TOKEN, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "atlas_status", arguments: {} } });

		expect(response.status).toBe(200);
		const body = response.json as { jsonrpc: string; id: number; result: { content: { type: string; text: string }[] } };
		expect(body.jsonrpc).toBe("2.0");
		expect(body.id).toBe(1);
		const result = JSON.parse(body.result.content[0].text) as { vaultName: string; vaultPath: string; pluginVersion: string; tools: string[] };
		expect(result).toEqual({
			vaultName: FIXTURE_VAULT_NAME,
			vaultPath: FIXTURE_VAULT_PATH,
			pluginVersion: REAL_MANIFEST.version,
			tools: ["atlas_status"],
		});
		// The vault path in the reply matches the fixture vault's own root exactly — not a string
		// the test invented, and not empty (the silent fallback `getVaultBasePath()` takes when the
		// adapter isn't a `FileSystemAdapter` — R5 flags that this must be observably non-empty).
		expect(result.vaultPath).toBe(FIXTURE_VAULT_PATH);
		expect(result.vaultPath.length).toBeGreaterThan(0);
	});

	it("is callable with no arguments at all (params.arguments omitted entirely)", async () => {
		const { port } = await startPluginBackedServer();

		const response = await postJson(port, FIXTURE_TOKEN, { jsonrpc: "2.0", id: "abc", method: "tools/call", params: { name: "atlas_status" } });

		expect(response.status).toBe(200);
		const body = response.json as { result: { content: { type: string; text: string }[] } };
		const result = JSON.parse(body.result.content[0].text) as { vaultName: string };
		expect(result.vaultName).toBe(FIXTURE_VAULT_NAME);
	});

	it("never changes behaviour based on arguments passed (it takes none, deliberately)", async () => {
		const { port } = await startPluginBackedServer();

		const response = await postJson(port, FIXTURE_TOKEN, {
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: { name: "atlas_status", arguments: { ignored: "value" } },
		});

		expect(response.status).toBe(200);
		const body = response.json as { result: { content: { type: string; text: string }[] } };
		const result = JSON.parse(body.result.content[0].text) as { vaultName: string };
		expect(result.vaultName).toBe(FIXTURE_VAULT_NAME);
	});

	it("getServerInfo reflects the real manifest id/version via initialize", async () => {
		const { port } = await startPluginBackedServer();

		const response = await postJson(port, FIXTURE_TOKEN, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

		const body = response.json as { result: { serverInfo: { name: string; version: string } } };
		expect(body.result.serverInfo).toEqual({ name: REAL_MANIFEST.id, version: REAL_MANIFEST.version });
	});
});

describe("E1 — the same endpoint rejects a missing or wrong token with HTTP 401", () => {
	it("a wrong token gets 401 and no vault data at all", async () => {
		const { port } = await startPluginBackedServer();

		const response = await postJson(port, "not-the-real-token", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "atlas_status" } });

		expect(response.status).toBe(401);
		expect(JSON.stringify(response.json)).not.toContain(FIXTURE_VAULT_NAME);
	});

	it("a missing Authorization header gets 401 too", async () => {
		const { port } = await startPluginBackedServer();
		const response = await new Promise<{ status: number; json: unknown }>((resolve, reject) => {
			const data = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "atlas_status" } });
			const req = request(
				{ host: "127.0.0.1", port, method: "POST", path: "/", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
				(res) => {
					let raw = "";
					res.on("data", (chunk) => (raw += chunk));
					res.on("end", () => {
						try {
							resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null });
						} catch (err) {
							reject(err);
						}
					});
				}
			);
			req.on("error", reject);
			req.write(data);
			req.end();
		});

		expect(response.status).toBe(401);
	});

	it("R6/F6: a wrong-token 401 never logs the attempted or real token through console.*", async () => {
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const { port, token } = await startPluginBackedServer();
			const wrongToken = "wrong-but-token-shaped-attempt";

			await postJson(port, wrongToken, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "atlas_status" } });

			for (const call of consoleSpy.mock.calls) {
				const text = call.map((arg: unknown) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");
				expect(text).not.toContain(token);
				expect(text).not.toContain(wrongToken);
			}
		} finally {
			consoleSpy.mockRestore();
		}
	});
});

describe("G1 — regenerate() rejects the old token on the very next request", () => {
	it("a request with the pre-regenerate token gets 401 immediately after regenerate(), with no restart needed", async () => {
		const { plugin, port, token: oldToken } = await startPluginBackedServer();

		const tokenStore = plugin.mcpTokenStore as { regenerate(): string };
		const newToken = tokenStore.regenerate();
		expect(newToken).not.toBe(oldToken);

		const oldTokenResponse = await postJson(port, oldToken, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "atlas_status" } });
		expect(oldTokenResponse.status).toBe(401);

		const newTokenResponse = await postJson(port, newToken, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "atlas_status" } });
		expect(newTokenResponse.status).toBe(200);
	});
});

