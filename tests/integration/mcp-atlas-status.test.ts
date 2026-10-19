import { createServer as createNetServer } from "node:net";
import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "../../src/mcp-server";
import { McpTool } from "../../src/mcp-protocol";
import { createAtlasStatusTool } from "../../src/mcp-tools";

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

function postJson(port: number, token: string, body: unknown): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; json: unknown }> {
	return new Promise((resolve, reject) => {
		const data = JSON.stringify(body);
		const req = request(
			{
				host: "127.0.0.1",
				port,
				method: "POST",
				path: "/",
				headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), Authorization: `Bearer ${token}` },
			},
			(res) => {
				let raw = "";
				res.on("data", (chunk) => (raw += chunk));
				res.on("end", () => {
					try {
						resolve({ status: res.statusCode ?? 0, headers: res.headers, json: raw ? JSON.parse(raw) : null });
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
	await Promise.all(servers.splice(0).map((s) => s.stop()));
});

/** A "fixture vault" — a plain identity this PR's `atlas_status` tool reads from, standing in for
 * a real Obsidian `App`/vault. `createAtlasStatusTool` only ever depends on these four getters, so
 * driving it through a real loopback HTTP request needs no Obsidian mock at all. */
const FIXTURE_VAULT = { name: "Fixture Vault", path: "/Users/test/vaults/Fixture Vault" };
const FIXTURE_TOKEN = "atlas-status-fixture-token";
const PLUGIN_VERSION = "0.8.0";

async function startFixtureServer(): Promise<{ server: McpServer; port: number }> {
	const port = await getFreePort();
	const tools = new Map<string, McpTool>();
	tools.set(
		"atlas_status",
		createAtlasStatusTool({
			getVaultName: () => FIXTURE_VAULT.name,
			getVaultPath: () => FIXTURE_VAULT.path,
			getPluginVersion: () => PLUGIN_VERSION,
			getToolNames: () => Array.from(tools.keys()),
		})
	);
	const server = new McpServer({ getToken: () => FIXTURE_TOKEN, getPort: () => port, tools, notify: () => {}, logError: () => {} });
	servers.push(server);
	await server.start();
	return { server, port };
}

describe("GP2/G8 — atlas_status over a real loopback HTTP request", () => {
	it("a JSON-RPC tools/call for atlas_status returns the vault name, path, plugin version and tool list", async () => {
		const { port } = await startFixtureServer();

		const response = await postJson(port, FIXTURE_TOKEN, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "atlas_status", arguments: {} } });

		expect(response.status).toBe(200);
		const body = response.json as { jsonrpc: string; id: number; result: { vaultName: string; vaultPath: string; pluginVersion: string; tools: string[] } };
		expect(body.jsonrpc).toBe("2.0");
		expect(body.id).toBe(1);
		expect(body.result).toEqual({
			vaultName: FIXTURE_VAULT.name,
			vaultPath: FIXTURE_VAULT.path,
			pluginVersion: PLUGIN_VERSION,
			tools: ["atlas_status"],
		});
		// The vault path in the reply matches the fixture vault's own root exactly.
		expect(body.result.vaultPath).toBe(FIXTURE_VAULT.path);
	});

	it("is callable with no arguments at all (params.arguments omitted entirely)", async () => {
		const { port } = await startFixtureServer();

		const response = await postJson(port, FIXTURE_TOKEN, { jsonrpc: "2.0", id: "abc", method: "tools/call", params: { name: "atlas_status" } });

		expect(response.status).toBe(200);
		const body = response.json as { result: { vaultName: string } };
		expect(body.result.vaultName).toBe(FIXTURE_VAULT.name);
	});

	it("never changes behaviour based on arguments passed (it takes none, deliberately)", async () => {
		const { port } = await startFixtureServer();

		const response = await postJson(port, FIXTURE_TOKEN, {
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: { name: "atlas_status", arguments: { ignored: "value" } },
		});

		expect(response.status).toBe(200);
		const body = response.json as { result: { vaultName: string } };
		expect(body.result.vaultName).toBe(FIXTURE_VAULT.name);
	});
});

describe("E1 — the same endpoint rejects a missing or wrong token with HTTP 401", () => {
	it("a wrong token gets 401 and no vault data at all", async () => {
		const { port } = await startFixtureServer();

		const response = await postJson(port, "not-the-real-token", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "atlas_status" } });

		expect(response.status).toBe(401);
		expect(JSON.stringify(response.json)).not.toContain(FIXTURE_VAULT.name);
	});

	it("a missing Authorization header gets 401 too", async () => {
		const { port } = await startFixtureServer();
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
});
