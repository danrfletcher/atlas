import { afterEach, describe, expect, it, vi } from "vitest";
import { App, Menu } from "obsidian";
import { AtlasExplorerView } from "../../src/explorer-view";
import type { Unit, UnitRef, View } from "../../src/types";
import { createEmptyView } from "../../src/types";
import { seedRoot } from "../helpers";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
import { ViewsManager } from "../../src/views";

const file = (path: string): UnitRef => ({ kind: "file", path });

afterEach(() => {
	vi.restoreAllMocks();
	document.body.innerHTML = "";
});

// --- showInboxUnitMenu: "Dismiss" item registration and click wiring (G4-G6, F1) -------------------

type FakeMenuThis = {
	plugin: {
		unitIndex: { setDismissed: ReturnType<typeof vi.fn> };
		flushSave: ReturnType<typeof vi.fn>;
	};
	render: ReturnType<typeof vi.fn>;
};

function fakeMenuThis(): FakeMenuThis {
	return {
		plugin: {
			unitIndex: { setDismissed: vi.fn() },
			flushSave: vi.fn(async () => {}),
		},
		render: vi.fn(async () => {}),
	};
}

function callShowInboxUnitMenu(fake: FakeMenuThis, ref: UnitRef, view: View): Menu {
	let builtMenu: Menu | undefined;
	vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
		builtMenu = this;
	});
	(
		AtlasExplorerView.prototype as unknown as {
			showInboxUnitMenu: (this: FakeMenuThis, evt: MouseEvent, ref: UnitRef, view: View) => void;
		}
	).showInboxUnitMenu.call(fake, new MouseEvent("contextmenu"), ref, view);
	return builtMenu!;
}

/** Same wiring as `callShowInboxUnitMenu`, but against a real `UnitIndex` instead of a mocked
 * `setDismissed` — needed for R2's G6 regression, which has to assert on real `isAdded`/
 * `getAddedItems`/`getManualPromotions` state after the click, not just on call shape. */
function callShowInboxUnitMenuWithRealIndex(index: UnitIndex, ref: UnitRef, view: View): Menu {
	const fake = {
		plugin: { unitIndex: index, flushSave: vi.fn(async () => {}) },
		render: vi.fn(async () => {}),
	};
	let builtMenu: Menu | undefined;
	vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu) {
		builtMenu = this;
	});
	(
		AtlasExplorerView.prototype as unknown as {
			showInboxUnitMenu: (this: typeof fake, evt: MouseEvent, ref: UnitRef, view: View) => void;
		}
	).showInboxUnitMenu.call(fake, new MouseEvent("contextmenu"), ref, view);
	return builtMenu!;
}

describe("showInboxUnitMenu — Dismiss item (G4)", () => {
	it("registers a 'Dismiss' item alongside the existing items, using the same Menu/addItem pattern", () => {
		const fake = fakeMenuThis();
		const menu = callShowInboxUnitMenu(fake, file("Foo.md"), createEmptyView("v1", "Default"));
		expect(menu.titles()).toEqual(["Open", "Open in new tab", "Reveal in native explorer", "Copy link", "Place in view…", "Dismiss"]);
	});

	it("F1: exactly one removal-type item ('Dismiss') exists — never a second 'remove'/'un-add' item", () => {
		const fake = fakeMenuThis();
		const menu = callShowInboxUnitMenu(fake, file("Foo.md"), createEmptyView("v1", "Default"));
		const removalLike = menu.titles().filter((t) => /dismiss|remove|un-?add/i.test(t));
		expect(removalLike).toEqual(["Dismiss"]);
	});

	it("clicking Dismiss outside Global view calls the per-view write with the current view's id and the ref, and never the global write", () => {
		const fake = fakeMenuThis();
		const view = createEmptyView("v1", "Default"); // inboxMode defaults to "view"
		const ref = file("Foo.md");
		const menu = callShowInboxUnitMenu(fake, ref, view);

		const dismissItem = menu.items.find((i) => i.title === "Dismiss")!;
		dismissItem.clickHandler!();

		expect(fake.plugin.unitIndex.setDismissed).toHaveBeenCalledTimes(1);
		expect(fake.plugin.unitIndex.setDismissed).toHaveBeenCalledWith(ref, "view", true, "v1");
		expect(fake.plugin.flushSave).toHaveBeenCalledTimes(1);
		expect(fake.render).toHaveBeenCalledTimes(1);
	});

	it("G5: clicking Dismiss while in Global view calls the global write exactly once, and never the per-view write", () => {
		const fake = fakeMenuThis();
		const view: View = { ...createEmptyView("v1", "Default"), inboxMode: "global" };
		const ref = file("Foo.md");
		const menu = callShowInboxUnitMenu(fake, ref, view);

		const dismissItem = menu.items.find((i) => i.title === "Dismiss")!;
		dismissItem.clickHandler!();

		expect(fake.plugin.unitIndex.setDismissed).toHaveBeenCalledTimes(1);
		expect(fake.plugin.unitIndex.setDismissed).toHaveBeenCalledWith(ref, "global", true);
	});

	it("G6: dismissing a row flagged as added calls the exact same dismiss write path as a non-added row", () => {
		// The menu/click path makes no distinction based on "added" state at all — it only ever reads
		// `ref`/`view`, never consults `isAdded`. Asserting identical call shape for an added-looking
		// ref is the regression guard that a future change doesn't special-case it.
		const fake = fakeMenuThis();
		const view = createEmptyView("v1", "Default");
		const addedRef = file("Areas/Career/Notes.md");
		const menu = callShowInboxUnitMenu(fake, addedRef, view);

		menu.items.find((i) => i.title === "Dismiss")!.clickHandler!();

		expect(fake.plugin.unitIndex.setDismissed).toHaveBeenCalledWith(addedRef, "view", true, "v1");
		// No "un-add"/clear-added call exists on the fake at all — if the implementation tried to call
		// one, this test would throw rather than silently pass.
	});

	it("R2/G6 (real UnitIndex): dismissing an added + manually-promoted row clears neither marker and removes it from the inbox", () => {
		const app = new App();
		seedRoot(app, ["Foo.md"]);
		const ref = file("Foo.md");
		const index = new UnitIndex(app, DEFAULT_SETTINGS, [ref]); // seeded manual promotion
		index.markAdded(ref);
		const view = createEmptyView("v1", "Default"); // inboxMode defaults to "view"

		const menu = callShowInboxUnitMenuWithRealIndex(index, ref, view);
		menu.items.find((i) => i.title === "Dismiss")!.clickHandler!();

		expect(index.isAdded(ref)).toBe(true);
		expect(index.getAddedItems()).toEqual([{ ref, tag: "added" }]);
		expect(index.getManualPromotions()).toEqual([ref]);

		const views = new ViewsManager(app, [], "v1", () => {});
		expect(views.getInboxUnits(makeUnits(["Foo.md"]), "v1", "view", index)).toEqual([]);
	});

	it("idempotency: invoking the Dismiss click handler twice issues two identical writes, matching UnitIndex.setDismissed's own no-op-on-repeat contract (no throw)", () => {
		const fake = fakeMenuThis();
		const view = createEmptyView("v1", "Default");
		const ref = file("Foo.md");
		const menu = callShowInboxUnitMenu(fake, ref, view);
		const dismissItem = menu.items.find((i) => i.title === "Dismiss")!;

		expect(() => {
			dismissItem.clickHandler!();
			dismissItem.clickHandler!();
		}).not.toThrow();
		expect(fake.plugin.unitIndex.setDismissed).toHaveBeenCalledTimes(2);
		expect(fake.plugin.unitIndex.setDismissed).toHaveBeenNthCalledWith(1, ref, "view", true, "v1");
		expect(fake.plugin.unitIndex.setDismissed).toHaveBeenNthCalledWith(2, ref, "view", true, "v1");
	});

	it("R1: on a real UnitIndex, a repeated per-view and a repeated global dismiss write each leave state unchanged (no duplicate entries)", () => {
		const app = new App();
		seedRoot(app, ["Foo.md"]);
		const index = new UnitIndex(app, DEFAULT_SETTINGS, []);
		const ref = file("Foo.md");

		index.setDismissed(ref, "view", true, "v1");
		index.setDismissed(ref, "view", true, "v1");
		expect(index.getDismissedByView()).toEqual({ v1: [ref] });

		index.setDismissed(ref, "global", true);
		index.setDismissed(ref, "global", true);
		expect(index.getDismissedGlobal()).toEqual([ref]);
	});
});

// --- renderInboxRow: contextmenu always targets this row's own ref, ignoring multi-selection -------

interface FakeRowInfo {
	text: string;
	icon: string;
	promoted: boolean;
	added: boolean;
	missing: boolean;
	secondary?: string;
}

function callRenderInboxRowAndContextmenu(ref: UnitRef, view: View, showInboxUnitMenu: ReturnType<typeof vi.fn>): void {
	const fake = {
		selectedInboxRefKeys: new Set<string>(["file:Other.md", "file:AnotherOther.md"]),
		setPlacementTooltip: vi.fn(),
		showInboxUnitMenu,
	};
	const container = document.createElement("div");
	const info: FakeRowInfo = { text: "Foo", icon: "file", promoted: false, added: false, missing: false };
	const row = (
		AtlasExplorerView.prototype as unknown as {
			renderInboxRow: (this: typeof fake, container: HTMLElement, ref: UnitRef, info: FakeRowInfo, view: View) => HTMLElement;
		}
	).renderInboxRow.call(fake, container, ref, info, view);
	row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
}

describe("renderInboxRow — contextmenu ignores multi-selection (existing showInboxUnitMenu behavior)", () => {
	it("right-clicking one row of a multi-selected set opens the menu for only that row's own ref", () => {
		const showInboxUnitMenu = vi.fn();
		const view = createEmptyView("v1", "Default");
		const ref = file("Clicked.md");

		callRenderInboxRowAndContextmenu(ref, view, showInboxUnitMenu);

		expect(showInboxUnitMenu).toHaveBeenCalledTimes(1);
		expect(showInboxUnitMenu).toHaveBeenCalledWith(expect.anything(), ref, view);
	});
});

// --- getInboxUnits: dismissed-state render-time filter (G4/G5 OR-check) ----------------------------

function makeUnits(paths: string[]): Unit[] {
	return paths.map((path) => ({ type: "root-file", path }) as Unit);
}

describe("ViewsManager.getInboxUnits — dismissed-state OR-check (G4, G5, E7)", () => {
	it("a row whose ref is in the global dismiss set is excluded from every view's inbox, including a view with no per-view entry at all", () => {
		const app = new App();
		seedRoot(app, ["Foo.md"]);
		const index = new UnitIndex(app, DEFAULT_SETTINGS, []);
		index.setDismissed(file("Foo.md"), "global", true);
		const views = new ViewsManager(app, [], "v1", () => {});

		const units = makeUnits(["Foo.md"]);
		expect(views.getInboxUnits(units, "v1", "view", index)).toEqual([]);
		expect(views.getInboxUnits(units, "a-view-never-seen-before", "view", index)).toEqual([]);
		expect(views.getInboxUnits(units, "v1", "global", index)).toEqual([]);
	});

	it("a row dismissed only in one view's per-view map still appears in another view's resolved inbox and in Global's", () => {
		const app = new App();
		seedRoot(app, ["Foo.md"]);
		const index = new UnitIndex(app, DEFAULT_SETTINGS, []);
		index.setDismissed(file("Foo.md"), "view", true, "v1");
		const views = new ViewsManager(app, [], "v1", () => {});

		const units = makeUnits(["Foo.md"]);
		expect(views.getInboxUnits(units, "v1", "view", index)).toEqual([]);
		expect(views.getInboxUnits(units, "v2", "view", index).map((u) => u.path)).toEqual(["Foo.md"]);
		expect(views.getInboxUnits(units, "v1", "global", index).map((u) => u.path)).toEqual(["Foo.md"]);
	});

	it("G4: a non-Global dismiss never writes to the global set, so Global's own inbox is unaffected", () => {
		const app = new App();
		seedRoot(app, ["Foo.md"]);
		const index = new UnitIndex(app, DEFAULT_SETTINGS, []);
		index.setDismissed(file("Foo.md"), "view", true, "v1");
		const views = new ViewsManager(app, [], "v1", () => {});

		expect(index.getDismissedGlobal()).toEqual([]);
		expect(views.getInboxUnits(makeUnits(["Foo.md"]), "v1", "global", index).map((u) => u.path)).toEqual(["Foo.md"]);
	});

	it("E7: a view that exists but was never rendered still has a prior Global dismiss applied once resolved, with no per-view write needed", () => {
		const app = new App();
		seedRoot(app, ["Foo.md"]);
		const index = new UnitIndex(app, DEFAULT_SETTINGS, []);
		index.setDismissed(file("Foo.md"), "global", true);
		const views = new ViewsManager(app, [], "v1", () => {});

		// "never-rendered-view" never got a per-view dismiss entry of its own — the global entry alone
		// must still exclude the row once this view is resolved.
		expect(index.getDismissedByView()).toEqual({});
		expect(views.getInboxUnits(makeUnits(["Foo.md"]), "never-rendered-view", "view", index)).toEqual([]);
	});

	it("without a unitIndex argument, behaves exactly as before (back-compat for existing callers)", () => {
		const app = new App();
		seedRoot(app, ["Foo.md"]);
		const views = new ViewsManager(app, [], "v1", () => {});
		expect(views.getInboxUnits(makeUnits(["Foo.md"]), "v1", "view").map((u) => u.path)).toEqual(["Foo.md"]);
	});
});
