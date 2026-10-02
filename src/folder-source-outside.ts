import * as fs from "fs";
import * as nodePath from "path";
import { UnitRef } from "./types";

/** Minimal read-only filesystem surface this module needs — kept narrow so path resolution stays
 * pure/testable against a fake, without pulling in real `fs` (mirrors `FolderSourceVaultLike` in
 * `folder-source.ts`, the same narrowing principle applied to Node's `fs` instead of `Vault`). */
export interface OutsideFsLike {
	existsSync(path: string): boolean;
	statSync(path: string): { isDirectory(): boolean };
}

/** G6/E8: an Outside-Vault path "resolves" only when it exists on this device *and* is a directory —
 * a path that resolves to a file, is blank/whitespace-only, doesn't exist, or throws on access
 * (permission-denied on a restricted external volume) is uniformly "unresolved," never a thrown
 * error surfaced to the user (every edge case the spec calls out collapses to this one boolean). */
export function resolveOutsidePathWith(fsLike: OutsideFsLike, path: string): boolean {
	const trimmed = path.trim();
	if (!trimmed) return false;
	try {
		if (!fsLike.existsSync(trimmed)) return false;
		return fsLike.statSync(trimmed).isDirectory();
	} catch {
		return false;
	}
}

/** Real-`fs`-backed wrapper — the only call site production code needs; tests exercise
 * `resolveOutsidePathWith` directly against a fake, or this against a real temp-directory fixture. */
export function resolveOutsidePath(path: string): boolean {
	return resolveOutsidePathWith(fs, path);
}

/** `OutsideFsLike` plus the one extra read `listOutsideChildrenWith` needs — kept as its own
 * interface rather than widening `OutsideFsLike` itself, since path resolution alone never needs it. */
export interface OutsideReaddirFsLike extends OutsideFsLike {
	readdirSync(path: string, options: { withFileTypes: true }): { name: string; isDirectory(): boolean }[];
}

/** G6/G3-mirror: the direct children of an Outside-Vault folder, filtered by `showFiles`/
 * `showFolders` exactly like `folderToRows` does for an Inside-Vault one — refs carry an absolute
 * filesystem path instead of a vault-relative one. Returns `[]` (never throws) whenever `path`
 * itself doesn't resolve, or enumerating it fails (e.g. permission denied mid-read). */
export function listOutsideChildrenWith(
	fsLike: OutsideReaddirFsLike,
	path: string,
	options: { showFiles: boolean; showFolders: boolean }
): UnitRef[] {
	if (!resolveOutsidePathWith(fsLike, path)) return [];
	const refs: UnitRef[] = [];
	try {
		for (const entry of fsLike.readdirSync(path, { withFileTypes: true })) {
			const childPath = nodePath.join(path, entry.name);
			if (entry.isDirectory()) {
				if (options.showFolders) refs.push({ kind: "folder", path: childPath });
			} else if (options.showFiles) {
				refs.push({ kind: "file", path: childPath });
			}
		}
	} catch {
		return [];
	}
	return refs;
}

export function listOutsideChildren(path: string, options: { showFiles: boolean; showFolders: boolean }): UnitRef[] {
	return listOutsideChildrenWith(fs, path, options);
}
