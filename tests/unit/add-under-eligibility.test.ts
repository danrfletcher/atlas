import { describe, expect, it } from "vitest";
import { ApiSourceConfig, CsvSourceConfig, FolderSourceConfig, MarkdownTableSourceConfig, ViewNode } from "../../src/types";
import { CanAddUnderDeps, canAddUnder } from "../../src/add-under";
import { file, folder, meta, unit } from "../integration/create-from-meta-fixtures";

const VIEW_ID = "v1";

/** Stubs the one owner lookup `canAddUnder` needs, from a plain id->node map — the "`getNode`
 * stubbed for the owner lookup" the spec asks for, with no `ViewsManager`/Obsidian involved. */
function depsFromMap(byId: Record<string, ViewNode>): CanAddUnderDeps {
	return { getNode: (_viewId, nodeId) => byId[nodeId] ?? null };
}

const NO_OWNERS = depsFromMap({});

const insideOwner = meta("owner", "Folder", [], { folderSource: { location: "inside", path: "Projects", showFiles: true, showFolders: true } });
const outsideOwner = meta("owner", "Folder", [], { folderSource: { location: "outside", path: "", showFiles: true, showFolders: true } });

describe("canAddUnder — G7/F1/E8 eligibility predicate", () => {
	it.each<[string, ViewNode, CanAddUnderDeps, boolean]>([
		["a unit (file) row is eligible", unit("u", file("Notes/a.md")), NO_OWNERS, true],
		["a unit (module/folder) row is eligible", unit("u", folder("Projects")), NO_OWNERS, true],
		["a Folder (meta) row is eligible", meta("m", "Folder"), NO_OWNERS, true],
		["a managed unit with no folderSourceOwnerId yet is eligible (nothing to exclude it on)", unit("u", file("a.md"), { folderSourceManaged: true }), NO_OWNERS, true],
		["a managed unit whose owner id doesn't resolve to any node is eligible (unknown owner is not Outside)", unit("u", file("a.md"), { folderSourceManaged: true, folderSourceOwnerId: "owner" }), NO_OWNERS, true],
		[
			"a child of an Inside-Vault Folder source is eligible",
			unit("c", file("Projects/a.md"), { folderSourceManaged: true, folderSourceOwnerId: "owner" }),
			depsFromMap({ owner: insideOwner }),
			true,
		],
		[
			"a child of an Outside-Vault Folder source is NOT eligible (isOutsideManagedUnit)",
			unit("c", file("a.md"), { folderSourceManaged: true, folderSourceOwnerId: "owner" }),
			depsFromMap({ owner: outsideOwner }),
			false,
		],
		[
			"a hand-made Folder nested under an Outside-Vault source stays eligible — only isOutsideManagedUnit rows are excluded",
			meta("hand-made", "Notes"),
			depsFromMap({ owner: outsideOwner }),
			true,
		],
		["a row with an Inside-Vault folderSource configured is NOT eligible", meta("m", "Folder", [], { folderSource: { location: "inside", path: "Projects", showFiles: true, showFolders: true } as FolderSourceConfig }), NO_OWNERS, false],
		["a row with an Outside-Vault folderSource configured is NOT eligible", meta("m", "Folder", [], { folderSource: { location: "outside", path: "", showFiles: true, showFolders: true } as FolderSourceConfig }), NO_OWNERS, false],
		["a row with an apiSource configured is NOT eligible", meta("m", "Folder", [], { apiSource: { url: "https://x" } as unknown as ApiSourceConfig }), NO_OWNERS, false],
		["a row with a csvSource configured is NOT eligible", meta("m", "Folder", [], { csvSource: { path: "a.csv" } as unknown as CsvSourceConfig }), NO_OWNERS, false],
		["a row with a markdownTableSource configured is NOT eligible", meta("m", "Folder", [], { markdownTableSource: { path: "t.md" } as unknown as MarkdownTableSourceConfig }), NO_OWNERS, false],
	])("%s", (_label, node, deps, expected) => {
		expect(canAddUnder(deps, VIEW_ID, node)).toBe(expected);
	});

	it("nesting depth doesn't matter — a unit three levels deep is still eligible", () => {
		const deep = unit("deepest", file("Sub/Sub2/Sub3/a.md"));
		const l2 = meta("l2", "Level 2", [deep]);
		const l1 = meta("l1", "Level 1", [l2]);
		meta("l0", "Level 0", [l1]); // just builds the tree; canAddUnder itself only ever looks at `deep`.
		expect(canAddUnder(NO_OWNERS, VIEW_ID, deep)).toBe(true);
	});

	it("a missing row is NOT eligible, even though the node itself has no source and isn't Outside-managed", () => {
		const node = unit("u", file("Gone.md"));
		expect(canAddUnder(NO_OWNERS, VIEW_ID, node, { missing: true })).toBe(false);
	});

	it("a greyed 'filtered out' row is NOT eligible", () => {
		const node = unit("c", file("Projects/a.md"), { folderSourceManaged: true, folderSourceOwnerId: "owner" });
		expect(canAddUnder(depsFromMap({ owner: insideOwner }), VIEW_ID, node, { filteredOut: true })).toBe(false);
	});

	it("an otherwise-eligible row with both flags explicitly false stays eligible (control case)", () => {
		const node = unit("u", file("Notes/a.md"));
		expect(canAddUnder(NO_OWNERS, VIEW_ID, node, { missing: false, filteredOut: false })).toBe(true);
	});
});
