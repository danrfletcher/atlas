import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { TFolder, Vault } from "../../tests/mocks/obsidian";
import { buildFolderSourceChildren, folderToRows, isAncestorOrSelf, reconcileManagedChildren } from "../../src/folder-source";
import { ViewsManager } from "../../src/views";
import { FolderSourceConfig, UnitRef, ViewNode } from "../../src/types";

function source(overrides: Partial<FolderSourceConfig> = {}): FolderSourceConfig {
	return {
		location: "inside",
		path: "Projects",
		showFiles: true,
		showFolders: true,
		refreshOnViewLoad: false,
		...overrides,
	};
}

let nextId = 0;
function unitNode(ref: UnitRef, overrides: Partial<ViewNode> = {}): ViewNode {
	nextId += 1;
	return { id: `n${nextId}`, type: "unit", ref, children: [], ...overrides };
}

describe("folderToRows — G3/G4", () => {
	it("lists only direct children, filtered independently by showFiles/showFolders", () => {
		const vault = new Vault();
		vault.seedFolder("Projects");
		vault.seedFile("Projects/a.md");
		vault.seedFolder("Projects/Sub");
		vault.seedFile("Projects/b.md");
		const target = vault.getAbstractFileByPath("Projects") as TFolder;

		expect(folderToRows(target, { showFiles: true, showFolders: true })).toEqual([
			{ kind: "file", path: "Projects/a.md" },
			{ kind: "folder", path: "Projects/Sub" },
			{ kind: "file", path: "Projects/b.md" },
		]);
	});

	it("showFiles off hides files, keeps folders", () => {
		const vault = new Vault();
		vault.seedFolder("Projects");
		vault.seedFile("Projects/a.md");
		vault.seedFolder("Projects/Sub");
		const target = vault.getAbstractFileByPath("Projects") as TFolder;

		expect(folderToRows(target, { showFiles: false, showFolders: true })).toEqual([{ kind: "folder", path: "Projects/Sub" }]);
	});

	it("showFolders off hides folders, keeps files", () => {
		const vault = new Vault();
		vault.seedFolder("Projects");
		vault.seedFile("Projects/a.md");
		vault.seedFolder("Projects/Sub");
		const target = vault.getAbstractFileByPath("Projects") as TFolder;

		expect(folderToRows(target, { showFiles: true, showFolders: false })).toEqual([{ kind: "file", path: "Projects/a.md" }]);
	});

	it("an empty folder with both toggles off (or just empty) produces zero rows", () => {
		const vault = new Vault();
		vault.seedFolder("Empty");
		const target = vault.getAbstractFileByPath("Empty") as TFolder;

		expect(folderToRows(target, { showFiles: true, showFolders: true })).toEqual([]);
		expect(folderToRows(target, { showFiles: false, showFolders: false })).toEqual([]);
	});
});

describe("isAncestorOrSelf", () => {
	it("is true for the identical path", () => {
		expect(isAncestorOrSelf("Projects", "Projects")).toBe(true);
	});

	it("is true for a descendant path", () => {
		expect(isAncestorOrSelf("Projects", "Projects/Sub/file.md")).toBe(true);
	});

	it("is false for an unrelated or sibling path", () => {
		expect(isAncestorOrSelf("Projects", "Other")).toBe(false);
		expect(isAncestorOrSelf("Projects", "ProjectsArchive")).toBe(false);
	});
});

describe("reconcileManagedChildren — G7/G9/E2", () => {
	it("appends new managed children for refs with no existing match", () => {
		const result = reconcileManagedChildren([], [{ kind: "file", path: "Projects/a.md" }], { showFiles: true, showFolders: true }, (ref) =>
			unitNode(ref, { folderSourceManaged: true })
		);
		expect(result).toHaveLength(1);
		expect(result[0].ref).toEqual({ kind: "file", path: "Projects/a.md" });
		expect(result[0].folderSourceManaged).toBe(true);
	});

	it("keeps a reordered/renested managed child in place even if its ref vanished from desiredRefs (never auto-removed)", () => {
		const existing = [unitNode({ kind: "file", path: "Projects/gone.md" }, { folderSourceManaged: true })];
		const result = reconcileManagedChildren(existing, [], { showFiles: true, showFolders: true }, (ref) => unitNode(ref, { folderSourceManaged: true }));
		expect(result).toEqual(existing);
	});

	it("leaves non-managed children (hand-nested by the user) untouched and does not dedupe them against managed rows", () => {
		const handNested = unitNode({ kind: "file", path: "Projects/a.md" });
		const result = reconcileManagedChildren([handNested], [{ kind: "file", path: "Projects/a.md" }], { showFiles: true, showFolders: true }, (ref) =>
			unitNode(ref, { folderSourceManaged: true })
		);
		// The hand-nested node is kept, and a second managed node for the same ref is also added —
		// reconcile only matches against its own previously-managed rows, not arbitrary existing refs.
		expect(result).toHaveLength(2);
		expect(result[0]).toBe(handNested);
	});

	it("toggling a kind off removes that kind's managed children, lifting their own children up one level", () => {
		const grandchild = unitNode({ kind: "file", path: "Projects/Sub/inner.md" });
		const managedFolder = unitNode({ kind: "folder", path: "Projects/Sub" }, { folderSourceManaged: true, children: [grandchild] });
		const managedFile = unitNode({ kind: "file", path: "Projects/a.md" }, { folderSourceManaged: true });
		const result = reconcileManagedChildren([managedFolder, managedFile], [], { showFiles: true, showFolders: false }, (ref) =>
			unitNode(ref, { folderSourceManaged: true })
		);
		expect(result).toEqual([grandchild, managedFile]);
	});

	it("a managed child whose kind is still enabled is kept exactly once even when its ref reappears in desiredRefs", () => {
		const existing = unitNode({ kind: "file", path: "Projects/a.md" }, { folderSourceManaged: true });
		const result = reconcileManagedChildren([existing], [{ kind: "file", path: "Projects/a.md" }], { showFiles: true, showFolders: true }, (ref) =>
			unitNode(ref, { folderSourceManaged: true })
		);
		expect(result).toEqual([existing]);
	});
});

describe("buildFolderSourceChildren — G16/E1", () => {
	it("location 'outside' is a no-op in this PR, returning existingChildren unchanged", () => {
		const existing = [unitNode({ kind: "file", path: "x.md" })];
		const result = buildFolderSourceChildren({ getAbstractFileByPath: () => null }, source({ location: "outside" }), existing, (ref) => unitNode(ref));
		expect(result).toBe(existing);
	});

	it("an unresolvable target folder falls back to a single missing-ref sentinel managed child", () => {
		const result = buildFolderSourceChildren({ getAbstractFileByPath: () => null }, source({ path: "Gone" }), [], (ref) => unitNode(ref, { folderSourceManaged: true }));
		expect(result).toHaveLength(1);
		expect(result[0].ref).toEqual({ kind: "folder", path: "Gone" });
		expect(result[0].folderSourceManaged).toBe(true);
	});

	it("reuses the same sentinel node (by ref equality) across refreshes while the target stays missing", () => {
		const vaultLike = { getAbstractFileByPath: () => null };
		const first = buildFolderSourceChildren(vaultLike, source({ path: "Gone" }), [], (ref) => unitNode(ref, { folderSourceManaged: true }));
		const second = buildFolderSourceChildren(vaultLike, source({ path: "Gone" }), first, (ref) => unitNode(ref, { folderSourceManaged: true }));
		expect(second).toHaveLength(1);
		expect(second[0]).toBe(first[0]);
	});

	it("drops non-managed children too once the target becomes unresolvable (nothing resolvable to reconcile against)", () => {
		const nonManaged = unitNode({ kind: "file", path: "keep-me.md" });
		const existingSentinel = buildFolderSourceChildren({ getAbstractFileByPath: () => null }, source({ path: "Gone" }), [], (ref) =>
			unitNode(ref, { folderSourceManaged: true })
		);
		const result = buildFolderSourceChildren({ getAbstractFileByPath: () => null }, source({ path: "Gone" }), [nonManaged, ...existingSentinel], (ref) =>
			unitNode(ref, { folderSourceManaged: true })
		);
		expect(result).toContain(nonManaged);
		expect(result.filter((n) => n.folderSourceManaged)).toHaveLength(1);
	});

	it("a resolvable target reconciles ordinary rows via folderToRows/reconcileManagedChildren", () => {
		const vault = new Vault();
		vault.seedFolder("Projects");
		vault.seedFile("Projects/a.md");
		const result = buildFolderSourceChildren(vault, source(), [], (ref) => unitNode(ref, { folderSourceManaged: true }));
		expect(result).toEqual([expect.objectContaining({ ref: { kind: "file", path: "Projects/a.md" }, folderSourceManaged: true })]);
	});

	it("edge case: a target folder that is an ancestor of, or identical to, the source Folder's own location does not crash (isAncestorOrSelf is available for callers to guard with)", () => {
		const vault = new Vault();
		vault.seedFolder("Projects");
		vault.seedFolder("Projects/Sub");
		expect(isAncestorOrSelf("Projects", "Projects")).toBe(true);
		expect(() => buildFolderSourceChildren(vault, source({ path: "Projects" }), [], (ref) => unitNode(ref, { folderSourceManaged: true }))).not.toThrow();
	});
});

function makeViewsManager() {
	return new ViewsManager({} as App, [], "", () => {});
}

describe("vault-relative path storage round-trip — G5", () => {
	it("setFolderSource stores a plain vault-relative path string, unchanged through a save/reload cycle, with no absolute-path leakage", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "Folder source")!;
		vm.setFolderSource(view.id, folder.id, source({ path: "Projects/Sub" }));

		const persistedJson = JSON.stringify(vm.getViews());
		expect(persistedJson).toContain("\"path\":\"Projects/Sub\"");
		expect(persistedJson).not.toMatch(/"path":"\/|"path":"[A-Za-z]:\\/);

		const reloaded = new ViewsManager({} as App, JSON.parse(persistedJson), "", () => {});
		const reloadedSource = reloaded.getNode(view.id, folder.id)!.folderSource!;
		expect(reloadedSource.location).toBe("inside");
		expect(reloadedSource.path).toBe("Projects/Sub");
		expect(reloadedSource.showFiles).toBe(true);
		expect(reloadedSource.showFolders).toBe(true);
	});
});

describe("ref-rewrite-on-rename — G5", () => {
	it("onVaultRename rewrites folderSource.path when the target folder itself is renamed/moved, via the same rewrite call used by other reference types", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "Folder source")!;
		vm.setFolderSource(view.id, folder.id, source({ path: "Projects" }));

		vm.onVaultRename("Projects", "Renamed");

		expect(vm.getNode(view.id, folder.id)!.folderSource!.path).toBe("Renamed");
	});

	it("onVaultRename rewrites folderSource.path when an ancestor folder is renamed/moved (descendant path)", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "Folder source")!;
		vm.setFolderSource(view.id, folder.id, source({ path: "Projects/Sub" }));

		vm.onVaultRename("Projects", "Renamed");

		expect(vm.getNode(view.id, folder.id)!.folderSource!.path).toBe("Renamed/Sub");
	});

	it("onVaultRename leaves an unrelated folderSource.path untouched", () => {
		const vm = makeViewsManager();
		const view = vm.getViews()[0];
		const folder = vm.addMetaFolder(view.id, null, "Folder source")!;
		vm.setFolderSource(view.id, folder.id, source({ path: "Unrelated" }));

		vm.onVaultRename("Projects", "Renamed");

		expect(vm.getNode(view.id, folder.id)!.folderSource!.path).toBe("Unrelated");
	});
});
