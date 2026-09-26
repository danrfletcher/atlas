import { App, Menu, Notice, TFile, TFolder, Vault } from "obsidian";
import { openNameDialog } from "./name-dialog";
import { collectRootEntries, isNameTakenAtRoot } from "./name-rules";
import { Unit, UnitRef, unitRefsEqual, unitToRef } from "./types";

export const CREATE_MODULE_TITLE = "Create Module";

/** Create Module is offered only for a `.md` file sitting directly in the vault root, and only when
 * the index classes it a root-file. The unit type (not the `kind: "file"` ref) is what rules out
 * free blocks, promoted or nested files and interface notes. */
export function canCreateModule(vault: Pick<Vault, "getAbstractFileByPath">, unit: Unit | undefined): boolean {
	if (unit?.type !== "root-file") return false;
	const file = vault.getAbstractFileByPath(unit.path);
	return file instanceof TFile && file.extension === "md" && !!file.parent?.isRoot();
}

/** The index unit behind a row's ref, if there is one (a missing file has none). A file path is
 * one unit type at a time, so the ref alone identifies it. */
export function unitForRef(units: Unit[], ref: UnitRef): Unit | undefined {
	return units.find((unit) => unitRefsEqual(unitToRef(unit), ref));
}

export interface CreateModulePlan {
	/** The new folder, at the vault root. */
	folder: string;
	/** Where the file ends up: the interface note `<folder>/<folder>.md`. */
	target: string;
	/** The chosen name differs from the file's own name, so the move also renames it. */
	needsRename: boolean;
}

/** The chosen name is used verbatim: no trim, no replacement, no case change. */
export function planCreateModule(filePath: string, name: string): CreateModulePlan {
	const fileName = filePath.slice(filePath.lastIndexOf("/") + 1);
	const basename = fileName.endsWith(".md") ? fileName.slice(0, -".md".length) : fileName;
	return { folder: name, target: `${name}/${name}.md`, needsRename: basename !== name };
}

export interface CreateModuleDeps {
	app: Pick<App, "vault" | "fileManager">;
	/** Converts every view node, duplicate and manual promotion that referenced the file. Data only. */
	convert(filePath: string, folderPath: string): void;
	/** Writes data.json now. The views manager only schedules a debounced save, and the file is gone
	 * from disk by then, so a reload inside the debounce window would leave a stale file ref behind. */
	save(): Promise<void>;
	/** Runs after the move went through: the "links weren't updated" notice when Obsidian's setting is off. */
	afterMove(): void;
}

export type CreateModuleResult = { ok: true; folder: string; target: string } | { ok: false; reason: string };

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const ERROR_NOTICE_MS = 8000;

/** Creates folder `<name>`, then moves the file in with one `renameFile` (renaming it on the way if
 * the name differs), then converts the view data. Never touches the file's content. If the move
 * fails after Atlas made the folder, deletes that folder again when it is still empty and leaves the
 * file where it was. Always resolves; failures show as one error notice. */
export async function createModule(deps: CreateModuleDeps, file: TFile, originalPath: string, name: string): Promise<CreateModuleResult> {
	const { vault, fileManager } = deps.app;
	const plan = planCreateModule(originalPath, name);
	const fail = (reason: string, extra = ""): CreateModuleResult => {
		new Notice(`Atlas: couldn't create module "${name}": ${reason}${extra}`, ERROR_NOTICE_MS);
		return { ok: false, reason };
	};

	// The dialog may have been open a while: the file must still be where it was, and the name still free.
	if (file.path !== originalPath || vault.getAbstractFileByPath(originalPath) !== file) {
		return fail("the note was moved, renamed or deleted after the dialog opened");
	}
	if (isNameTakenAtRoot(name, collectRootEntries(vault), [originalPath])) {
		return fail(`a note or folder called '${name}' already exists at the vault root`);
	}

	let folder: TFolder;
	try {
		folder = await vault.createFolder(plan.folder);
	} catch (error) {
		return fail(describe(error)); // Atlas made nothing, so there is nothing to roll back
	}

	try {
		await fileManager.renameFile(file, plan.target);
	} catch (error) {
		const reason = describe(error);
		if (folder.children.length > 0) return fail(reason, `. The folder "${plan.folder}" isn't empty, so Atlas left it in place`);
		try {
			// `force` is required for a folder: Obsidian's plain delete throws EISDIR on one. The
			// emptiness check just above is what makes recursive removal safe here.
			await vault.delete(folder, true);
		} catch (deleteError) {
			return fail(reason, `. Atlas couldn't remove the empty folder "${plan.folder}" either (${describe(deleteError)})`);
		}
		return fail(reason);
	}

	deps.convert(originalPath, plan.folder);
	try {
		await deps.save();
	} catch (error) {
		new Notice(`Atlas: the module "${name}" was created, but saving the views failed: ${describe(error)}`, ERROR_NOTICE_MS);
	}
	deps.afterMove();
	return { ok: true, folder: plan.folder, target: plan.target };
}

export interface CreateModuleFlowDeps extends CreateModuleDeps {
	app: App;
	getPoolFolder(): string;
	getExcludedFolders(): string[];
}

/** File paths with a Create Module run in progress (dialog open or move under way). */
const running = new Set<string>();

/** The right-click action: name dialog prefilled with the file's name, then `createModule`. Cancel
 * does nothing at all. */
export async function startCreateModule(deps: CreateModuleFlowDeps, file: TFile): Promise<void> {
	const originalPath = file.path;
	if (running.has(originalPath)) return;
	running.add(originalPath);
	try {
		const name = await openNameDialog(deps.app, {
			title: CREATE_MODULE_TITLE,
			initialValue: file.basename,
			ignoreRootPaths: [originalPath],
			poolFolder: deps.getPoolFolder(),
			excludedFolders: deps.getExcludedFolders(),
		});
		if (name === null) return;
		await createModule(deps, file, originalPath, name);
	} finally {
		running.delete(originalPath);
	}
}

/** Adds the "Create Module" item to a unit row's menu when the row qualifies. */
export function addCreateModuleItem(menu: Menu, vault: Pick<Vault, "getAbstractFileByPath">, unit: Unit | undefined, onChoose: (file: TFile) => void): void {
	if (!unit || !canCreateModule(vault, unit)) return;
	const file = vault.getAbstractFileByPath(unit.path);
	if (!(file instanceof TFile)) return;
	menu.addSeparator();
	menu.addItem((item) => item.setTitle(CREATE_MODULE_TITLE).setIcon("folder-plus").onClick(() => onChoose(file)));
}
