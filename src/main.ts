import { Notice, Plugin, TFile, TFolder } from "obsidian";
import { AtlasSettingTab, AtlasSettings, DEFAULT_SETTINGS, computeDefaultExcludedFolders } from "./settings";
import { UnitIndex } from "./unit-index";
import { UnitRef } from "./types";
import {
	registerAddBlockCommand,
	registerCreateInterfaceNoteCommand,
	registerOpenFolderUnitCommand,
	registerOpenPromotedBlockCommand,
} from "./commands";
import { AtlasLinkSuggest } from "./link-suggest";
import { applySuggesterPrecedence, removeSuggesterPrecedence } from "./suggester-precedence";
import { FreeBlockTextCache, freeBlockLivePreviewPlugin, registerBlockLinkDisplayPostProcessor } from "./block-link-display";

interface AtlasData {
	settings: AtlasSettings;
	manualPromotions: UnitRef[];
}

export default class AtlasPlugin extends Plugin {
	declare settings: AtlasSettings;
	manualPromotions: UnitRef[];
	unitIndex: UnitIndex;
	private linkSuggest: AtlasLinkSuggest;
	private freeBlockTextCache: FreeBlockTextCache;

	async onload() {
		await this.loadSettings();

		this.unitIndex = new UnitIndex(this.app, this.settings, this.manualPromotions);
		this.addSettingTab(new AtlasSettingTab(this.app, this));

		this.linkSuggest = new AtlasLinkSuggest(this);
		this.registerEditorSuggest(this.linkSuggest);

		this.freeBlockTextCache = new FreeBlockTextCache(this);
		this.freeBlockTextCache.register();
		registerBlockLinkDisplayPostProcessor(this);
		this.registerEditorExtension([freeBlockLivePreviewPlugin(this, this.freeBlockTextCache)]);

		this.app.workspace.onLayoutReady(() => {
			this.unitIndex.rebuild();
			void this.freeBlockTextCache.populateAll();
			// Deferred until layout is ready so the native `[[` suggester is already registered —
			// see docs/decisions.md for why this reorder is needed and how it degrades safely.
			applySuggesterPrecedence(this.app, this.linkSuggest);
		});

		this.registerEvent(this.app.vault.on("create", (file) => this.unitIndex.onVaultCreate(file)));
		this.registerEvent(this.app.vault.on("delete", (file) => this.unitIndex.onVaultDelete(file.path)));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.unitIndex.onVaultRename(file, oldPath)));
		this.registerEvent(this.app.metadataCache.on("resolved", () => this.unitIndex.onMetadataResolved()));

		registerOpenFolderUnitCommand(this);
		registerCreateInterfaceNoteCommand(this);
		registerAddBlockCommand(this);
		registerOpenPromotedBlockCommand(this);

		this.addCommand({
			id: "rebuild-index",
			name: "Rebuild index",
			callback: () => {
				this.unitIndex.rebuild();
				new Notice(`Atlas: index rebuilt (${this.unitIndex.getUnits().length} units) — see console for timings.`);
			},
		});

		// Temporary debug aids for verifying F2's manual-promotion storage AC ahead of F3's real
		// drag-to-promote UI. Remove once F3 lands.
		this.addCommand({
			id: "debug-toggle-manual-promotion-active-file",
			name: "Debug — toggle manual promotion for active file",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (checking) return true;
				const ref: UnitRef = { kind: "file", path: file.path };
				const isPromoted = this.unitIndex.getManualPromotions().some((r) => r.kind === "file" && r.path === file.path);
				if (isPromoted) {
					this.unitIndex.removeManualPromotion(ref);
					new Notice(`Atlas: removed manual promotion for ${file.path}`);
				} else {
					this.unitIndex.addManualPromotion(ref);
					new Notice(`Atlas: manually promoted ${file.path}`);
				}
				this.saveManualPromotions();
				return true;
			},
		});

		this.addCommand({
			id: "debug-dump-index",
			name: "Debug — dump index summary to console",
			callback: () => {
				const units = this.unitIndex.getUnits();
				const counts: Record<string, number> = {};
				for (const unit of units) counts[unit.type] = (counts[unit.type] ?? 0) + 1;
				console.debug("[Atlas] index summary", counts, units);
				new Notice(`Atlas: ${units.length} units — see console for the breakdown.`);
			},
		});
	}

	onunload() {
		removeSuggesterPrecedence(this.app, this.linkSuggest);
		console.debug("[Atlas] unloading");
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as AtlasData | null;
		const isFirstRun = !data;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings);
		this.manualPromotions = data?.manualPromotions ?? [];
		if (isFirstRun) {
			this.settings.excludedFolders = computeDefaultExcludedFolders(this.app, this.settings.poolFolder);
			await this.saveSettings();
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData({ settings: this.settings, manualPromotions: this.manualPromotions } satisfies AtlasData);
	}

	async saveManualPromotions(): Promise<void> {
		this.manualPromotions = this.unitIndex.getManualPromotions();
		await this.saveSettings();
	}

	/** F1 AC: changing the pool folder re-indexes; free blocks left behind in the old folder are
	 * flagged with a warning instead of silently disappearing or being deleted. */
	async handlePoolFolderChanged(oldPoolFolder: string, newPoolFolder: string): Promise<void> {
		const excluded = new Set(this.settings.excludedFolders);
		excluded.delete(oldPoolFolder);
		excluded.add(newPoolFolder);
		this.settings.excludedFolders = Array.from(excluded);
		await this.saveSettings();
		this.unitIndex.rebuild();

		const oldFolder = this.app.vault.getAbstractFileByPath(oldPoolFolder);
		if (oldFolder instanceof TFolder) {
			const remaining = oldFolder.children.filter((child) => child instanceof TFile && child.extension === "md");
			if (remaining.length > 0) {
				new Notice(
					`Atlas: ${remaining.length} block(s) left behind in the old pool folder "${oldPoolFolder}" — move them into "${newPoolFolder}" to keep them as free blocks.`,
					10000
				);
			}
		}
	}
}
