import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { isAuthorized } from "./mcp-auth";
import { JSON_RPC_ERROR_CODES, McpServerInfo, McpTool, dispatchJsonRpc } from "./mcp-protocol";

/** 1 MB: generous for any tool call this PR or the next two ship, small enough to bound memory
 * for a stray huge body (the E-case this PR's malformed-input matrix covers as "oversized body"). */
const MAX_BODY_BYTES = 1_000_000;

/** Used only when `McpServerOptions.getServerInfo` is omitted — every real caller (`main.ts`)
 * always supplies the real plugin identity; this exists so tests that only exercise `tools/call`
 * don't need to supply one too. */
const DEFAULT_SERVER_INFO: McpServerInfo = { name: "atlas", version: "0.0.0" };

export interface McpServerOptions {
	/** Read fresh on every request/start — a regenerated token or changed port takes effect
	 * immediately, with no restart required to pick either up. */
	getToken: () => string;
	getPort: () => number;
	tools: ReadonlyMap<string, McpTool>;
	/** R2: identifies this server to a client's `initialize` call. */
	getServerInfo?: () => McpServerInfo;
	/** Surfaces to the user — F6: the implementation never passes the token value here. */
	notify: (message: string) => void;
	logError: (message: string, err?: unknown) => void;
}

export interface McpBoundAddress {
	address: string;
	port: number;
}

/**
 * F1: binds `127.0.0.1` explicitly, never `0.0.0.0` or an unspecified host — a request addressed
 * to the machine's LAN/external IP simply never reaches this listener. F2/F3/F4: this class only
 * ever serves MCP's own handshake plus `tools/call` against whatever tools it's given; it has no
 * file, status or node knowledge of its own. F6: never logs or echoes the bearer token, on a 401
 * or anywhere else. R8: never touches `node:http` until `start()` actually runs — a listener is
 * only ever started from the `!Platform.isMobile` path in `main.ts`, so this import is lazy
 * (dynamic `import`) rather than a top-level one that would run on every platform, mobile
 * included, the moment the bundle loads.
 */
export class McpServer {
	private server: Server | null = null;
	private running = false;
	/** The outcome every `start()`/`stop()` call is steering toward — read live, at the one instant
	 * it actually matters (inside the `listen` callback below), rather than cached per-attempt.
	 * That's what lets the *last* call always win regardless of how many start()/stop() calls
	 * landed while an attempt was in flight (R1, R11, R15, R17 were all variations on an earlier,
	 * flag-stacking version of this losing track of which call was most recent). */
	private desiredRunning = false;
	/** Bumped by every `start()`/`stop()` call. The convergence loop below snapshots it before an
	 * attempt and compares again after: if it's unchanged, that attempt's outcome (success,
	 * failure, or a no-op close) fully answers the most recent call and the loop stops; if it
	 * changed mid-attempt, a newer call arrived and the loop runs another iteration to address it. */
	private generation = 0;
	/** The convergence loop currently driving `running` toward `desiredRunning`, if one is active.
	 * A `start()`/`stop()` call that arrives while this is set joins it instead of starting a
	 * second, independently-racing attempt — this is also what makes two concurrent `start()`
	 * calls (no `stop()` between them) return the exact same promise (R1). */
	private activeLoop: Promise<void> | null = null;

	constructor(private options: McpServerOptions) {}

	isRunning(): boolean {
		return this.running;
	}

	/** Only meaningful once `start()` has resolved successfully; used by tests to avoid hard-coding
	 * a port (and so never collide with another test file's own server). */
	getBoundAddress(): McpBoundAddress | null {
		if (!this.server) return null;
		const addr = this.server.address();
		if (!addr || typeof addr === "string") return null;
		return { address: addr.address, port: addr.port };
	}

	/**
	 * E4: a port already bound to another listener shows a `Notice`, logs a console error, and
	 * leaves the server stopped — no fallback port is ever attempted. Resolves once the outcome
	 * (success or failure) is known, never rejects: a failed start is reported through `notify`/
	 * `logError`, not an exception. Safe to call again later (e.g. once the port frees up, or
	 * after a prior failed start) since every call creates a fresh `http.Server` rather than
	 * reusing one that might be latched in a failed state.
	 *
	 * R1/R11/R15/R17: calling `start()` (or `stop()`) again while a previous call is still pending
	 * joins the same convergence loop (see `ensureConverged`) rather than racing an independent
	 * second `listen()`, and the loop always re-reads the *latest* desired state before deciding
	 * it's done — so whichever of `start()`/`stop()` was called last always wins, no matter how
	 * many of the other arrived in between while an attempt was in flight.
	 */
	start(): Promise<void> {
		this.desiredRunning = true;
		this.generation++;
		return this.ensureConverged();
	}

	/** Stops accepting new connections but lets any in-flight request finish — `http.Server.close`'s
	 * own behaviour, so a toggle-off mid-request never tears a response down. Idempotent: calling
	 * it twice, or before `start()`, never throws. See `start()`'s doc comment for how this
	 * interacts with a concurrent or pending `start()`. */
	async stop(): Promise<void> {
		this.desiredRunning = false;
		this.generation++;
		await this.ensureConverged();
	}

	/** Shares a single in-flight convergence attempt across every `start()`/`stop()` call that
	 * arrives while it's running, and starts a fresh one otherwise. */
	private ensureConverged(): Promise<void> {
		if (this.activeLoop) return this.activeLoop;
		const loop = this.runUntilConverged().finally(() => {
			if (this.activeLoop === loop) this.activeLoop = null;
		});
		this.activeLoop = loop;
		return loop;
	}

	/** Drives `running` toward `desiredRunning`, re-checking after every attempt whether a newer
	 * `start()`/`stop()` call arrived while that attempt was in flight. If one did, `generation`
	 * will have moved past the snapshot taken at the top of this iteration, and the loop runs
	 * again to address it; otherwise the most recent call has been fully answered (whether that
	 * answer was "now running", "now stopped", or "attempted and failed — still stopped") and the
	 * loop stops. This is what lets the *last* caller's intent always win: a failed or
	 * superseded bind never gets silently retried, but a bind that's still in flight when a newer
	 * call changes the desired outcome is always re-examined once it settles. */
	private async runUntilConverged(): Promise<void> {
		for (;;) {
			const gen = this.generation;
			const desired = this.desiredRunning;
			if (desired === this.running) {
				if (gen === this.generation) return;
				continue;
			}
			if (desired) {
				await this.attemptStart();
			} else {
				await this.attemptStop();
			}
			if (gen === this.generation) return;
		}
	}

	private async attemptStart(): Promise<void> {
		const { createServer } = await import("node:http"); // R8: lazy — never required on mobile
		const port = this.options.getPort();
		await new Promise<void>((resolve) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				resolve();
			};
			const server = createServer((req, res) => void this.handleRequest(req, res));
			server.on("error", (err: NodeJS.ErrnoException) => {
				this.running = false;
				this.server = null;
				const message =
					err.code === "EADDRINUSE"
						? `Atlas: the MCP server's port (${port}) is already in use — the server was not started.`
						: `Atlas: the MCP server failed to start (${err.message}).`;
				this.options.notify(message);
				this.options.logError("[Atlas MCP] server error", err);
				finish();
			});
			server.listen(port, "127.0.0.1", () => {
				// R17: read the *live* desired state, not a value captured when this attempt was
				// launched — a stop() (or another start()) may have landed while the bind was in
				// flight, and the most recent call must be the one that's honoured.
				if (!this.desiredRunning) {
					server.close();
					this.server = null;
					this.running = false;
				} else {
					this.server = server;
					this.running = true;
				}
				finish();
			});
		});
	}

	private async attemptStop(): Promise<void> {
		const server = this.server;
		this.server = null;
		this.running = false;
		if (!server) return;
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		try {
			if (req.method !== "POST") {
				res.writeHead(405, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Only POST is supported" }));
				return;
			}
			if (!isAuthorized(req.headers.authorization, this.options.getToken())) {
				// E1/F6: rejected with nothing server-side changed, and no hint of the expected value.
				res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Unauthorized" }));
				return;
			}

			const { text, oversized } = await readBody(req, MAX_BODY_BYTES);
			if (oversized) {
				res
					.writeHead(200, { "Content-Type": "application/json" })
					.end(
						JSON.stringify({
							jsonrpc: "2.0",
							id: null,
							error: { code: JSON_RPC_ERROR_CODES.INVALID_REQUEST, message: "Request body exceeds the maximum allowed size" },
						})
					);
				return;
			}

			const serverInfo = this.options.getServerInfo?.() ?? DEFAULT_SERVER_INFO;
			const response = await dispatchJsonRpc(text, this.options.tools, serverInfo);
			if (response === null) {
				// R2: a JSON-RPC notification (no `id`, e.g. MCP's `notifications/initialized`) gets
				// no body at all — 202 Accepted, never an error response the sender has no way to
				// associate back, and never a dropped connection.
				res.writeHead(202).end();
				return;
			}
			res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(response));
		} catch (err) {
			// Defensive: dispatchJsonRpc already turns tool/parse failures into a structured
			// response, so reaching here means something unexpected (a stream error, say) — still
			// never an uncaught exception or a dropped connection.
			this.options.logError("[Atlas MCP] request handling failed", err);
			if (!res.headersSent) {
				res
					.writeHead(200, { "Content-Type": "application/json" })
					.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR, message: "Internal error" } }));
			}
		}
	}
}

/** Reads the whole request body, bounded by `maxBytes`. On overflow, keeps draining the stream to
 * completion (rather than destroying the socket) so the caller can still send back a structured
 * JSON-RPC error instead of dropping the connection — the buffered text is discarded either way. */
function readBody(req: IncomingMessage, maxBytes: number): Promise<{ text: string; oversized: boolean }> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let total = 0;
		let oversized = false;
		req.on("data", (chunk: Buffer) => {
			total += chunk.length;
			if (total > maxBytes) {
				oversized = true;
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve({ text: Buffer.concat(chunks).toString("utf8"), oversized }));
		req.on("error", (err) => reject(err));
	});
}

/** G1: whether the server should auto-start — on when `enabled` is true and the device isn't
 * mobile (F5). A pure function so lifecycle gating is testable against a fake `Platform`/settings
 * host with no real listener involved. */
export function shouldAutoStartMcpServer(enabled: boolean, isMobile: boolean): boolean {
	return enabled && !isMobile;
}
