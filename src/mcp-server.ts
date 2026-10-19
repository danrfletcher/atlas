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

	/** Serialises every `start()`/`stop()` call into one FIFO queue: each call appends exactly one
	 * operation after whatever is already queued, and operations always run in call order. That
	 * alone is enough for the most recent call to always be the last (and therefore final) word on
	 * the desired state — no counter, flag or convergence loop is needed. R1/R11/R15/R17/R18/R19
	 * were all variations on an earlier, counter-based version of this losing track of which call
	 * was most recent, or retrying a failed bind it should have left alone; a plain queue can't
	 * have either problem because there is nothing to race — each op only ever runs after the one
	 * before it has fully settled. */
	private tail: Promise<void> = Promise.resolve();
	/** The most recently queued operation, for as long as it hasn't finished running. Lets a
	 * second call of the *same* kind that arrives before that operation starts (or while it's
	 * still in flight) join it rather than queue an independent, identical operation behind it —
	 * R19: two concurrent `start()` calls against an already-bound port must produce exactly one
	 * failed bind attempt (one `Notice`, one logged error), not two. Cleared synchronously from
	 * inside the operation's own completion, strictly before the next queued operation runs, so a
	 * settled operation is never handed out to a later caller (that was R18's bug in the previous,
	 * counter-based design: a finished attempt stayed joinable for one extra microtask). */
	private pending: { kind: "start" | "stop"; promise: Promise<void> } | null = null;

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
	 * after a prior failed start) since every attempt creates a fresh `http.Server` rather than
	 * reusing one that might be latched in a failed state.
	 *
	 * Calling `start()` again while an identical call is still queued or in flight returns that
	 * same promise rather than queuing a second, independent attempt — so two concurrent `start()`
	 * calls (e.g. the onload auto-start racing a settings toggle) against an already-bound port
	 * produce exactly one failed-bind `Notice`, not two (R19). A `start()` that arrives behind a
	 * queued `stop()` (or vice versa) is queued strictly after it, so whichever of `start()`/
	 * `stop()` was called last always ends up as the last operation to run, and therefore always
	 * wins (R1/R11/R15/R17/R18).
	 */
	start(): Promise<void> {
		if (this.pending?.kind === "start") return this.pending.promise;
		return this.enqueue("start", () => (this.running ? Promise.resolve() : this.attemptStart()));
	}

	/** Stops accepting new connections but lets any in-flight request finish — `http.Server.close`'s
	 * own behaviour, so a toggle-off mid-request never tears a response down. Idempotent: calling
	 * it twice, or before `start()`, never throws. See `start()`'s doc comment for how this
	 * interacts with a concurrent or queued `start()`. */
	async stop(): Promise<void> {
		if (this.pending?.kind === "stop") return this.pending.promise;
		await this.enqueue("stop", () => (this.server ? this.attemptStop() : Promise.resolve()));
	}

	/** Appends `op` after whatever is currently queued and tracks it as `pending` until it settles.
	 * Because `this.tail` is reassigned to the new promise *before* `op` runs, each queued
	 * operation only ever sees the real, settled `running`/`server` state the operation before it
	 * left behind — never a stale snapshot taken back when it was queued. */
	private enqueue(kind: "start" | "stop", op: () => Promise<void>): Promise<void> {
		const promise: Promise<void> = this.tail.then(async () => {
			try {
				await op();
			} finally {
				if (this.pending?.promise === promise) this.pending = null;
			}
		});
		this.tail = promise;
		this.pending = { kind, promise };
		return promise;
	}

	/** Makes exactly one `listen()` attempt — never retried. A failed bind is reported and left
	 * alone; whatever `start()`/`stop()` call is queued behind this one (if any) runs next and
	 * acts on the outcome, rather than this attempt trying to out-guess a call that hasn't
	 * happened yet. */
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
				this.server = server;
				this.running = true;
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
