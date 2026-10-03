import { App, TAbstractFile, TFile, TFolder } from "obsidian";
import type { AtlasSettings } from "./settings";
import { Unit, UnitRef, rewriteRefPath, unitRefsEqual } from "./types";

/**
 * In-memory index of every unit in the vault (F2). Rebuilt fully on load, then kept current by
 * two separate incremental paths: vault structure events (create/delete/rename — cheap, O(1) per
 * file) and metadataCache's `resolved` event (recomputes the promoted-* overlay from the link
 * graph — proportional to link count, not full file/folder re-listing). Both paths are timed and
 * logged at debug level so the F2/F11 performance ACs can be checked against real numbers rather
 * than a guess.
 */
export class UnitIndex {
	private folderUnits = new Map<string, Unit>();
	private baseFileUnits = new Map<string, Unit>(); // root-file, free-block
	private promotedFiles = new Map<string, Unit>();
	private promotedFolders = new Map<string, Unit>();
	private promotedBlocks = new Map<string, Unit>();
	/** PR-4 (T1): every ref any Folder source currently manages (`ViewsManager.getFolderSourceManagedRefs`),
	 * lifted into the same `promoted-*` shape a manual/link promotion gets — so a Folder-source child
	 * (an ordinary nested file/folder, never a vault-root folder) resolves through `getUnits()`/
	 * `ExplorerView.resolveRef`'s normal lookup instead of falling through to the missing-ref fallback.
	 * Kept separate from `manualPromotions` (never persisted as one — `main.ts` only ever persists
	 * `getManualPromotions()`) since this set is derived fresh from the current view tree on every
	 * change, not a standing user choice. */
	private folderSourceUnits = new Map<string, Unit>();
	private manualPromotions: UnitRef[];
	private changeListeners = new Set<() => void>();
	/** Paths whose units are kept out of `getUnits` (a count each, so overlapping holds are safe). */
	private held = new Map<string, number>();

	constructor(private app: App, private settings: AtlasSettings, manualPromotions: UnitRef[]) {
		this.manualPromotions = manualPromotions;
	}

	onChange(cb: () => void): () => void {
		this.changeListeners.add(cb);
		return () => this.changeListeners.delete(cb);
	}

	private notifyChange(): void {
		for (const cb of this.changeListeners) cb();
	}

	getUnits(): Unit[] {
		const all = [
			...this.folderUnits.values(),
			...this.baseFileUnits.values(),
			...this.promotedFiles.values(),
			...this.promotedFolders.values(),
			...this.promotedBlocks.values(),
			...this.folderSourceUnits.values(),
		];
		return this.held.size === 0 ? all : all.filter((unit) => !this.held.has(unit.path));
	}

	/** PR-4 (T1): replaces the whole set of Folder-source-managed refs with `refs` (the caller —
	 * `main.ts`, fed by `ViewsManager.getFolderSourceManagedRefs` — always passes the complete
	 * current list), so a ref no longer managed by any source drops out on its own rather than
	 * needing an explicit remove call. */
	setFolderSourceRefs(refs: UnitRef[]): void {
		const next = new Map<string, Unit>();
		for (const ref of refs) {
			const topLevelFolder = this.topLevelFolderFor(ref.path) ?? "";
			if (ref.kind === "file") {
				next.set(`file:${ref.path}`, { type: "promoted-file", path: ref.path, topLevelFolder });
			} else if (ref.kind === "folder") {
				next.set(`folder:${ref.path}`, { type: "promoted-folder", path: ref.path, topLevelFolder });
			} else {
				next.set(`block:${ref.path}#${ref.subpath}`, { type: "promoted-block", path: ref.path, subpath: ref.subpath });
			}
		}
		this.folderSourceUnits = next;
		this.notifyChange();
	}

	/** Keeps the unit at `path` out of `getUnits` until the returned release is called (once; extra
	 * calls do nothing). The index itself still updates from vault events, so nothing is lost: Create
	 * uses this so a folder or file it is still setting up is not listed as unplaced before its view
	 * node has been swapped in. Release tells listeners, so views redraw with the unit visible. */
	holdUnit(path: string): () => void {
		this.held.set(path, (this.held.get(path) ?? 0) + 1);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const left = (this.held.get(path) ?? 1) - 1;
			if (left > 0) this.held.set(path, left);
			else this.held.delete(path);
			this.notifyChange();
		};
	}

	getManualPromotions(): UnitRef[] {
		return this.manualPromotions;
	}

	/** F3 will call this from the drag-to-promote action; wired up now since F2 owns the storage/data-model AC. */
	addManualPromotion(ref: UnitRef): void {
		if (this.manualPromotions.some((existing) => unitRefsEqual(existing, ref))) return;
		this.manualPromotions.push(ref);
		this.computePromotions();
	}

	removeManualPromotion(ref: UnitRef): void {
		this.manualPromotions = this.manualPromotions.filter((existing) => !unitRefsEqual(existing, ref));
		this.computePromotions();
	}

	/** Create Module on a root file: a manual promotion of the file becomes one of the new module
	 * (folder) instead. Also catches the interface-note path `<folder>/<folder>.md`, in case the
	 * rename hook ran first; a result equal to the new folder ref is dropped if already present
	 * (other entries are never deduped). Returns how many promotions changed;
	 * the caller persists (data-only, never touches disk). */
	convertManualPromotionToModule(filePath: string, folderPath: string): number {
		const folderRef: UnitRef = { kind: "folder", path: folderPath };
		const interfacePath = `${folderPath}/${folderPath.split("/").pop()}.md`;
		let changed = 0;
		const next: UnitRef[] = [];
		for (const ref of this.manualPromotions) {
			const matches = ref.kind === "file" && (ref.path === filePath || ref.path === interfacePath);
			const candidate = matches ? folderRef : ref;
			if (matches) changed++;
			if (unitRefsEqual(candidate, folderRef) && next.some((existing) => unitRefsEqual(existing, folderRef))) continue;
			next.push(candidate);
		}
		if (changed === 0) return 0;
		this.manualPromotions = next;
		this.computePromotions();
		return changed;
	}

	/** A path (folder or file) is excluded unless it's inside the pool folder — the pool folder
	 * itself is excluded from being a folder-unit, but its contents are never excluded as files. */
	private isExcluded(path: string): boolean {
		const poolFolder = this.settings.poolFolder;
		if (path.startsWith(`${poolFolder}/`)) return false;
		return this.settings.excludedFolders.some((excluded) => path === excluded || path.startsWith(`${excluded}/`));
	}

	/** The top-level folder-unit containing `path`, or null if `path` is at vault root, in the
	 * pool folder, or inside an excluded folder — all of which mean "not inside any folder-unit". */
	private topLevelFolderFor(path: string): string | null {
		const slash = path.indexOf("/");
		if (slash === -1) return null;
		const top = path.slice(0, slash);
		return this.isExcluded(top) ? null : top;
	}

	private interfaceNoteFolderFor(file: TFile): string | null {
		const parent = file.parent;
		if (!parent || parent.isRoot()) return null;
		if (file.name === `${parent.name}.md`) return parent.path;
		if (this.settings.interfaceNoteAcceptAltNames && (file.name === "index.md" || file.name === "README.md")) {
			return parent.path;
		}
		return null;
	}

	/** Full rebuild: base classification (folders, root files, free blocks) + the promoted-* overlay. Runs on load. */
	rebuild(): void {
		const start = performance.now();
		this.classifyBaseUnits();
		this.computePromotions();
		const elapsed = performance.now() - start;
		const units = this.getUnits();
		const counts: Record<string, number> = {};
		for (const unit of units) counts[unit.type] = (counts[unit.type] ?? 0) + 1;
		console.debug(`[Atlas] full index rebuild in ${elapsed.toFixed(1)}ms (${units.length} units) ${JSON.stringify(counts)}`);
	}

	private classifyBaseUnits(): void {
		const folderUnits = new Map<string, Unit>();
		const baseFileUnits = new Map<string, Unit>();

		for (const child of this.app.vault.getRoot().children) {
			if (child instanceof TFolder) {
				if (this.isExcluded(child.path)) continue;
				folderUnits.set(child.path, { type: "folder-unit", path: child.path });
			} else if (child instanceof TFile) {
				baseFileUnits.set(child.path, { type: "root-file", path: child.path });
			}
		}

		const poolFolder = this.settings.poolFolder;
		for (const file of this.app.vault.getFiles()) {
			if (file.extension === "md" && file.parent?.path === poolFolder) {
				baseFileUnits.set(file.path, { type: "free-block", path: file.path });
			}
		}

		this.folderUnits = folderUnits;
		this.baseFileUnits = baseFileUnits;
	}

	/** Recomputes promoted-file / promoted-folder / promoted-block from the current link graph.
	 * Reuses the already-current folder/file base classification, so this alone is the incremental
	 * path fired from metadataCache's `resolved` event — it never re-lists the vault. */
	private computePromotions(): void {
		const start = performance.now();
		const promotedFiles = new Map<string, Unit>();
		const promotedFolders = new Map<string, Unit>();
		const promotedBlocks = new Map<string, Unit>();
		let linkCount = 0;

		// Single pass over every file's link/embed cache. A reference with a subpath (`#^id` or
		// `#Heading`) promotes only the block, never its containing file — a link to one paragraph
		// isn't a link to the whole note. Only a subpath-less reference can promote the file/folder.
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (this.isExcluded(file.path)) continue;
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache) continue;
			const sourceTop = this.topLevelFolderFor(file.path);

			for (const ref of [...(cache.links ?? []), ...(cache.embeds ?? []), ...(cache.frontmatterLinks ?? [])]) {
				linkCount++;
				const hashIndex = ref.link.indexOf("#");
				const linkpath = hashIndex === -1 ? ref.link : ref.link.slice(0, hashIndex);
				const subpath = hashIndex === -1 ? "" : ref.link.slice(hashIndex + 1);
				const destPath = linkpath ? this.app.metadataCache.getFirstLinkpathDest(linkpath, file.path)?.path : file.path;
				if (!destPath || destPath === file.path || this.isExcluded(destPath)) continue; // unresolved, or "from another file" fails

				// The same-module check applies to every reference the same way, subpath or not — a
				// block reference from inside the same module is exactly as "not outside it" as a
				// plain file link from inside the same module would be, so it must run before the
				// subpath branch decides whether to promote the block. Having no module of your own
				// (vault-root files, pool free blocks) is not the same as sharing a module, so the
				// `=== null` guard keeps a null targetTop from ever matching a null sourceTop here:
				// a block reference between two such module-less files still promotes, exactly as it
				// did before this PR; see the R3/R5 tests for that edge case.
				const targetTop = this.topLevelFolderFor(destPath);
				if (targetTop !== null && targetTop === sourceTop) continue; // only a genuine same-module match is "not outside"

				if (subpath) {
					// Unlike a plain file/folder reference, a promoted *block* doesn't need its own module:
					// pool free blocks and vault-root files aren't inside any folder-unit to begin with, so a
					// reference to one of their blocks — from inside a real module, from another module-less
					// file, or from a different pool free block — is still "from outside" and should promote,
					// exactly as it did before bug 1's fix.
					promotedBlocks.set(`${destPath}#${subpath}`, { type: "promoted-block", path: destPath, subpath });
					continue;
				}

				// A promoted file/folder entry records its module (`topLevelFolder: targetTop`) for display,
				// so a target with no module of its own has nothing meaningful to promote.
				if (targetTop === null) continue;

				const targetFile = this.app.vault.getAbstractFileByPath(destPath);
				if (!(targetFile instanceof TFile)) continue;

				const interfaceFolder = this.interfaceNoteFolderFor(targetFile);
				if (interfaceFolder) {
					if (interfaceFolder !== targetTop) {
						promotedFolders.set(interfaceFolder, { type: "promoted-folder", path: interfaceFolder, topLevelFolder: targetTop });
					}
				} else {
					promotedFiles.set(destPath, { type: "promoted-file", path: destPath, topLevelFolder: targetTop });
				}
			}
		}

		this.promotedFiles = promotedFiles;
		this.promotedFolders = promotedFolders;
		this.promotedBlocks = promotedBlocks;
		this.applyManualPromotions();
		this.notifyChange();

		const elapsed = performance.now() - start;
		console.debug(`[Atlas] promotions recomputed in ${elapsed.toFixed(2)}ms (${linkCount} links scanned)`);
	}

	private applyManualPromotions(): void {
		for (const ref of this.manualPromotions) {
			if (ref.kind === "file") {
				this.promotedFiles.set(ref.path, { type: "promoted-file", path: ref.path, topLevelFolder: this.topLevelFolderFor(ref.path) ?? "" });
			} else if (ref.kind === "folder") {
				this.promotedFolders.set(ref.path, {
					type: "promoted-folder",
					path: ref.path,
					topLevelFolder: this.topLevelFolderFor(ref.path) ?? "",
				});
			} else {
				this.promotedBlocks.set(`${ref.path}#${ref.subpath}`, { type: "promoted-block", path: ref.path, subpath: ref.subpath });
			}
		}
	}

	/** Called from `metadataCache.on("resolved", ...)` — the link graph has settled after whatever changed. */
	onMetadataResolved(): void {
		this.computePromotions();
	}

	onVaultCreate(file: TAbstractFile): void {
		const start = performance.now();
		if (file instanceof TFolder) {
			if (file.parent?.isRoot() && !this.isExcluded(file.path)) {
				this.folderUnits.set(file.path, { type: "folder-unit", path: file.path });
			}
		} else if (file instanceof TFile) {
			if (file.parent?.isRoot()) {
				this.baseFileUnits.set(file.path, { type: "root-file", path: file.path });
			} else if (file.extension === "md" && file.parent?.path === this.settings.poolFolder) {
				this.baseFileUnits.set(file.path, { type: "free-block", path: file.path });
			}
		}
		this.notifyChange();
		this.logIncremental("create", start);
	}

	onVaultDelete(path: string): void {
		const start = performance.now();
		const prefix = `${path}/`;
		for (const map of [this.folderUnits, this.baseFileUnits, this.promotedFiles, this.promotedFolders]) {
			map.delete(path);
			for (const key of Array.from(map.keys())) {
				if (key.startsWith(prefix)) map.delete(key);
			}
		}
		for (const key of Array.from(this.promotedBlocks.keys())) {
			if (key === path || key.startsWith(`${path}#`) || key.startsWith(prefix)) this.promotedBlocks.delete(key);
		}
		this.notifyChange();
		this.logIncremental("delete", start);
	}

	/** Points every manual promotion at `oldPath` (or under it) to `newPath`; true if any changed. */
	rewriteManualPromotions(oldPath: string, newPath: string): boolean {
		const rewritten = this.manualPromotions.map((ref) => rewriteRefPath(ref, oldPath, newPath));
		const changed = rewritten.some((ref, i) => ref !== this.manualPromotions[i]);
		this.manualPromotions = rewritten;
		return changed;
	}

	/** Returns whether any manual promotion's path was rewritten, so callers know to persist. */
	onVaultRename(file: TAbstractFile, oldPath: string): boolean {
		const start = performance.now();
		const promotionsChanged = this.rewriteManualPromotions(oldPath, file.path);

		if (file instanceof TFolder) {
			// A folder rename can move every nested unit's path at once — re-derive from scratch
			// rather than remapping each map entry by hand. Rare event, correctness over the last ms.
			this.rebuild();
			this.logIncremental("rename (folder, full rebuild)", start);
			return promotionsChanged;
		}
		this.onVaultDelete(oldPath);
		this.onVaultCreate(file);
		this.logIncremental("rename", start);
		return promotionsChanged;
	}

	private logIncremental(kind: string, start: number): void {
		const elapsed = performance.now() - start;
		console.debug(`[Atlas] incremental ${kind} handled in ${elapsed.toFixed(2)}ms`);
	}
}
