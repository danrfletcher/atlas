import { App, Menu, Notice, TFile, TFolder } from "obsidian";
import { generateBlockId } from "./display-text";
import { openNameDialog } from "./name-dialog";
import { collectRootEntries, validateName } from "./name-rules";
import { UnitRef, ViewNode } from "./types";

/** What a meta folder can become. A free block is a `file`-kind ref, so Block and File resolve to the
 * same status "apply to" switch; only Module differs. */
export type CreateKind = "block" | "file" | "module";

export const CREATE_ITEM_TITLE = "Create";

/** In menu order. */
export const CREATE_KINDS: ReadonlyArray<{ kind: CreateKind; label: string; icon: string }> = [
	{ kind: "block", label: "Block", icon: "square" },
	{ kind: "file", label: "File", icon: "file" },
	{ kind: "module", label: "Module", icon: "folder" },
];

export function createDialogTitle(kind: CreateKind): string {
	const { label } = CREATE_KINDS.find((entry) => entry.kind === kind)!;
	return `Create ${label}`;
}

/** The chosen name with surrounding whitespace dropped. Inner text is kept exactly as typed. */
function trimmed(name: string): string {
	return name.trim();
}

/** Body of every file Create writes: a heading with the name, one trailing newline. */
export function buildBlockContent(name: string): string {
	return `# ${trimmed(name)}\n`;
}

/** `<pool>/<ID>.md`, the same shape Add block makes. */
export function blockPath(poolFolder: string, now: Date, random: () => number = Math.random): string {
	return `${poolFolder}/${generateBlockId(now, random)}.md`;
}

export function filePath(name: string): string {
	return `${trimmed(name)}.md`;
}

export function modulePaths(name: string): { folder: string; note: string } {
	const folder = trimmed(name);
	return { folder, note: `${folder}/${folder}.md` };
}

/** The pool folder path without trailing slashes, or null when the setting can't hold a file (empty,
 * or the vault root itself). */
export function usablePoolFolder(setting: string): string | null {
	const pool = setting.trim().replace(/\/+$/, "");
	return pool === "" || pool === "." ? null : pool;
}

/** Give up on finding a free ID after this many collisions (it can only happen with a broken random source). */
const MAX_ID_ATTEMPTS = 100;

/** The first `<pool>/<ID>.md` path nothing occupies yet. Never returns an existing path. */
export function freeBlockPath(vault: Pick<App["vault"], "getAbstractFileByPath">, poolFolder: string, now: Date, random: () => number = Math.random): string | null {
	for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
		const path = blockPath(poolFolder, now, random);
		if (!vault.getAbstractFileByPath(path)) return path;
	}
	return null;
}

export interface CreateFromMetaDeps {
	app: Pick<App, "vault">;
	getPoolFolder(): string;
	getExcludedFolders(): string[];
	/** The views manager's read and replace calls (data only, never disk). */
	getNode(viewId: string, nodeId: string): ViewNode | null;
	replaceMetaNodeWithUnit(viewId: string, nodeId: string, ref: UnitRef): boolean;
	/** Writes data.json now, so a reload right after Create can't bring the meta folder back. */
	save(): Promise<void>;
	/** Clock and random source for the block ID (injectable for tests). */
	now?(): Date;
	random?(): number;
}

export type CreateFromMetaResult = { ok: true; ref: UnitRef; path: string } | { ok: false; reason: string };

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const ERROR_NOTICE_MS = 8000;

/** Creates the one new item on disk for `kind`, then swaps the meta node for it in the view. The node
 * is replaced only after the disk step succeeded; if that step fails, whatever Atlas made is removed
 * again and the meta folder is left exactly as it was. Never opens the new item and never touches any
 * other file. Always resolves; failures show as one error notice. */
export async function createFromMeta(deps: CreateFromMetaDeps, kind: CreateKind, viewId: string, nodeId: string, rawName: string): Promise<CreateFromMetaResult> {
	const { vault } = deps.app;
	const name = trimmed(rawName);
	const fail = (reason: string, extra = ""): CreateFromMetaResult => {
		new Notice(`Atlas: couldn't create ${kind} "${name}": ${reason}${extra}`, ERROR_NOTICE_MS);
		return { ok: false, reason };
	};

	// The dialog may have been open a while: the folder must still be there, and the name still free.
	const node = deps.getNode(viewId, nodeId);
	if (!node || node.type !== "meta") return fail("the folder no longer exists");
	const validation = validateName(name, {
		mode: kind === "block" ? "non-empty" : "full",
		root: kind === "block" ? [] : collectRootEntries(vault),
		poolFolder: deps.getPoolFolder(),
		excludedFolders: deps.getExcludedFolders(),
	});
	if (!validation.valid) return fail(validation.message);

	const made: { file?: TFile; folder?: TFolder; pool?: TFolder } = {};
	/** Removes what this run made (files first), each only if it is still what we created. Best effort. */
	const rollback = async (): Promise<string> => {
		let leftover = "";
		try {
			if (made.file) await vault.delete(made.file);
			// `force` is required for a folder (Obsidian's plain delete throws EISDIR on one); the emptiness
			// check is what makes the recursive removal safe.
			if (made.folder && made.folder.children.length === 0) await vault.delete(made.folder, true);
			else if (made.folder) leftover = `. The folder "${made.folder.path}" isn't empty, so Atlas left it in place`;
			if (made.pool && made.pool.children.length === 0) await vault.delete(made.pool, true);
		} catch (error) {
			leftover = `. Atlas couldn't clean up what it had made (${describe(error)})`;
		}
		return leftover;
	};

	let ref: UnitRef;
	let path: string;
	try {
		if (kind === "block") {
			const pool = usablePoolFolder(deps.getPoolFolder());
			if (!pool) return fail("the pool folder setting is empty or the vault root");
			if (!(vault.getAbstractFileByPath(pool) instanceof TFolder)) made.pool = await vault.createFolder(pool);
			const free = freeBlockPath(vault, pool, deps.now?.() ?? new Date(), deps.random);
			if (!free) return fail("no free block ID was available", await rollback());
			made.file = await vault.create(free, buildBlockContent(name));
			path = free;
			ref = { kind: "file", path };
		} else if (kind === "file") {
			path = filePath(name);
			made.file = await vault.create(path, buildBlockContent(name));
			ref = { kind: "file", path };
		} else {
			const paths = modulePaths(name);
			made.folder = await vault.createFolder(paths.folder);
			made.file = await vault.create(paths.note, buildBlockContent(name));
			path = paths.folder;
			ref = { kind: "folder", path };
		}
	} catch (error) {
		// Only things this run created are in `made` (a create call that threw made nothing), so a
		// half-made module leaves nothing behind and an existing file is never touched.
		return fail(describe(error), await rollback());
	}

	// The folder may have gone while the disk step ran (a data sync): don't leave an orphan behind.
	if (!deps.replaceMetaNodeWithUnit(viewId, nodeId, ref)) return fail("the folder no longer exists", await rollback());
	try {
		await deps.save();
	} catch (error) {
		new Notice(`Atlas: "${name}" was created, but saving the views failed: ${describe(error)}`, ERROR_NOTICE_MS);
	}
	return { ok: true, ref, path };
}

export interface CreateFromMetaFlowDeps extends CreateFromMetaDeps {
	app: App;
}

/** Meta folders (`viewId:nodeId`) with a Create run in progress (dialog open or disk step under way). */
const running = new Set<string>();

/** The menu action: name dialog prefilled with the meta folder's current label, then `createFromMeta`.
 * Cancel does nothing at all. */
export async function startCreateFromMeta(deps: CreateFromMetaFlowDeps, kind: CreateKind, viewId: string, nodeId: string): Promise<void> {
	const key = `${viewId}:${nodeId}`;
	if (running.has(key)) return;
	const node = deps.getNode(viewId, nodeId);
	if (!node || node.type !== "meta") return;
	running.add(key);
	try {
		const name = await openNameDialog(deps.app, {
			title: createDialogTitle(kind),
			initialValue: node.label ?? "",
			mode: kind === "block" ? "non-empty" : "full",
			poolFolder: deps.getPoolFolder(),
			excludedFolders: deps.getExcludedFolders(),
		});
		if (name === null) return;
		await createFromMeta(deps, kind, viewId, nodeId, name);
	} finally {
		running.delete(key);
	}
}

/** Adds "Create" to a meta folder's menu. Obsidian's public Menu API has no submenu, so choosing it
 * pops a second small menu with Block, File and Module at the same spot: two clicks either way. */
export function addCreateItem(menu: Menu, evt: Pick<MouseEvent, "clientX" | "clientY">, onChoose: (kind: CreateKind) => void): void {
	menu.addItem((item) =>
		item
			.setTitle(CREATE_ITEM_TITLE)
			.setIcon("plus-circle")
			.onClick(() => {
				const chooser = new Menu();
				for (const { kind, label, icon } of CREATE_KINDS) {
					chooser.addItem((entry) => entry.setTitle(label).setIcon(icon).onClick(() => onChoose(kind)));
				}
				chooser.showAtPosition({ x: evt.clientX, y: evt.clientY });
			})
	);
}
