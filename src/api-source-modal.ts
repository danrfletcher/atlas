import { App, ButtonComponent, Modal, Notice, Platform, Setting } from "obsidian";
import { canSaveApiSource, findArrayFields, sampleFieldsForArrayField } from "./api-mapping";
import { httpGetJson } from "./api-http";
import { obsidianRequestImpl } from "./api-request-obsidian";
import { validateRefreshMinutes } from "./api-refresh-timer";
import { ApiFieldMapping, ApiHeader, ApiSourceConfig } from "./types";

export interface ApiSourceModalResult {
	source: ApiSourceConfig;
	headers: ApiHeader[];
}

const MAPPING_TARGETS: { key: keyof ApiFieldMapping; label: string; required: boolean }[] = [
	{ key: "idField", label: "ID (required)", required: true },
	{ key: "labelField", label: "Label (required)", required: true },
	{ key: "secondaryField", label: "Secondary (optional)", required: false },
];

/**
 * G1/PR-3: "Data source…" modal on a Folder. URL + device-local headers + GET-only fetch, a sample
 * fetch that lists the response's fields as draggable chips (G2), three drop targets (id/label
 * required, secondary optional), Merge/Append/Overwrite fill modes, Overwrite's two guards (G6b, greyed
 * out and their values retained unless Overwrite is selected), and the two independent refresh toggles
 * (G5a "when Atlas view loads", G5b "every X minutes").
 */
export class ApiSourceModal extends Modal {
	private url: string;
	private headers: ApiHeader[];
	private mode: "append" | "merge" | "overwrite";
	private refreshOnViewLoad: boolean;
	/** G6b(i)/(ii): retained regardless of `mode` — only Overwrite's UI exposes them for editing, but
	 * switching away and back must not lose whatever was set. */
	private keepOnEmpty: boolean;
	private confirmBeforeDelete: boolean;
	/** G5b: off by default, no fixed value — the raw text field's own value, validated on every change
	 * rather than coerced, so a mid-edit invalid value doesn't silently become someone else's number. */
	private refreshEveryMinutesEnabled: boolean;
	private refreshEveryMinutesRaw: string;
	private mapping: ApiFieldMapping;
	private sampleFields: string[] = [];
	private arrayFieldCandidates: string[] = [];
	private lastResponse: unknown = null;
	/** T1: must be the `ButtonComponent` itself, not just its `buttonEl` — Obsidian's click handler
	 * gates on the component's own internal `disabled` field, not the DOM element's `disabled`
	 * attribute, so re-syncing only the latter (as this used to) left the button unclickable forever
	 * after any full `render()` recreated it in a disabled state. */
	private saveButton: ButtonComponent | null = null;

	constructor(app: App, initial: ApiSourceConfig | null, initialHeaders: ApiHeader[], private onSave: (result: ApiSourceModalResult) => void) {
		super(app);
		this.url = initial?.url ?? "";
		this.headers = initialHeaders.map((h) => ({ ...h }));
		this.mode = initial?.mode ?? "merge";
		this.refreshOnViewLoad = initial?.refreshOnViewLoad ?? false;
		this.keepOnEmpty = initial?.keepOnEmpty ?? true;
		this.confirmBeforeDelete = initial?.confirmBeforeDelete ?? true;
		this.refreshEveryMinutesEnabled = initial?.refreshEveryMinutesEnabled ?? false;
		this.refreshEveryMinutesRaw = initial?.refreshEveryMinutes !== undefined ? String(initial.refreshEveryMinutes) : "";
		this.mapping = initial?.mapping ? { ...initial.mapping } : { idField: "", labelField: "", secondaryField: undefined };
	}

	onOpen(): void {
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: "Data source" });

		new Setting(contentEl)
			.setName("URL")
			.addText((text) =>
				text
					.setPlaceholder("https://api.example.com/items")
					.setValue(this.url)
					.onChange((value) => (this.url = value))
			);

		new Setting(contentEl).setName("Method").addText((text) => text.setValue("GET").setDisabled(true));

		new Setting(contentEl)
			.setName("Headers")
			.setDesc("Stored on this device only — never synced, and kept as plain text, unencrypted.")
			.setHeading();
		for (let i = 0; i < this.headers.length; i++) {
			const header = this.headers[i];
			const row = new Setting(contentEl);
			row.addText((text) => text.setPlaceholder("Header name").setValue(header.key).onChange((value) => (header.key = value)));
			row.addText((text) => text.setPlaceholder("Value").setValue(header.value).onChange((value) => (header.value = value)));
			row.addExtraButton((btn) =>
				btn.setIcon("x").setTooltip("Remove header").onClick(() => {
					this.headers.splice(i, 1);
					this.render();
				})
			);
		}
		new Setting(contentEl).addButton((btn) =>
			btn.setButtonText("Add header").onClick(() => {
				this.headers.push({ key: "", value: "" });
				this.render();
			})
		);

		new Setting(contentEl).addButton((btn) =>
			btn.setButtonText("Fetch sample").onClick(() => void this.fetchSample())
		);

		if (this.arrayFieldCandidates.length > 0) {
			new Setting(contentEl)
				.setName("Array field")
				.setDesc("The response is an object — pick which field holds the list of rows.")
				.addDropdown((dropdown) => {
					dropdown.addOption("", "Choose…");
					for (const field of this.arrayFieldCandidates) dropdown.addOption(field, field);
					dropdown.setValue(this.mapping.arrayField ?? "");
					dropdown.onChange((value) => {
						this.mapping.arrayField = value || undefined;
						this.applyMapping();
						this.render();
					});
				});
		}

		if (this.sampleFields.length > 0) {
			new Setting(contentEl).setName("Map fields").setDesc("Drag a field onto a target below.").setHeading();
			const chipsEl = contentEl.createDiv({ cls: "atlas-api-field-chips" });
			for (const field of this.sampleFields) {
				const chip = chipsEl.createSpan({ cls: "atlas-api-field-chip", text: field });
				chip.setAttr("draggable", "true");
				chip.addEventListener("dragstart", (evt) => evt.dataTransfer?.setData("text/plain", field));
			}

			for (const target of MAPPING_TARGETS) {
				const targetRow = new Setting(contentEl).setName(target.label);
				const dropZone = targetRow.controlEl.createDiv({ cls: "atlas-api-drop-zone", text: this.mapping[target.key] || "Drop field here" });
				dropZone.addEventListener("dragover", (evt) => evt.preventDefault());
				dropZone.addEventListener("drop", (evt) => {
					evt.preventDefault();
					const field = evt.dataTransfer?.getData("text/plain");
					if (!field) return;
					this.mapping[target.key] = field;
					this.render();
				});
				if (this.mapping[target.key] && !target.required) {
					targetRow.addExtraButton((btn) =>
						btn.setIcon("x").setTooltip("Clear").onClick(() => {
							(this.mapping as unknown as Record<string, string | undefined>)[target.key] = undefined;
							this.render();
						})
					);
				}
			}
		}

		new Setting(contentEl)
			.setName("Fill mode")
			.setDesc("Merge keeps items by id across refreshes; Append only ever adds new ones; Overwrite replaces every row each refresh.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("merge", "Merge")
					.addOption("append", "Append")
					.addOption("overwrite", "Overwrite")
					.setValue(this.mode)
					.onChange((value) => {
						this.mode = value as "append" | "merge" | "overwrite";
						// Guard toggles' disabled state depends on `mode` — re-render so it updates live.
						this.render();
					})
			);

		const overwriteGuardsDisabled = this.mode !== "overwrite";
		new Setting(contentEl)
			.setName("Keep current rows if the response is empty")
			.setDesc("Overwrite only. On: an empty response leaves every row untouched. Off: an empty response deletes all rows (subject to the confirm guard below).")
			.addToggle((toggle) =>
				toggle
					.setValue(this.keepOnEmpty)
					.setDisabled(overwriteGuardsDisabled)
					.onChange((value) => (this.keepOnEmpty = value))
			);
		new Setting(contentEl)
			.setName("Confirm before deleting rows")
			.setDesc("Overwrite only. Asks for confirmation whenever a refresh would delete one or more rows.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.confirmBeforeDelete)
					.setDisabled(overwriteGuardsDisabled)
					.onChange((value) => (this.confirmBeforeDelete = value))
			);

		new Setting(contentEl)
			.setName("Refresh when Atlas view loads")
			.addToggle((toggle) => toggle.setValue(this.refreshOnViewLoad).onChange((value) => (this.refreshOnViewLoad = value)));

		let refreshErrorEl: HTMLElement | null = null;
		const updateRefreshMinutesValidity = () => {
			const validation = this.refreshEveryMinutesEnabled ? validateRefreshMinutes(this.refreshEveryMinutesRaw) : null;
			refreshErrorEl?.setText(validation && !validation.ok ? validation.error : "");
			this.updateSaveButton();
		};
		new Setting(contentEl)
			.setName("Refresh every")
			.setDesc("Minutes between automatic refreshes while this Atlas view is open. Minimum 5 — off by default.")
			.addToggle((toggle) =>
				toggle.setValue(this.refreshEveryMinutesEnabled).onChange((value) => {
					this.refreshEveryMinutesEnabled = value;
					// Enabling/disabling the field's own editability — a discrete click, not a keystroke,
					// so a full re-render here doesn't cost focus the way it would mid-typing.
					this.render();
				})
			)
			.addText((text) =>
				text
					.setPlaceholder("minutes")
					.setValue(this.refreshEveryMinutesRaw)
					.setDisabled(!this.refreshEveryMinutesEnabled)
					.onChange((value) => {
						this.refreshEveryMinutesRaw = value;
						updateRefreshMinutesValidity();
					})
			);
		refreshErrorEl = contentEl.createEl("p", { cls: "atlas-api-field-error" });
		updateRefreshMinutesValidity();

		const footer = new Setting(contentEl);
		footer.addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.close()));
		footer.addButton((btn) => {
			this.saveButton = btn;
			btn
				.setCta()
				.setButtonText("Save")
				.setDisabled(!this.canSave())
				.onClick(() => this.save());
			return btn;
		});
	}

	private canSave(): boolean {
		if (!canSaveApiSource(this.url, this.mapping)) return false;
		if (this.refreshEveryMinutesEnabled && !validateRefreshMinutes(this.refreshEveryMinutesRaw).ok) return false;
		return true;
	}

	private updateSaveButton(): void {
		this.saveButton?.setDisabled(!this.canSave());
	}

	/** R2: was deriving `sampleFields` from the *top-level* response's own keys (`Object.keys`) no
	 * matter which array field got picked — wrong for an object response, whose rows live one level
	 * down inside that array. Now shares `sampleFieldsForArrayField` with the initial `fetchSample`
	 * fetch, so both derive fields from the chosen array's first item, not the wrapper object. */
	private applyMapping(): void {
		if (!this.lastResponse) return;
		this.sampleFields = sampleFieldsForArrayField(this.lastResponse, this.mapping.arrayField);
	}

	private async fetchSample(): Promise<void> {
		// R8/G13: mobile shows cached rows only — Fetch sample would otherwise attempt a live request.
		if (Platform.isMobile) {
			new Notice("Fetching a sample isn't available on mobile.");
			return;
		}
		const headerRecord: Record<string, string> = {};
		for (const header of this.headers) if (header.key) headerRecord[header.key] = header.value;

		const result = await httpGetJson(this.url, headerRecord, { requestImpl: obsidianRequestImpl });
		if (!result.ok) {
			new Notice(`Atlas: fetch failed — ${result.error.message}`);
			return;
		}
		this.lastResponse = result.json;
		this.arrayFieldCandidates = findArrayFields(result.json);
		this.sampleFields = sampleFieldsForArrayField(result.json, this.mapping.arrayField);
		if (this.sampleFields.length === 0 && this.arrayFieldCandidates.length === 0 && !Array.isArray(result.json)) {
			new Notice("Atlas: response is not a JSON list and has no array field to pick.");
		}
		this.render();
	}

	private save(): void {
		if (!this.canSave()) return;
		const refreshEveryMinutesValidation = this.refreshEveryMinutesEnabled ? validateRefreshMinutes(this.refreshEveryMinutesRaw) : null;
		const source: ApiSourceConfig = {
			url: this.url.trim(),
			method: "GET",
			mapping: { ...this.mapping },
			mode: this.mode,
			refreshOnViewLoad: this.refreshOnViewLoad,
			refreshEveryMinutesEnabled: this.refreshEveryMinutesEnabled,
			refreshEveryMinutes: refreshEveryMinutesValidation?.ok ? refreshEveryMinutesValidation.minutes : undefined,
			keepOnEmpty: this.keepOnEmpty,
			confirmBeforeDelete: this.confirmBeforeDelete,
		};
		this.close();
		this.onSave({ source, headers: this.headers.filter((h) => h.key.trim().length > 0) });
	}
}
