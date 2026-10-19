import { createServer as createNetServer } from "node:net";
import { request } from "node:http";
import { networkInterfaces } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
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

	it("R11: a start() issued right after stop() while an earlier start() is still pending wins — the last intent (on) takes effect", async () => {
		const port = await getFreePort();
		const server = makeServer(() => port);

		const a = server.start();
		const b = server.stop();
		const c = server.start();
		await Promise.all([a, b, c]);

		expect(server.isRunning()).toBe(true);
		expect(server.getBoundAddress()).toEqual({ address: "127.0.0.1", port });
	});

	it("R15: start()/stop()/start()/start() chains only one fresh attempt — a single listener, no Notice, port free after a final stop()", async () => {
		const port = await getFreePort();
		const notifications: string[] = [];
		const server = track(
			new McpServer({ getToken: () => "tok", getPort: () => port, tools: new Map(), notify: (m) => notifications.push(m), logError: () => {} })
		);

		const a = server.start();
		const b = server.stop();
		const c = server.start();
		const d = server.start();
		await Promise.all([a, b, c, d]);

		expect(server.isRunning()).toBe(true);
		expect(server.getBoundAddress()).toEqual({ address: "127.0.0.1", port });
		expect(notifications).toHaveLength(0); // no false "port already in use" from a second, redundant bind

		await server.stop();
		expect(server.isRunning()).toBe(false);

		// Proves the socket was actually released, not just this instance's own bookkeeping: a
		// fresh listener can bind the same port immediately afterward.
		const probe = createNetServer();
		await new Promise<void>((resolve, reject) => {
			probe.once("error", reject);
			probe.listen(port, "127.0.0.1", () => resolve());
		});
		await new Promise<void>((resolve) => probe.close(() => resolve()));
	});

	it("R17: start/stop/start/stop — the final stop() always wins, even though a start was queued behind an earlier stop", async () => {
		const port = await getFreePort();
		const server = makeServer(() => port);

		const a = server.start();
		const b = server.stop();
		const c = server.start();
		const e = server.stop();
		await Promise.all([a, b, c, e]);

		expect(server.isRunning()).toBe(false);
		expect(server.getBoundAddress()).toBeNull();
		// Proves the socket was actually released, not just this instance's own bookkeeping.
		const probe = createNetServer();
		await new Promise<void>((resolve, reject) => {
			probe.once("error", reject);
			probe.listen(port, "127.0.0.1", () => resolve());
		});
		await new Promise<void>((resolve) => probe.close(() => resolve()));
	});

	it("R17: an awaited stop() while a start is queued behind an earlier stop still ends up stopped once that queued start settles", async () => {
		const port = await getFreePort();
		const server = makeServer(() => port);

		server.start();
		server.stop();
		const c = server.start();
		await server.stop();

		expect(server.isRunning()).toBe(false);
		expect(server.getBoundAddress()).toBeNull();
		await c; // the queued start must settle without ever flipping isRunning() back to true afterward
		expect(server.isRunning()).toBe(false);

		const probe = createNetServer();
		await new Promise<void>((resolve, reject) => {
			probe.once("error", reject);
			probe.listen(port, "127.0.0.1", () => resolve());
		});
		await new Promise<void>((resolve) => probe.close(() => resolve()));
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

	it("R18: a start() that's already settled and converged does not get joined by a later start()+stop() pair — the stop() still wins", async () => {
		const port = await getFreePort();
		const server = makeServer(() => port);

		await server.start();
		expect(server.isRunning()).toBe(true);

		// The first start() has fully resolved (and so has whatever cleared its bookkeeping) by
		// the time this line runs — the earlier, counter-based implementation left a one-microtask
		// window right here where a start()+stop() pair issued now could still join the already-
		// finished attempt and never see the stop() at all (R18).
		await Promise.all([server.start(), server.stop()]);

		expect(server.isRunning()).toBe(false);
		expect(server.getBoundAddress()).toBeNull();
		// Proves the socket was actually released, not just this instance's own bookkeeping.
		const probe = createNetServer();
		await new Promise<void>((resolve, reject) => {
			probe.once("error", reject);
			probe.listen(port, "127.0.0.1", () => resolve());
		});
		await new Promise<void>((resolve) => probe.close(() => resolve()));
	});

	it("R18: the same window, inverted — a stop()+start() pair issued against an already-converged stopped server still ends up running", async () => {
		const port = await getFreePort();
		const server = makeServer(() => port);

		expect(server.isRunning()).toBe(false);

		await Promise.all([server.stop(), server.start()]);

		expect(server.isRunning()).toBe(true);
		expect(server.getBoundAddress()).toEqual({ address: "127.0.0.1", port });
	});

	it("R19: two concurrent start() calls against an already-bound port produce exactly one failed-bind Notice and one logged error, not two", async () => {
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

			await Promise.all([server.start(), server.start()]);

			expect(server.isRunning()).toBe(false);
			expect(notifications).toHaveLength(1);
			expect(notifications[0]).toMatch(/already in use/i);
			expect(errors).toHaveLength(1);
		} finally {
			await new Promise<void>((resolve) => squatter.close(() => resolve()));
		}
	});
});

describe("McpServer — R20: a failed start never poisons the start/stop queue", () => {
	it("a start() that throws synchronously (bad port) resolves rather than rejects, and a later start() on a valid port still binds", async () => {
		// Node throws ERR_SOCKET_BAD_PORT straight out of `listen()` for a port outside 0–65535 —
		// synchronously, never via the `error` event — which is exactly the shape of failure R20
		// found the FIFO queue couldn't survive.
		let port = 70000;
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

		await expect(server.start()).resolves.toBeUndefined();
		expect(server.isRunning()).toBe(false);
		expect(notifications).toHaveLength(1);
		expect(errors).toHaveLength(1);

		// The queue must not be stuck rejecting forever behind that failure: once the port is
		// fixed, the very next start() attempts a fresh bind rather than staying latched.
		port = await getFreePort();
		await expect(server.start()).resolves.toBeUndefined();
		expect(server.isRunning()).toBe(true);
		expect(server.getBoundAddress()).toEqual({ address: "127.0.0.1", port });

		await expect(server.stop()).resolves.toBeUndefined();
		expect(server.isRunning()).toBe(false);

		// Proves the socket was actually released, not just this instance's own bookkeeping.
		const probe = createNetServer();
		await new Promise<void>((resolve, reject) => {
			probe.once("error", reject);
			probe.listen(port, "127.0.0.1", () => resolve());
		});
		await new Promise<void>((resolve) => probe.close(() => resolve()));
	});

	it("stop() right after a failed start still resolves rather than rejecting with the stale error", async () => {
		const server = track(
			new McpServer({ getToken: () => "tok", getPort: () => 70000, tools: new Map(), notify: () => {}, logError: () => {} })
		);
		await server.start();
		expect(server.isRunning()).toBe(false);
		await expect(server.stop()).resolves.toBeUndefined();
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

	// R13: the naive version of this test (probe a closed port directly and expect ECONNREFUSED)
	// always skipped on this dev Mac — its LAN interface silently drops packets to closed ports
	// over a non-loopback address instead of sending TCP RST, so no ECONNREFUSED (or any reply)
	// ever arrives, closed port or not. That made the skip-check indistinguishable from "this
	// environment can't observe LAN refusal at all" and from "this environment can't route to
	// its own LAN IP at all" — the real F1 property (127.0.0.1-only binding) was never actually
	// exercised here. A *control* listener, explicitly bound to `0.0.0.0` (all interfaces), is
	// reachable via the LAN IP on this same host — proving the environment *can* route LAN-IP
	// traffic to a real listener. Only once that control succeeds does the test ask whether the
	// MCP server's own 127.0.0.1-only listener is reachable the same way (it must not be);
	// skip is reserved for the case where even the control itself can't connect.
	it("a 0.0.0.0 control listener is reachable over the LAN IP, but the MCP server's 127.0.0.1-only listener is not", async (ctx) => {
		if (!lanIp) {
			ctx.skip("this machine has no non-internal IPv4 address to probe against");
			return;
		}

		const { createServer: createHttpServer } = await import("node:http");
		const control = createHttpServer((_req, res) => res.end("ok"));
		await new Promise<void>((resolve, reject) => {
			control.once("error", reject);
			control.listen(0, "0.0.0.0", () => resolve());
		});
		const controlPort = (control.address() as { port: number }).port;

		try {
			await connectWithTimeout(lanIp, controlPort, 1500);
		} catch (err) {
			ctx.skip(
				`this environment doesn't deliver LAN-IP traffic even to a 0.0.0.0 control listener (${(err as Error).message}) — a sandbox/VPN property of the environment, not this server's code`
			);
			return;
		} finally {
			await new Promise<void>((resolve) => control.close(() => resolve()));
		}

		const server = makeServer(() => 0);
		await server.start();
		const port = server.getBoundAddress()!.port;

		// F1: refused outright (ECONNREFUSED) or, on a host that drops rather than resets,
		// never answered within the bound — either way, never a real response the way the
		// 0.0.0.0 control above just proved this environment is capable of delivering.
		await expect(connectWithTimeout(lanIp, port, 2000)).rejects.toBeInstanceOf(Error);
	}, 8000);
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
