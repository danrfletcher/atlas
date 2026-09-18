import { MarkdownView, TFolder } from "obsidian";
import type AtlasPlugin from "./main";
import { generateBlockId } from "./display-text";

/** F4 — creates `<pool>/<ID>.md`, no title prompt, cursor lands on the first (empty) body line.
 * Exported standalone (not just registered as a command) so F8's "Add block" toolbar button calls
 * the exact same path rather than going through Obsidian's command-by-id lookup. */
export async function addBlock(plugin: AtlasPlugin): Promise<void> {
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
}

export function registerAddBlockCommand(plugin: AtlasPlugin): void {
	plugin.addCommand({
		id: "add-block",
		name: "Add block",
		callback: () => void addBlock(plugin),
	});
}
