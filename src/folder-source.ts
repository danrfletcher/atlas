import { TFolder } from "obsidian";
import { FolderSourceConfig, UnitRef, ViewNode, unitRefKey } from "./types";

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

/** G7/G9/E2: reconciles a Folder source's current *direct* children against the folder's current
 * listing, touching only nodes this source itself manages (`folderSourceManaged`). Anything else
 * already in `existingChildren` (the user nesting something by hand alongside the managed rows) is
 * left alone and kept in place.
 *
 * - A managed child whose own kind (`file`/`folder`) is still enabled by `options` is always kept
 *   exactly where it is, whether or not its ref is still present in `desiredRefs` — reordering/
 *   nesting it by hand (G7) survives the next reconcile untouched, and refs to a since-deleted file
 *   are never auto-removed project-wide, left for `resolveRef`'s existing generic missing-ref
 *   fallback to render as a greyed row instead (G16/E1).
 * - A managed child whose kind is now toggled off is removed, lifting its own children up one level
 *   (same contract as any other removal in this codebase) — this is the one case reconcile actually
 *   drops a managed row, since it's a deliberate config change rather than a disk event.
 * - Anything in `desiredRefs` already matched by a kept managed child in `existingChildren` itself, or
 *   by `dedupe.managedElsewhere` (R1 fix — supplied by the caller from a whole-view scan, covering rows
 *   this source manages that have been dragged or nested elsewhere), or remembered as user-removed
 *   (`dedupe.removedRefs`), is skipped; everything else is appended as a new managed child. `dedupe`
 *   defaults to empty so callers that only ever deal with one flat array of direct children (e.g.
 *   existing tests) see no change in behavior. */
export function reconcileManagedChildren(
	existingChildren: ViewNode[],
	desiredRefs: UnitRef[],
	options: { showFiles: boolean; showFolders: boolean },
	makeNode: (ref: UnitRef) => ViewNode,
	dedupe: { managedElsewhere?: Set<string>; removedRefs?: Set<string> } = {}
): ViewNode[] {
	const managedElsewhere = new Set(dedupe.managedElsewhere ?? []);
	const removedRefs = dedupe.removedRefs ?? new Set<string>();
	const kept: ViewNode[] = [];
	for (const child of existingChildren) {
		if (child.folderSourceManaged && child.ref) {
			const kindEnabled = child.ref.kind === "folder" ? options.showFolders : options.showFiles;
			if (!kindEnabled) {
				kept.push(...child.children);
				continue;
			}
			managedElsewhere.add(unitRefKey(child.ref));
		}
		kept.push(child);
	}
	for (const ref of desiredRefs) {
		const key = unitRefKey(ref);
		if (managedElsewhere.has(key) || removedRefs.has(key)) continue;
		kept.push(makeNode(ref));
	}
	return kept;
}

/** R1 fix: collects the `unitRefKey` of every node anywhere in `nodes` (recursively, not just direct
 * children) that this specific Folder source (`sourceNodeId`) manages — wherever the user has since
 * moved, nested, or left it. `reconcileManagedChildren` uses this instead of only scanning its own
 * direct children, so a managed row that got dragged out of its source Folder or re-nested under
 * another child is recognized as "already placed" rather than duplicated. */
function collectManagedRefKeys(nodes: ViewNode[], sourceNodeId: string): Set<string> {
	const keys = new Set<string>();
	const walk = (list: ViewNode[]): void => {
		for (const node of list) {
			if (node.folderSourceManaged && node.folderSourceOwnerId === sourceNodeId && node.ref) {
				keys.add(unitRefKey(node.ref));
			}
			walk(node.children);
		}
	};
	walk(nodes);
	return keys;
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
 * - The target folder doesn't resolve (deleted/renamed away/never existed): if this source already
 *   has real managed rows from a previous, resolvable listing, they're left exactly as they are
 *   (R2 fix) — each one's own `ref` individually falls back to `resolveRef`'s existing generic
 *   missing-unit rendering (G16/E1), which already carries whatever explicit statuses, fold state, or
 *   hand-nested children they had, rather than being thrown away and rebuilt from nothing once the
 *   target resolves again. Only a source that has *never* resolved (no managed rows exist yet) gets a
 *   single folder-level sentinel row instead, so a brand-new unresolvable path still shows something
 *   rather than silently rendering nothing.
 * - The target folder resolves: ordinary reconciliation via `folderToRows`/`reconcileManagedChildren`,
 *   using `context` (R1 fix) to recognize a managed row that has moved anywhere else in the view, and
 *   `source.removedRefs` to never recreate one the user removed outright. */
export function buildFolderSourceChildren(
	vault: FolderSourceVaultLike,
	source: FolderSourceConfig,
	existingChildren: ViewNode[],
	makeNode: (ref: UnitRef) => ViewNode,
	context: { sourceNodeId: string; viewRoot: ViewNode[] } = { sourceNodeId: "", viewRoot: existingChildren }
): ViewNode[] {
	if (source.location !== "inside") return existingChildren;
	const target = vault.getAbstractFileByPath(source.path);
	if (!(target instanceof TFolder)) {
		if (existingChildren.some((child) => child.folderSourceManaged)) return existingChildren;
		const sentinelRef: UnitRef = { kind: "folder", path: source.path };
		return [...existingChildren, makeNode(sentinelRef)];
	}
	const desiredRefs = folderToRows(target, source);
	const managedElsewhere = collectManagedRefKeys(context.viewRoot, context.sourceNodeId);
	const removedRefs = new Set(source.removedRefs ?? []);
	return reconcileManagedChildren(existingChildren, desiredRefs, source, makeNode, { managedElsewhere, removedRefs });
}
