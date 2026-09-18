import { App, PluginSettingTab, Setting } from "obsidian";
import type AtlasPlugin from "./main";

export interface AtlasSettings {
	poolFolder: string;
	excludedFolders: string[];
	interfaceNoteAcceptAltNames: boolean;
	replaceNativeExplorerOnStartup: boolean;
	blockDisplayLength: number;
	defaultViewId: string;
	/** F8 follow-up (Dan's live drag-and-drop testing feedback): folders/modules are first-class
	 * citizens whose internal organization Atlas doesn't otherwise touch, so filing a file/block
	 * into one via drag is a deliberate exception — gated by a confirm dialog when this is on. */
	confirmAddToModule: boolean;
}

export const DEFAULT_TO_DELETE_FOLDER = "_to_delete";
export const DEFAULT_POOL_FOLDER = "_pool";

export const DEFAULT_SETTINGS: AtlasSettings = {
	poolFolder: DEFAULT_POOL_FOLDER,
	excludedFolders: [],
	interfaceNoteAcceptAltNames: false,
	replaceNativeExplorerOnStartup: true,
	blockDisplayLength: 80,
	defaultViewId: "default",
	confirmAddToModule: true,
};

/** Dot-folders + the pool folder + `_to_delete`, computed once against the live vault root. */
export function computeDefaultExcludedFolders(app: App, poolFolder: string): string[] {
	const rootFolders = app.vault
		.getRoot()
		.children.filter((child) => "children" in child)
		.map((child) => child.path);
	const dotFolders = rootFolders.filter((path) => path.startsWith("."));
	return Array.from(new Set([...dotFolders, poolFolder, DEFAULT_TO_DELETE_FOLDER]));
}

export class AtlasSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: AtlasPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Pool folder")
			.setDesc("Where free blocks live. Created on demand the first time you add a block.")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_POOL_FOLDER)
					.setValue(this.plugin.settings.poolFolder)
					.onChange(async (value) => {
						const oldPoolFolder = this.plugin.settings.poolFolder;
						const newPoolFolder = value.trim() || DEFAULT_POOL_FOLDER;
						this.plugin.settings.poolFolder = newPoolFolder;
						await this.plugin.saveSettings();
						await this.plugin.handlePoolFolderChanged(oldPoolFolder, newPoolFolder);
					})
			);

		new Setting(containerEl)
			.setName("Excluded folders")
			.setDesc(
				"One per line. These never appear in the explorer, and their files never appear in any inbox — except files in the pool folder, which still show as free blocks."
			)
			.addTextArea((text) =>
				text
					.setPlaceholder(".obsidian\n.git\n.trash")
					.setValue(this.plugin.settings.excludedFolders.join("\n"))
					.onChange(async (value) => {
						this.plugin.settings.excludedFolders = value
							.split("\n")
							.map((line) => line.trim())
							.filter((line) => line.length > 0);
						await this.plugin.saveSettings();
						this.plugin.unitIndex.rebuild();
					})
			);

		new Setting(containerEl)
			.setName("Interface note convention")
			.setDesc("A folder's interface note is always <Folder>/<Folder>.md. Also accept index.md / README.md as a fallback.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.interfaceNoteAcceptAltNames).onChange(async (value) => {
					this.plugin.settings.interfaceNoteAcceptAltNames = value;
					await this.plugin.saveSettings();
					this.plugin.unitIndex.rebuild();
				})
			);

		new Setting(containerEl)
			.setName("Replace native explorer on startup")
			.setDesc("Make Atlas the active view in the left sidebar on launch. The native explorer stays available as a tab.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.replaceNativeExplorerOnStartup).onChange(async (value) => {
					this.plugin.settings.replaceNativeExplorerOnStartup = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Block display length")
			.setDesc("How many characters of a free block's first line to show in the explorer.")
			.addText((text) =>
				text.setValue(String(this.plugin.settings.blockDisplayLength)).onChange(async (value) => {
					const parsed = Number.parseInt(value, 10);
					if (Number.isFinite(parsed) && parsed > 0) {
						this.plugin.settings.blockDisplayLength = parsed;
						await this.plugin.saveSettings();
					}
				})
			);

		new Setting(containerEl)
			.setName("Confirm before adding a unit to a module")
			.setDesc(
				"Dragging a file or block onto a folder-unit (module) files it into that folder on disk — a deliberate exception to Atlas never otherwise touching folder internals. When on, asks first. When off, it happens immediately."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.confirmAddToModule).onChange(async (value) => {
					this.plugin.settings.confirmAddToModule = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Default view on launch")
			// Only "Default" exists until F9 (views) ships — the dropdown is wired up now so it needs
			// no rework later, it just has one option today.
			.setDesc("Which view Atlas opens to when the vault loads.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("default", "Default")
					.setValue(this.plugin.settings.defaultViewId)
					.onChange(async (value) => {
						this.plugin.settings.defaultViewId = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
