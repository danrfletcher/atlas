/**
 * The JSON-RPC 2.0 request/response shapes and dispatch logic for the Atlas MCP server, kept
 * separate from `mcp-server.ts`'s HTTP transport so it can be driven directly (no socket needed)
 * by a test, and so a later PR's tools plug into the same `tools` registry without touching the
 * transport at all.
 *
 * R2: speaks enough of MCP's own handshake (`initialize`, `notifications/initialized`,
 * `tools/list`) that a standard MCP client — not just a hand-written `curl` — can reach
 * `tools/call`. `tools/call` results come back in MCP's own `{ content: [...] }` shape rather
 * than the bare tool return value.
 */

export interface McpTool {
	name: string;
	/** Shown to a client via `tools/list` — optional since this PR's only tool (`atlas_status`)
	 * is self-explanatory, but later tools should set one. */
	description?: string;
	/** A JSON Schema object describing `arguments`, shown to a client via `tools/list`. Defaults
	 * to an empty-object schema (no required arguments) when omitted. */
	inputSchema?: Record<string, unknown>;
	/** Receives the call's `arguments` object (empty object when none were given). May throw —
	 * `dispatchJsonRpc` turns that into a well-formed JSON-RPC error, never an uncaught exception. */
	handler: (args: Record<string, unknown>) => unknown | Promise<unknown>;
}

/** Identifies this server to a client's `initialize` call (MCP's `serverInfo`). */
export interface McpServerInfo {
	name: string;
	version: string;
}

interface JsonRpcErrorShape {
	code: number;
	message: string;
}

export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: unknown;
	result?: unknown;
	error?: JsonRpcErrorShape;
}

const JSON_RPC_VERSION = "2.0";

/** The MCP protocol revision this server echoes back when a client's `initialize` call doesn't
 * specify one — in practice every real client sends one, which this server echoes back verbatim
 * (a minimal, permissive negotiation; this PR's scope is reachability, not strict version
 * enforcement across every future MCP revision). */
const DEFAULT_MCP_PROTOCOL_VERSION = "2024-11-05";

/** Standard JSON-RPC 2.0 reserved error codes (the spec reserves -32768..-32000). */
export const JSON_RPC_ERROR_CODES = {
	PARSE_ERROR: -32700,
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	INTERNAL_ERROR: -32603,
} as const;

function errorResponse(id: unknown, code: number, message: string): JsonRpcResponse {
	return { jsonrpc: JSON_RPC_VERSION, id: id ?? null, error: { code, message } };
}

/**
 * Parses and dispatches one JSON-RPC 2.0 request body against a tool registry.
 *
 * Recognises `initialize` (MCP's handshake), `tools/list` (built from `tools`) and `tools/call`
 * (MCP convention: `{ method: "tools/call", params: { name, arguments } }`) — later PRs register
 * more tools in the same `tools` map, never a new top-level RPC method.
 *
 * Returns `null`, never a response body, for a JSON-RPC *notification* — any request object with
 * no `id` member at all, per JSON-RPC 2.0 §4.1 ("Notifications are not confirmable... the Client
 * would not be aware of any errors"). This is also exactly how MCP's own
 * `notifications/initialized` is sent, so it needs no special case: lacking an `id` is what makes
 * it a notification. The HTTP transport turns a `null` return into "202 Accepted, no body"
 * instead of a JSON-RPC error.
 *
 * Never throws: invalid JSON, a non-object body, a missing `jsonrpc`/`method` field (on a request
 * that does carry an `id`), an unknown method or tool name, and a tool handler that itself throws
 * all come back as a structured JSON-RPC error response — the edge case this PR's fence requires
 * ("never an uncaught exception or a dropped connection"). A parse failure or non-object body
 * always gets an `id: null` error reply regardless of notification status: the server can't yet
 * tell whether an `id` was present.
 */
export async function dispatchJsonRpc(
	rawBody: string,
	tools: ReadonlyMap<string, McpTool>,
	serverInfo: McpServerInfo
): Promise<JsonRpcResponse | null> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawBody);
	} catch {
		return errorResponse(null, JSON_RPC_ERROR_CODES.PARSE_ERROR, "Invalid JSON in request body");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return errorResponse(null, JSON_RPC_ERROR_CODES.INVALID_REQUEST, "Request body must be a JSON object");
	}
	const req = parsed as Record<string, unknown>;

	if (!("id" in req)) return null; // a well-formed Request object with no `id` is a Notification — no reply, ever.
	const id = req.id;

	if (req.jsonrpc !== JSON_RPC_VERSION) {
		return errorResponse(id, JSON_RPC_ERROR_CODES.INVALID_REQUEST, 'Missing or invalid "jsonrpc" field; expected "2.0"');
	}
	if (typeof req.method !== "string" || req.method.length === 0) {
		return errorResponse(id, JSON_RPC_ERROR_CODES.INVALID_REQUEST, 'Missing "method" field');
	}

	switch (req.method) {
		case "initialize":
			return handleInitialize(id, req, serverInfo);
		case "tools/list":
			return { jsonrpc: JSON_RPC_VERSION, id, result: { tools: listToolDescriptors(tools) } };
		case "tools/call":
			return handleToolsCall(id, req, tools);
		default:
			return errorResponse(id, JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND, `Unknown method '${req.method}'`);
	}
}

/** MCP's handshake reply: the negotiated protocol version, which capability groups this server
 * supports (just `tools`, with no `listChanged` notifications — the registry is fixed per
 * process lifetime), and this server's own identity. */
function handleInitialize(id: unknown, req: Record<string, unknown>, serverInfo: McpServerInfo): JsonRpcResponse {
	const params = typeof req.params === "object" && req.params !== null ? (req.params as Record<string, unknown>) : {};
	const protocolVersion = typeof params.protocolVersion === "string" ? params.protocolVersion : DEFAULT_MCP_PROTOCOL_VERSION;
	return {
		jsonrpc: JSON_RPC_VERSION,
		id,
		result: {
			protocolVersion,
			capabilities: { tools: {} },
			serverInfo,
		},
	};
}

function listToolDescriptors(tools: ReadonlyMap<string, McpTool>): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
	return Array.from(tools.values()).map((tool) => ({
		name: tool.name,
		description: tool.description ?? "",
		inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
	}));
}

async function handleToolsCall(id: unknown, req: Record<string, unknown>, tools: ReadonlyMap<string, McpTool>): Promise<JsonRpcResponse> {
	const rawParams = typeof req.params === "object" && req.params !== null ? (req.params as Record<string, unknown>) : {};
	if (typeof rawParams.name !== "string" || rawParams.name.length === 0) {
		return errorResponse(id, JSON_RPC_ERROR_CODES.INVALID_PARAMS, 'Missing "params.name" (tool name)');
	}
	const tool = tools.get(rawParams.name);
	if (!tool) {
		return errorResponse(id, JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND, `Unknown tool '${rawParams.name}'`);
	}
	const args = typeof rawParams.arguments === "object" && rawParams.arguments !== null ? (rawParams.arguments as Record<string, unknown>) : {};

	try {
		const result = await tool.handler(args);
		// R2: MCP's own `CallToolResult` shape — a `content` array of blocks, not the bare tool
		// return value — so a standard MCP client (which expects this shape) can actually read it.
		return { jsonrpc: JSON_RPC_VERSION, id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } };
	} catch (err) {
		return errorResponse(id, JSON_RPC_ERROR_CODES.INTERNAL_ERROR, err instanceof Error ? err.message : "Internal error");
	}
}
