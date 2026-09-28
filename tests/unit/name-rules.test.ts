import { describe, expect, it } from "vitest";
import { TFile, TFolder, Vault } from "obsidian";
import { NameRuleOptions, RootEntry, collectRootEntries, validateName } from "../../src/name-rules";

// FX-ROOT
const ROOT: RootEntry[] = [
	{ name: "Alpha.md", kind: "file" },
	{ name: "Solo.md", kind: "file" },
	{ name: "Pair.md", kind: "file" },
	{ name: "Reading list.md", kind: "file" },
	{ name: "Résumé.md", kind: "file" }, // stored NFD
	{ name: "photo.png", kind: "file" },
	{ name: "Canvas.canvas", kind: "file" },
	{ name: "Projects", kind: "folder" },
	{ name: "Bets", kind: "folder" },
	{ name: "Duo", kind: "folder" },
	{ name: "Pair", kind: "folder" },
];
const BASE: NameRuleOptions = { root: ROOT, poolFolder: "_pool", excludedFolders: ["_pool", "_to_delete"] };

const EMPTY = "Enter a name";
const TOO_LONG = "That name is too long (252 bytes at most)";
const LEADING_DOT = "A name can't start with a dot";
const TRAILING = "A name can't end with a dot or a space";
const clashMsg = (n: string) => `A note or folder called '${n}' already exists at the vault root`;
const reservedMsg = (n: string) => `'${n}' is a reserved name`;
const illegalMsg = (chars: string) => `A name can't contain: ${chars}`;
const linkMsg = (chars: string) => `A name can't contain: ${chars} (they break links)`;

type Row = [id: string, name: string, expected: { code: string; message: string } | "valid", options?: NameRuleOptions];

const rows: Row[] = [
	["NV-01", "", { code: "empty", message: EMPTY }],
	["NV-02", "   ", { code: "empty", message: EMPTY }],
	["NV-03", "\t", { code: "empty", message: EMPTY }],
	["NV-04", "a".repeat(253), { code: "too-long", message: TOO_LONG }],
	["NV-05", "a".repeat(252), "valid"],
	["NV-06", "é".repeat(126), "valid"],
	["NV-07", "é".repeat(127), { code: "too-long", message: TOO_LONG }],
	["NV-08", "\u{1F600}".repeat(63), "valid"],
	["NV-09", "\u{1F600}".repeat(64), { code: "too-long", message: TOO_LONG }],
	["NV-10", "/".repeat(300), { code: "too-long", message: TOO_LONG }],
	...[".", "..", "...", ".hidden", "..a", ".obsidian"].map(
		(n, i): Row => [`NV-${11 + i}`, n, { code: "leading-dot", message: LEADING_DOT }]
	),
	...["a.", "a..", "a ", "a   ", "a. "].map((n, i): Row => [`NV-${17 + i}`, n, { code: "trailing-dot-or-space", message: TRAILING }]),
	["NV-22", "a.b", "valid"],
	["NV-23", "a b", "valid"],
	["NV-24", " a", "valid"],
	["NV-25", "a/b", { code: "illegal-chars", message: illegalMsg("/") }],
	["NV-26", "a\\b", { code: "illegal-chars", message: illegalMsg("\\") }],
	["NV-27", "a:b", { code: "illegal-chars", message: illegalMsg(":") }],
	["NV-28", "a*b", { code: "illegal-chars", message: illegalMsg("*") }],
	["NV-29", "a?b", { code: "illegal-chars", message: illegalMsg("?") }],
	["NV-30", 'a"b', { code: "illegal-chars", message: illegalMsg('"') }],
	["NV-31", "a<b", { code: "illegal-chars", message: illegalMsg("<") }],
	["NV-32", "a>b", { code: "illegal-chars", message: illegalMsg(">") }],
	["NV-33", "a/b:c", { code: "illegal-chars", message: illegalMsg("/ :") }],
	["NV-34", "a\u0000b", { code: "illegal-chars", message: illegalMsg("control character") }],
	["NV-35", "a\tb", { code: "illegal-chars", message: illegalMsg("control character") }],
	["NV-35b", "a\tb\u0001", { code: "illegal-chars", message: illegalMsg("control character") }],
	["NV-36", "Projects/Beta", { code: "illegal-chars", message: illegalMsg("/") }],
	["NV-37", "a#b", { code: "link-chars", message: linkMsg("#") }],
	["NV-38", "a^b", { code: "link-chars", message: linkMsg("^") }],
	["NV-39", "a[b", { code: "link-chars", message: linkMsg("[") }],
	["NV-39b", "a]b", { code: "link-chars", message: linkMsg("]") }],
	["NV-39c", "a|b", { code: "link-chars", message: linkMsg("|") }],
	["NV-39d", "[[x]]", { code: "link-chars", message: linkMsg("[ ]") }],
	["NV-39e", "a/#", { code: "illegal-chars", message: illegalMsg("/") }],
	["NV-41", "Alpha", { code: "clash", message: clashMsg("Alpha") }],
	["NV-42", "alpha", { code: "clash", message: clashMsg("alpha") }],
	["NV-43", "ALPHA", { code: "clash", message: clashMsg("ALPHA") }],
	["NV-44", "Projects", { code: "clash", message: clashMsg("Projects") }],
	["NV-45", "projects", { code: "clash", message: clashMsg("projects") }],
	["NV-46", "Solo", { code: "clash", message: clashMsg("Solo") }],
	["NV-47", "Duo", { code: "clash", message: clashMsg("Duo") }],
	["NV-48", "Pair", { code: "clash", message: clashMsg("Pair") }],
	["NV-49", "Reading list", { code: "clash", message: clashMsg("Reading list") }],
	["NV-50", "RÉSUMÉ", { code: "clash", message: clashMsg("RÉSUMÉ") }],
	["NV-51", "Résumé", { code: "clash", message: clashMsg("Résumé") }],
	["NV-52", "Bets", { code: "clash", message: clashMsg("Bets") }],
	["NV-53a", "Beta", "valid"],
	["NV-53b", "photo", "valid"],
	["NV-53c", "Canvas", "valid"],
	["NV-53d", "Field tech", "valid"],
	["NV-53e", "Alpha.md", "valid"],
	["NV-54", "Alpha", "valid", { ignoreRootPaths: ["Alpha.md"] }],
	[
		"NV-55",
		"Alpha",
		{ code: "clash", message: clashMsg("Alpha") },
		{ ignoreRootPaths: ["Alpha.md"], root: [...ROOT, { name: "Alpha", kind: "folder" }] },
	],
	["NV-55b", "alpha", "valid", { ignoreRootPaths: ["Alpha.md"] }],
	["NV-55c", "Beta2", "valid", { ignoreRootPaths: ["Alpha.md"] }],
	["NV-55d", "Solo", { code: "clash", message: clashMsg("Solo") }, { ignoreRootPaths: ["Alpha.md"] }],
	["NV-60", "Reading list", "valid", { mode: "non-empty" }],
	["NV-61", ".x/y", "valid", { mode: "non-empty" }],
	["NV-62", "CON", "valid", { mode: "non-empty" }],
	["NV-63", "a#b", "valid", { mode: "non-empty" }],
	["NV-64", "a".repeat(300), "valid", { mode: "non-empty" }],
	["NV-65", "", { code: "empty", message: EMPTY }, { mode: "non-empty" }],
	["NV-66", "  ", { code: "empty", message: EMPTY }, { mode: "non-empty" }],
	["NV-70", ".a/b", { code: "leading-dot", message: LEADING_DOT }],
	["NV-71", "a/b ", { code: "trailing-dot-or-space", message: TRAILING }],
	["NV-72", "a/".repeat(150), { code: "too-long", message: TOO_LONG }],
	["NV-73", "CON.", { code: "trailing-dot-or-space", message: TRAILING }],
	["NV-74", "Alpha ", { code: "trailing-dot-or-space", message: TRAILING }],
	...["CON", "con", "Nul", "PRN", "AUX", "COM1", "lpt9", "CON.x", "_pool", "_POOL", "_to_delete"].map(
		(n, i): Row => [`NV-${75 + i}`, n, { code: "reserved", message: reservedMsg(n) }]
	),
	["NV-86", "COM10", "valid"],
	["NV-87", "CONSOLE", "valid"],
	["NV-88", "aux2", "valid"],
	["NV-89", "COM0", "valid"],
	["NV-90", "x", "valid", { poolFolder: "", excludedFolders: [""] }],
];

describe("validateName matrix", () => {
	for (const [id, name, expected, extra] of rows) {
		it(`${id}: ${JSON.stringify(name.length > 40 ? `${name.slice(0, 12)}…(${name.length})` : name)}`, () => {
			const result = validateName(name, { ...BASE, ...extra });
			if (expected === "valid") {
				expect(result).toEqual({ valid: true }); // UT-R1: no `message` key either
				expect("message" in result).toBe(false);
			} else {
				expect(result).toEqual({ valid: false, ...expected }); // UT-R2
			}
		});
	}

	it("never edits or trims the name (pure function of its input)", () => {
		const name = " a/b ";
		validateName(name, BASE);
		expect(name).toBe(" a/b ");
	});
});

describe("collectRootEntries", () => {
	it("UT-R3: root children only, with names and kinds", () => {
		const vault = new Vault();
		vault.seedFile("Alpha.md");
		vault.seedFolder("Projects");
		vault.seedFile("Projects/Beta.md");
		vault.seedFile("Projects/Projects.md");
		vault.seedFile("photo.png");
		expect(collectRootEntries(vault)).toEqual([
			{ name: "Alpha.md", kind: "file" },
			{ name: "Projects", kind: "folder" },
			{ name: "photo.png", kind: "file" },
		]);
		expect(vault.getRoot().children[1]).toBeInstanceOf(TFolder);
		expect(vault.getRoot().children[0]).toBeInstanceOf(TFile);
	});
});
