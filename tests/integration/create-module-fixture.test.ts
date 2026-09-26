import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const DIR = join(__dirname, "..", "fixtures", "create-module-vault");
const ALLOWED_MISSING = ["Gone.md"];

function refs(value: unknown, out: Array<{ kind: string; path: string }> = []) {
	if (Array.isArray(value)) value.forEach((v) => refs(v, out));
	else if (value && typeof value === "object") {
		const o = value as Record<string, unknown>;
		if (typeof o.kind === "string" && typeof o.path === "string") out.push({ kind: o.kind, path: o.path });
		Object.values(o).forEach((v) => refs(v, out));
	}
	return out;
}

describe("create-module fixture vault", () => {
	const data = JSON.parse(readFileSync(join(DIR, "plugin-data.json"), "utf8"));
	it("every ref points at a file or folder in the fixture, bar the deliberate missing one", () => {
		const missing = refs(data).filter((r) => !existsSync(join(DIR, r.path))).map((r) => r.path);
		expect([...new Set(missing)].filter((p) => !ALLOWED_MISSING.includes(p))).toEqual([]);
	});
	it("keeps one deliberately missing row", () => {
		expect(refs(data).some((r) => ALLOWED_MISSING.includes(r.path))).toBe(true);
	});
});
