import { describe, expect, it } from "vitest";

// Pipeline spike smoke test: proves the test runner picks up and passes a new file.
describe("spike smoke", () => {
	it("adds numbers", () => {
		expect(1 + 1).toBe(2);
	});
});
