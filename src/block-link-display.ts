import { TAbstractFile, TFile, editorLivePreviewField } from "obsidian";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import type AtlasPlugin from "./main";
import { getFreeBlockDisplayText } from "./display-text";

function isFreeBlockFile(plugin: AtlasPlugin, file: TFile): boolean {
	return file.extension === "md" && file.parent?.path === plugin.settings.poolFolder;
}

/**
 * F7 needs a free block's display text inside a synchronous CM6 decoration builder, but deriving
 * it is inherently async (a file read). This cache is the bridge: kept current by vault events, so
 * `buildDecorations` below only ever does a synchronous lookup. A cache miss (not yet populated,
 * e.g. right after startup) just means that render pass shows the raw ID — CM6 re-invokes the
 * builder on the next keystroke/scroll/selection change regardless, which is frequent enough in
 * practice that this self-corrects within a render or two, matching "updates on next render."
 */
export class FreeBlockTextCache {
	private cache = new Map<string, string>();

	constructor(private plugin: AtlasPlugin) {}

	get(path: string): string | undefined {
		return this.cache.get(path);
	}

	async populateAll(): Promise<void> {
		const units = this.plugin.unitIndex.getUnits().filter((u) => u.type === "free-block");
		await Promise.all(units.map((unit) => this.refresh(unit.path)));
	}

	async refresh(path: string): Promise<void> {
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile) || !isFreeBlockFile(this.plugin, file)) {
			this.cache.delete(path);
			return;
		}
		this.cache.set(path, await getFreeBlockDisplayText(this.plugin.app, file, this.plugin.settings.blockDisplayLength));
	}

	remove(path: string): void {
		this.cache.delete(path);
	}

	/** Registers the vault listeners that keep the cache current — call once from `onload`. */
	register(): void {
		this.plugin.registerEvent(
			this.plugin.app.vault.on("modify", (file) => {
				if (file instanceof TFile && isFreeBlockFile(this.plugin, file)) void this.refresh(file.path);
			})
		);
		this.plugin.registerEvent(this.plugin.app.vault.on("create", (file: TAbstractFile) => {
			if (file instanceof TFile && isFreeBlockFile(this.plugin, file)) void this.refresh(file.path);
		}));
		this.plugin.registerEvent(this.plugin.app.vault.on("delete", (file) => this.remove(file.path)));
		this.plugin.registerEvent(
			this.plugin.app.vault.on("rename", (file, oldPath) => {
				this.remove(oldPath);
				if (file instanceof TFile && isFreeBlockFile(this.plugin, file)) void this.refresh(file.path);
			})
		);
	}
}

/** F7 — reading view: an alias-less link to a free block renders as its display text instead of
 * the raw ID. Aliased links (the common case, since F6 always inserts one) are left untouched. */
export function registerBlockLinkDisplayPostProcessor(plugin: AtlasPlugin): void {
	plugin.registerMarkdownPostProcessor((el, ctx) => {
		el.querySelectorAll<HTMLAnchorElement>("a.internal-link").forEach((a) => {
			void applyReadingViewText(plugin, a, ctx.sourcePath);
		});
	});
}

async function applyReadingViewText(plugin: AtlasPlugin, a: HTMLAnchorElement, sourcePath: string): Promise<void> {
	const rawHref = a.getAttribute("data-href") ?? a.getAttribute("href");
	if (!rawHref) return;
	let target = rawHref;
	try {
		target = decodeURIComponent(rawHref);
	} catch {
		// Malformed escape sequence — compare against the raw href instead.
	}
	if (a.textContent !== target) return; // already aliased — rendered text differs from the raw target
	const dest = plugin.app.metadataCache.getFirstLinkpathDest(target, sourcePath);
	if (!dest || !isFreeBlockFile(plugin, dest)) return;
	a.textContent = await getFreeBlockDisplayText(plugin.app, dest, plugin.settings.blockDisplayLength);
}

const WIKILINK_RE = /\[\[([^[\]|]+)\]\]/g;

class FreeBlockWidget extends WidgetType {
	constructor(private plugin: AtlasPlugin, private file: TFile, private text: string, private sourcePath: string) {
		super();
	}

	eq(other: FreeBlockWidget): boolean {
		return other.file.path === this.file.path && other.text === this.text;
	}

	toDOM(): HTMLElement {
		const span = document.createElement("span");
		span.addClass("cm-hmd-internal-link", "atlas-free-block-link");
		span.textContent = this.text;
		span.addEventListener("click", (evt) => {
			evt.preventDefault();
			void this.plugin.app.workspace.openLinkText(this.file.path, this.sourcePath, evt.ctrlKey || evt.metaKey);
		});
		span.addEventListener("mouseover", (evt) => {
			this.plugin.app.workspace.trigger("hover-link", {
				event: evt,
				source: "atlas-free-block",
				hoverParent: span,
				targetEl: span,
				linktext: this.file.path,
				sourcePath: this.sourcePath,
			});
		});
		return span;
	}

	ignoreEvent(): boolean {
		return true;
	}
}

function buildDecorations(plugin: AtlasPlugin, cache: FreeBlockTextCache, view: EditorView): DecorationSet {
	if (!view.state.field(editorLivePreviewField)) return Decoration.none; // source mode shows raw text
	const sourcePath = plugin.app.workspace.getActiveFile()?.path ?? "";
	const builder = new RangeSetBuilder<Decoration>();
	const doc = view.state.doc;

	for (const { from, to } of view.visibleRanges) {
		let pos = from;
		while (pos <= to) {
			const line = doc.lineAt(pos);
			WIKILINK_RE.lastIndex = 0;
			let m: RegExpExecArray | null;
			while ((m = WIKILINK_RE.exec(line.text)) !== null) {
				const dest = plugin.app.metadataCache.getFirstLinkpathDest(m[1], sourcePath);
				if (!dest || !isFreeBlockFile(plugin, dest)) continue;
				const text = cache.get(dest.path);
				if (text === undefined) continue; // not cached yet — next render picks it up

				const start = line.from + m.index;
				const end = start + m[0].length;
				if (start < line.from || end > line.to) continue;
				builder.add(start, end, Decoration.replace({ widget: new FreeBlockWidget(plugin, dest, text, sourcePath) }));
			}
			if (line.to + 1 <= pos) break;
			pos = line.to + 1;
		}
	}

	return builder.finish();
}

export function freeBlockLivePreviewPlugin(plugin: AtlasPlugin, cache: FreeBlockTextCache) {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = buildDecorations(plugin, cache, view);
			}
			update(u: ViewUpdate) {
				if (u.docChanged || u.viewportChanged || u.selectionSet) {
					this.decorations = buildDecorations(plugin, cache, u.view);
				}
			}
		},
		{ decorations: (v) => v.decorations }
	);
}
