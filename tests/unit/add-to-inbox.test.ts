import { afterEach, describe, expect, it, vi } from "vitest";
import { App, TFile } from "obsidian";
import { AddFileSuggestModal, AtlasExplorerView, candidateFilesForAdd } from "../../src/explorer-view";
import type { Unit, UnitRef } from "../../src/types";
import { seedRoot } from "../helpers";

const file = (path: string): UnitRef => ({ kind: "file", path });

function filesOf(app: App, paths: string[]): TFile[] {
	return paths.map((p) => app.vault.getAbstractFileByPath(p) as TFile);
}

// --- candidateFilesForAdd: G2 exclusion rules, F3 eligibility-blindness -----------------------------

describe("candidateFilesForAdd (G2, E4, F3)", () => {
	it("returns every vault file when nothing is a unit or placed anywhere", () => {
		const app = new App();
		seedRoot(app, ["A.md", "B.md"]);
		const result = candidateFilesForAdd(app.vault.getFiles(), [], () => false);
		expect(result.map((f) => f.path).sort()).toEqual(["A.md", "B.md"]);
	});

	it("G2/E4: excludes a file already present as an auto-promoted unit", () => {
		const app = new App();
		seedRoot(app, ["ModuleA/Promoted.md", "Other.md"], ["ModuleA"]);
		const units: Unit[] = [{ type: "promoted-file", path: "ModuleA/Promoted.md", topLevelFolder: "ModuleA" }];
		const result = candidateFilesForAdd(app.vault.getFiles(), units, () => false);
		expect(result.map((f) => f.path).sort()).toEqual(["Other.md"]);
	});

	it("G2/E4: excludes a file already present as a manually promoted unit", () => {
		const app = new App();
		seedRoot(app, ["ModuleA/Manual.md", "Other.md"], ["ModuleA"]);
		// Manual promotions are folded into the same promoted-file classification by the index —
		// candidateFilesForAdd only ever sees the resulting Unit, never the manualPromotions list itself.
		const units: Unit[] = [{ type: "promoted-file", path: "ModuleA/Manual.md", topLevelFolder: "ModuleA" }];
		const result = candidateFilesForAdd(app.vault.getFiles(), units, () => false);
		expect(result.map((f) => f.path).sort()).toEqual(["Other.md"]);
	});

	it("G2/E4: excludes a file already present as a manually-added unit (prevents double-adding)", () => {
		const app = new App();
		seedRoot(app, ["Areas/Added.md", "Other.md"], ["Areas"]);
		const units: Unit[] = [{ type: "added-file", path: "Areas/Added.md" }];
		const result = candidateFilesForAdd(app.vault.getFiles(), units, () => false);
		expect(result.map((f) => f.path).sort()).toEqual(["Other.md"]);
	});

	it("G2: excludes a file already placed/nested as a node in any view, even though it is not classified as any Unit", () => {
		const app = new App();
		seedRoot(app, ["Areas/Placed.md", "Areas/Eligible.md"], ["Areas"]);
		const isPlacedAnywhere = (ref: UnitRef) => ref.path === "Areas/Placed.md";
		const result = candidateFilesForAdd(app.vault.getFiles(), [], isPlacedAnywhere);
		expect(result.map((f) => f.path).sort()).toEqual(["Areas/Eligible.md"]);
	});

	it("F3: a file that fails the auto-promotion eligibility rule (no outside-module references, so never auto-promoted) is still a candidate — no eligibility check is invoked here", () => {
		const app = new App();
		seedRoot(app, ["ModuleA/NeverReferenced.md"], ["ModuleA"]);
		// units=[] simulates exactly this: the file was never auto-promoted (fails the parent ticket's
		// "references outside the module" rule) and was never manually promoted/added either.
		const result = candidateFilesForAdd(app.vault.getFiles(), [], () => false);
		expect(result.map((f) => f.path)).toEqual(["ModuleA/NeverReferenced.md"]);
	});

	it("combines all four exclusion states at once against a mixed fixture (integration-shaped)", () => {
		const app = new App();
		seedRoot(
			app,
			["ModuleA/AutoPromoted.md", "ModuleA/ManualPromoted.md", "ModuleA/Added.md", "ModuleA/Placed.md", "ModuleA/Eligible.md"],
			["ModuleA"],
		);
		const units: Unit[] = [
			{ type: "promoted-file", path: "ModuleA/AutoPromoted.md", topLevelFolder: "ModuleA" },
			{ type: "promoted-file", path: "ModuleA/ManualPromoted.md", topLevelFolder: "ModuleA" },
			{ type: "added-file", path: "ModuleA/Added.md" },
		];
		const isPlacedAnywhere = (ref: UnitRef) => ref.path === "ModuleA/Placed.md";
		const result = candidateFilesForAdd(app.vault.getFiles(), units, isPlacedAnywhere);
		expect(result.map((f) => f.path)).toEqual(["ModuleA/Eligible.md"]);
	});

	it("opening with zero eligible files returns an empty list without throwing", () => {
		const app = new App();
		seedRoot(app, ["Only.md"]);
		const units: Unit[] = [{ type: "added-file", path: "Only.md" }];
		expect(() => candidateFilesForAdd(app.vault.getFiles(), units, () => false)).not.toThrow();
		expect(candidateFilesForAdd(app.vault.getFiles(), units, () => false)).toEqual([]);
	});
});

// --- AddFileSuggestModal: thin FuzzySuggestModal subclass, mirrors ViewSuggestModal ----------------

describe("AddFileSuggestModal (G2 structural, G3 wiring)", () => {
	it("getItems/getItemText/onChooseItem pass through unmodified — real fuzzy matching is inherited from FuzzySuggestModal, never reimplemented here", () => {
		const app = new App();
		seedRoot(app, ["A.md", "B.md"]);
		const files = filesOf(app, ["A.md", "B.md"]);
		const onChoose = vi.fn();
		const modal = new AddFileSuggestModal(app, files, onChoose);
		expect(modal.getItems()).toBe(files);
		expect(modal.getItemText(files[0])).toBe("A.md");
		modal.onChooseItem(files[1]);
		expect(onChoose).toHaveBeenCalledWith(files[1]);
	});
});

// --- AtlasExplorerView.openAddFileModal: full add-flow wiring (G2, G3, GP3) -------------------------

type FakeThis = {
	plugin: {
		app: { vault: { getFiles: () => TFile[] } };
		unitIndex: { getUnits: () => Unit[]; markAdded: ReturnType<typeof vi.fn> };
		viewsManager: { isPlacedAnywhere: (ref: UnitRef) => boolean };
		flushSave: ReturnType<typeof vi.fn>;
	};
	render: ReturnType<typeof vi.fn>;
};

function callOpenAddFileModal(fake: FakeThis): void {
	(AtlasExplorerView.prototype as unknown as { openAddFileModal: (this: FakeThis) => void }).openAddFileModal.call(fake);
}

function fakeFor(units: Unit[], files: TFile[], isPlacedAnywhere: (ref: UnitRef) => boolean = () => false): FakeThis {
	return {
		plugin: {
			app: { vault: { getFiles: () => files } },
			unitIndex: { getUnits: () => units, markAdded: vi.fn() },
			viewsManager: { isPlacedAnywhere },
			flushSave: vi.fn(async () => {}),
		},
		render: vi.fn(async () => {}),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	document.body.innerHTML = "";
});

describe("AtlasExplorerView.openAddFileModal (G2, G3, E4, GP3)", () => {
	it("opens exactly one AddFileSuggestModal whose candidate list is the correctly-filtered set end to end", () => {
		const app = new App();
		seedRoot(app, ["ModuleA/Promoted.md", "ModuleA/Placed.md", "Areas/Career/Notes.md"], ["ModuleA", "Areas", "Areas/Career"]);
		const files = app.vault.getFiles();
		const units: Unit[] = [{ type: "promoted-file", path: "ModuleA/Promoted.md", topLevelFolder: "ModuleA" }];
		const fake = fakeFor(units, files, (ref) => ref.path === "ModuleA/Placed.md");

		let built: AddFileSuggestModal | undefined;
		vi.spyOn(AddFileSuggestModal.prototype, "open").mockImplementation(function (this: AddFileSuggestModal) {
			built = this;
		});

		callOpenAddFileModal(fake);

		expect(built).toBeDefined();
		expect(built!.getItems().map((f) => f.path)).toEqual(["Areas/Career/Notes.md"]);
	});

	it("GP3/G3: selecting a candidate marks it added, flushes the save, and re-renders — not the 'promoted' path", async () => {
		const app = new App();
		seedRoot(app, ["Areas/Career/Notes.md"], ["Areas", "Areas/Career"]);
		const files = app.vault.getFiles();
		const fake = fakeFor([], files);

		let built: AddFileSuggestModal | undefined;
		vi.spyOn(AddFileSuggestModal.prototype, "open").mockImplementation(function (this: AddFileSuggestModal) {
			built = this;
		});

		callOpenAddFileModal(fake);
		built!.onChooseItem(files[0]);
		await Promise.resolve();

		expect(fake.plugin.unitIndex.markAdded).toHaveBeenCalledWith(file("Areas/Career/Notes.md"));
		expect(fake.plugin.unitIndex.markAdded).toHaveBeenCalledTimes(1);
		expect(fake.plugin.flushSave).toHaveBeenCalledTimes(1);
		expect(fake.render).toHaveBeenCalledTimes(1);
	});

	it("E4/edge: opening when every file is already excluded shows an empty candidate list without throwing", () => {
		const app = new App();
		seedRoot(app, ["Only.md"]);
		const units: Unit[] = [{ type: "added-file", path: "Only.md" }];
		const fake = fakeFor(units, app.vault.getFiles());

		let built: AddFileSuggestModal | undefined;
		vi.spyOn(AddFileSuggestModal.prototype, "open").mockImplementation(function (this: AddFileSuggestModal) {
			built = this;
		});

		expect(() => callOpenAddFileModal(fake)).not.toThrow();
		expect(built!.getItems()).toEqual([]);
	});

	it("edge: dismissing the modal without selecting anything never calls markAdded/flushSave/render (inbox unchanged)", () => {
		const app = new App();
		seedRoot(app, ["A.md"]);
		const fake = fakeFor([], app.vault.getFiles());

		vi.spyOn(AddFileSuggestModal.prototype, "open").mockImplementation(() => {});

		callOpenAddFileModal(fake);

		expect(fake.plugin.unitIndex.markAdded).not.toHaveBeenCalled();
		expect(fake.plugin.flushSave).not.toHaveBeenCalled();
		expect(fake.render).not.toHaveBeenCalled();
	});
});

// --- renderInboxRow: "added" badge rendering (G3), distinct from and mutually exclusive with
// the "promoted" badge (regression) ------------------------------------------------------------------

interface FakeRowInfo {
	text: string;
	icon: string;
	promoted: boolean;
	added: boolean;
	missing: boolean;
	secondary?: string;
}

function callRenderInboxRow(container: HTMLElement, ref: UnitRef, info: FakeRowInfo): HTMLElement {
	const fake = {
		selectedInboxRefKeys: new Set<string>(),
		setPlacementTooltip: vi.fn(),
	};
	return (
		AtlasExplorerView.prototype as unknown as {
			renderInboxRow: (this: typeof fake, container: HTMLElement, ref: UnitRef, info: FakeRowInfo) => HTMLElement;
		}
	).renderInboxRow.call(fake, container, ref, info);
}

describe("renderInboxRow — added badge (G3)", () => {
	it("renders an 'added' badge (atlas-badge class, 'added' text) when info.added is true, and no 'promoted' badge", () => {
		const container = document.createElement("div");
		const row = callRenderInboxRow(container, file("Areas/Career/Notes.md"), {
			text: "Notes",
			icon: "file",
			promoted: false,
			added: true,
			missing: false,
		});
		const badges = Array.from(row.querySelectorAll(".atlas-badge")).map((b) => b.textContent);
		expect(badges).toEqual(["added"]);
	});

	it("regression: still renders a 'promoted' badge (not 'added') when info.promoted is true and info.added is false", () => {
		const container = document.createElement("div");
		const row = callRenderInboxRow(container, file("ModuleA/Promoted.md"), {
			text: "Promoted",
			icon: "file",
			promoted: true,
			added: false,
			missing: false,
		});
		const badges = Array.from(row.querySelectorAll(".atlas-badge")).map((b) => b.textContent);
		expect(badges).toEqual(["promoted"]);
	});

	it("renders neither badge for a plain inbox unit (neither promoted nor added)", () => {
		const container = document.createElement("div");
		const row = callRenderInboxRow(container, file("Root.md"), {
			text: "Root",
			icon: "file",
			promoted: false,
			added: false,
			missing: false,
		});
		expect(row.querySelectorAll(".atlas-badge").length).toBe(0);
	});
});
