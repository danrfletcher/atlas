import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "obsidian";
import { closeNameDialog, openNameDialog } from "../../src/name-dialog";
import { button, flush, inputEl, key, messageEl, modals, seedRoot, type } from "../helpers";

let app: App;

beforeEach(() => {
	app = new App();
});

afterEach(async () => {
	closeNameDialog();
	await flush();
	document.body.innerHTML = "";
});

const CLASH = (n: string) => `A note or folder called '${n}' already exists at the vault root`;
const isGreen = () => inputEl().classList.contains("atlas-name-valid");
const isRed = () => inputEl().classList.contains("atlas-name-invalid");

describe("name dialog over a vault", () => {
	it("IT-D1 clash opens red; typing a free name turns it green; Create resolves it", async () => {
		seedRoot(app, ["Reading list.md"]);
		const result = openNameDialog(app, { title: "Rename", initialValue: "Reading list" });
		expect(isRed()).toBe(true);
		expect(messageEl().textContent).toBe(CLASH("Reading list"));
		expect(button("Create").disabled).toBe(true);
		type("reading LIST");
		expect(messageEl().textContent).toBe(CLASH("reading LIST"));
		type("Reading list 2");
		expect(isGreen()).toBe(true);
		expect(messageEl().textContent).toBe("");
		expect(button("Create").disabled).toBe(false);
		button("Create").click();
		expect(await result).toBe("Reading list 2");
	});

	it("IT-D2 a note created while the dialog is open refuses submit and turns red", async () => {
		let resolved = false;
		const result = openNameDialog(app, { title: "Create", initialValue: "Zed" });
		void result.then(() => (resolved = true));
		expect(isGreen()).toBe(true);
		await app.vault.create("Zed.md", "");
		expect(isGreen()).toBe(true); // no input event yet
		button("Create").click();
		await flush();
		expect(resolved).toBe(false);
		expect(isRed()).toBe(true);
		expect(messageEl().textContent).toBe(CLASH("Zed"));
		key("Escape");
		expect(await result).toBeNull();
	});

	it("IT-D2b deleting the clashing note then typing re-validates green", async () => {
		seedRoot(app, ["Alpha.md"]);
		openNameDialog(app, { title: "Create", initialValue: "Alpha" });
		expect(isRed()).toBe(true);
		await app.vault.delete(app.vault.getAbstractFileByPath("Alpha.md")!);
		type("Alpha");
		expect(isGreen()).toBe(true);
	});

	it("IT-D3 ignoreRootPaths exempts only that file, never a folder of the same name", () => {
		seedRoot(app, ["Alpha.md"]);
		openNameDialog(app, { title: "Create Module", initialValue: "Alpha", ignoreRootPaths: ["Alpha.md"] });
		expect(isGreen()).toBe(true);
		expect(button("Create").disabled).toBe(false);
		app.vault.seedFolder("Alpha");
		type("Alpha");
		expect(isRed()).toBe(true);
	});

	it("IT-D3b non-empty mode ignores the root entirely", () => {
		seedRoot(app, ["Reading list.md"]);
		openNameDialog(app, { title: "Create Block", initialValue: "Reading list", mode: "non-empty" });
		expect(isGreen()).toBe(true);
	});

	it("IT-D4 a second call while one is open resolves null at once; the first is unchanged", async () => {
		const first = openNameDialog(app, { title: "One", initialValue: "First" });
		type("First edited");
		const second = await openNameDialog(app, { title: "Two", initialValue: "Second" });
		expect(second).toBeNull();
		expect(modals()).toHaveLength(1);
		expect(inputEl().value).toBe("First edited");
		expect(document.querySelector(".modal-title")!.textContent).toBe("One");
		key("Enter");
		expect(await first).toBe("First edited");
	});

	it("IT-D4b the guard is released after resolve, cancel and forced close", async () => {
		const settle = async (how: "enter" | "cancel" | "forced") => {
			const p = openNameDialog(app, { title: "T", initialValue: "Free" });
			if (how === "enter") key("Enter");
			else if (how === "cancel") button("Cancel").click();
			else closeNameDialog();
			return p;
		};
		expect(await settle("enter")).toBe("Free");
		expect(await settle("cancel")).toBeNull();
		expect(await settle("forced")).toBeNull();
		const again = openNameDialog(app, { title: "T", initialValue: "Free" });
		expect(modals()).toHaveLength(1);
		key("Enter");
		expect(await again).toBe("Free");
	});

	it("the guard is not left stuck when the caller's continuation throws", async () => {
		const p = openNameDialog(app, { title: "T", initialValue: "Free" }).then(() => {
			throw new Error("caller bug");
		});
		key("Enter");
		await expect(p).rejects.toThrow("caller bug");
		const again = openNameDialog(app, { title: "T", initialValue: "Free" });
		expect(modals()).toHaveLength(1);
		key("Escape");
		expect(await again).toBeNull();
	});
});
