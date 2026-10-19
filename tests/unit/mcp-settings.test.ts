import { describe, expect, it, vi } from "vitest";
import { AtlasSettingTab, DEFAULT_SETTINGS } from "../../src/settings";
import type { AtlasSettings } from "../../src/settings";
import { McpTokenStore } from "../../src/mcp-token-store";

interface TextState {
	value?: string;
	disabled?: boolean;
	onChange?: (value: string) => unknown;
}
interface ButtonState {
	text?: string;
	onClick?: () => unknown;
}
interface ExtraButtonState {
	icon?: string;
	onClick?: () => unknown;
}
interface Row {
	name: string;
	desc: string;
	heading: boolean;
	toggles: { value?: boolean; onChange?: (v: boolean) => unknown }[];
	texts: TextState[];
	buttons: ButtonState[];
	extraButtons: ExtraButtonState[];
}

/** Obsidian's `Setting` is replaced with a recorder so the settings tab can be read back as rows
 * — the same technique `tests/unit/settings-highlight-open-note.test.ts` already uses for the
 * Basic tab's other controls. Every other export of the obsidian mock is kept as it is. */
vi.mock("obsidian", async (importOriginal) => {
	const actual = await importOriginal<typeof import("obsidian")>();

	class FakeSetting {
		static rows: Row[] = [];
		private row: Row;
		constructor(public containerEl: HTMLElement) {
			this.row = { name: "", desc: "", heading: false, toggles: [], texts: [], buttons: [], extraButtons: [] };
			FakeSetting.rows.push(this.row);
		}
		setName(name: string) {
			this.row.name = name;
			return this;
		}
		setDesc(desc: string) {
			this.row.desc = desc;
			return this;
		}
		setHeading() {
			this.row.heading = true;
			return this;
		}
		addToggle(cb: (c: { setValue: (v: boolean) => unknown; onChange: (fn: (v: boolean) => unknown) => unknown }) => void) {
			const state: { value?: boolean; onChange?: (v: boolean) => unknown } = {};
			const component = {
				setValue: (v: boolean) => {
					state.value = v;
					return component;
				},
				onChange: (fn: (v: boolean) => unknown) => {
					state.onChange = fn;
					return component;
				},
			};
			cb(component);
			this.row.toggles.push(state);
			return this;
		}
		addText(
			cb: (c: {
				setValue: (v: string) => unknown;
				setDisabled: (v: boolean) => unknown;
				setPlaceholder: (p: string) => unknown;
				onChange: (fn: (v: string) => unknown) => unknown;
			}) => void
		) {
			const state: TextState = {};
			const component = {
				setValue: (v: string) => {
					state.value = v;
					return component;
				},
				setDisabled: (v: boolean) => {
					state.disabled = v;
					return component;
				},
				setPlaceholder: (_p: string) => component,
				onChange: (fn: (v: string) => unknown) => {
					state.onChange = fn;
					return component;
				},
			};
			cb(component);
			this.row.texts.push(state);
			return this;
		}
		addButton(cb: (c: { setButtonText: (t: string) => unknown; onClick: (fn: () => unknown) => unknown; setCta: () => unknown }) => void) {
			const state: ButtonState = {};
			const component = {
				setButtonText: (t: string) => {
					state.text = t;
					return component;
				},
				onClick: (fn: () => unknown) => {
					state.onClick = fn;
					return component;
				},
				setCta: () => component,
			};
			cb(component);
			this.row.buttons.push(state);
			return this;
		}
		addExtraButton(cb: (c: { setIcon: (i: string) => unknown; setTooltip: (t: string) => unknown; onClick: (fn: () => unknown) => unknown }) => void) {
			const state: ExtraButtonState = {};
			const component = {
				setIcon: (i: string) => {
					state.icon = i;
					return component;
				},
				setTooltip: (_t: string) => component,
				onClick: (fn: () => unknown) => {
					state.onClick = fn;
					return component;
				},
			};
			cb(component);
			this.row.extraButtons.push(state);
			return this;
		}
		addDropdown(cb: (c: { addOption: () => unknown; setValue: () => unknown; onChange: () => unknown }) => void) {
			const component = { addOption: () => component, setValue: () => component, onChange: () => component };
			cb(component);
			return this;
		}
		addTextArea(cb: (c: { setPlaceholder: () => unknown; setValue: () => unknown; onChange: () => unknown }) => void) {
			const component = { setPlaceholder: () => component, setValue: () => component, onChange: () => component };
			cb(component);
			return this;
		}
	}

	return { ...actual, Setting: FakeSetting, Platform: { ...actual.Platform, isMobile: false } };
});

class FakeLocalStorageHost {
	store = new Map<string, unknown>();
	loadLocalStorage(key: string): unknown {
		return this.store.get(key) ?? null;
	}
	saveLocalStorage(key: string, data: unknown): void {
		this.store.set(key, data);
	}
}

async function buildTab(mcpServerEnabled: boolean) {
	const { Setting, App } = await import("obsidian");
	const { rows } = Setting as unknown as { rows: Row[] };
	rows.length = 0;

	const mcpTokenStore = new McpTokenStore(new FakeLocalStorageHost());
	const settings: AtlasSettings = { ...DEFAULT_SETTINGS, mcpServerEnabled };
	const plugin = {
		settings,
		mcpTokenStore,
		mcpServer: { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) },
		saveSettings: vi.fn(async () => {}),
	};
	const tab = new AtlasSettingTab(new App() as never, plugin as never);
	// The mock `PluginSettingTab` base class doesn't allocate `containerEl` the way real Obsidian
	// does — needed here because a click handler inside the section calls `this.display()` for a
	// full re-render (Regenerate, and the enable toggle), not just this one section.
	(tab as unknown as { containerEl: HTMLElement }).containerEl = document.createElement("div");
	(tab as unknown as { renderMcpServerSection(el: HTMLElement): void }).renderMcpServerSection(document.createElement("div"));
	return { rows, plugin, tab, mcpTokenStore };
}

describe("MCP server settings section", () => {
	it("toggle off: the port/token rows don't render at all", async () => {
		const { rows } = await buildTab(false);
		expect(rows.find((r) => r.name === "Enable MCP server")).toBeDefined();
		expect(rows.find((r) => r.name === "Port")).toBeUndefined();
		expect(rows.find((r) => r.name === "Token")).toBeUndefined();
	});

	it("toggle on: the port and token rows render, disabled, with the current credentials", async () => {
		const { rows, mcpTokenStore } = await buildTab(true);
		const credentials = mcpTokenStore.get();

		const portRow = rows.find((r) => r.name === "Port")!;
		expect(portRow.texts[0].value).toBe(String(credentials.port));
		expect(portRow.texts[0].disabled).toBe(true);

		const tokenRow = rows.find((r) => r.name === "Token")!;
		expect(tokenRow.texts[0].value).toBe(credentials.token);
		expect(tokenRow.texts[0].disabled).toBe(true);
		expect(tokenRow.buttons.some((b) => b.text === "Regenerate")).toBe(true);
	});

	it("toggling the switch on calls through to mcpServer.start() and saveSettings()", async () => {
		const { rows, plugin } = await buildTab(false);
		const enableRow = rows.find((r) => r.name === "Enable MCP server")!;
		await enableRow.toggles[0].onChange?.(true);
		expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
		expect(plugin.mcpServer.start).toHaveBeenCalledTimes(1);
		expect(plugin.mcpServer.stop).not.toHaveBeenCalled();
	});

	it("toggling the switch off calls through to mcpServer.stop()", async () => {
		const { rows, plugin } = await buildTab(true);
		const enableRow = rows.find((r) => r.name === "Enable MCP server")!;
		await enableRow.toggles[0].onChange?.(false);
		expect(plugin.mcpServer.stop).toHaveBeenCalledTimes(1);
		expect(plugin.mcpServer.start).not.toHaveBeenCalled();
	});

	it("Regenerate calls through to McpTokenStore.regenerate(), and the displayed token updates in the same render pass", async () => {
		const { rows, mcpTokenStore } = await buildTab(true);
		const before = mcpTokenStore.get().token;
		const tokenRowBefore = rows.find((r) => r.name === "Token")!;
		expect(tokenRowBefore.texts[0].value).toBe(before);

		const regenerateButton = tokenRowBefore.buttons.find((b) => b.text === "Regenerate")!;
		const spy = vi.spyOn(mcpTokenStore, "regenerate");
		regenerateButton.onClick?.();

		expect(spy).toHaveBeenCalledTimes(1);
		const after = mcpTokenStore.get().token;
		expect(after).not.toBe(before);

		// The re-render (`this.display()`, called from inside the click handler) rebuilt the rows —
		// the same render pass's Token row now shows the freshly regenerated value, not the old one.
		// After `this.display()` (triggered by the click handler below) re-renders the whole tab,
		// `rows` has every setting appended again — the live tab's own Token row is the last one
		// named "Token", not the first.
		const tokenRowAfter = rows.filter((r) => r.name === "Token").at(-1)!;
		expect(tokenRowAfter.texts[0].value).toBe(after);
		expect(tokenRowAfter.texts[0].value).not.toBe(before);
	});
});
