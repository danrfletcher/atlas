/**
 * E1: every MCP request is checked against the device-local bearer token before anything else
 * runs — a rule, not a per-call afterthought, so every tool added in a later PR inherits it for
 * free by going through `McpServer.handleRequest`, the single place this is called.
 *
 * Accepts only `Authorization: Bearer <token>` matching the current token exactly. Trailing
 * whitespace around the token is tolerated (Node's own HTTP header parsing already strips
 * leading/trailing optional whitespace per RFC 7230, so this just keeps the same behaviour if
 * anything slips through un-trimmed). A missing header, an empty header, a non-"Bearer" scheme or
 * a well-formed-but-wrong token are all rejected the same way: a boolean, never a thrown error, so
 * the caller can turn a "no" into a plain HTTP 401 — F6: this function never logs the token or the
 * current value it's compared against.
 */
export function isAuthorized(authorizationHeader: string | string[] | undefined | null, currentToken: string): boolean {
	if (typeof authorizationHeader !== "string" || authorizationHeader.length === 0) return false;
	const match = /^Bearer\s+(.*)$/.exec(authorizationHeader);
	if (!match) return false;
	const provided = match[1].trim();
	if (provided.length === 0) return false;
	return provided === currentToken;
}
