import { App, DropdownComponent, Modal, Setting } from "obsidian";
import { StatusSet } from "./statuses";

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

/** PR 15: the minimal "Statuses" modal — a master on/off toggle plus which status set governs this
 * node's own status. No inherit/hide/apply-to/truncate fields yet (PR 16). Applies live on every
 * change (matching PR 16's own framing of a persistent, greyed-out-until-enabled modal) rather
 * than a draft-then-submit OK/Cancel pattern, since there's nothing here worth batching. */
export class StatusesModal extends Modal {
	private enabled: boolean;
	private statusSetId: string | null;
	private setDropdown: DropdownComponent | null = null;

	constructor(
		app: App,
		private statusSets: StatusSet[],
		initialEnabled: boolean,
		initialStatusSetId: string | null,
		private onChange: (enabled: boolean, statusSetId: string | null) => void
	) {
		super(app);
		this.enabled = initialEnabled;
		this.statusSetId = initialStatusSetId ?? statusSets[0]?.id ?? null;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Statuses" });

		new Setting(contentEl)
			.setName("Enable statuses")
			.addToggle((toggle) =>
				toggle.setValue(this.enabled).onChange((value) => {
					this.enabled = value;
					this.setDropdown?.setDisabled(!this.enabled || this.statusSets.length === 0);
					this.onChange(this.enabled, this.statusSetId);
				})
			);

		new Setting(contentEl).setName("Status set").addDropdown((dropdown) => {
			this.setDropdown = dropdown;
			if (this.statusSets.length === 0) {
				dropdown.addOption("", "Create a status set first");
			} else {
				for (const set of this.statusSets) dropdown.addOption(set.id, set.name);
				dropdown.setValue(this.statusSetId ?? this.statusSets[0].id);
			}
			dropdown.setDisabled(!this.enabled || this.statusSets.length === 0);
			dropdown.onChange((value) => {
				this.statusSetId = value || null;
				this.onChange(this.enabled, this.statusSetId);
			});
		});

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
