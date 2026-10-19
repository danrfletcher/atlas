import { createServer as createNetServer } from "node:net";
import { request } from "node:http";
import { networkInterfaces } from "node:os";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { App, Platform } from "obsidian";
import { McpServer, shouldAutoStartMcpServer } from "../../src/mcp-server";
import { McpTool } from "../../src/mcp-protocol";
import AtlasPlugin from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/settings";

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

describe("McpServer — R1: start()/stop() race safety", () => {
	it("stop() called while start() is still pending closes the listener once it binds, instead of leaving it orphaned", async () => {
		const port = await getFreePort();
		const server = makeServer(() => port);

		const p = server.start();
		await server.stop();
		await p;

		expect(server.isRunning()).toBe(false);
		expect(server.getBoundAddress()).toBeNull();
		// Proves the socket was actually released (not just this instance's own bookkeeping): a
		// fresh listener can bind the same port immediately afterward.
		const probe = createNetServer();
		await new Promise<void>((resolve, reject) => {
			probe.once("error", reject);
			probe.listen(port, "127.0.0.1", () => resolve());
		});
		await new Promise<void>((resolve) => probe.close(() => resolve()));
	});

	it("two concurrent start() calls on the same instance share one attempt rather than racing a second listen()", async () => {
		const port = await getFreePort();
		const server = makeServer(() => port);

		const p1 = server.start();
		const p2 = server.start();
		expect(p1).toBe(p2); // the exact same in-flight promise, not two independent attempts

		await Promise.all([p1, p2]);
		expect(server.isRunning()).toBe(true);
		expect(server.getBoundAddress()).toEqual({ address: "127.0.0.1", port });
	});

	it("an onload auto-start racing a settings toggle never produces a false 'port already in use' Notice", async () => {
		const port = await getFreePort();
		const notifications: string[] = [];
		const server = track(
			new McpServer({ getToken: () => "tok", getPort: () => port, tools: new Map(), notify: (m) => notifications.push(m), logError: () => {} })
		);

		// Mirrors main.ts: onload's own auto-start and a settings-panel toggle both call start()
		// on the same McpServer instance without awaiting each other first.
		await Promise.all([server.start(), server.start()]);

		expect(server.isRunning()).toBe(true);
		expect(notifications).toHaveLength(0);
	});
});

describe("McpServer — a toggle-off mid-request lets that response complete", () => {
	it("stop() called while a request is in flight still lets that request's response arrive", async () => {
		const port = await getFreePort();
		const tools = new Map<string, McpTool>();
		let release: (() => void) | null = null;
		let handlerEntered: (() => void) | null = null;
		const entered = new Promise<void>((resolve) => {
			handlerEntered = resolve;
		});
		tools.set("slow_tool", {
			name: "slow_tool",
			handler: () =>
				new Promise((resolve) => {
					release = () => resolve({ ok: true });
					handlerEntered?.();
				}),
		});
		const server = track(new McpServer({ getToken: () => "tok", getPort: () => port, tools, notify: () => {}, logError: () => {} }));
		await server.start();

		const pending = postJson(port, "tok", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slow_tool" } });
		// Wait for the handler itself to signal it's running (not a fixed sleep — R4: a timed guess
		// at how long the request takes to reach the handler is exactly the kind of thing that
		// flakes under load), then toggle off — `http.Server.close()`'s own semantics: stop
		// accepting new connections, let this one finish.
		await entered;
		const stopping = server.stop();
		expect(release).not.toBeNull();
		release!();

		const response = await pending;
		expect(response.status).toBe(200);
		const body = response.json as { result: { content: { type: string; text: string }[] } };
		expect(JSON.parse(body.result.content[0].text)).toEqual({ ok: true });
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

	const lanIp = pickNonInternalIPv4();
	// R3: some sandboxes/VPN-tunnelled hosts silently drop packets to a closed port on a
	// non-loopback local address instead of sending TCP RST (no ECONNREFUSED ever arrives, only a
	// timeout) — a firewall/network-namespace property of the *environment*, not something this
	// server's own code controls either way. Probed once in `beforeAll`, against a port nothing
	// binds, so the real assertion below skips itself with a clear reason on such a host rather
	// than failing on something this PR can't fix.
	let canObserveRefusal = false;
	beforeAll(async () => {
		if (!lanIp) return;
		try {
			await connectWithTimeout(lanIp, 1, 1500);
		} catch (err) {
			canObserveRefusal = (err as NodeJS.ErrnoException).code === "ECONNREFUSED";
		}
	});

	it("a request addressed to the machine's own LAN/external IP is refused (ECONNREFUSED) — only 127.0.0.1 is listening", async (ctx) => {
		if (!lanIp) {
			ctx.skip("this machine has no non-internal IPv4 address to probe against");
			return;
		}
		if (!canObserveRefusal) {
			ctx.skip("this environment doesn't deliver ECONNREFUSED for a closed port on a non-loopback local address (a firewall/VPN property of the sandbox, not this server's code)");
			return;
		}
		const server = makeServer(() => 0);
		await server.start();
		const port = server.getBoundAddress()!.port;

		await expect(connectWithTimeout(lanIp, port, 2000)).rejects.toMatchObject({ code: "ECONNREFUSED" });
	}, 5000);
});

/** The first non-internal (not 127.0.0.1/::1) IPv4 address this machine has, or `null` if there
 * genuinely isn't one (e.g. a sandboxed CI runner with only loopback) — R3's LAN-refusal test
 * skips itself with a reason rather than failing when there's nothing to probe against. */
function pickNonInternalIPv4(): string | null {
	const interfaces = networkInterfaces();
	for (const addresses of Object.values(interfaces)) {
		for (const info of addresses ?? []) {
			if (info.family === "IPv4" && !info.internal) return info.address;
		}
	}
	return null;
}

/** Attempts a bounded-time HTTP POST to `host:port`. Rejects with the connection error (expected:
 * `ECONNREFUSED`, since nothing listens on that address) or a timeout error if the OS never
 * replies at all — either way this never hangs the test suite. */
function connectWithTimeout(host: string, port: number, timeoutMs: number): Promise<never> {
	return new Promise((resolve, reject) => {
		const req = request({ host, port, method: "POST", path: "/", timeout: timeoutMs }, () => resolve(undefined as never));
		req.on("timeout", () => {
			req.destroy();
			reject(new Error(`timed out waiting for a response from ${host}:${port}`));
		});
		req.on("error", (err) => reject(err));
		req.end();
	});
}

describe("AtlasPlugin's own MCP lifecycle gating (R4) — driven through the real plugin method, not reimplemented inline", () => {
	afterEach(() => {
		Platform.isMobile = false;
	});

	function makePlugin(): AtlasPlugin & Record<string, unknown> {
		const plugin = Object.create(AtlasPlugin.prototype) as AtlasPlugin & Record<string, unknown>;
		plugin.app = new App();
		plugin.manifest = { id: "atlas-explorer", name: "Atlas Explorer", version: "9.9.9", minAppVersion: "1.13.1", description: "", author: "", isDesktopOnly: false };
		plugin.folderLiveRefresh = { cancelAll: () => {} };
		plugin.externalMoveDetector = { cancelAll: () => {} };
		plugin.outsideFolderWatchers = { closeAll: () => {} };
		plugin.graduation = { dispose: () => {} };
		plugin.persistDebounced = undefined;
		plugin.linkSuggest = undefined;
		plugin.mcpServer = null; // Object.create bypasses AtlasPlugin's own `= null` field initializer
		return plugin;
	}

	it("desktop + enabled: the real initMcpServer() constructs and starts the server; onunload stops it", async () => {
		Platform.isMobile = false;
		const plugin = makePlugin();
		plugin.settings = { ...DEFAULT_SETTINGS, mcpServerEnabled: true };

		await (plugin as unknown as { initMcpServer(): Promise<void> }).initMcpServer();

		expect(plugin.mcpServer).not.toBeNull();
		const server = plugin.mcpServer as McpServer;
		expect(server.isRunning()).toBe(true);
		track(server);

		const stopSpy = vi.spyOn(server, "stop");
		plugin.onunload();
		expect(stopSpy).toHaveBeenCalledTimes(1);
		await stopSpy.mock.results[0].value;
		expect(server.isRunning()).toBe(false);
	});

	it("desktop + disabled: constructs the server (so a later toggle-on works) but never starts it", async () => {
		Platform.isMobile = false;
		const plugin = makePlugin();
		plugin.settings = { ...DEFAULT_SETTINGS, mcpServerEnabled: false };

		await (plugin as unknown as { initMcpServer(): Promise<void> }).initMcpServer();

		expect(plugin.mcpServer).not.toBeNull();
		expect((plugin.mcpServer as McpServer).isRunning()).toBe(false);
	});

	it("mobile + enabled: F5 — onload's real gating never even constructs the server", async () => {
		Platform.isMobile = true;
		const plugin = makePlugin();
		plugin.settings = { ...DEFAULT_SETTINGS, mcpServerEnabled: true };

		await (plugin as unknown as { initMcpServer(): Promise<void> }).initMcpServer();

		expect(plugin.mcpServer).toBeNull();
	});

	it("mobile + disabled: also never constructs the server", async () => {
		Platform.isMobile = true;
		const plugin = makePlugin();
		plugin.settings = { ...DEFAULT_SETTINGS, mcpServerEnabled: false };

		await (plugin as unknown as { initMcpServer(): Promise<void> }).initMcpServer();

		expect(plugin.mcpServer).toBeNull();
	});

	it("onunload is a no-op (never throws) when the server was never constructed", () => {
		Platform.isMobile = true;
		const plugin = makePlugin();
		plugin.mcpServer = null;
		expect(() => plugin.onunload()).not.toThrow();
	});
});
