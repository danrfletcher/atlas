import { createServer as createNetServer } from "node:net";
import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer, shouldAutoStartMcpServer } from "../../src/mcp-server";
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

function postJson(port: number, token: string, body: unknown): Promise<{ status: number; json: unknown }> {
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
function track(server: McpServer): McpServer {
	servers.push(server);
	return server;
}
afterEach(async () => {
	await Promise.all(servers.splice(0).map((s) => s.stop()));
});

function makeServer(getPort: () => number) {
	const tools = new Map<string, McpTool>();
	return track(
		new McpServer({
			getToken: () => "test-token",
			getPort,
			tools,
			notify: () => {},
			logError: () => {},
		})
	);
}

describe("shouldAutoStartMcpServer — G1/F5: a pure gating rule, testable with no real listener", () => {
	it("starts only when enabled and not mobile", () => {
		expect(shouldAutoStartMcpServer(true, false)).toBe(true);
	});
	it("never starts when disabled, desktop or not", () => {
		expect(shouldAutoStartMcpServer(false, false)).toBe(false);
		expect(shouldAutoStartMcpServer(false, true)).toBe(false);
	});
	it("never starts on mobile even when enabled", () => {
		expect(shouldAutoStartMcpServer(true, true)).toBe(false);
	});
});

describe("McpServer lifecycle — against a fake settings/Platform host", () => {
	it("a fake host that mirrors main.ts's own wiring: desktop+enabled really starts the listener", async () => {
		const port = await getFreePort();
		const settings = { mcpServerEnabled: true };
		const platform = { isMobile: false };
		let server: McpServer | null = null;
		if (!platform.isMobile) {
			server = makeServer(() => port);
			if (shouldAutoStartMcpServer(settings.mcpServerEnabled, platform.isMobile)) await server.start();
		}
		expect(server?.isRunning()).toBe(true);
	});

	it("desktop+disabled constructs the server (so a later toggle-on works) but never starts it", async () => {
		const port = await getFreePort();
		const settings = { mcpServerEnabled: false };
		const platform = { isMobile: false };
		let server: McpServer | null = null;
		if (!platform.isMobile) {
			server = makeServer(() => port);
			if (shouldAutoStartMcpServer(settings.mcpServerEnabled, platform.isMobile)) await server.start();
		}
		expect(server).not.toBeNull();
		expect(server?.isRunning()).toBe(false);
	});

	it("mobile+enabled never even constructs the server — F5: no listener, port or token work at all", async () => {
		const settings = { mcpServerEnabled: true };
		const platform = { isMobile: true };
		let server: McpServer | null = null;
		if (!platform.isMobile) {
			server = makeServer(() => 0);
			if (shouldAutoStartMcpServer(settings.mcpServerEnabled, platform.isMobile)) await server.start();
		}
		expect(server).toBeNull();
	});

	it("mobile+disabled also never constructs the server", async () => {
		const settings = { mcpServerEnabled: false };
		const platform = { isMobile: true };
		let server: McpServer | null = null;
		if (!platform.isMobile) {
			server = makeServer(() => 0);
			if (shouldAutoStartMcpServer(settings.mcpServerEnabled, platform.isMobile)) await server.start();
		}
		expect(server).toBeNull();
	});
});

describe("McpServer.stop — idempotent", () => {
	it("calling stop() before start() never throws", async () => {
		const server = makeServer(() => 0);
		await expect(server.stop()).resolves.toBeUndefined();
	});

	it("calling stop() twice after a real start never throws, and isRunning stays false", async () => {
		const port = await getFreePort();
		const server = makeServer(() => port);
		await server.start();
		expect(server.isRunning()).toBe(true);
		await server.stop();
		expect(server.isRunning()).toBe(false);
		await expect(server.stop()).resolves.toBeUndefined();
		expect(server.isRunning()).toBe(false);
	});
});

describe("McpServer — a toggle-off mid-request lets that response complete", () => {
	it("stop() called while a request is in flight still lets that request's response arrive", async () => {
		const port = await getFreePort();
		const tools = new Map<string, McpTool>();
		let release: (() => void) | null = null;
		tools.set("slow_tool", {
			name: "slow_tool",
			handler: () =>
				new Promise((resolve) => {
					release = () => resolve({ ok: true });
				}),
		});
		const server = track(new McpServer({ getToken: () => "tok", getPort: () => port, tools, notify: () => {}, logError: () => {} }));
		await server.start();

		const pending = postJson(port, "tok", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slow_tool" } });
		// Give the request time to reach the handler and register `release`, then toggle off —
		// `http.Server.close()`'s own semantics: stop accepting new connections, let this one finish.
		await new Promise((r) => setTimeout(r, 20));
		const stopping = server.stop();
		expect(release).not.toBeNull();
		release!();

		const response = await pending;
		expect(response.status).toBe(200);
		expect((response.json as { result: { ok: boolean } }).result).toEqual({ ok: true });
		await stopping;
		expect(server.isRunning()).toBe(false);
	});
});

describe("McpServer.start — E4: port already bound", () => {
	it("a Notice, a logged console error, isRunning() stays false, and no second bind on a different port", async () => {
		const port = await getFreePort();
		const squatter = createNetServer();
		await new Promise<void>((resolve, reject) => {
			squatter.once("error", reject);
			squatter.listen(port, "127.0.0.1", () => resolve());
		});

		try {
			const notifications: string[] = [];
			const errors: unknown[] = [];
			const server = track(
				new McpServer({
					getToken: () => "tok",
					getPort: () => port,
					tools: new Map(),
					notify: (message) => notifications.push(message),
					logError: (message, err) => errors.push({ message, err }),
				})
			);

			await server.start();

			expect(server.isRunning()).toBe(false);
			expect(notifications).toHaveLength(1);
			expect(notifications[0]).toMatch(/already in use/i);
			expect(errors).toHaveLength(1);
			// F6: the Notice/log never contain the bearer token.
			expect(notifications[0]).not.toContain("tok");
		} finally {
			await new Promise<void>((resolve) => squatter.close(() => resolve()));
		}
	});

	it("re-enabling after a prior failed start attempts a fresh bind once the port frees up", async () => {
		const port = await getFreePort();
		const squatter = createNetServer();
		await new Promise<void>((resolve, reject) => {
			squatter.once("error", reject);
			squatter.listen(port, "127.0.0.1", () => resolve());
		});

		const server = makeServer(() => port);
		await server.start();
		expect(server.isRunning()).toBe(false);

		await new Promise<void>((resolve) => squatter.close(() => resolve()));

		await server.start();
		expect(server.isRunning()).toBe(true);
		expect(server.getBoundAddress()).toEqual({ address: "127.0.0.1", port });
	});
});

describe("McpServer — F1: binds 127.0.0.1 explicitly", () => {
	it("getBoundAddress() reports 127.0.0.1, never 0.0.0.0 or an unspecified host", async () => {
		const server = makeServer(() => 0); // port 0: let the OS pick a free one
		await server.start();
		expect(server.getBoundAddress()?.address).toBe("127.0.0.1");
	});
});
