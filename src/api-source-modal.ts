import { App, Modal, Notice, Setting } from "obsidian";
import { findArrayFields, isMapError, mapResponseRows } from "./api-mapping";
import { httpGetJson } from "./api-http";
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
 * G1: "Data source…" modal on a Folder. URL + device-local headers + GET-only fetch, a sample fetch
 * that lists the response's fields as draggable chips (G2), three drop targets (id/label required,
 * secondary optional), Append/Merge only (Overwrite is out of scope per the fence — simply never
 * offered), and "Refresh when Atlas view loads" (G5a) — "Refresh every X minutes" is likewise never
 * offered (also fenced out).
 */
export class ApiSourceModal extends Modal {
	private url: string;
	private headers: ApiHeader[];
	private mode: "append" | "merge";
	private refreshOnViewLoad: boolean;
	private mapping: ApiFieldMapping;
	private sampleFields: string[] = [];
	private arrayFieldCandidates: string[] = [];
	private lastResponse: unknown = null;
	private saveButton: HTMLButtonElement | null = null;

	constructor(app: App, initial: ApiSourceConfig | null, initialHeaders: ApiHeader[], private onSave: (result: ApiSourceModalResult) => void) {
		super(app);
		this.url = initial?.url ?? "";
		this.headers = initialHeaders.map((h) => ({ ...h }));
		this.mode = initial?.mode ?? "merge";
		this.refreshOnViewLoad = initial?.refreshOnViewLoad ?? false;
		this.mapping = initial?.mapping ?? { idField: "", labelField: "", secondaryField: undefined };
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

		new Setting(contentEl).setName("Headers").setDesc("Stored on this device only — never synced.").setHeading();
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
			.setDesc("Merge keeps items by id across refreshes; Append only ever adds new ones.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("merge", "Merge")
					.addOption("append", "Append")
					.setValue(this.mode)
					.onChange((value) => (this.mode = value as "append" | "merge"))
			);

		new Setting(contentEl)
			.setName("Refresh when Atlas view loads")
			.addToggle((toggle) => toggle.setValue(this.refreshOnViewLoad).onChange((value) => (this.refreshOnViewLoad = value)));

		const footer = new Setting(contentEl);
		footer.addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.close()));
		footer.addButton((btn) => {
			this.saveButton = btn.buttonEl;
			btn
				.setCta()
				.setButtonText("Save")
				.setDisabled(!this.canSave())
				.onClick(() => this.save());
			return btn;
		});
	}

	private canSave(): boolean {
		return this.url.trim().length > 0 && this.mapping.idField.trim().length > 0 && this.mapping.labelField.trim().length > 0;
	}

	private applyMapping(): void {
		if (!this.lastResponse) return;
		const result = mapResponseRows(this.lastResponse, this.mapping);
		if (!isMapError(result) && result.rows.length > 0) {
			this.sampleFields = Object.keys(this.lastResponse as Record<string, unknown>);
		}
	}

	private async fetchSample(): Promise<void> {
		const headerRecord: Record<string, string> = {};
		for (const header of this.headers) if (header.key) headerRecord[header.key] = header.value;

		const result = await httpGetJson(this.url, headerRecord);
		if (!result.ok) {
			new Notice(`Atlas: fetch failed — ${result.error.message}`);
			return;
		}
		this.lastResponse = result.json;
		this.arrayFieldCandidates = findArrayFields(result.json);

		const items = Array.isArray(result.json)
			? result.json
			: this.mapping.arrayField && Array.isArray((result.json as Record<string, unknown>)[this.mapping.arrayField])
				? ((result.json as Record<string, unknown>)[this.mapping.arrayField] as unknown[])
				: null;

		if (items === null) {
			this.sampleFields = [];
			if (this.arrayFieldCandidates.length === 0) new Notice("Atlas: response is not a JSON list and has no array field to pick.");
			this.render();
			return;
		}
		const first = items.find((item) => item && typeof item === "object") as Record<string, unknown> | undefined;
		this.sampleFields = first ? Object.keys(first) : [];
		this.render();
	}

	private save(): void {
		if (!this.canSave()) return;
		const source: ApiSourceConfig = {
			url: this.url.trim(),
			method: "GET",
			mapping: { ...this.mapping },
			mode: this.mode,
			refreshOnViewLoad: this.refreshOnViewLoad,
		};
		this.close();
		this.onSave({ source, headers: this.headers.filter((h) => h.key.trim().length > 0) });
	}
}
