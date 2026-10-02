import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listOutsideChildren, listOutsideChildrenWith, resolveOutsidePath, resolveOutsidePathWith } from "../../src/folder-source-outside";

/** G6/E8/edge cases: path-resolution rules for an Outside-Vault Folder source. A path "resolves"
 * only when it exists on this device *and* is a directory — blank/whitespace, missing, a real file
 * (not a directory), or permission-denied are all uniformly "unresolved," never a thrown error. */
describe("resolveOutsidePathWith — fake-fs unit rules", () => {
	it("an empty string is unresolved", () => {
		expect(resolveOutsidePathWith({ existsSync: () => true, statSync: () => ({ isDirectory: () => true }) }, "")).toBe(false);
	});

	it("a whitespace-only string is unresolved", () => {
		expect(resolveOutsidePathWith({ existsSync: () => true, statSync: () => ({ isDirectory: () => true }) }, "   ")).toBe(false);
	});

	it("a path that does not exist on disk is unresolved", () => {
		expect(resolveOutsidePathWith({ existsSync: () => false, statSync: () => ({ isDirectory: () => true }) }, "/nope")).toBe(false);
	});

	it("a path that exists but is a file, not a directory, is unresolved", () => {
		expect(resolveOutsidePathWith({ existsSync: () => true, statSync: () => ({ isDirectory: () => false }) }, "/some/file.txt")).toBe(false);
	});

	it("a path whose access throws (permission denied) is unresolved, never throws", () => {
		const fsLike = {
			existsSync: () => {
				throw new Error("EACCES: permission denied");
			},
			statSync: () => ({ isDirectory: () => true }),
		};
		expect(() => resolveOutsidePathWith(fsLike, "/restricted")).not.toThrow();
		expect(resolveOutsidePathWith(fsLike, "/restricted")).toBe(false);
	});

	it("a path whose statSync throws after existsSync succeeds is unresolved, never throws", () => {
		const fsLike = {
			existsSync: () => true,
			statSync: () => {
				throw new Error("EACCES: permission denied");
			},
		};
		expect(() => resolveOutsidePathWith(fsLike, "/restricted")).not.toThrow();
		expect(resolveOutsidePathWith(fsLike, "/restricted")).toBe(false);
	});

	it("a path that exists and is a directory resolves", () => {
		expect(resolveOutsidePathWith({ existsSync: () => true, statSync: () => ({ isDirectory: () => true }) }, "/real/dir")).toBe(true);
	});

	it("a path with leading/trailing whitespace is trimmed before checking", () => {
		let checked = "";
		const fsLike = {
			existsSync: (p: string) => {
				checked = p;
				return true;
			},
			statSync: () => ({ isDirectory: () => true }),
		};
		expect(resolveOutsidePathWith(fsLike, "  /real/dir  ")).toBe(true);
		expect(checked).toBe("/real/dir");
	});
});

describe("resolveOutsidePath/listOutsideChildren — real filesystem, against a temp directory fixture", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-outside-folder-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("resolves a real directory on disk", () => {
		expect(resolveOutsidePath(tmpDir)).toBe(true);
	});

	it("does not resolve a real file (not a directory) on disk", () => {
		const filePath = path.join(tmpDir, "a-file.md");
		fs.writeFileSync(filePath, "hello");
		expect(resolveOutsidePath(filePath)).toBe(false);
	});

	it("does not resolve a path that does not exist", () => {
		expect(resolveOutsidePath(path.join(tmpDir, "does-not-exist"))).toBe(false);
	});

	it("E8: a since-deleted directory stops resolving, then resolves again once recreated — no caching", () => {
		const childDir = path.join(tmpDir, "child");
		fs.mkdirSync(childDir);
		expect(resolveOutsidePath(childDir)).toBe(true);

		fs.rmSync(childDir, { recursive: true, force: true });
		expect(resolveOutsidePath(childDir)).toBe(false);

		fs.mkdirSync(childDir);
		expect(resolveOutsidePath(childDir)).toBe(true);
	});

	it("R4: lists direct files and folders, filtered by showFiles/showFolders, as refs relative to the Outside root (never the absolute device path)", () => {
		fs.writeFileSync(path.join(tmpDir, "note.md"), "x");
		fs.mkdirSync(path.join(tmpDir, "Sub"));

		const both = listOutsideChildren(tmpDir, { showFiles: true, showFolders: true });
		expect(both).toHaveLength(2);
		expect(both).toContainEqual({ kind: "file", path: "note.md" });
		expect(both).toContainEqual({ kind: "folder", path: "Sub" });

		const filesOnly = listOutsideChildren(tmpDir, { showFiles: true, showFolders: false });
		expect(filesOnly).toEqual([{ kind: "file", path: "note.md" }]);

		const foldersOnly = listOutsideChildren(tmpDir, { showFiles: false, showFolders: true });
		expect(foldersOnly).toEqual([{ kind: "folder", path: "Sub" }]);
	});

	it("an unresolved path lists no children instead of throwing", () => {
		expect(listOutsideChildren(path.join(tmpDir, "nope"), { showFiles: true, showFolders: true })).toEqual([]);
	});

	it("a readdir failure after the path resolves is treated as no children, not a crash", () => {
		const fsLike = {
			existsSync: () => true,
			statSync: () => ({ isDirectory: () => true }),
			readdirSync: () => {
				throw new Error("EACCES: permission denied");
			},
		};
		expect(() => listOutsideChildrenWith(fsLike, "/restricted", { showFiles: true, showFolders: true })).not.toThrow();
		expect(listOutsideChildrenWith(fsLike, "/restricted", { showFiles: true, showFolders: true })).toEqual([]);
	});

	it("unmount/remount: a directory removed mid-run stops listing children, then lists them again once recreated", () => {
		const mountDir = path.join(tmpDir, "mount");
		fs.mkdirSync(mountDir);
		fs.writeFileSync(path.join(mountDir, "file.md"), "x");

		expect(listOutsideChildren(mountDir, { showFiles: true, showFolders: true })).toHaveLength(1);

		// Simulate an external drive unmounting mid-session.
		fs.rmSync(mountDir, { recursive: true, force: true });
		expect(resolveOutsidePath(mountDir)).toBe(false);
		expect(listOutsideChildren(mountDir, { showFiles: true, showFolders: true })).toEqual([]);

		// Simulate the drive being remounted with the same contents.
		fs.mkdirSync(mountDir);
		fs.writeFileSync(path.join(mountDir, "file.md"), "x");
		expect(resolveOutsidePath(mountDir)).toBe(true);
		expect(listOutsideChildren(mountDir, { showFiles: true, showFolders: true })).toEqual([{ kind: "file", path: "file.md" }]);
	});
});
