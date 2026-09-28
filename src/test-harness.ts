import { TFile } from "obsidian";
import type AtlasPlugin from "./main";
import { NameDialogOptions, openNameDialog } from "./name-dialog";
import { noticeIfLinksNotUpdated } from "./links-notice";
import { UnitRef } from "./types";

/** Test-only handle for driving the PR-1 helpers from the desktop container over CDP. Registered
 * only when `__ATLAS_TEST__` is true (never in a production build). */
interface AtlasTestHarness {
	lastResult: string | null | undefined;
	openNameDialog(opts: NameDialogOptions): Promise<string | null>;
	convertFileNodesToModule(filePath: string, folderPath: string): { nodes: number; manualPromotions: number };
	replaceMetaNodeWithUnit(viewId: string, nodeId: string, ref: UnitRef): boolean;
	noticeIfLinksNotUpdated(): boolean;
	scenarioMoveIntoModule(filePath: string, folder: string): Promise<{ nodes: number; manualPromotions: number }>;
	dump(): Promise<unknown>;
}

export function registerTestHarness(plugin: AtlasPlugin): () => void {
	const { app } = plugin;
	const harness: AtlasTestHarness = {
		lastResult: undefined,
		async openNameDialog(opts) {
			harness.lastResult = undefined;
			const result = await openNameDialog(app, {
				poolFolder: plugin.settings.poolFolder,
				excludedFolders: plugin.settings.excludedFolders,
				...opts,
			});
			harness.lastResult = result;
			return result;
		},
		convertFileNodesToModule: (filePath, folderPath) => plugin.viewsManager.convertFileNodesToModule(filePath, folderPath, plugin.unitIndex),
		replaceMetaNodeWithUnit: (viewId, nodeId, ref) => plugin.viewsManager.replaceMetaNodeWithUnit(viewId, nodeId, ref),
		noticeIfLinksNotUpdated: () => noticeIfLinksNotUpdated(app),
		async scenarioMoveIntoModule(filePath, folder) {
			const file = app.vault.getAbstractFileByPath(filePath);
			if (!(file instanceof TFile)) throw new Error(`No file at ${filePath}`);
			await app.vault.createFolder(folder);
			await app.fileManager.renameFile(file, `${folder}/${folder}.md`);
			const counts = plugin.viewsManager.convertFileNodesToModule(filePath, folder, plugin.unitIndex);
			noticeIfLinksNotUpdated(app);
			return counts;
		},
		async dump() {
			await new Promise((resolve) => window.setTimeout(resolve, 600)); // let the debounced save land
			return {
				views: plugin.viewsManager.getViews(),
				manualPromotions: plugin.unitIndex.getManualPromotions(),
				data: await plugin.loadData(),
			};
		},
	};
	(window as unknown as { __atlasTest?: AtlasTestHarness }).__atlasTest = harness;
	return () => {
		delete (window as unknown as { __atlasTest?: AtlasTestHarness }).__atlasTest;
	};
}
