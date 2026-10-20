import { describe, expect, it } from "vitest";
import { isAuthorized } from "../../src/mcp-auth";

const TOKEN = "correct-token-abc123";

/** E1: table-driven over every auth row, asserting exactly which rows pass and which return 401
 * — a rule, not one example. */
describe("isAuthorized — E1: table-driven over every Authorization header shape", () => {
	const rows: { name: string; header: string | string[] | undefined; expected: boolean }[] = [
		{ name: "no header at all", header: undefined, expected: false },
		{ name: "empty header", header: "", expected: false },
		{ name: "wrong scheme (Basic)", header: `Basic ${TOKEN}`, expected: false },
		{ name: "wrong scheme (lowercase bearer)", header: `bearer ${TOKEN}`, expected: false },
		{ name: "Bearer with no token at all", header: "Bearer", expected: false },
		{ name: "Bearer with only whitespace as the token", header: "Bearer    ", expected: false },
		{ name: "well-formed but wrong token", header: "Bearer some-other-token", expected: false },
		{ name: "correct token", header: `Bearer ${TOKEN}`, expected: true },
		{ name: "correct token with trailing whitespace", header: `Bearer ${TOKEN}   `, expected: true },
		{ name: "correct token with a leading-whitespace artifact before Bearer is still rejected", header: `  Bearer ${TOKEN}`, expected: false },
		{ name: "header value as a string array (Node can type it that way) is rejected, not just stringified", header: [`Bearer ${TOKEN}`], expected: false },
	];

	it.each(rows)("$name -> $expected", ({ header, expected }) => {
		expect(isAuthorized(header, TOKEN)).toBe(expected);
	});

	it("never matches when the current token itself is empty (nothing to compare against)", () => {
		expect(isAuthorized("Bearer ", "")).toBe(false);
		expect(isAuthorized("Bearer anything", "")).toBe(false);
	});

	it("is case-sensitive on the token value", () => {
		expect(isAuthorized(`Bearer ${TOKEN.toUpperCase()}`, TOKEN)).toBe(false);
	});
});
