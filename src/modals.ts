import { App, Modal, Setting } from "obsidian";
import { StatusSet } from "./statuses";
import { ApplyToConfig, StatusGovernance } from "./types";

/** A single text field + OK/Cancel, for anything that needs a short name from the user (new view,
 * rename, new meta folder). Submits on Enter or the OK button. */
export class TextPromptModal extends Modal {
	private value: string;

	constructor(
		app: App,
		private title: string,
		initialValue: string,
		private onSubmit: (value: string) => void,
		private placeholder = ""
	) {
		super(app);
		this.value = initialValue;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: this.title });
		let inputEl: HTMLInputElement | undefined;
		new Setting(contentEl).addText((text) => {
			inputEl = text.inputEl;
			text.setPlaceholder(this.placeholder)
				.setValue(this.value)
				.onChange((value) => (this.value = value));
			text.inputEl.addEventListener("keydown", (evt) => {
				if (evt.key === "Enter") {
					evt.preventDefault();
					this.submit();
				}
			});
		});
		new Setting(contentEl)
			.addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((btn) =>
				btn
					.setCta()
					.setButtonText("OK")
					.onClick(() => this.submit())
			);
		window.setTimeout(() => {
			inputEl?.focus();
			inputEl?.select();
		}, 0);
	}

	private submit(): void {
		const value = this.value;
		this.close();
		this.onSubmit(value);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** PR 15/17: the "Statuses" modal — opened from a bucket item's (or the view-name selector's, for
 * root-level assignment) right-click menu. A master on/off toggle plus which status set governs
 * the *children* of the right-clicked item (Dan's own spec: "the statuses apply to the first
 * direct children under that item" — this item's own row is never itself affected), plus (PR 17)
 * inherit-to-subfolders, hide-completed/cancelled, which unit kinds receive treatment, and per-
 * status truncation. Everything below the master toggle is disabled while it's off, but never
 * discarded (Dan's own edge case AC) — `this.governance` keeps every field locally regardless of
 * `statusEnabled`, the same way the underlying data model does. Applies live on every change
 * (matching the reference plugin's own framing of a persistent, greyed-out-until-enabled modal)
 * rather than a draft-then-submit OK/Cancel pattern, since there's nothing here worth batching.
 * Re-renders itself on any change that affects what else should be shown/enabled (master toggle,
 * status set choice, a truncate-row's own enable flip) rather than tracking a component reference
 * per field — simpler once the modal has this many fields, matching the settings tab's own
 * `display()` re-render pattern. Text fields (truncate labels) don't trigger a re-render, only
 * their own `onChange`, so typing in them doesn't fight the modal for focus. */
export class StatusesModal extends Modal {
	private governance: StatusGovernance;

	constructor(app: App, private statusSets: StatusSet[], initial: StatusGovernance, private onChange: (patch: Partial<StatusGovernance>) => void) {
		super(app);
		this.governance = { ...initial };
	}

	onOpen(): void {
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: "Statuses" });

		const hasSets = this.statusSets.length > 0;
		if (!hasSets) {
			contentEl.createEl("p", {
				text: "No status sets exist yet — create one in Settings → Atlas → Status before enabling this.",
				cls: "setting-item-description",
			});
			// Dan-found bug (PR 14): the toggle used to stay enabled with no set to actually assign,
			// silently persisting `statusEnabled: true, statusSetId: undefined` — enabled but never
			// resolving to a visible status anywhere. Disabling the toggle itself when there's
			// nothing to pick makes that state unreachable instead of just unlikely.
			if (this.governance.statusEnabled) {
				this.governance.statusEnabled = false;
				this.onChange({ statusEnabled: false });
			}
		} else if (this.governance.statusSetId === undefined) {
			// PR 17 bug (caught in this PR's own live testing, not shipped): the dropdown below
			// defaults its *visible* selection to the first set via `setValue`, but that's cosmetic
			// only — it never touched `this.governance` unless the user actually interacted with the
			// dropdown. Enabling the master toggle without ever touching the dropdown persisted
			// `statusEnabled: true` with `statusSetId` still `undefined`, silently resolving to no
			// status at all despite the dropdown visibly showing a set selected. Defaulting it here,
			// eagerly, keeps the underlying data honest with what the dropdown already displays.
			this.governance.statusSetId = this.statusSets[0].id;
			this.onChange({ statusSetId: this.governance.statusSetId });
		}

		new Setting(contentEl)
			.setName("Enable statuses")
			.setDesc("Applies to this item's direct children, not this item itself.")
			.addToggle((toggle) =>
				toggle
					.setValue(!!this.governance.statusEnabled)
					.setDisabled(!hasSets)
					.onChange((value) => {
						this.governance.statusEnabled = value;
						this.onChange({ statusEnabled: value });
						this.render();
					})
			);

		const disabled = !this.governance.statusEnabled || !hasSets;

		new Setting(contentEl).setName("Status set").addDropdown((dropdown) => {
			if (!hasSets) {
				dropdown.addOption("", "Create a status set first");
			} else {
				for (const set of this.statusSets) dropdown.addOption(set.id, set.name);
				dropdown.setValue(this.governance.statusSetId ?? this.statusSets[0].id);
			}
			dropdown.setDisabled(disabled);
			dropdown.onChange((value) => {
				this.governance.statusSetId = value || undefined;
				this.onChange({ statusSetId: this.governance.statusSetId });
				this.render(); // the truncate section below depends on which set is now chosen
			});
		});

		new Setting(contentEl)
			.setName("Inherit to subfolders")
			.setDesc("Apply this status set all the way down the tree, not just to direct children, until a closer item has its own assignment.")
			.addToggle((toggle) =>
				toggle
					.setValue(!!this.governance.inheritToSubfolders)
					.setDisabled(disabled)
					.onChange((value) => {
						this.governance.inheritToSubfolders = value;
						this.onChange({ inheritToSubfolders: value });
					})
			);

		new Setting(contentEl)
			.setName("Hide completed")
			.setDesc("Hide items whose current status is marked completed.")
			.addToggle((toggle) =>
				toggle
					.setValue(!!this.governance.hideCompleted)
					.setDisabled(disabled)
					.onChange((value) => {
						this.governance.hideCompleted = value;
						this.onChange({ hideCompleted: value });
					})
			);

		new Setting(contentEl)
			.setName("Hide cancelled")
			.setDesc("Hide items whose current status is marked cancelled.")
			.addToggle((toggle) =>
				toggle
					.setValue(!!this.governance.hideCancelled)
					.setDisabled(disabled)
					.onChange((value) => {
						this.governance.hideCancelled = value;
						this.onChange({ hideCancelled: value });
					})
			);

		new Setting(contentEl).setName("Apply statuses to").setHeading();
		const applyToFields: { key: keyof ApplyToConfig; label: string; desc: string }[] = [
			{ key: "block", label: "Blocks", desc: "Free and promoted blocks." },
			{ key: "file", label: "Files", desc: "Files and promoted files." },
			{ key: "module", label: "Modules", desc: "Real folders on disk." },
			{ key: "metaFolder", label: "Meta folders", desc: "Organizational labels with no disk presence." },
		];
		for (const field of applyToFields) {
			new Setting(contentEl)
				.setName(field.label)
				.setDesc(field.desc)
				.addToggle((toggle) =>
					toggle
						.setValue(this.governance.applyTo?.[field.key] ?? true)
						.setDisabled(disabled)
						.onChange((value) => {
							const next: ApplyToConfig = { ...this.governance.applyTo, [field.key]: value };
							this.governance.applyTo = next;
							this.onChange({ applyTo: next });
						})
				);
		}

		const chosenSet = this.statusSets.find((s) => s.id === this.governance.statusSetId);
		if (chosenSet && chosenSet.statuses.length > 0) {
			new Setting(contentEl).setName("Truncate statuses").setHeading();
			contentEl.createEl("p", {
				text: "Collapse every item with a given status into a single summary row instead of listing each one.",
				cls: "setting-item-description",
			});
			for (const status of chosenSet.statuses) {
				const truncConfig = this.governance.truncatedStatuses?.[status.id];
				const row = new Setting(contentEl).setName(status.label);
				row.addToggle((toggle) =>
					toggle
						.setValue(!!truncConfig?.enabled)
						.setDisabled(disabled)
						.onChange((value) => {
							const next = { ...this.governance.truncatedStatuses, [status.id]: { enabled: value, label: truncConfig?.label } };
							this.governance.truncatedStatuses = next;
							this.onChange({ truncatedStatuses: next });
							this.render(); // shows/hides the label field below
						})
				);
				if (truncConfig?.enabled) {
					row.addText((text) =>
						text
							.setPlaceholder("Summary label")
							.setValue(truncConfig.label ?? "")
							.setDisabled(disabled)
							.onChange((value) => {
								const next = { ...this.governance.truncatedStatuses, [status.id]: { enabled: true, label: value } };
								this.governance.truncatedStatuses = next;
								this.onChange({ truncatedStatuses: next });
							})
					);
				}
			}
		}

		new Setting(contentEl).addButton((btn) => btn.setButtonText("Done").setCta().onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class ConfirmModal extends Modal {
	constructor(app: App, private message: string, private confirmLabel: string, private onConfirm: () => void) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("p", { text: this.message });
		new Setting(contentEl)
			.addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((btn) =>
				btn
					.setWarning()
					.setButtonText(this.confirmLabel)
					.onClick(() => {
						this.close();
						this.onConfirm();
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
