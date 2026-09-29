import { App, ButtonComponent, Modal, Notice, Platform, Setting } from "obsidian";
import { canSaveApiSource, findArrayFields, isMapError, isValidExtraFieldName, mapResponseRows, sampleFieldsForArrayField } from "./api-mapping";
import { generateJsFromMapping, runJsMapping, validateJsSource } from "./api-js-mapping";
import { httpGetJson } from "./api-http";
import { obsidianRequestImpl } from "./api-request-obsidian";
import { validateRefreshMinutes } from "./api-refresh-timer";
import { resolveArgv, validateCommand } from "./command-argv";
import { ConfirmModal } from "./modals";
import { ApiClickAction, ApiFieldMapping, ApiHeader, ApiSourceConfig } from "./types";

export interface ApiSourceModalResult {
	source: ApiSourceConfig;
	headers: ApiHeader[];
}

const MAPPING_TARGETS: { key: "idField" | "labelField" | "secondaryField"; label: string; required: boolean }[] = [
	{ key: "idField", label: "ID (required)", required: true },
	{ key: "labelField", label: "Label (required)", required: true },
	{ key: "secondaryField", label: "Secondary (optional)", required: false },
];

/**
 * G1/PR-3/PR-5: "Data source…" modal on a Folder. URL + device-local headers + GET-only fetch, a sample
 * fetch that lists the response's fields as draggable chips (G2), drop targets (id/label
 * required, secondary optional, plus extra named fields), Merge/Append/Overwrite fill modes, Overwrite's two guards (G6b, greyed
 * out and their values retained unless Overwrite is selected), two independent refresh toggles
 * (G5a "when Atlas view loads", G5b "every X minutes"), and the optional click action (G9b).
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
	private extraFields: { name: string; field: string }[] = [];
	private action: ApiClickAction;
	private command: string;
	private sampleFields: string[] = [];
	private arrayFieldCandidates: string[] = [];
	private lastResponse: unknown = null;
	/** T1: must be the `ButtonComponent` itself, not just its `buttonEl` — Obsidian's click handler
	 * gates on the component's own internal `disabled` field, not the DOM element's `disabled`
	 * attribute, so re-syncing only the latter (as this used to) left the button unclickable forever
	 * after any full `render()` recreated it in a disabled state. */
	private saveButton: ButtonComponent | null = null;
	/** PR-4/G3: "drag" (default) behaves exactly as PR-2/PR-3; "js" replaces the mapping step with
	 * `jsSource`. `mapping` itself is never cleared on drag→js — only a confirmed js→drag switch
	 * clears `jsSource` (see the mode dropdown's `onChange`), so toggling modes never loses either
	 * side's state until the user actually confirms discarding it. */
	private mappingMode: "drag" | "js";
	private jsSource: string;
	/** Test button output (row/skip/truncate summary or the mapping error) — mode-aware, never saves
	 * or touches the cache. Persists across re-renders until the next Test run, a mode switch, or a
	 * fresh Fetch sample. */
	private testResult: string | null = null;
	private testResultEl: HTMLElement | null = null;

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
		this.mappingMode = initial?.mappingMode === "js" ? "js" : "drag";
		this.jsSource = initial?.jsSource ?? "";
		this.action = initial?.action ?? initial?.clickAction ?? "open-attachment";
		this.command = initial?.command ?? "";
		const rawExtras = initial?.mapping?.extraFields;
		if (rawExtras && typeof rawExtras === "object") {
			this.extraFields = Object.entries(rawExtras).map(([name, field]) => ({ name, field }));
		}
	}

	onOpen(): void {
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	/** Fix 2 (Round 1 human testing), corrected in Round 2 (T1-T5): `render()` fully rebuilds
	 * `contentEl`, and clearing/regrowing its content inside the modal disturbs scroll position — but
	 * `contentEl` (Obsidian's `.modal-content`) never itself scrolls in this modal's layout
	 * (scrollHeight === clientHeight always, scrollTop permanently 0). The actual scrolling element the
	 * user sees is `modalEl` (the ancestor `.modal`), which a bare `render()` doesn't reset but whose
	 * position drifts anyway (e.g. via the browser's scroll anchoring) once the content changes size.
	 * Captures and restores `modalEl.scrollTop` explicitly around Fetch sample/Test so the visible
	 * scroll position is pinned rather than left to drift. */
	private renderPreservingScroll(): void {
		const scrollTop = this.modalEl.scrollTop;
		this.render();
		this.modalEl.scrollTop = scrollTop;
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

		new Setting(contentEl)
			.setName("Mapping mode")
			.addDropdown((dropdown) => {
				dropdown.addOption("drag", "Drag fields");
				dropdown.addOption("js", "JavaScript");
				dropdown.setValue(this.mappingMode);
				dropdown.onChange((value) => {
					const next = value as "drag" | "js";
					if (next === this.mappingMode) return;
					if (this.mappingMode === "js" && next === "drag") {
						// G3: re-render first so the dropdown's own displayed value snaps back to "js"
						// until the user actually confirms — Cancel (no callback at all, see
						// `ConfirmModal`) must leave the mode and the code untouched.
						this.render();
						new ConfirmModal(
							this.app,
							"Switching to drag-field mapping discards the JavaScript code — this can't be undone.",
							"Discard code",
							() => {
								this.mappingMode = "drag";
								this.jsSource = "";
								this.testResult = null;
								this.render();
							}
						).open();
						return;
					}
					this.mappingMode = next;
					this.testResult = null;
					if (next === "js") this.jsSource = generateJsFromMapping({ ...this.mapping, extraFields: this.buildExtraFieldsRecord() });
					this.render();
				});
			});

		if (this.mappingMode === "js") {
			contentEl.createEl("p", {
				cls: "atlas-api-js-warning",
				text: "JavaScript runs with Atlas's full trust — there is no sandbox. An infinite loop or a function that never resolves has no separate timeout of its own; only the request itself is capped.",
			});

			let jsErrorEl: HTMLElement | null = null;
			const updateJsValidity = () => {
				const validation = validateJsSource(this.jsSource);
				jsErrorEl?.setText(validation.ok ? "" : validation.error);
				this.updateSaveButton();
			};
			new Setting(contentEl)
				.setName("Mapping function")
				.setDesc("(response) => [{ id, label, secondary, extra }] — secondary and extra are optional.")
				.addTextArea((text) =>
					text.setValue(this.jsSource).onChange((value) => {
						this.jsSource = value;
						updateJsValidity();
					})
				);
			jsErrorEl = contentEl.createEl("p", { cls: "atlas-api-field-error" });
			updateJsValidity();
		}

		new Setting(contentEl).addButton((btn) => btn.setButtonText("Test").onClick(() => void this.runTest()));
		this.testResultEl = contentEl.createEl("p", { cls: "atlas-api-test-result" });
		this.testResultEl.setText(this.testResult ?? "");

		if (this.mappingMode === "drag" && this.arrayFieldCandidates.length > 0) {
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

		if (this.mappingMode === "drag" && this.sampleFields.length > 0) {
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
					this.renderPreservingScroll();
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

			for (let i = 0; i < this.extraFields.length; i++) {
				const extra = this.extraFields[i];
				const targetRow = new Setting(contentEl);
				targetRow.addText((text) =>
					text
						.setPlaceholder("field_name")
						.setValue(extra.name)
						.onChange((value) => {
							extra.name = value.trim();
							this.updateSaveButton();
						})
				);
				const dropZone = targetRow.controlEl.createDiv({ cls: "atlas-api-drop-zone", text: extra.field || "Drop field here" });
				dropZone.addEventListener("dragover", (evt) => evt.preventDefault());
				dropZone.addEventListener("drop", (evt) => {
					evt.preventDefault();
					const field = evt.dataTransfer?.getData("text/plain");
					if (!field) return;
					extra.field = field;
					this.renderPreservingScroll();
				});
				targetRow.addExtraButton((btn) =>
					btn
						.setIcon("x")
						.setTooltip("Remove extra field")
						.onClick(() => {
							this.extraFields.splice(i, 1);
							this.render();
						})
				);
			}

			const addExtraRow = new Setting(contentEl).setName("Extra field");
			const addDropZone = addExtraRow.controlEl.createDiv({
				cls: "atlas-api-drop-zone atlas-api-add-drop-zone",
				text: "Drop field here to add extra field",
			});
			addDropZone.addEventListener("dragover", (evt) => evt.preventDefault());
			addDropZone.addEventListener("drop", (evt) => {
				evt.preventDefault();
				const field = evt.dataTransfer?.getData("text/plain");
				if (!field) return;
				let name = field.replace(/[^a-zA-Z0-9_]/g, "_") || "extra";
				if (this.extraFields.some((e) => e.name === name)) {
					let n = 1;
					while (this.extraFields.some((e) => e.name === `${name}_${n}`)) n++;
					name = `${name}_${n}`;
				}
				this.extraFields.push({ name, field });
				this.renderPreservingScroll();
			});
			addExtraRow.addButton((btn) =>
				btn.setButtonText("Add extra field").onClick(() => {
					let name = "extra";
					let n = 1;
					while (this.extraFields.some((e) => e.name === `${name}_${n}`)) n++;
					this.extraFields.push({ name: `${name}_${n}`, field: "" });
					this.render();
				})
			);
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

		new Setting(contentEl).setName("Click action").setHeading();
		new Setting(contentEl)
			.setName("Action on click")
			.setDesc("What happens when an API row is clicked.")
			.addDropdown((dropdown) => {
				dropdown.addOption("open-attachment", "Open attachment (default)");
				dropdown.addOption("none", "None");
				if (Platform.isMobile) {
					// G13: Click-action commands are not available on mobile
				} else {
					dropdown.addOption("run-command", "Run terminal command in background");
				}
				dropdown.setValue(this.action);
				dropdown.onChange((value) => {
					this.action = value as ApiClickAction;
					this.render();
				});
			});

		if (this.action === "run-command" && !Platform.isMobile) {
			contentEl.createEl("p", {
				cls: "atlas-api-command-warning",
				text: "Commands run with the user's trust. Shell features (pipes, redirects, &&, globbing, ~, env vars) are unsupported in v1.",
			});

			let commandErrorEl: HTMLElement | null = null;
			const updateCommandValidity = () => {
				const availableExtras = this.extraFields.map((e) => e.name);
				const validation = validateCommand(this.command, availableExtras);
				commandErrorEl?.setText(validation.ok ? "" : validation.error);
				this.updateSaveButton();
			};

			new Setting(contentEl)
				.setName("Command")
				.setDesc("Command to execute in the background. Use {field} for extra mapped field values.")
				.addText((text) =>
					text
						.setPlaceholder("open -a Docker")
						.setValue(this.command)
						.onChange((value) => {
							this.command = value;
							updateCommandValidity();
						})
				);
			commandErrorEl = contentEl.createEl("p", { cls: "atlas-api-field-error" });
			updateCommandValidity();
		}

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

	private buildExtraFieldsRecord(): Record<string, string> {
		const out: Record<string, string> = {};
		for (const e of this.extraFields) {
			if (e.name && e.field && isValidExtraFieldName(e.name)) {
				out[e.name] = e.field;
			}
		}
		return out;
	}

	private canSave(): boolean {
		if (this.mappingMode === "js") {
			if (!this.url.trim()) return false;
			if (!validateJsSource(this.jsSource).ok) return false;
		} else if (!canSaveApiSource(this.url, this.mapping)) {
			return false;
		}
		if (this.refreshEveryMinutesEnabled && !validateRefreshMinutes(this.refreshEveryMinutesRaw).ok) return false;

		// Check extra fields validity: valid identifier, unique
		for (let i = 0; i < this.extraFields.length; i++) {
			const extra = this.extraFields[i];
			if (!isValidExtraFieldName(extra.name)) return false;
			if (this.extraFields.findIndex((other) => other.name === extra.name) !== i) return false;
		}

		// Check command validity if run-command is selected
		if (this.action === "run-command" && !Platform.isMobile) {
			const availableExtras = this.extraFields.map((e) => e.name);
			if (!validateCommand(this.command, availableExtras).ok) return false;
		}

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
		this.testResult = null;
		if (this.sampleFields.length === 0 && this.arrayFieldCandidates.length === 0 && !Array.isArray(result.json)) {
			new Notice("Atlas: response is not a JSON list and has no array field to pick.");
		}
		this.renderPreservingScroll();
	}

	/** G3: "The Test button, Fetch sample and Save all use the active mode." Runs the active mode's
	 * mapping against the last-fetched sample and shows the resulting row/skip/truncate summary or the
	 * mapping error — never saves, never touches `apiCache`. */
	private async runTest(): Promise<void> {
		if (this.lastResponse === null) {
			new Notice("Fetch a sample first.");
			return;
		}
		const mappingWithExtras: ApiFieldMapping = {
			...this.mapping,
			extraFields: this.buildExtraFieldsRecord(),
		};
		const result = this.mappingMode === "js" ? await runJsMapping(this.jsSource, this.lastResponse) : mapResponseRows(this.lastResponse, mappingWithExtras);
		if (isMapError(result)) {
			this.testResult = `Error: ${result.error}`;
		} else {
			const parts = [`${result.rows.length} row(s)`];
			if (result.skippedCount > 0) parts.push(`${result.skippedCount} skipped`);
			if (result.truncated) parts.push("truncated at 5,000");

			if (this.action === "run-command" && this.command.trim()) {
				const availableExtras = this.extraFields.map((e) => e.name);
				const validation = validateCommand(this.command, availableExtras);
				if (!validation.ok) {
					parts.push(`Command error: ${validation.error}`);
				} else if (result.rows.length > 0) {
					const firstRow = result.rows[0];
					const resolved = resolveArgv(validation.tokens, firstRow.extra);
					if (resolved.ok) {
						parts.push(`Argv preview: ${JSON.stringify(resolved.argv)}`);
					} else {
						parts.push(`Argv preview error: ${resolved.error}`);
					}
				}
			}

			this.testResult = parts.join(", ");
		}
		this.renderPreservingScroll();
	}

	private save(): void {
		if (!this.canSave()) return;
		const refreshEveryMinutesValidation = this.refreshEveryMinutesEnabled ? validateRefreshMinutes(this.refreshEveryMinutesRaw) : null;
		const extraFieldsRecord = this.buildExtraFieldsRecord();
		const source: ApiSourceConfig = {
			url: this.url.trim(),
			method: "GET",
			mapping: {
				...this.mapping,
				extraFields: Object.keys(extraFieldsRecord).length > 0 ? extraFieldsRecord : undefined,
			},
			mode: this.mode,
			refreshOnViewLoad: this.refreshOnViewLoad,
			refreshEveryMinutesEnabled: this.refreshEveryMinutesEnabled,
			refreshEveryMinutes: refreshEveryMinutesValidation?.ok ? refreshEveryMinutesValidation.minutes : undefined,
			keepOnEmpty: this.keepOnEmpty,
			confirmBeforeDelete: this.confirmBeforeDelete,
			mappingMode: this.mappingMode === "js" ? "js" : undefined,
			jsSource: this.mappingMode === "js" ? this.jsSource : undefined,
			action: this.action,
			clickAction: this.action,
			command: this.action === "run-command" ? this.command.trim() : undefined,
		};
		this.close();
		this.onSave({ source, headers: this.headers.filter((h) => h.key.trim().length > 0) });
	}
}
