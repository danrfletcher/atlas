import { FuzzySuggestModal, MarkdownView, Notice, TFile, TFolder } from "obsidian";
import type AtlasPlugin from "./main";
import { createInterfaceNote, findInterfaceNote } from "./interface-notes";
import { generateBlockId, getPromotedBlockDisplayText } from "./display-text";
import { Unit } from "./types";

function topLevelFolders(plugin: AtlasPlugin): TFolder[] {
	return plugin.unitIndex
		.getUnits()
		.filter((unit): unit is Unit & { type: "folder-unit" } => unit.type === "folder-unit")
		.map((unit) => plugin.app.vault.getAbstractFileByPath(unit.path))
		.filter((file): file is TFolder => file instanceof TFolder);
}

class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
	constructor(plugin: AtlasPlugin, private folders: TFolder[], private onChoose: (folder: TFolder) => void) {
		super(plugin.app);
	}
	getItems(): TFolder[] {
		return this.folders;
	}
	getItemText(folder: TFolder): string {
		return folder.name;
	}
	onChooseItem(folder: TFolder): void {
		this.onChoose(folder);
	}
}

interface PromotedBlockItem {
	unit: Extract<Unit, { type: "promoted-block" }>;
	label: string;
}

class PromotedBlockSuggestModal extends FuzzySuggestModal<PromotedBlockItem> {
	constructor(plugin: AtlasPlugin, private items: PromotedBlockItem[], private onChoose: (item: PromotedBlockItem) => void) {
		super(plugin.app);
	}
	getItems(): PromotedBlockItem[] {
		return this.items;
	}
	getItemText(item: PromotedBlockItem): string {
		return item.label;
	}
	onChooseItem(item: PromotedBlockItem): void {
		this.onChoose(item);
	}
}

/** TEMPORARY — not in F10's finalized command list. Stands in for clicking a folder-unit row
 * (opens its interface note if one exists) until F8's real explorer list exists; remove then. */
export function registerOpenFolderUnitCommand(plugin: AtlasPlugin): void {
	plugin.addCommand({
		id: "open-folder-unit",
		name: "Open folder-unit…",
		callback: () => {
			const folders = topLevelFolders(plugin);
			new FolderSuggestModal(plugin, folders, async (folder) => {
				const note = findInterfaceNote(plugin.app, folder, plugin.settings);
				if (note) {
					await plugin.app.workspace.getLeaf(false).openFile(note);
				} else {
					new Notice(`Atlas: "${folder.name}" has no interface note yet — use "Create interface note for folder…".`);
				}
			}).open();
		},
	});
}

/** TEMPORARY — not in F10's finalized command list. Stands in for the "Create interface note"
 * context-menu action until F8's real menu exists; remove then. */
export function registerCreateInterfaceNoteCommand(plugin: AtlasPlugin): void {
	plugin.addCommand({
		id: "create-interface-note",
		name: "Create interface note for folder…",
		callback: () => {
			const withoutNote = topLevelFolders(plugin).filter((folder) => !findInterfaceNote(plugin.app, folder, plugin.settings));
			if (withoutNote.length === 0) {
				new Notice("Atlas: every top-level folder already has an interface note.");
				return;
			}
			new FolderSuggestModal(plugin, withoutNote, async (folder) => {
				const note = await createInterfaceNote(plugin.app, folder);
				await plugin.app.workspace.getLeaf(false).openFile(note);
			}).open();
		},
	});
}

/** F4 — creates `<pool>/<ID>.md`, no title prompt, cursor lands on the first (empty) body line. */
export function registerAddBlockCommand(plugin: AtlasPlugin): void {
	plugin.addCommand({
		id: "add-block",
		name: "Add block",
		callback: async () => {
			const { vault } = plugin.app;
			const poolFolder = plugin.settings.poolFolder;
			if (!(vault.getAbstractFileByPath(poolFolder) instanceof TFolder)) {
				await vault.createFolder(poolFolder);
			}

			let path: string;
			do {
				path = `${poolFolder}/${generateBlockId(new Date())}.md`;
			} while (vault.getAbstractFileByPath(path));

			const file = await vault.create(path, "");
			const leaf = plugin.app.workspace.getLeaf(false);
			await leaf.openFile(file);
			plugin.app.workspace.getActiveViewOfType(MarkdownView)?.editor.setCursor({ line: 0, ch: 0 });
		},
	});
}

/** TEMPORARY — not in F10's finalized command list. Stands in for clicking a promoted-block row
 * (navigates via Obsidian's own `#^id` / `#Heading` resolution) until F8's real explorer list
 * exists; remove then, unless it's deliberately kept as a permanent quick-jump — that would be its
 * own decision to log, not a default. */
export function registerOpenPromotedBlockCommand(plugin: AtlasPlugin): void {
	plugin.addCommand({
		id: "open-promoted-block",
		name: "Open promoted block…",
		callback: async () => {
			const blocks = plugin.unitIndex
				.getUnits()
				.filter((unit): unit is Extract<Unit, { type: "promoted-block" }> => unit.type === "promoted-block");

			if (blocks.length === 0) {
				new Notice("Atlas: no promoted blocks in the vault yet.");
				return;
			}

			const items: PromotedBlockItem[] = [];
			for (const unit of blocks) {
				const file = plugin.app.vault.getAbstractFileByPath(unit.path);
				if (!(file instanceof TFile)) continue;
				const text = await getPromotedBlockDisplayText(plugin.app, file, unit.subpath, plugin.settings.blockDisplayLength);
				items.push({ unit, label: `${text} — in ${file.name}` });
			}

			new PromotedBlockSuggestModal(plugin, items, ({ unit }) => {
				plugin.app.workspace.openLinkText(`${unit.path}#${unit.subpath}`, "", false);
			}).open();
		},
	});
}
