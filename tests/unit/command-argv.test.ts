import { describe, expect, it } from "vitest";
import { extractPlaceholders, resolveArgv, tokenizeCommand, validateCommand, MAX_ARG_LENGTH } from "../../src/command-argv";
import hostileItems from "../fixtures/hostile-api.json";

describe("command-argv — G9b: Documented command splitter and argv builder", () => {
	describe("Table-driven command splitter (tokenizeCommand)", () => {
		const testCases: { input: string; expected: string[] }[] = [
			{ input: "open -a Docker", expected: ["open", "-a", "Docker"] },
			{ input: "  open   -a    Docker   ", expected: ["open", "-a", "Docker"] },
			{ input: 'open -a "Docker Desktop"', expected: ["open", "-a", "Docker Desktop"] },
			{ input: "open -a 'Docker Desktop'", expected: ["open", "-a", "Docker Desktop"] },
			{ input: 'echo "escaped \\"quotes\\""', expected: ["echo", 'escaped "quotes"'] },
			{ input: "echo 'escaped \\'quotes\\''", expected: ["echo", "escaped 'quotes'"] },
			{ input: '--flag="with value"', expected: ["--flag=with value"] },
			{ input: "--flag='with value'", expected: ["--flag=with value"] },
			{ input: 'record-args {path} "extra arg"', expected: ["record-args", "{path}", "extra arg"] },
			{ input: "", expected: [] },
			{ input: "   ", expected: [] },
		];

		for (const tc of testCases) {
			it(`splits "${tc.input}" into ${JSON.stringify(tc.expected)}`, () => {
				const res = tokenizeCommand(tc.input);
				expect(res.ok).toBe(true);
				if (res.ok) {
					expect(res.tokens).toEqual(tc.expected);
				}
			});
		}

		it("rejects unbalanced double quotes with an inline error", () => {
			const res = tokenizeCommand('open -a "Docker Desktop');
			expect(res.ok).toBe(false);
			if (!res.ok) {
				expect(res.error).toBe("Unbalanced quote in command");
			}
		});

		it("rejects unbalanced single quotes with an inline error", () => {
			const res = tokenizeCommand("open -a 'Docker Desktop");
			expect(res.ok).toBe(false);
			if (!res.ok) {
				expect(res.error).toBe("Unbalanced quote in command");
			}
		});

		it("rejects trailing escaped quote that leaves string open", () => {
			const res = tokenizeCommand('echo "unclosed\\"');
			expect(res.ok).toBe(false);
			if (!res.ok) {
				expect(res.error).toBe("Unbalanced quote in command");
			}
		});
	});

	describe("Placeholder extraction (extractPlaceholders)", () => {
		it("extracts unique valid placeholders", () => {
			expect(extractPlaceholders("record-args {path} {name} {path}")).toEqual(["path", "name"]);
		});

		it("returns empty array when no placeholders are present", () => {
			expect(extractPlaceholders("open -a Docker")).toEqual([]);
		});

		it("ignores invalid placeholder formats with dashes or special chars", () => {
			expect(extractPlaceholders("record-args {invalid-name} {valid_name_1}")).toEqual(["valid_name_1"]);
		});
	});

	describe("Command validation at save time (validateCommand)", () => {
		it("rejects an empty command string", () => {
			const res = validateCommand("   ");
			expect(res.ok).toBe(false);
			if (!res.ok) expect(res.error).toBe("Command cannot be empty");
		});

		it("rejects unbalanced quotes", () => {
			const res = validateCommand('open -a "Docker');
			expect(res.ok).toBe(false);
			if (!res.ok) expect(res.error).toBe("Unbalanced quote in command");
		});

		it("rejects unknown placeholders not in available extra fields", () => {
			const res = validateCommand("record-args {path} {missing}", ["path"]);
			expect(res.ok).toBe(false);
			if (!res.ok) expect(res.error).toBe("Unknown placeholder: {missing}");
		});

		it("accepts valid command with all placeholders available", () => {
			const res = validateCommand("record-args {path} {name}", ["path", "name", "unused"]);
			expect(res.ok).toBe(true);
			if (res.ok) {
				expect(res.tokens).toEqual(["record-args", "{path}", "{name}"]);
				expect(res.placeholders).toEqual(["path", "name"]);
			}
		});
	});

	describe("Placeholder substitution at run time (resolveArgv)", () => {
		it("maps each placeholder to exactly one argv element even with spaces, quotes, and newlines", () => {
			const tokens = ["record-args", "{path}"];
			const complexValue = "Path With 'Quotes' & \"Double Quotes\"\nAnd Newline";
			const res = resolveArgv(tokens, { path: complexValue });
			expect(res.ok).toBe(true);
			if (res.ok) {
				expect(res.argv).toHaveLength(2);
				expect(res.argv[0]).toBe("record-args");
				expect(res.argv[1]).toBe(complexValue);
			}
		});

		it("preserves empty string values as a single argv element", () => {
			const tokens = ["record-args", "{empty}"];
			const res = resolveArgv(tokens, { empty: "" });
			expect(res.ok).toBe(true);
			if (res.ok) {
				expect(res.argv).toEqual(["record-args", ""]);
			}
		});

		it("substitutes placeholders within a flag token as a single element", () => {
			const tokens = ["cmd", "--path={path}"];
			const res = resolveArgv(tokens, { path: "/app with space/bin" });
			expect(res.ok).toBe(true);
			if (res.ok) {
				expect(res.argv).toEqual(["cmd", "--path=/app with space/bin"]);
			}
		});

		it("fails when a placeholder value is missing on the row", () => {
			const tokens = ["record-args", "{path}"];
			const res = resolveArgv(tokens, { other: "val" });
			expect(res.ok).toBe(false);
			if (!res.ok) {
				expect(res.error).toBe("Missing value for placeholder: {path}");
				expect(res.missingPlaceholder).toBe("path");
			}
		});

		it("fails when a placeholder value is null", () => {
			const tokens = ["record-args", "{path}"];
			const res = resolveArgv(tokens, { path: null });
			expect(res.ok).toBe(false);
			if (!res.ok) {
				expect(res.error).toBe("Missing value for placeholder: {path}");
			}
		});

		it("rejects over-length values exceeding the 100 KB limit", () => {
			const huge = "a".repeat(MAX_ARG_LENGTH + 1);
			const tokens = ["record-args", "{path}"];
			const res = resolveArgv(tokens, { path: huge });
			expect(res.ok).toBe(false);
			if (!res.ok) {
				expect(res.error).toContain("100 KB limit");
				expect(res.overlength).toBe(true);
			}
		});

		it("preserves unicode and emoji values intact", () => {
			const tokens = ["record-args", "{msg}"];
			const unicodeMsg = "🚀 Launch 測試 123";
			const res = resolveArgv(tokens, { msg: unicodeMsg });
			expect(res.ok).toBe(true);
			if (res.ok) {
				expect(res.argv).toEqual(["record-args", unicodeMsg]);
			}
		});
	});

	describe("Hostile-value corpus — No shell expansion", () => {
		for (const item of hostileItems) {
			it(`treats hostile value from ${item.id} ("${item.name}") strictly as a literal argument`, () => {
				const tokens = ["record-args", "{path}"];
				const res = resolveArgv(tokens, { path: item.path });
				expect(res.ok).toBe(true);
				if (res.ok) {
					// Must have exactly 2 argv elements: command and literal value
					expect(res.argv).toHaveLength(2);
					expect(res.argv[0]).toBe("record-args");
					expect(res.argv[1]).toBe(item.path);
					// Not split by spaces, pipes, semicolons, or newlines
					expect(typeof res.argv[1]).toBe("string");
				}
			});
		}
	});
});
