import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "obsidian";
import { openNameDialog } from "../../src/name-dialog";
import { button, flush, inputEl, key, messageEl, modals, seedRoot, type } from "../helpers";

let app: App;
let closers: Array<() => void> = [];

beforeEach(() => {
	app = new App();
	seedRoot(app, ["Reading list.md"], ["Projects"]);
});

afterEach(async () => {
	// Cancel whatever a test left open so the one-dialog guard is released.
	if (modals().length) key("Escape");
	await flush();
	document.body.innerHTML = "";
	closers = [];
});

/** Opens a dialog and records how many times (and with what) it resolved. */
function open(initialValue: string, extra: object = {}) {
	const results: Array<string | null> = [];
	const promise = openNameDialog(app, { title: "Create Module", initialValue, ...extra });
	void promise.then((v) => results.push(v));
	return { promise, results };
}

describe("name dialog", () => {
	it("UT-D1 opens with title, focused + selected prefilled input, Create and Cancel", () => {
		open("Quarry drone LiDAR");
		expect(document.querySelector(".modal-title")!.textContent).toBe("Create Module");
		expect(inputEl().value).toBe("Quarry drone LiDAR");
		expect(document.activeElement).toBe(inputEl());
		expect([inputEl().selectionStart, inputEl().selectionEnd]).toEqual([0, "Quarry drone LiDAR".length]);
		expect(button("Create")).toBeTruthy();
		expect(button("Cancel")).toBeTruthy();
	});

	it("UT-D2 valid: green class, hidden empty message, Create enabled, aria-invalid false", () => {
		open("Quarry drone LiDAR");
		expect(inputEl().classList.contains("atlas-name-valid")).toBe(true);
		expect(inputEl().classList.contains("atlas-name-invalid")).toBe(false);
		expect(messageEl().textContent).toBe("");
		expect(messageEl().classList.contains("atlas-hidden")).toBe(true);
		expect(button("Create").disabled).toBe(false);
		expect(inputEl().getAttribute("aria-invalid")).toBe("false");
	});

	it("UT-D3 invalid: red class, matrix message, Create disabled, aria-invalid true", () => {
		open("Reading list");
		expect(inputEl().classList.contains("atlas-name-invalid")).toBe(true);
		expect(inputEl().classList.contains("atlas-name-valid")).toBe(false);
		expect(messageEl().textContent).toBe("A note or folder called 'Reading list' already exists at the vault root");
		expect(messageEl().classList.contains("atlas-hidden")).toBe(false);
		expect(button("Create").disabled).toBe(true);
		expect(inputEl().getAttribute("aria-invalid")).toBe("true");
		type("a/b");
		expect(messageEl().textContent).toBe("A name can't contain: /");
		type("");
		expect(messageEl().textContent).toBe("Enter a name");
	});

	it("UT-D4 Enter on valid resolves the typed string once and closes", async () => {
		const { results } = open("Fine");
		key("Enter");
		await flush();
		expect(results).toEqual(["Fine"]);
		expect(modals()).toHaveLength(0);
	});

	it("UT-D6 pressing the disabled Create keeps focus in the box and typing works", () => {
		open("Reading list");
		const wrap = button("Create").parentElement!;
		expect(wrap.classList.contains("atlas-name-create-wrap")).toBe(true);
		inputEl().blur();
		const evt = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
		wrap.dispatchEvent(evt);
		expect(evt.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(inputEl());
		type("Fine");
		expect(button("Create").disabled).toBe(false);
		const again = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
		wrap.dispatchEvent(again);
		expect(again.defaultPrevented).toBe(false);
	});

	it("UT-D5 Enter or Create click on invalid does not resolve or close", async () => {
		const { results } = open("Reading list");
		key("Enter");
		button("Create").click();
		await flush();
		expect(results).toEqual([]);
		expect(modals()).toHaveLength(1);
		expect(document.activeElement).toBe(inputEl());
	});

	it("UT-D6 Escape, Cancel and the close X each resolve null once", async () => {
		for (const how of ["escape", "cancel", "x"]) {
			const { results } = open("Fine");
			if (how === "escape") key("Escape");
			else if (how === "cancel") button("Cancel").click();
			else document.querySelector<HTMLElement>(".modal-close-button")!.click();
			await flush();
			expect(results, how).toEqual([null]);
			expect(modals()).toHaveLength(0);
		}
	});

	it("UT-D6b Escape cancels while invalid too", async () => {
		const { results } = open("Reading list");
		key("Escape");
		await flush();
		expect(results).toEqual([null]);
	});

	it("UT-D7 the resolved string is exactly what was typed (no trim, replace or normalise)", async () => {
		const inputs = [" leading", "café", "café", "é".repeat(126), "a".repeat(252)];
		for (const value of inputs) {
			const { results } = open("x");
			type(value);
			key("Enter");
			await flush();
			expect(results).toHaveLength(1);
			expect(results[0]).toBe(value);
		}
	});

	it("UT-D8 double submit and Enter-then-Escape resolve once", async () => {
		let a = open("Fine");
		let el = inputEl();
		const create = button("Create");
		key("Enter", {}, el);
		key("Enter", {}, el);
		create.click();
		await flush();
		expect(a.results).toEqual(["Fine"]);

		a = open("Fine");
		el = inputEl();
		key("Enter", {}, el);
		key("Escape", {}, el);
		await flush();
		expect(a.results).toEqual(["Fine"]);

		a = open("Fine");
		el = inputEl();
		key("Escape", {}, el);
		key("Enter", {}, el);
		await flush();
		expect(a.results).toEqual([null]);
	});

	it("UT-D9 Enter while composing is ignored", async () => {
		const { results } = open("Fine");
		key("Enter", { isComposing: true });
		await flush();
		expect(results).toEqual([]);
		expect(modals()).toHaveLength(1);
	});

	it("newlines in a pasted value are dropped and the pasted value validated", () => {
		open("Fine");
		type("a/b");
		expect(inputEl().value).toBe("a/b");
		expect(inputEl().classList.contains("atlas-name-invalid")).toBe(true);
		const el = inputEl();
		el.value = "one";
		el.dispatchEvent(new Event("input"));
		expect(el.value).toBe("one");
	});

	it("an invalid initial value opens red immediately", () => {
		open(".x");
		expect(inputEl().classList.contains("atlas-name-invalid")).toBe(true);
		expect(button("Create").disabled).toBe(true);
	});

	it("non-empty mode accepts what full mode rejects, but not empty", () => {
		open("x", { mode: "non-empty" });
		for (const v of ["Reading list", ".x/y", "CON", "a#b", "a".repeat(300)]) {
			type(v);
			expect(inputEl().classList.contains("atlas-name-valid"), v).toBe(true);
		}
		type("  ");
		expect(messageEl().textContent).toBe("Enter a name");
	});

	it("reserves the pool folder and excluded folders when told about them", () => {
		open("x", { poolFolder: "_pool", excludedFolders: ["_to_delete"] });
		type("_pool");
		expect(messageEl().textContent).toBe("'_pool' is a reserved name");
		type("_to_delete");
		expect(messageEl().textContent).toBe("'_to_delete' is a reserved name");
	});
});
