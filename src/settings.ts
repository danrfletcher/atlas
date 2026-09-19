import { App, Menu, PluginSettingTab, Setting } from "obsidian";
import type AtlasPlugin from "./main";
import { normalizeHexColor } from "./statuses";

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
	/** PR 14: status-dot glow effect, ported from the reference plugin's own toggle. Lives under
	 * the "Status" settings tab even though it's stored alongside the rest of settings, same as
	 * every other simple on/off toggle in this file. */
	glowEnabled: boolean;
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
	glowEnabled: false,
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

type SettingsTabId = "basic" | "status";

export class AtlasSettingTab extends PluginSettingTab {
	/** Not persisted — resets to "Basic" each time the settings panel is reopened, same as any
	 * other Obsidian settings tab's in-session UI state. */
	private activeTab: SettingsTabId = "basic";

	constructor(app: App, private plugin: AtlasPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const tabBar = containerEl.createDiv({ cls: "atlas-settings-tabs" });
		this.renderTabButton(tabBar, "basic", "Basic");
		this.renderTabButton(tabBar, "status", "Status");

		const body = containerEl.createDiv({ cls: "atlas-settings-body" });
		if (this.activeTab === "basic") this.renderBasicTab(body);
		else this.renderStatusTab(body);
	}

	private renderTabButton(tabBar: HTMLElement, id: SettingsTabId, label: string): void {
		const btn = tabBar.createEl("button", { text: label, cls: "atlas-settings-tab" });
		if (this.activeTab === id) btn.addClass("is-active");
		btn.addEventListener("click", () => {
			if (this.activeTab === id) return;
			this.activeTab = id;
			this.display();
		});
	}

	// ---------- Basic tab (everything that existed before PR 14) ----------

	private renderBasicTab(containerEl: HTMLElement): void {
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
				"Dragging a file or block onto a module files it into that module on disk — a deliberate exception to Atlas never otherwise touching a module's internal organization. When on, asks first. When off, it happens immediately."
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

	// ---------- Status tab (PR 14: data model + settings only, no tree rendering/assignment yet) ----------

	private renderStatusTab(containerEl: HTMLElement): void {
		containerEl.createEl("p", {
			text: "Define named status sets here. Assigning a status set to an item happens from its right-click menu in the explorer (coming in a later PR) — this tab only manages the sets themselves.",
			cls: "setting-item-description",
		});

		this.renderStatusSets(containerEl);
		this.renderColorPalette(containerEl);
		this.renderDesign(containerEl);
	}

	private renderStatusSets(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Status sets").setHeading();

		const statusesManager = this.plugin.statusesManager;
		for (const set of statusesManager.getStatusSets()) {
			const wrapper = containerEl.createDiv({ cls: "atlas-status-set-card" });

			new Setting(wrapper)
				.setName("Status set name")
				.addText((text) =>
					text.setValue(set.name).onChange((value) => {
						statusesManager.renameStatusSet(set.id, value);
					})
				)
				.addExtraButton((btn) =>
					btn
						.setIcon("trash")
						.setTooltip("Delete status set")
						.onClick(() => {
							statusesManager.deleteStatusSet(set.id);
							this.display();
						})
				);

			const list = wrapper.createDiv({ cls: "atlas-status-list" });
			set.statuses.forEach((status, idx) => {
				const isDefault = status.id === set.defaultStatusId;
				const row = new Setting(list).setClass("atlas-status-row");

				const swatch = row.controlEl.createEl("input", { type: "color" });
				swatch.value = normalizeHexColor(status.color);
				swatch.addEventListener("change", () => {
					statusesManager.updateStatus(set.id, status.id, { color: swatch.value });
				});

				row.addText((text) =>
					text.setValue(status.label).onChange((value) => {
						statusesManager.updateStatus(set.id, status.id, { label: value });
					})
				);

				const badges = row.controlEl.createDiv({ cls: "atlas-status-badges" });
				if (isDefault) badges.createSpan({ cls: "atlas-status-badge", text: "Default" });
				if (status.isCompleted) badges.createSpan({ cls: "atlas-status-badge", text: "Completed" });
				if (status.isCancelled) badges.createSpan({ cls: "atlas-status-badge", text: "Cancelled" });

				// Completed/cancelled + reorder + default all fold into one "more actions" menu
				// instead of a row of toggles — a full toggle-plus-label pair per flag didn't fit in
				// the settings panel's actual width (measured live: ~645px of controls in a ~300px
				// row), the same space-budget problem the reference plugin's own "more actions" popup
				// solves for the identical set of actions. Reusing Atlas's own `Menu` import (already
				// used elsewhere, e.g. the explorer's row context menus) rather than adding a new
				// popup utility just for this.
				row.addExtraButton((btn) => {
					btn.setIcon("more-vertical").setTooltip("More actions");
					btn.onClick(() => {
						const menu = new Menu();
						const rect = btn.extraSettingsEl.getBoundingClientRect();
						if (!isDefault) {
							menu.addItem((item) =>
								item
									.setTitle("Make default")
									.setIcon("star")
									.onClick(() => {
										statusesManager.setDefaultStatus(set.id, status.id);
										this.display();
									})
							);
						}
						menu.addItem((item) =>
							item
								.setTitle(status.isCompleted ? "Unmark as completed" : "Mark as completed")
								.setIcon("check-circle")
								.onClick(() => {
									statusesManager.setStatusCompleted(set.id, status.id, !status.isCompleted);
									this.display();
								})
						);
						menu.addItem((item) =>
							item
								.setTitle(status.isCancelled ? "Unmark as cancelled" : "Mark as cancelled")
								.setIcon("x-circle")
								.onClick(() => {
									statusesManager.setStatusCancelled(set.id, status.id, !status.isCancelled);
									this.display();
								})
						);
						menu.addSeparator();
						menu.addItem((item) =>
							item
								.setTitle("Move up")
								.setIcon("arrow-up")
								.setDisabled(idx === 0)
								.onClick(() => {
									const order = set.statuses.map((s) => s.id);
									[order[idx - 1], order[idx]] = [order[idx], order[idx - 1]];
									statusesManager.reorderStatuses(set.id, order);
									this.display();
								})
						);
						menu.addItem((item) =>
							item
								.setTitle("Move down")
								.setIcon("arrow-down")
								.setDisabled(idx === set.statuses.length - 1)
								.onClick(() => {
									const order = set.statuses.map((s) => s.id);
									[order[idx + 1], order[idx]] = [order[idx], order[idx + 1]];
									statusesManager.reorderStatuses(set.id, order);
									this.display();
								})
						);
						menu.addSeparator();
						menu.addItem((item) =>
							item
								.setTitle("Remove status")
								.setIcon("trash")
								.onClick(() => {
									statusesManager.removeStatus(set.id, status.id);
									this.display();
								})
						);
						menu.showAtPosition({ x: rect.left, y: rect.bottom });
					});
				});
			});

			new Setting(wrapper).addButton((btn) =>
				btn.setButtonText("Add status").onClick(() => {
					statusesManager.addStatus(set.id, "New status", "#888888");
					this.display();
				})
			);
		}

		new Setting(containerEl).addButton((btn) =>
			btn
				.setButtonText("New status set")
				.setCta()
				.onClick(() => {
					statusesManager.createStatusSet("New status set");
					this.display();
				})
		);
	}

	private renderColorPalette(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Color palette").setHeading();
		containerEl.createEl("p", {
			text: "Shared swatches offered by every status-color picker above, in addition to a fully custom color.",
			cls: "setting-item-description",
		});

		const statusesManager = this.plugin.statusesManager;
		const grid = containerEl.createDiv({ cls: "atlas-palette-grid" });
		for (const hex of statusesManager.getColorPalette()) {
			const item = grid.createDiv({ cls: "atlas-palette-item" });
			const swatch = item.createDiv({ cls: "atlas-palette-swatch" });
			swatch.setCssStyles({ backgroundColor: hex });
			swatch.setAttribute("title", hex);
			const removeBtn = item.createSpan({ cls: "atlas-palette-remove", text: "×" });
			removeBtn.setAttribute("role", "button");
			removeBtn.setAttribute("aria-label", `Remove ${hex} from palette`);
			removeBtn.addEventListener("click", () => {
				statusesManager.removePaletteColor(hex);
				this.display();
			});
		}

		const addWrapper = containerEl.createDiv({ cls: "atlas-palette-add" });
		const colorInput = addWrapper.createEl("input", { type: "color" });
		colorInput.value = "#888888";
		const addBtn = addWrapper.createEl("button", { text: "Add color to palette" });
		addBtn.addEventListener("click", () => {
			statusesManager.addPaletteColor(colorInput.value);
			this.display();
		});
	}

	private renderDesign(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Design").setHeading();

		new Setting(containerEl)
			.setName("Glow")
			.setDesc("Adds a soft glow around status dots. Purely cosmetic — takes effect once status rendering ships.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.glowEnabled).onChange(async (value) => {
					this.plugin.settings.glowEnabled = value;
					await this.plugin.saveSettings();
				})
			);
	}
}
