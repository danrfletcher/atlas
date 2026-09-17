import { App, TFile, TFolder } from "obsidian";
import type { AtlasSettings } from "./settings";

/** F3: the folder's interface note, if one exists under the configured convention (or the
 * accepted `index.md` / `README.md` fallback names). Null means the folder-unit has no interface
 * note yet — the caller offers to create one rather than treating this as an error. */
export function findInterfaceNote(app: App, folder: TFolder, settings: AtlasSettings): TFile | null {
	const conventional = app.vault.getAbstractFileByPath(`${folder.path}/${folder.name}.md`);
	if (conventional instanceof TFile) return conventional;

	if (settings.interfaceNoteAcceptAltNames) {
		for (const altName of ["index.md", "README.md"]) {
			const alt = app.vault.getAbstractFileByPath(`${folder.path}/${altName}`);
			if (alt instanceof TFile) return alt;
		}
	}
	return null;
}

/** Creates `<Folder>/<Folder>.md` with a one-line H1. Never overwrites an existing note — callers
 * should check `findInterfaceNote` first and only call this when it returned null. */
export async function createInterfaceNote(app: App, folder: TFolder): Promise<TFile> {
	const path = `${folder.path}/${folder.name}.md`;
	return app.vault.create(path, `# ${folder.name}\n`);
}
