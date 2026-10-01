import { TFolder } from "obsidian";
import { FolderSourceConfig, UnitRef, ViewNode, unitRefKey, unitRefsEqual } from "./types";

/** G3/G4: the direct children of `folder`, filtered independently by `showFiles`/`showFolders` —
 * both the simplest reading of "the target folder's children render... as real units" (direct
 * children only; a nested subfolder is its own real folder-unit, browsed via the normal module
 * pipeline rather than flattened in) and what keeps this function trivially pure/testable. */
export function folderToRows(folder: TFolder, options: { showFiles: boolean; showFolders: boolean }): UnitRef[] {
	const refs: UnitRef[] = [];
	for (const child of folder.children) {
		if (child instanceof TFolder) {
			if (options.showFolders) refs.push({ kind: "folder", path: child.path });
		} else if (options.showFiles) {
			refs.push({ kind: "file", path: child.path });
		}
	}
	return refs;
}

/** Edge case: "selecting a target folder that is an ancestor of, or identical to, the source
 * Folder's own location does not crash the explorer." Kept as a standalone pure function, not wired
 * into any live code path in this PR — a meta node (the only place `folderSource` ever lives) has no
 * disk path of its own to compare against, so there is nothing meaningful to call this with yet. */
export function isAncestorOrSelf(candidateAncestorPath: string, path: string): boolean {
	return path === candidateAncestorPath || path.startsWith(`${candidateAncestorPath}/`);
}

/** G7/G9/E2: reconciles a Folder source's current children against the folder's current listing,
 * touching only nodes this source itself manages (`folderSourceManaged`). Anything else already in
 * `existingChildren` (the user nesting something by hand alongside the managed rows) is left alone
 * and kept in place.
 *
 * - A managed child whose own kind (`file`/`folder`) is still enabled by `options` is always kept
 *   exactly where it is, whether or not its ref is still present in `desiredRefs` — reordering/
 *   nesting it by hand (G7) survives the next reconcile untouched, and refs to a since-deleted file
 *   are never auto-removed project-wide, left for `resolveRef`'s existing generic missing-ref
 *   fallback to render as a greyed row instead (G16/E1).
 * - A managed child whose kind is now toggled off is removed, lifting its own children up one level
 *   (same contract as any other removal in this codebase) — this is the one case reconcile actually
 *   drops a managed row, since it's a deliberate config change rather than a disk event.
 * - Anything in `desiredRefs` with no existing managed match is appended as a new managed child. */
export function reconcileManagedChildren(
	existingChildren: ViewNode[],
	desiredRefs: UnitRef[],
	options: { showFiles: boolean; showFolders: boolean },
	makeNode: (ref: UnitRef) => ViewNode
): ViewNode[] {
	const kept: ViewNode[] = [];
	const existingManagedKeys = new Set<string>();
	for (const child of existingChildren) {
		if (child.folderSourceManaged && child.ref) {
			const kindEnabled = child.ref.kind === "folder" ? options.showFolders : options.showFiles;
			if (!kindEnabled) {
				kept.push(...child.children);
				continue;
			}
			existingManagedKeys.add(unitRefKey(child.ref));
		}
		kept.push(child);
	}
	for (const ref of desiredRefs) {
		if (!existingManagedKeys.has(unitRefKey(ref))) kept.push(makeNode(ref));
	}
	return kept;
}

/** Minimal read-only surface this module needs from `Vault` — kept narrow so this stays pure/testable
 * without pulling in the real `obsidian` `Vault` class (which test fixtures stand in for anyway). */
export interface FolderSourceVaultLike {
	getAbstractFileByPath(path: string): unknown;
}

/** G16/E1: resolves `source.path` and reconciles `existingChildren` against it.
 *
 * - `location !== "inside"` (Outside Vault, PR-5): a no-op, since this PR never manages real-FS
 *   children — `existingChildren` is returned unchanged.
 * - The target folder doesn't resolve (deleted/renamed away/never existed): rather than inventing a
 *   bespoke error state, this routes through the *same* generic missing-unit fallback every other ref
 *   uses — a single managed child whose `ref` is the unresolvable target path itself, which
 *   `resolveRef` already renders as a greyed "(missing)" row with a remove button. Any non-managed
 *   children are kept; stale managed rows from a previous, resolvable listing are dropped (nothing
 *   can be reconciled against a target that no longer exists).
 * - The target folder resolves: ordinary reconciliation via `folderToRows`/`reconcileManagedChildren`. */
export function buildFolderSourceChildren(
	vault: FolderSourceVaultLike,
	source: FolderSourceConfig,
	existingChildren: ViewNode[],
	makeNode: (ref: UnitRef) => ViewNode
): ViewNode[] {
	if (source.location !== "inside") return existingChildren;
	const target = vault.getAbstractFileByPath(source.path);
	if (!(target instanceof TFolder)) {
		const nonManaged = existingChildren.filter((child) => !child.folderSourceManaged);
		const sentinelRef: UnitRef = { kind: "folder", path: source.path };
		const existingSentinel = existingChildren.find(
			(child) => child.folderSourceManaged && child.ref && unitRefsEqual(child.ref, sentinelRef)
		);
		return [...nonManaged, existingSentinel ?? makeNode(sentinelRef)];
	}
	const desiredRefs = folderToRows(target, source);
	return reconcileManagedChildren(existingChildren, desiredRefs, source, makeNode);
}
