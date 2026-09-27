import { describe, expect, it, vi } from "vitest";

/** T1: the real bug only shows up in Obsidian's actual `ButtonComponent`, whose click listener is
 * bound once at construction and gates on the component's own `disabled` field — not whatever gets
 * poked onto `buttonEl.disabled` afterwards. The "obsidian" package ships types only (no runtime), so
 * no test here can use the real class; instead this mock reproduces that exact gating rule (see
 * `FakeButtonComponent.simulateClick`) so a test can fail against the old bug and pass against the
 * fix without ever touching real DOM/Obsidian internals. */
vi.mock("obsidian", () => {
	function createFakeElement(): any {
		const el: any = {
			children: [] as any[],
			__settings: [] as any[],
			cls: undefined as string | undefined,
			textContent: "",
			empty() {
				this.children = [];
				this.__settings = [];
			},
			createEl(_tag: string, opts?: { text?: string; cls?: string }) {
				const child = createFakeElement();
				if (opts?.text) child.textContent = opts.text;
				if (opts?.cls) child.cls = opts.cls;
				this.children.push(child);
				return child;
			},
			createDiv(opts?: { cls?: string }) {
				return this.createEl("div", opts);
			},
			createSpan(opts?: { cls?: string; text?: string }) {
				return this.createEl("span", opts);
			},
			setText(t: string) {
				this.textContent = t;
			},
			setAttr() {},
			addEventListener() {},
		};
		return el;
	}

	class FakeTextComponent {
		value = "";
		disabled = false;
		private changeCb?: (v: string) => void;
		setPlaceholder() {
			return this;
		}
		setValue(v: string) {
			this.value = v;
			return this;
		}
		setDisabled(d: boolean) {
			this.disabled = d;
			return this;
		}
		onChange(cb: (v: string) => void) {
			this.changeCb = cb;
			return this;
		}
		/** Simulates the user typing a new value into the field. */
		type(v: string) {
			this.value = v;
			this.changeCb?.(v);
		}
	}

	class FakeToggleComponent {
		value = false;
		disabled = false;
		private changeCb?: (v: boolean) => void;
		setValue(v: boolean) {
			this.value = v;
			return this;
		}
		setDisabled(d: boolean) {
			this.disabled = d;
			return this;
		}
		onChange(cb: (v: boolean) => void) {
			this.changeCb = cb;
			return this;
		}
		/** Simulates the user flipping the toggle. */
		flip(v: boolean) {
			this.value = v;
			this.changeCb?.(v);
		}
	}

	class FakeDropdownComponent {
		value = "";
		private changeCb?: (v: string) => void;
		addOption() {
			return this;
		}
		setValue(v: string) {
			this.value = v;
			return this;
		}
		onChange(cb: (v: string) => void) {
			this.changeCb = cb;
			return this;
		}
		/** Simulates the user picking a different option. */
		select(v: string) {
			this.value = v;
			this.changeCb?.(v);
		}
	}

	class FakeButtonComponent {
		buttonEl: any = createFakeElement();
		/** The gate Obsidian's real click listener actually checks. */
		disabled = false;
		private clickCallback?: () => void;
		setButtonText(t: string) {
			this.buttonEl.textContent = t;
			return this;
		}
		setCta() {
			return this;
		}
		setDisabled(d: boolean) {
			this.disabled = d;
			this.buttonEl.disabled = d;
			return this;
		}
		onClick(cb: () => void) {
			this.clickCallback = cb;
			return this;
		}
		/** Mirrors Obsidian's real click handler (`if (this.disabled || !cb) return; cb();`), gated on
		 * the component's own field — never on `buttonEl.disabled` directly. */
		simulateClick() {
			if (this.disabled || !this.clickCallback) return;
			this.clickCallback();
		}
	}

	class FakeExtraButtonComponent {
		setIcon() {
			return this;
		}
		setTooltip() {
			return this;
		}
		onClick() {
			return this;
		}
	}

	class FakeSetting {
		name = "";
		components: unknown[] = [];
		controlEl: any = createFakeElement();
		constructor(public containerEl: any) {
			if (!containerEl.__settings) containerEl.__settings = [];
			containerEl.__settings.push(this);
		}
		setName(n: string) {
			this.name = n;
			return this;
		}
		setDesc() {
			return this;
		}
		setHeading() {
			return this;
		}
		addText(cb: (t: FakeTextComponent) => void) {
			const t = new FakeTextComponent();
			cb(t);
			this.components.push(t);
			return this;
		}
		addToggle(cb: (t: FakeToggleComponent) => void) {
			const t = new FakeToggleComponent();
			cb(t);
			this.components.push(t);
			return this;
		}
		addDropdown(cb: (t: FakeDropdownComponent) => void) {
			const t = new FakeDropdownComponent();
			cb(t);
			this.components.push(t);
			return this;
		}
		addButton(cb: (t: FakeButtonComponent) => void) {
			const t = new FakeButtonComponent();
			cb(t);
			this.components.push(t);
			return this;
		}
		addExtraButton(cb: (t: FakeExtraButtonComponent) => void) {
			const t = new FakeExtraButtonComponent();
			cb(t);
			this.components.push(t);
			return this;
		}
	}

	class FakeModal {
		app: unknown;
		contentEl: any = createFakeElement();
		constructor(app: unknown) {
			this.app = app;
		}
		open() {
			(this as any).onOpen?.();
		}
		close() {
			(this as any).onClose?.();
		}
	}

	class FakeNotice {
		constructor(_message?: string) {}
	}

	return {
		App: class {},
		ButtonComponent: FakeButtonComponent,
		Modal: FakeModal,
		Notice: FakeNotice,
		Platform: { isMobile: false },
		Setting: FakeSetting,
		requestUrl: async () => ({ status: 200, json: {} }),
	};
});

import { ApiSourceModal } from "../../src/api-source-modal";
import { ApiSourceConfig } from "../../src/types";

function settingNamed(modal: unknown, name: string): any {
	const contentEl = (modal as any).contentEl;
	return contentEl.__settings.find((s: any) => s.name === name);
}

function validConfig(): ApiSourceConfig {
	return {
		url: "https://api.example.com/items",
		method: "GET",
		mapping: { idField: "id", labelField: "name" },
		mode: "merge",
		refreshOnViewLoad: false,
	};
}

describe("T1/T3/T5/T7 — ApiSourceModal's Save button after an empty-then-valid 'Refresh every' edit", () => {
	it("stays clickable through the exact repro sequence: enable while blank (forces a re-render with a disabled Save), then type a valid value", () => {
		const onSave = vi.fn();
		const modal = new ApiSourceModal({} as any, validConfig(), [], onSave);
		(modal as any).onOpen();

		// GP5 / T5: mode Overwrite, "refresh on view load" on.
		settingNamed(modal, "Fill mode").components[0].select("overwrite");
		settingNamed(modal, "Refresh when Atlas view loads").components[0].flip(true);

		// T1 step 1: turn ON "Refresh every" while its minutes field is still blank — this is the
		// full render() that (pre-fix) left a fresh, permanently-disabled Save button behind.
		settingNamed(modal, "Refresh every").components[0].flip(true);

		const minutesField = () => settingNamed(modal, "Refresh every").components[1];
		const errorText = () => (modal as any).contentEl.children.find((c: any) => c.cls === "atlas-api-field-error")?.textContent;

		expect((modal as any).saveButton.disabled).toBe(true);

		// T7 / C38 checkpoint 2: 3, 4 and blank are all rejected with an inline error and a blocked Save.
		for (const bad of ["3", "4", ""]) {
			minutesField().type(bad);
			expect(errorText()).toBeTruthy();
			expect((modal as any).saveButton.disabled).toBe(true);
		}

		// T1 step 2: type a valid value. Pre-fix, updateSaveButton() only touched the raw buttonEl's
		// `.disabled` attribute, never the ButtonComponent's own field the click handler gates on, so
		// the button stayed permanently unresponsive from here on.
		minutesField().type("60");
		expect(errorText()).toBeFalsy();
		expect((modal as any).saveButton.disabled).toBe(false);

		(modal as any).saveButton.simulateClick();

		expect(onSave).toHaveBeenCalledTimes(1);
		expect(onSave).toHaveBeenCalledWith({
			source: expect.objectContaining({
				mode: "overwrite",
				refreshOnViewLoad: true,
				refreshEveryMinutesEnabled: true,
				refreshEveryMinutes: 60,
			}),
			headers: [],
		});
	});
});
