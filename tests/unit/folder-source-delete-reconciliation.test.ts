import { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { ViewsManager } from "../../src/views";
import { FolderSourceConfig, PLACEHOLDER_ROW_KIND, ViewNode } from "../../src/types";

/** One meta "Folder" node owning a Folder source in `mode`, with one managed real-unit child at
 * `Projects/a.md` — the minimal fixture every G12/G13/G14 case starts from. */
function setup(mode: "append" | "merge" | "overwrite", childOverrides: Partial<ViewNode> = {}) {
	const persist = vi.fn();
	const folderSource: FolderSourceConfig = {
		type: "folder",
		location: "inside",
		path: "Projects",
		showFiles: true,
		showFolders: true,
		refreshOnViewLoad: false,
		mode,
	};
	const child: ViewNode = {
		id: "child-1",
		type: "unit",
		ref: { kind: "file", path: "Projects/a.md" },
		children: [],
		folderSourceManaged: true,
		folderSourceOwnerId: "owner",
		...childOverrides,
	};
	const owner: ViewNode = {
		id: "owner",
		type: "meta",
		label: "Projects",
		children: [child],
		folderSource,
	};
	const vm = new ViewsManager({} as App, [{ id: "v1", name: "Default", inboxMode: "view" as const, root: [owner] }], "v1", persist);
	persist.mockClear();
	return { vm, persist, ownerId: "owner", childId: "child-1" };
}

describe("ViewsManager.onVaultDelete — PR-6 mode-reconciliation rule (G12/G13/G14)", () => {
	it.each([
		{ mode: "merge" as const, expectRow: true, expectNotFound: true },
		{ mode: "append" as const, expectRow: true, expectNotFound: false },
		{ mode: "overwrite" as const, expectRow: false, expectNotFound: false },
	])("mode=$mode: deleting the managed child's file produces exactly the G12/G13/G14 outcome", ({ mode, expectRow, expectNotFound }) => {
		const { vm, ownerId, childId } = setup(mode);

		vm.onVaultDelete("Projects/a.md");

		const owner = vm.getNode("v1", ownerId)!;
		// The real ViewNode is always removed from the tree — all three modes reconcile the *row*,
		// never leave the stale real unit sitting there.
		expect(owner.children.some((n) => n.id === childId)).toBe(false);

		const entries = Object.values(owner.apiItemState ?? {});
		if (!expectRow) {
			expect(entries).toHaveLength(0); // G14: overwrite leaves no placeholder at all.
			return;
		}
		expect(entries).toHaveLength(1);
		const entry = entries[0];
		expect(entry.kind).toBe(PLACEHOLDER_ROW_KIND);
		expect(!!entry.notFound).toBe(expectNotFound);
		if (expectNotFound) {
			expect(entry.lastSeenAt).toBeTruthy();
		} else {
			// G13: append mode's row carries no attachment once G27's existing clear sweep (run in the
			// same onVaultDelete call) picks up the noteRef this rule deliberately pointed at the
			// just-deleted path.
			expect(entry.noteRef).toBeUndefined();
		}
	});

	it("merge-mode last-seen row matches PR-2's stale-placeholder shape exactly", () => {
		const { vm, ownerId } = setup("merge");

		vm.onVaultDelete("Projects/a.md");

		const owner = vm.getNode("v1", ownerId)!;
		const entry = Object.values(owner.apiItemState ?? {})[0];
		expect(entry).toEqual({
			id: "file:Projects/a.md",
			label: "a.md",
			kind: PLACEHOLDER_ROW_KIND,
			notFound: true,
			lastSeenAt: entry.lastSeenAt,
			explicitStatusId: undefined,
		});
	});

	it("append-mode row retains non-attachment fields (label, explicitStatusId) after link clearing — only noteRef mutates", () => {
		const { vm, ownerId } = setup("append", { explicitStatusId: "in-progress" });

		vm.onVaultDelete("Projects/a.md");

		const owner = vm.getNode("v1", ownerId)!;
		const entry = Object.values(owner.apiItemState ?? {})[0];
		expect(entry.label).toBe("a.md");
		expect(entry.explicitStatusId).toBe("in-progress");
		expect(entry.noteRef).toBeUndefined();
		expect(entry.notFound).toBeFalsy();
	});

	it("overwrite-mode deletion persists silently — no placeholder, and persist is still called once (no dialog/confirm in this layer)", () => {
		const { vm, persist, ownerId } = setup("overwrite");

		vm.onVaultDelete("Projects/a.md");

		expect(vm.getNode("v1", ownerId)!.apiItemState ?? {}).toEqual({});
		expect(persist).toHaveBeenCalledTimes(1);
	});

	it("absent mode defaults to merge (same default as a freshly-sanitized FolderSourceConfig)", () => {
		const persist = vi.fn();
		const folderSource = {
			type: "folder" as const,
			location: "inside" as const,
			path: "Projects",
			showFiles: true,
			showFolders: true,
			refreshOnViewLoad: false,
		};
		const child: ViewNode = {
			id: "child-1",
			type: "unit",
			ref: { kind: "file", path: "Projects/a.md" },
			children: [],
			folderSourceManaged: true,
			folderSourceOwnerId: "owner",
		};
		const owner: ViewNode = { id: "owner", type: "meta", label: "Projects", children: [child], folderSource };
		const vm = new ViewsManager({} as App, [{ id: "v1", name: "Default", inboxMode: "view" as const, root: [owner] }], "v1", persist);

		vm.onVaultDelete("Projects/a.md");

		const entry = Object.values(vm.getNode("v1", "owner")!.apiItemState ?? {})[0];
		expect(entry.notFound).toBe(true);
	});
});
