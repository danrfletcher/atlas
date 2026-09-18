import { Debouncer, Notice, Plugin, TFile, TFolder, WorkspaceLeaf, debounce } from "obsidian";
import { AtlasSettingTab, AtlasSettings, DEFAULT_SETTINGS, computeDefaultExcludedFolders } from "./settings";
import { UnitIndex } from "./unit-index";
import { UnitRef, View } from "./types";
import { registerAddBlockCommand } from "./commands";
import { AtlasLinkSuggest } from "./link-suggest";
import { applySuggesterPrecedence, removeSuggesterPrecedence } from "./suggester-precedence";
import { FreeBlockTextCache, freeBlockLivePreviewPlugin, registerBlockLinkDisplayPostProcessor } from "./block-link-display";
import { ViewsManager } from "./views";
import { ATLAS_VIEW_TYPE, AtlasExplorerView } from "./explorer-view";
import { registerF10Commands } from "./f10-commands";

interface AtlasData {
	settings: AtlasSettings;
	manualPromotions: UnitRef[];
	views: View[];
	activeViewId: string;
}

export default class AtlasPlugin extends Plugin {
	declare settings: AtlasSettings;
	manualPromotions: UnitRef[];
	unitIndex: UnitIndex;
	viewsManager: ViewsManager;
	private linkSuggest: AtlasLinkSuggest;
	private freeBlockTextCache: FreeBlockTextCache;
	private persistDebounced: Debouncer<[], void>;

	async onload() {
		const data = (await this.loadData()) as AtlasData | null;
		this.loadFromData(data);

		this.persistDebounced = debounce(() => void this.persistNow(), 500, true);

		this.unitIndex = new UnitIndex(this.app, this.settings, this.manualPromotions);
		this.viewsManager = new ViewsManager(
			this.app,
			data?.views ?? [],
			data?.activeViewId ?? "",
			() => this.persistDebounced()
		);
		this.addSettingTab(new AtlasSettingTab(this.app, this));

		this.linkSuggest = new AtlasLinkSuggest(this);
		this.registerEditorSuggest(this.linkSuggest);

		this.freeBlockTextCache = new FreeBlockTextCache(this);
		this.freeBlockTextCache.register();
		registerBlockLinkDisplayPostProcessor(this);
		this.registerEditorExtension([freeBlockLivePreviewPlugin(this, this.freeBlockTextCache)]);

		this.registerView(ATLAS_VIEW_TYPE, (leaf) => new AtlasExplorerView(leaf, this));

		this.app.workspace.onLayoutReady(() => {
			this.unitIndex.rebuild();
			void this.freeBlockTextCache.populateAll();
			// Deferred until layout is ready so the native `[[` suggester is already registered —
			// see docs/decisions.md for why this reorder is needed and how it degrades safely.
			applySuggesterPrecedence(this.app, this.linkSuggest);
			if (this.settings.replaceNativeExplorerOnStartup) {
				void this.activateExplorerView();
			}
		});

		this.registerEvent(this.app.vault.on("create", (file) => this.unitIndex.onVaultCreate(file)));
		this.registerEvent(this.app.vault.on("delete", (file) => this.unitIndex.onVaultDelete(file.path)));
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				const promotionsChanged = this.unitIndex.onVaultRename(file, oldPath);
				this.viewsManager.onVaultRename(oldPath, file.path); // saves itself if anything changed
				if (promotionsChanged) this.persistDebounced();
			})
		);
		this.registerEvent(this.app.metadataCache.on("resolved", () => this.unitIndex.onMetadataResolved()));

		registerAddBlockCommand(this);
		registerF10Commands(this);
	}

	onunload() {
		removeSuggesterPrecedence(this.app, this.linkSuggest);
		this.persistDebounced?.run(); // flush any pending save rather than losing up to 500ms of drags
		console.debug("[Atlas] unloading");
	}

	/** Opens the Atlas explorer in the left sidebar, reusing an existing leaf if one's already open. */
	async activateExplorerView(): Promise<void> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(ATLAS_VIEW_TYPE)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getLeftLeaf(false);
			await leaf?.setViewState({ type: ATLAS_VIEW_TYPE, active: true });
		}
		if (leaf) workspace.revealLeaf(leaf);
	}

	private loadFromData(data: AtlasData | null): void {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings);
		this.manualPromotions = data?.manualPromotions ?? [];
		if (!data) {
			this.settings.excludedFolders = computeDefaultExcludedFolders(this.app, this.settings.poolFolder);
		}
	}

	private async persistNow(): Promise<void> {
		await this.saveData({
			settings: this.settings,
			manualPromotions: this.unitIndex.getManualPromotions(),
			views: this.viewsManager.getViews(),
			activeViewId: this.viewsManager.getActiveViewId(),
		} satisfies AtlasData);
	}

	/** Settings changes are deliberate, infrequent user actions — save immediately rather than
	 * through the drag-oriented debounce views/promotions use. */
	async saveSettings(): Promise<void> {
		await this.persistNow();
	}

	async saveManualPromotions(): Promise<void> {
		await this.persistNow();
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
