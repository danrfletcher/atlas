/**
 * The JSON-RPC 2.0 request/response shapes and dispatch logic for the Atlas MCP server, kept
 * separate from `mcp-server.ts`'s HTTP transport so it can be driven directly (no socket needed)
 * by a test, and so a later PR's tools plug into the same `tools` registry without touching the
 * transport at all.
 */

export interface McpTool {
	name: string;
	/** Receives the call's `arguments` object (empty object when none were given). May throw —
	 * `dispatchJsonRpc` turns that into a well-formed JSON-RPC error, never an uncaught exception. */
	handler: (args: Record<string, unknown>) => unknown | Promise<unknown>;
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
 * Parses and dispatches one JSON-RPC 2.0 request body against a tool registry. The only method
 * this PR (and the dispatch plumbing it provides) recognises is `tools/call`, matching the MCP
 * convention `{ method: "tools/call", params: { name, arguments } }` — later PRs register more
 * tools in the same `tools` map, never a new top-level RPC method.
 *
 * Never throws: invalid JSON, a missing `jsonrpc`/`method` field, an unknown method or tool name,
 * and a tool handler that itself throws all come back as a structured JSON-RPC error response —
 * the edge case this PR's fence requires ("never an uncaught exception or a dropped connection").
 */
export async function dispatchJsonRpc(rawBody: string, tools: ReadonlyMap<string, McpTool>): Promise<JsonRpcResponse> {
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
	const id = "id" in req ? req.id : null;

	if (req.jsonrpc !== JSON_RPC_VERSION) {
		return errorResponse(id, JSON_RPC_ERROR_CODES.INVALID_REQUEST, 'Missing or invalid "jsonrpc" field; expected "2.0"');
	}
	if (typeof req.method !== "string" || req.method.length === 0) {
		return errorResponse(id, JSON_RPC_ERROR_CODES.INVALID_REQUEST, 'Missing "method" field');
	}
	if (req.method !== "tools/call") {
		return errorResponse(id, JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND, `Unknown method '${req.method}'`);
	}

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
		return { jsonrpc: JSON_RPC_VERSION, id, result };
	} catch (err) {
		return errorResponse(id, JSON_RPC_ERROR_CODES.INTERNAL_ERROR, err instanceof Error ? err.message : "Internal error");
	}
}
