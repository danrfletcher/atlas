import { createServer as createNetServer } from "node:net";
import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "../../src/mcp-server";
import { McpTool } from "../../src/mcp-protocol";

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

/** Posts a raw body string (not JSON.stringify'd — some rows are deliberately not valid JSON). */
function postRaw(port: number, token: string, rawBody: string): Promise<{ status: number; json: unknown }> {
	return new Promise((resolve, reject) => {
		const req = request(
			{
				host: "127.0.0.1",
				port,
				method: "POST",
				path: "/",
				headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(rawBody), Authorization: `Bearer ${token}` },
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
		req.write(rawBody);
		req.end();
	});
}

const TOKEN = "mcp-protocol-test-token";
const servers: McpServer[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((s) => s.stop()));
});

async function startServer(): Promise<{ server: McpServer; port: number }> {
	const port = await getFreePort();
	const tools = new Map<string, McpTool>();
	tools.set("atlas_status", { name: "atlas_status", handler: () => ({ ok: true }) });
	const server = new McpServer({ getToken: () => TOKEN, getPort: () => port, tools, notify: () => {}, logError: () => {} });
	servers.push(server);
	await server.start();
	return { server, port };
}

interface ErrorBody {
	jsonrpc: string;
	error: { code: number; message: string };
}

describe("mcp-protocol — malformed-input matrix: every row yields a structured JSON-RPC error, never a dropped connection", () => {
	it("invalid JSON body", async () => {
		const { server, port } = await startServer();
		const response = await postRaw(port, TOKEN, "{not valid json");
		expect(response.status).toBe(200); // transport-level success; the JSON-RPC error is in the body
		const body = response.json as ErrorBody;
		expect(body.jsonrpc).toBe("2.0");
		expect(body.error).toBeDefined();
		expect(body.error.code).toBe(-32700);
		expect(server.isRunning()).toBe(true);
	});

	it("missing jsonrpc field", async () => {
		const { server, port } = await startServer();
		const response = await postRaw(port, TOKEN, JSON.stringify({ id: 1, method: "tools/call", params: { name: "atlas_status" } }));
		const body = response.json as ErrorBody;
		expect(body.error.code).toBe(-32600);
		expect(server.isRunning()).toBe(true);
	});

	it("missing method field", async () => {
		const { server, port } = await startServer();
		const response = await postRaw(port, TOKEN, JSON.stringify({ jsonrpc: "2.0", id: 1, params: { name: "atlas_status" } }));
		const body = response.json as ErrorBody;
		expect(body.error.code).toBe(-32600);
		expect(server.isRunning()).toBe(true);
	});

	it("unknown method name", async () => {
		const { server, port } = await startServer();
		const response = await postRaw(port, TOKEN, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "not/a-real-method" }));
		const body = response.json as ErrorBody;
		expect(body.error.code).toBe(-32601);
		expect(server.isRunning()).toBe(true);
	});

	// R10: a body missing `id` *and* `jsonrpc`/`method` is not a well-formed JSON-RPC Request at
	// all, so JSON-RPC 2.0 §4.1's "no `id` means Notification" rule never applies to it — it must
	// still get a structured `-32600` error, not 202-with-no-body.
	it("empty object: missing id, jsonrpc and method all at once", async () => {
		const { server, port } = await startServer();
		const response = await postRaw(port, TOKEN, JSON.stringify({}));
		expect(response.status).toBe(200);
		const body = response.json as ErrorBody;
		expect(body.jsonrpc).toBe("2.0");
		expect(body.error).toBeDefined();
		expect(body.error.code).toBe(-32600);
		expect(server.isRunning()).toBe(true);
	});

	it("missing id and jsonrpc, method present", async () => {
		const { server, port } = await startServer();
		const response = await postRaw(port, TOKEN, JSON.stringify({ method: "tools/call" }));
		const body = response.json as ErrorBody;
		expect(body.error.code).toBe(-32600);
		expect(server.isRunning()).toBe(true);
	});

	it("missing id and method, jsonrpc present", async () => {
		const { server, port } = await startServer();
		const response = await postRaw(port, TOKEN, JSON.stringify({ jsonrpc: "2.0" }));
		const body = response.json as ErrorBody;
		expect(body.error.code).toBe(-32600);
		expect(server.isRunning()).toBe(true);
	});

	it("missing id, jsonrpc and method, unrelated field present", async () => {
		const { server, port } = await startServer();
		const response = await postRaw(port, TOKEN, JSON.stringify({ foo: 1 }));
		const body = response.json as ErrorBody;
		expect(body.error.code).toBe(-32600);
		expect(server.isRunning()).toBe(true);
	});

	it("oversized body", async () => {
		const { server, port } = await startServer();
		// Well past this server's 1MB cap, but still a syntactically valid JSON-RPC envelope — the
		// size rejection has to fire before (or regardless of) JSON parsing.
		const hugeArg = "x".repeat(2_000_000);
		const response = await postRaw(
			port,
			TOKEN,
			JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "atlas_status", arguments: { hugeArg } } })
		);
		const body = response.json as ErrorBody;
		expect(body.error).toBeDefined();
		expect(server.isRunning()).toBe(true);
	});

	it("the server still answers a perfectly valid request after every malformed row above", async () => {
		const { port } = await startServer();
		await postRaw(port, TOKEN, "{not valid json");
		await postRaw(port, TOKEN, JSON.stringify({ id: 1, method: "tools/call" }));
		await postRaw(port, TOKEN, JSON.stringify({ jsonrpc: "2.0", id: 1 }));
		await postRaw(port, TOKEN, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "bogus" }));

		const response = await postRaw(port, TOKEN, JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "atlas_status" } }));
		const body = response.json as { result: { content: { type: string; text: string }[] } };
		expect(JSON.parse(body.result.content[0].text)).toEqual({ ok: true });
	});
});

describe("mcp-protocol — R2: MCP's own handshake, not just tools/call", () => {
	it("initialize returns protocolVersion, capabilities.tools and serverInfo", async () => {
		const { port } = await startServer();
		const response = await postRaw(port, TOKEN, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }));
		expect(response.status).toBe(200);
		const body = response.json as { jsonrpc: string; id: number; result: { protocolVersion: string; capabilities: { tools: unknown }; serverInfo: { name: string; version: string } } };
		expect(body.jsonrpc).toBe("2.0");
		expect(body.id).toBe(1);
		expect(body.result.protocolVersion).toBe("2024-11-05");
		expect(body.result.capabilities.tools).toBeDefined();
		expect(body.result.serverInfo).toBeDefined();
		expect(typeof body.result.serverInfo.name).toBe("string");
		expect(typeof body.result.serverInfo.version).toBe("string");
	});

	it("initialize falls back to a default protocolVersion when the client omits one", async () => {
		const { port } = await startServer();
		const response = await postRaw(port, TOKEN, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
		const body = response.json as { result: { protocolVersion: string } };
		expect(typeof body.result.protocolVersion).toBe("string");
		expect(body.result.protocolVersion.length).toBeGreaterThan(0);
	});

	it("tools/list returns every registered tool, built from the registry", async () => {
		const { port } = await startServer();
		const response = await postRaw(port, TOKEN, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
		expect(response.status).toBe(200);
		const body = response.json as { result: { tools: { name: string; description: string; inputSchema: unknown }[] } };
		expect(body.result.tools).toEqual([expect.objectContaining({ name: "atlas_status" })]);
		expect(body.result.tools[0].inputSchema).toBeDefined();
	});

	it("notifications/initialized — a notification (no id) gets no JSON-RPC response body at all", async () => {
		const { port } = await startServer();
		const response = await postRaw(port, TOKEN, JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
		expect(response.status).toBe(202);
		expect(response.json).toBeNull();
	});

	it("any request lacking an id is treated as a notification — no reply even for an unknown method", async () => {
		const { server, port } = await startServer();
		const response = await postRaw(port, TOKEN, JSON.stringify({ jsonrpc: "2.0", method: "not/a-real-method" }));
		expect(response.status).toBe(202);
		expect(response.json).toBeNull();
		expect(server.isRunning()).toBe(true);
	});

	it("tools/call results come back in MCP's content-array shape, not the bare tool return value", async () => {
		const { port } = await startServer();
		const response = await postRaw(port, TOKEN, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "atlas_status" } }));
		const body = response.json as { result: { content: { type: string; text: string }[] } };
		expect(body.result.content).toEqual([{ type: "text", text: JSON.stringify({ ok: true }) }]);
	});
});
