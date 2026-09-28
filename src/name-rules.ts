import { TFile, TFolder, Vault } from "obsidian";

/** Longest name in UTF-8 bytes, so `<name>.md` stays within the 255-byte filename limit. */
export const MAX_NAME_BYTES = 252;

export type NameErrorCode =
	| "empty"
	| "too-long"
	| "leading-dot"
	| "trailing-dot-or-space"
	| "illegal-chars"
	| "link-chars"
	| "reserved"
	| "clash";

export type NameValidation = { valid: true } | { valid: false; code: NameErrorCode; message: string };

/** One direct child of the vault root: `name` includes the extension for files. */
export interface RootEntry {
	name: string;
	kind: "file" | "folder";
}

export interface NameRuleOptions {
	/** `full` applies every rule; `non-empty` (Create > Block, whose file is named by ID) only rejects empty. */
	mode?: "full" | "non-empty";
	root?: RootEntry[];
	poolFolder?: string;
	excludedFolders?: string[];
	/** Root file paths that don't count as a clash (Create Module on a root file keeps its own name). */
	ignoreRootPaths?: string[];
}

const ILLEGAL_CHARS = new Set(["/", "\\", ":", "*", "?", '"', "<", ">"]);
const LINK_CHARS = new Set(["#", "^", "[", "]", "|"]);
const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function fold(name: string): string {
	return name.normalize("NFC").toLowerCase();
}

function isControl(ch: string): boolean {
	return ch.charCodeAt(0) < 0x20;
}

/** Distinct offending characters in order of first appearance (control characters listed once). */
function offenders(name: string, isBad: (ch: string) => boolean, isControlToo: boolean): string {
	const seen: string[] = [];
	for (const ch of name) {
		const label = isControlToo && isControl(ch) ? "control character" : isBad(ch) ? ch : null;
		if (label !== null && !seen.includes(label)) seen.push(label);
	}
	return seen.join(" ");
}

/** Root children only (name + kind), read live so callers can re-check on every keystroke. */
export function collectRootEntries(vault: Pick<Vault, "getRoot">): RootEntry[] {
	const entries: RootEntry[] = [];
	for (const child of vault.getRoot().children) {
		if (child instanceof TFolder) entries.push({ name: child.name, kind: "folder" });
		else if (child instanceof TFile) entries.push({ name: child.name, kind: "file" });
	}
	return entries;
}

/** The name rules, in check order (first failure wins, one message at a time). Pure: never edits
 * `name`, never trims it. */
export function validateName(name: string, options: NameRuleOptions = {}): NameValidation {
	const fail = (code: NameErrorCode, message: string): NameValidation => ({ valid: false, code, message });

	if (name.trim() === "") return fail("empty", "Enter a name");
	if ((options.mode ?? "full") === "non-empty") return { valid: true };

	if (new TextEncoder().encode(name).length > MAX_NAME_BYTES) {
		return fail("too-long", `That name is too long (${MAX_NAME_BYTES} bytes at most)`);
	}
	if (name.startsWith(".")) return fail("leading-dot", "A name can't start with a dot");
	if (name.endsWith(".") || name.endsWith(" ")) {
		return fail("trailing-dot-or-space", "A name can't end with a dot or a space");
	}

	const illegal = offenders(name, (ch) => ILLEGAL_CHARS.has(ch), true);
	if (illegal) return fail("illegal-chars", `A name can't contain: ${illegal}`);
	const linkChars = offenders(name, (ch) => LINK_CHARS.has(ch), false);
	if (linkChars) return fail("link-chars", `A name can't contain: ${linkChars} (they break links)`);

	const lower = fold(name);
	const reservedFolders = [options.poolFolder, ...(options.excludedFolders ?? [])].filter((f): f is string => !!f);
	if (DEVICE_NAME.test(name) || reservedFolders.some((f) => fold(f) === lower)) {
		return fail("reserved", `'${name}' is a reserved name`);
	}

	const noteName = `${lower}.md`;
	const ignored = new Set((options.ignoreRootPaths ?? []).map(fold));
	const clash = (options.root ?? []).some((entry) => {
		const entryName = fold(entry.name);
		if (entry.kind === "folder") return entryName === lower;
		return entryName === noteName && !ignored.has(entryName);
	});
	if (clash) return fail("clash", `A note or folder called '${name}' already exists at the vault root`);

	return { valid: true };
}
