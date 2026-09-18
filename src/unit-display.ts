import { App, TFile, TFolder } from "obsidian";
import type { AtlasSettings } from "./settings";
import { Unit } from "./types";
import { getFreeBlockDisplayText, getPromotedBlockDisplayText } from "./display-text";

export interface ResolvedUnit {
	unit: Unit;
	text: string;
	secondary?: string;
	icon: string;
	promoted: boolean;
	/** ctime of the underlying file/folder, for the inbox's "newest first" default sort. */
	ctime: number;
}

function iconFor(unit: Unit): string {
	switch (unit.type) {
		case "folder-unit":
		case "promoted-folder":
			return "folder";
		case "free-block":
			return "message-square";
		case "promoted-block":
			return "quote";
		default:
			return "file";
	}
}

/** Resolves everything the explorer needs to render one row for a unit. Reads files where the
 * display text is derived from content (free blocks, promoted blocks) — done once per render pass
 * rather than per keystroke; virtualizing/caching this further is F11's job, not this one's. */
export async function resolveUnit(app: App, settings: AtlasSettings, unit: Unit): Promise<ResolvedUnit | null> {
	const file = app.vault.getAbstractFileByPath(unit.path);
	if (!file) return null;
	const promoted = unit.type === "promoted-file" || unit.type === "promoted-folder" || unit.type === "promoted-block";

	switch (unit.type) {
		case "root-file":
		case "promoted-file":
			if (!(file instanceof TFile)) return null;
			return { unit, text: file.basename, icon: iconFor(unit), promoted, ctime: file.stat.ctime };
		case "folder-unit":
		case "promoted-folder":
			if (!(file instanceof TFolder)) return null;
			return { unit, text: file.name, icon: iconFor(unit), promoted, ctime: 0 };
		case "free-block": {
			if (!(file instanceof TFile)) return null;
			const text = await getFreeBlockDisplayText(app, file, settings.blockDisplayLength);
			return { unit, text, icon: iconFor(unit), promoted, ctime: file.stat.ctime };
		}
		case "promoted-block": {
			if (!(file instanceof TFile)) return null;
			const text = await getPromotedBlockDisplayText(app, file, unit.subpath, settings.blockDisplayLength);
			return { unit, text, secondary: `in ${file.name}`, icon: iconFor(unit), promoted, ctime: file.stat.ctime };
		}
	}
}

export async function resolveUnits(app: App, settings: AtlasSettings, units: Unit[]): Promise<ResolvedUnit[]> {
	const resolved = await Promise.all(units.map((unit) => resolveUnit(app, settings, unit)));
	return resolved.filter((r): r is ResolvedUnit => r !== null);
}
