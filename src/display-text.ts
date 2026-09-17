import { App, TFile } from "obsidian";

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

/** `YYYYMMDDHHmmss-xxxx` — xxxx is 4 random base36 chars, so two blocks created in the same
 * second still get different IDs. The user never sees or types this; it's a filename only. */
export function generateBlockId(now: Date): string {
	const pad = (n: number, len = 2) => String(n).padStart(len, "0");
	const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(
		now.getMinutes()
	)}${pad(now.getSeconds())}`;
	let suffix = "";
	for (let i = 0; i < 4; i++) suffix += BASE36[Math.floor(Math.random() * BASE36.length)];
	return `${timestamp}-${suffix}`;
}

/** Strips the markdown syntax a first line commonly carries (heading, task, list bullet,
 * blockquote, code fence opener) down to its plain text, for display purposes only. */
export function stripMarkdownLine(line: string): string {
	let text = line.trim();
	text = text.replace(/^#+\s*/, ""); // heading
	text = text.replace(/^[-*+]\s+\[[ xX]\]\s*/, ""); // task
	text = text.replace(/^[-*+]\s+/, ""); // bullet list
	text = text.replace(/^\d+\.\s+/, ""); // numbered list
	text = text.replace(/^>+\s*/, ""); // blockquote
	text = text.replace(/^`{3,}\s*/, ""); // code fence opener
	text = text.replace(/\*\*([^*]+)\*\*/g, "$1"); // bold
	text = text.replace(/\*([^*]+)\*/g, "$1"); // italic
	text = text.replace(/`([^`]+)`/g, "$1"); // inline code
	return text.trim();
}

function truncate(text: string, length: number): string {
	return text.length > length ? `${text.slice(0, length).trimEnd()}…` : text;
}

/** The free block's display text from raw file content — `title` frontmatter takes precedence
 * over the body, matching F4. Frontmatter is skipped when scanning the body for a first line. */
export function getFreeBlockDisplayTextFromContent(raw: string, displayLength: number, frontmatterTitle?: string): string {
	if (frontmatterTitle && frontmatterTitle.trim().length > 0) {
		return truncate(frontmatterTitle.trim(), displayLength);
	}
	let body = raw;
	if (body.startsWith("---")) {
		const end = body.indexOf("\n---", 3);
		if (end !== -1) body = body.slice(end + 4);
	}
	for (const line of body.split("\n")) {
		const stripped = stripMarkdownLine(line);
		if (stripped.length > 0) return truncate(stripped, displayLength);
	}
	return "(empty block)";
}

/** F4: reads the free block from disk and derives its display text. */
export async function getFreeBlockDisplayText(app: App, file: TFile, displayLength: number): Promise<string> {
	const cache = app.metadataCache.getFileCache(file);
	const title = cache?.frontmatter?.title;
	const raw = await app.vault.cachedRead(file);
	return getFreeBlockDisplayTextFromContent(raw, displayLength, typeof title === "string" ? title : undefined);
}

/** F5: the display text for a promoted block — the block/heading's own text, stripped and
 * truncated. Heading links already carry their heading text as the subpath; `^id` block links
 * need their actual line looked up and read from disk. */
export async function getPromotedBlockDisplayText(app: App, file: TFile, subpath: string, displayLength: number): Promise<string> {
	if (!subpath.startsWith("^")) {
		return truncate(stripMarkdownLine(subpath), displayLength);
	}
	const cache = app.metadataCache.getFileCache(file);
	const block = cache?.blocks?.[subpath.slice(1).toLowerCase()];
	if (!block) return truncate(subpath, displayLength);
	const raw = await app.vault.cachedRead(file);
	const lineText = raw.split("\n")[block.position.start.line] ?? "";
	const withoutBlockId = lineText.replace(/\s*\^[a-zA-Z0-9-]+\s*$/, "");
	return truncate(stripMarkdownLine(withoutBlockId), displayLength);
}
