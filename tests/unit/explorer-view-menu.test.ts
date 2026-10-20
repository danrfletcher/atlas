import { beforeEach, describe, expect, it, vi } from "vitest";
import { Menu } from "obsidian";
import { AtlasExplorerView } from "../../src/explorer-view";
import { ATLAS_SORT_AZ_ICON_ID } from "../../src/sort";
import { ApiItemState, StatusGovernance, View, ViewNode } from "../../src/types";

const view: View = { id: "v1", name: "Default", inboxMode: "view", root: [] };
const folderNode: ViewNode = { id: "folder", type: "meta", label: "Folder", children: [] };

function item(overrides: Partial<ApiItemState> = {}): ApiItemState {
	return { id: "1", label: "Row", kind: "placeholder", ...overrides };
}

function buildMenu(it: ApiItemState, node: ViewNode = folderNode) {
	const fake = {
		plugin: { viewsManager: { removeApiItem: vi.fn(), clearApiItemNoteRef: vi.fn() } },
	};
	let built: Menu | undefined;
	const show = vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
		built = this;
	});
	(AtlasExplorerView.prototype as unknown as { showApiItemMenu: (...a: unknown[]) => void }).showApiItemMenu.call(
		fake,
		new MouseEvent("contextmenu"),
		view,
		node,
		it
	);
	show.mockRestore();
	return { menu: built!, fake };
}

describe("G26 — Remove menu item enablement", () => {
	it("appears only when the row is notFound", () => {
		const { menu } = buildMenu(item({ notFound: true }));
		expect(menu.titles()).toContain("Remove");
	});

	it("is absent when the row is not notFound", () => {
		const { menu } = buildMenu(item());
		expect(menu.titles()).not.toContain("Remove");
	});

	it("clicking Remove deletes the apiItemState entry via ViewsManager, and nothing else", () => {
		const { menu, fake } = buildMenu(item({ notFound: true }));
		menu.items.find((i) => i.title === "Remove")!.clickHandler!();
		expect(fake.plugin.viewsManager.removeApiItem).toHaveBeenCalledWith("v1", "folder", "1");
		expect(fake.plugin.viewsManager.clearApiItemNoteRef).not.toHaveBeenCalled();
	});

	it("E6: Remove still removes the entry even if notFound flips back to false between menu-open and click", () => {
		const row = item({ notFound: true });
		const { menu, fake } = buildMenu(row);
		// Mutate the live item after the menu (and its click handler) was already built, simulating
		// the row flipping back to found before the user's click resolves.
		row.notFound = false;
		menu.items.find((i) => i.title === "Remove")!.clickHandler!();
		expect(fake.plugin.viewsManager.removeApiItem).toHaveBeenCalledWith("v1", "folder", "1");
	});
});

describe("G28 — Remove attachment menu item enablement", () => {
	it("appears whenever noteRef is set, regardless of notFound", () => {
		const { menu } = buildMenu(item({ noteRef: { kind: "file", path: "Note.md" } }));
		expect(menu.titles()).toContain("Remove attachment");
	});

	it("is absent when noteRef is unset", () => {
		const { menu } = buildMenu(item());
		expect(menu.titles()).not.toContain("Remove attachment");
	});

	it("clicking Remove attachment clears only the noteRef via ViewsManager", () => {
		const { menu, fake } = buildMenu(item({ noteRef: { kind: "file", path: "Note.md" } }));
		menu.items.find((i) => i.title === "Remove attachment")!.clickHandler!();
		expect(fake.plugin.viewsManager.clearApiItemNoteRef).toHaveBeenCalledWith("v1", "folder", "1");
		expect(fake.plugin.viewsManager.removeApiItem).not.toHaveBeenCalled();
	});

	it("is independent of G27's auto-clear: present even on a row whose notFound is also true", () => {
		const { menu } = buildMenu(item({ notFound: true, noteRef: { kind: "file", path: "Note.md" } }));
		expect(menu.titles()).toContain("Remove attachment");
		expect(menu.titles()).toContain("Remove");
	});
});

describe("F3/F4 — no bulk remove, no undo", () => {
	it("no bulk 'remove all' action appears anywhere in the menu", () => {
		const { menu } = buildMenu(item({ notFound: true, noteRef: { kind: "file", path: "Note.md" } }));
		expect(menu.titles().some((t) => /remove all/i.test(t))).toBe(false);
	});

	it("no undo action appears after Remove or Remove attachment are clicked", () => {
		const { menu } = buildMenu(item({ notFound: true, noteRef: { kind: "file", path: "Note.md" } }));
		menu.items.find((i) => i.title === "Remove attachment")!.clickHandler!();
		menu.items.find((i) => i.title === "Remove")!.clickHandler!();
		expect(menu.titles().some((t) => /undo/i.test(t))).toBe(false);
	});
});

describe("G29 — existing API-item behavior is unchanged", () => {
	it("Open attachment / Add note / Add block / Add module keep their existing conditions and ordering", () => {
		const { menu } = buildMenu(item({ noteRef: { kind: "file", path: "Note.md" } }));
		expect(menu.titles().slice(0, 4)).toEqual(["Open attachment", "Add note", "Add block", "Add module"]);
	});

	it("an item with no noteRef and not notFound shows only the unconditional Add actions", () => {
		const { menu } = buildMenu(item());
		expect(menu.titles()).toEqual(["Add note", "Add block", "Add module"]);
	});

	it("Remove/Remove attachment never appear for a non-placeholder-kind item, even with notFound/noteRef set", () => {
		const nonPlaceholder = { ...item({ notFound: true, noteRef: { kind: "file", path: "Note.md" } }), kind: "something-else" } as unknown as ApiItemState;
		const { menu } = buildMenu(nonPlaceholder);
		expect(menu.titles()).not.toContain("Remove");
		expect(menu.titles()).not.toContain("Remove attachment");
	});
});

// PR-1 (G11e): Statuses, Data source…, Refresh now and Remove data source come from one shared helper,
// so an Atlas-folder menu and a unit menu list them with the same labels, order and conditions.
describe("PR-1 G11e — shared source/status menu items on a meta and a unit menu", () => {
	const SOURCE_TITLES = ["Data source…", "Refresh now", "Remove data source"];
	const apiSource = { url: "https://x", method: "GET" as const, mapping: { idField: "id", labelField: "name" }, mode: "merge" as const, refreshOnViewLoad: false };

	function fakeFor(): Record<string, unknown> {
		const plugin = { app: {}, unitIndex: { getUnits: () => [] }, viewsManager: { getNode: () => null } };
		const target: Record<string, unknown> = { plugin };
		return new Proxy(target, {
			get: (t, prop: string) => (prop in t ? t[prop] : vi.fn()),
		});
	}

	function menuTitles(method: "showMetaFolderMenu" | "showUnitMenu", node: ViewNode, ref?: { kind: "file"; path: string }): string[] {
		let built: Menu | undefined;
		const show = vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
			built = this;
		});
		const args = method === "showUnitMenu" ? [new MouseEvent("contextmenu"), ref ?? { kind: "file", path: "U.md" }, view, node] : [new MouseEvent("contextmenu"), node, view];
		(AtlasExplorerView.prototype as unknown as Record<string, (...a: unknown[]) => void>)[method].call(fakeFor(), ...args);
		show.mockRestore();
		return built!.titles();
	}

	const sourceOf = (titles: string[]) => titles.filter((t) => SOURCE_TITLES.includes(t));

	it("a unit with no source offers Data source… and no Refresh now or Remove data source", () => {
		const unit: ViewNode = { id: "u", type: "unit", ref: { kind: "file", path: "U.md" }, children: [] };
		const titles = menuTitles("showUnitMenu", unit);
		expect(titles).toContain("Data source…");
		expect(titles).not.toContain("Refresh now");
		expect(titles).not.toContain("Remove data source");
	});

	it("a unit with an API source lists Data source…, Refresh now, Remove data source in the same order as an Atlas folder", () => {
		const unit: ViewNode = { id: "u", type: "unit", ref: { kind: "file", path: "U.md" }, children: [], apiSource };
		const folder: ViewNode = { id: "f", type: "meta", label: "Linear issues", children: [], apiSource };
		expect(sourceOf(menuTitles("showUnitMenu", unit))).toEqual(SOURCE_TITLES);
		expect(sourceOf(menuTitles("showMetaFolderMenu", folder))).toEqual(SOURCE_TITLES);
	});

	it("an Atlas folder without a source offers the same single Data source… item as a unit does", () => {
		const folder: ViewNode = { id: "f", type: "meta", label: "Plain", children: [] };
		const unit: ViewNode = { id: "u", type: "unit", ref: { kind: "file", path: "U.md" }, children: [] };
		expect(sourceOf(menuTitles("showMetaFolderMenu", folder))).toEqual(["Data source…"]);
		expect(sourceOf(menuTitles("showUnitMenu", unit))).toEqual(["Data source…"]);
	});
});

// PR-2 (G1-G4): Swap items. "Swap with…" on any swappable bucket node; "Swap for Atlas folder" on units only;
// both directly above "Remove from view" on a unit, and "Swap with…" right after "Create" on an Atlas folder.
describe("PR-2 G1-G4 — Swap menu items", () => {
	const SWAP = ["Swap with…", "Swap for Atlas folder"];

	function swapFake() {
		return {
			plugin: { app: {}, unitIndex: { getUnits: () => [] }, viewsManager: { getNode: () => null } },
			openSwapPicker: vi.fn(),
			openSwapForFolder: vi.fn(),
		};
	}

	function build(method: "showMetaFolderMenu" | "showUnitMenu", node: ViewNode, ref: { kind: "file"; path: string } = { kind: "file", path: "U.md" }, displayName = "U") {
		const fake = swapFake();
		let built: Menu | undefined;
		const show = vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
			built = this;
		});
		const args = method === "showUnitMenu" ? [new MouseEvent("contextmenu"), ref, view, node, displayName] : [new MouseEvent("contextmenu"), node, view];
		(AtlasExplorerView.prototype as unknown as Record<string, (...a: unknown[]) => void>)[method].call(fake, ...args);
		show.mockRestore();
		return { menu: built!, fake };
	}

	const unitNode = (over: Partial<ViewNode> = {}): ViewNode => ({ id: "u", type: "unit", ref: { kind: "file", path: "U.md" }, children: [], ...over });
	const metaNode = (over: Partial<ViewNode> = {}): ViewNode => ({ id: "m", type: "meta", label: "Folder", children: [], ...over });

	it("a unit's Swap items sit directly above Remove from view, after Duplicate (Meta)", () => {
		const titles = build("showUnitMenu", unitNode()).menu.titles();
		const at = titles.indexOf("Remove from view");
		expect(titles.slice(at - 3, at)).toEqual(["Duplicate (Meta)", ...SWAP]);
	});

	it.each([
		["a file", { kind: "file" as const, path: "U.md" }],
		["a folder", { kind: "folder" as const, path: "Boat" }],
		["a block", { kind: "block" as const, path: "U.md", subpath: "^abc" }],
		["a promoted folder (nested, not a module)", { kind: "folder" as const, path: "Projects/Career" }],
		["a promoted block", { kind: "block" as const, path: "Projects/Career.md", subpath: "^abc" }],
		["a free block", { kind: "file" as const, path: "_pool/20260101000000-aaaa.md" }],
	])("offers both items for %s units (G1)", (_label, ref) => {
		const titles = build("showUnitMenu", unitNode({ ref })).menu.titles();
		expect(titles).toEqual(expect.arrayContaining(SWAP));
	});

	it("an Atlas folder offers only Swap with…, straight after Create", () => {
		const titles = build("showMetaFolderMenu", metaNode()).menu.titles();
		expect(titles).not.toContain("Swap for Atlas folder");
		const at = titles.indexOf("Create");
		expect(titles[at + 1]).toBe("Swap with…");
	});

	it("a linked-folder (folderSourceManaged) unit has no Swap items at all", () => {
		expect(build("showUnitMenu", unitNode({ folderSourceManaged: true })).menu.titles()).not.toEqual(expect.arrayContaining(SWAP));
	});

	it("a linked-folder Atlas folder has no Swap item", () => {
		expect(build("showMetaFolderMenu", metaNode({ folderSourceManaged: true })).menu.titles()).not.toContain("Swap with…");
	});

	it("Swap with… opens the picker for this exact spot", () => {
		const node = unitNode();
		const { menu, fake } = build("showUnitMenu", node);
		menu.items.find((i) => i.title === "Swap with…")!.clickHandler!();
		expect(fake.openSwapPicker).toHaveBeenCalledWith(view, node);
	});

	it("Swap for Atlas folder opens the name box with the row's display name", () => {
		const node = unitNode();
		const { menu, fake } = build("showUnitMenu", node, { kind: "file", path: "Boat.md" }, "Boat");
		menu.items.find((i) => i.title === "Swap for Atlas folder")!.clickHandler!();
		expect(fake.openSwapForFolder).toHaveBeenCalledWith(view, node, "Boat");
	});

	it("the API-row menu has no Swap item", () => {
		const fake = { plugin: { viewsManager: { removeApiItem: vi.fn(), clearApiItemNoteRef: vi.fn() } } };
		let built: Menu | undefined;
		const show = vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
			built = this;
		});
		const row: ApiItemState = { id: "1", label: "Row", kind: "placeholder", notFound: true, noteRef: { kind: "file", path: "N.md" } };
		(AtlasExplorerView.prototype as unknown as { showApiItemMenu: (...a: unknown[]) => void }).showApiItemMenu.call(
			fake,
			new MouseEvent("contextmenu"),
			view,
			metaNode({ id: "folder" }),
			row
		);
		show.mockRestore();
		expect(built!.titles()).not.toEqual(expect.arrayContaining(SWAP));
	});
});

// PR-1 (G6/G7/G11/F8/G19): "Sort children…" submenu — same on a unit row, a Folder row and the
// Bucket header, written through the generic updateStatusGovernance(viewId, nodeId, patch).
describe("PR-1 G6/G7 — Sort children… menu", () => {
	beforeEach(() => {
		Menu.shownAtPosition = [];
	});

	function sortFake(statusGovernor: StatusGovernance | null = null) {
		const vault = {
			create: vi.fn(),
			createFolder: vi.fn(),
			createBinary: vi.fn(),
			modify: vi.fn(),
			modifyBinary: vi.fn(),
			append: vi.fn(),
			delete: vi.fn(),
			trash: vi.fn(),
			rename: vi.fn(),
			copy: vi.fn(),
		};
		return {
			plugin: {
				app: { vault, fileManager: { renameFile: vi.fn() } },
				unitIndex: { getUnits: () => [] },
				viewsManager: { getNode: () => null, updateStatusGovernance: vi.fn() },
				statusesManager: { findSortGovernor: vi.fn(() => statusGovernor) },
			},
		};
	}

	/** F1: none of a Vault's disk-write methods (nor `fileManager.renameFile`) were ever called. */
	function expectNoVaultWrite(fake: ReturnType<typeof sortFake>): void {
		const vault = fake.plugin.app.vault as unknown as Record<string, ReturnType<typeof vi.fn>>;
		for (const name of ["create", "createFolder", "createBinary", "modify", "modifyBinary", "append", "delete", "trash", "rename", "copy"]) {
			expect(vault[name]).not.toHaveBeenCalled();
		}
		expect(fake.plugin.app.fileManager.renameFile).not.toHaveBeenCalled();
	}

	function build(
		method: "showMetaFolderMenu" | "showUnitMenu" | "showBucketHeaderMenu",
		node?: ViewNode,
		ref: { kind: "file"; path: string } = { kind: "file", path: "U.md" },
		statusGovernor: StatusGovernance | null = null
	) {
		const fake = sortFake(statusGovernor);
		let built: Menu | undefined;
		const show = vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
			built = this;
		});
		const evt = new MouseEvent("contextmenu");
		const args = method === "showUnitMenu" ? [evt, ref, view, node] : method === "showMetaFolderMenu" ? [evt, node, view] : [evt, view];
		(AtlasExplorerView.prototype as unknown as Record<string, (...a: unknown[]) => void>)[method].call(fake, ...args);
		show.mockRestore();
		return { menu: built!, fake };
	}

	/** Opens the chooser popped by "Sort children…"'s own click handler. */
	function openChooser(menu: Menu): Menu {
		menu.items.find((i) => i.title === "Sort children…")!.clickHandler!();
		return Menu.shownAtPosition[Menu.shownAtPosition.length - 1];
	}

	const unitNode = (over: Partial<ViewNode> = {}): ViewNode => ({ id: "u", type: "unit", ref: { kind: "file", path: "U.md" }, children: [], ...over });
	const metaNode = (over: Partial<ViewNode> = {}): ViewNode => ({ id: "m", type: "meta", label: "Folder", children: [], ...over });

	it("appears on a unit row, a Folder row and the Bucket header", () => {
		expect(build("showUnitMenu", unitNode()).menu.titles()).toContain("Sort children…");
		expect(build("showMetaFolderMenu", metaNode()).menu.titles()).toContain("Sort children…");
		expect(build("showBucketHeaderMenu").menu.titles()).toContain("Sort children…");
	});

	// PR-2 (T12): the "Sort children…" item's own icon must resolve to Atlas's registered
	// sort-az id, not a bare or lucide-prefixed Lucide string — neither ever rendered an <svg>
	// through MenuItem.setIcon() in the real Obsidian build across three fix rounds (T5/T9/T12).
	it("its own icon is Atlas's registered sort-az icon id", () => {
		const { menu } = build("showUnitMenu", unitNode());
		expect(menu.items.find((i) => i.title === "Sort children…")!.icon).toBe(ATLAS_SORT_AZ_ICON_ID);
	});

	it("its chooser lists exactly Manual, A-Z, Modified, Time added, then Reverse order", () => {
		const chooser = openChooser(build("showUnitMenu", unitNode()).menu);
		expect(chooser.titles()).toEqual(["Manual", "A-Z", "Modified", "Time added", "Reverse order"]);
	});

	it("ticks the node's current sortMode, defaulting to Manual when unset", () => {
		const unset = openChooser(build("showUnitMenu", unitNode()).menu);
		expect(unset.items.find((i) => i.title === "Manual")!.checked).toBe(true);

		const alpha = openChooser(build("showUnitMenu", unitNode({ sortMode: "alphabetical" })).menu);
		expect(alpha.items.find((i) => i.title === "A-Z")!.checked).toBe(true);
		expect(alpha.items.find((i) => i.title === "Manual")!.checked).toBe(false);
	});

	it("Reverse order is disabled under Manual, and enabled (ticked per sortReverse) otherwise (G11/F8)", () => {
		const manual = openChooser(build("showUnitMenu", unitNode()).menu);
		const manualReverse = manual.items.find((i) => i.title === "Reverse order")!;
		expect(manualReverse.disabled).toBe(true);
		expect(manualReverse.checked).toBe(false);

		const modifiedOn = openChooser(build("showUnitMenu", unitNode({ sortMode: "modified", sortReverse: true })).menu);
		const modifiedReverse = modifiedOn.items.find((i) => i.title === "Reverse order")!;
		expect(modifiedReverse.disabled).toBe(false);
		expect(modifiedReverse.checked).toBe(true);
	});

	it("picking a mode writes sortMode and resets sortReverse to off (G19)", () => {
		const node = unitNode({ sortMode: "modified", sortReverse: true });
		const { menu, fake } = build("showUnitMenu", node);
		const chooser = openChooser(menu);
		chooser.items.find((i) => i.title === "A-Z")!.clickHandler!();
		expect(fake.plugin.viewsManager.updateStatusGovernance).toHaveBeenCalledWith("v1", "u", { sortMode: "alphabetical", sortReverse: false });
	});

	it("clicking Reverse order only flips sortReverse, never the mode", () => {
		const node = unitNode({ sortMode: "modified", sortReverse: false });
		const { menu, fake } = build("showUnitMenu", node);
		const chooser = openChooser(menu);
		chooser.items.find((i) => i.title === "Reverse order")!.clickHandler!();
		expect(fake.plugin.viewsManager.updateStatusGovernance).toHaveBeenCalledWith("v1", "u", { sortReverse: true });
	});

	it("a Folder row writes through the same mechanism, keyed by the Folder's own node id", () => {
		const node = metaNode({ id: "f1" });
		const { menu, fake } = build("showMetaFolderMenu", node);
		const chooser = openChooser(menu);
		chooser.items.find((i) => i.title === "Modified")!.clickHandler!();
		expect(fake.plugin.viewsManager.updateStatusGovernance).toHaveBeenCalledWith("v1", "f1", { sortMode: "modified", sortReverse: false });
	});

	it("the Bucket header writes through the view itself (nodeId: null), per G7", () => {
		const { menu, fake } = build("showBucketHeaderMenu");
		const chooser = openChooser(menu);
		chooser.items.find((i) => i.title === "Time added")!.clickHandler!();
		expect(fake.plugin.viewsManager.updateStatusGovernance).toHaveBeenCalledWith("v1", null, { sortMode: "time-added", sortReverse: false });
	});

	it("F1: picking any sort mode or toggling Reverse never writes, renames or deletes a vault file — only data.json (via updateStatusGovernance) changes", () => {
		const node = unitNode({ sortMode: "modified", sortReverse: true });
		const { menu, fake } = build("showUnitMenu", node);

		const chooser1 = openChooser(menu);
		chooser1.items.find((i) => i.title === "A-Z")!.clickHandler!();
		const chooser2 = openChooser(menu);
		chooser2.items.find((i) => i.title === "Reverse order")!.clickHandler!();
		const chooser3 = openChooser(menu);
		chooser3.items.find((i) => i.title === "Manual")!.clickHandler!();

		expect(fake.plugin.viewsManager.updateStatusGovernance).toHaveBeenCalledTimes(3);
		expectNoVaultWrite(fake);
	});

	it("F1: the same holds for a Folder row and the Bucket header", () => {
		const metaFake = build("showMetaFolderMenu", metaNode({ id: "f1" }));
		openChooser(metaFake.menu)
			.items.find((i) => i.title === "Modified")!
			.clickHandler!();
		expectNoVaultWrite(metaFake.fake);

		const bucketFake = build("showBucketHeaderMenu");
		openChooser(bucketFake.menu)
			.items.find((i) => i.title === "Time added")!
			.clickHandler!();
		expectNoVaultWrite(bucketFake.fake);
	});

	// PR-2 (G12/G19/E5/F4): the "Status" item — present only on a governing row (or the Bucket
	// root of a governing view), labeled "(inherited)" when the governor is an ancestor rather
	// than this row itself, and ticked whenever `activeSortFor` resolves to "status".
	describe("PR-2 G12/G19/E5/F4 — Status in the Sort children… menu", () => {
		it("is absent from the menu on a row that does not govern a status set and has no inherited status sort", () => {
			const chooser = openChooser(build("showUnitMenu", unitNode()).menu);
			expect(chooser.titles()).not.toContain("Status");
			expect(chooser.titles()).not.toContain("Status (inherited)");
		});

		it('labels it plain "Status" (not inherited) when this row is itself the governor', () => {
			const node = metaNode({ id: "f1", statusEnabled: true, statusSetId: "S" });
			const governor: StatusGovernance = { statusEnabled: true, statusSetId: "S" };
			const chooser = openChooser(build("showMetaFolderMenu", node, undefined, governor).menu);
			expect(chooser.titles()).toContain("Status");
			expect(chooser.titles()).not.toContain("Status (inherited)");
		});

		it('labels it "Status (inherited)" when the governor is an ancestor, not this row itself (E5)', () => {
			const node = metaNode({ id: "f1" }); // no statusEnabled/statusSetId of its own
			const governor: StatusGovernance = { statusEnabled: true, statusSetId: "S" }; // an ancestor's
			const chooser = openChooser(build("showMetaFolderMenu", node, undefined, governor).menu);
			expect(chooser.titles()).toContain("Status (inherited)");
			expect(chooser.titles()).not.toContain("Status");
		});

		it('ticks Status when this row\'s own setting is explicitly "status"', () => {
			const node = metaNode({ id: "f1", statusEnabled: true, statusSetId: "S", sortMode: "status" });
			const governor: StatusGovernance = { statusEnabled: true, statusSetId: "S", sortMode: "status" };
			const chooser = openChooser(build("showMetaFolderMenu", node, undefined, governor).menu);
			expect(chooser.items.find((i) => i.title === "Status")!.checked).toBe(true);
		});

		it("E5: ticks Status (inherited) when this row has no setting of its own, following an inherited status sort", () => {
			const node = metaNode({ id: "f1" }); // absent own sortMode
			const governor: StatusGovernance = { statusEnabled: true, statusSetId: "S", sortMode: "status" };
			const chooser = openChooser(build("showMetaFolderMenu", node, undefined, governor).menu);
			expect(chooser.items.find((i) => i.title === "Status (inherited)")!.checked).toBe(true);
			// R1: the effective sort here is Status (inherited), not Manual — Manual must not also
			// be ticked, which would claim two contradictory sorts are both active.
			expect(chooser.items.find((i) => i.title === "Manual")!.checked).toBe(false);
		});

		it("does not tick Status (inherited) when this row's own setting explicitly overrides the inherited status sort with another mode", () => {
			const node = metaNode({ id: "f1", sortMode: "alphabetical" });
			const governor: StatusGovernance = { statusEnabled: true, statusSetId: "S", sortMode: "status" };
			const chooser = openChooser(build("showMetaFolderMenu", node, undefined, governor).menu);
			expect(chooser.items.find((i) => i.title === "Status (inherited)")!.checked).toBe(false);
			expect(chooser.items.find((i) => i.title === "A-Z")!.checked).toBe(true);
		});

		it("E5: choosing Manual on a row currently following an inherited status sort stores an explicit Manual", () => {
			const node = metaNode({ id: "f1" });
			const governor: StatusGovernance = { statusEnabled: true, statusSetId: "S", sortMode: "status" };
			const { menu, fake } = build("showMetaFolderMenu", node, undefined, governor);
			const chooser = openChooser(menu);
			chooser.items.find((i) => i.title === "Manual")!.clickHandler!();
			expect(fake.plugin.viewsManager.updateStatusGovernance).toHaveBeenCalledWith("v1", "f1", { sortMode: "manual", sortReverse: false });
		});

		it('clicking Status stores an explicit sortMode: "status" with sortReverse reset off', () => {
			const node = metaNode({ id: "f1", sortMode: "modified", sortReverse: true });
			const governor: StatusGovernance = { statusEnabled: true, statusSetId: "S" };
			const { menu, fake } = build("showMetaFolderMenu", node, undefined, governor);
			const chooser = openChooser(menu);
			chooser.items.find((i) => i.title === "Status (inherited)")!.clickHandler!();
			expect(fake.plugin.viewsManager.updateStatusGovernance).toHaveBeenCalledWith("v1", "f1", { sortMode: "status", sortReverse: false });
		});

		it("the Bucket root offers Status (plain, not inherited) when the view itself governs a status set", () => {
			const governingView: View = { id: "v2", name: "Governed", inboxMode: "view", root: [], statusEnabled: true, statusSetId: "S" };
			const fake = sortFake({ statusEnabled: true, statusSetId: "S" });
			let built: Menu | undefined;
			const show = vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
				built = this;
			});
			(AtlasExplorerView.prototype as unknown as { showBucketHeaderMenu: (...a: unknown[]) => void }).showBucketHeaderMenu.call(fake, new MouseEvent("contextmenu"), governingView);
			show.mockRestore();
			const chooser = openChooser(built!);
			expect(chooser.titles()).toContain("Status");
			expect(chooser.titles()).not.toContain("Status (inherited)");
		});
	});
});
