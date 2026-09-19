import { StatusDefinition, StatusSet } from "./statuses";

/**
 * PR 16 — a small anchored popup for picking one item from a short list, each optionally with its
 * own colored swatch. A plain Obsidian `Menu` can't render an arbitrary swatch color per item, so
 * this is a purpose-built DOM popup instead — positioning/closing logic ported directly from the
 * reference plugin's own popup (checked its live container build), not guessed at, since Dan wants
 * this interaction "borrowed wholesale."
 */
export interface ChoiceItem {
	id: string;
	label: string;
	color?: string;
}

interface ChoicePopupOptions {
	anchor: HTMLElement;
	items: ChoiceItem[];
	currentId: string | null;
	onSelect: (item: ChoiceItem) => void;
	emptyMessage?: string;
}

/** The currently-open popup's own cleanup, if any — reviewer-caught (A21): a bare `.remove()`
 * (either from a stale-popup sweep or a successful item pick) only detaches the DOM node, not the
 * document-level `mousedown`/`keydown` listeners `positionAndBindClose` registers, leaking one pair
 * per popup that closes this way instead of via its own outside-click/Escape handler. Routing every
 * close through this instead of a direct `.remove()` means there's exactly one way a popup ever
 * shuts down, not two. */
let activePopupClose: (() => void) | null = null;

export function openChoicePopup(opts: ChoicePopupOptions): void {
	activePopupClose?.();

	const doc = opts.anchor.ownerDocument;
	const popup = doc.body.createDiv({ cls: "atlas-choice-popup" });
	if (opts.items.length === 0) {
		popup.createDiv({ cls: "atlas-choice-popup-empty", text: opts.emptyMessage ?? "Nothing to choose from yet." });
	}
	for (const item of opts.items) {
		const row = popup.createDiv({ cls: "atlas-choice-popup-item" });
		if (item.id === opts.currentId) row.addClass("is-active");
		if (item.color) {
			const swatch = row.createSpan({ cls: "atlas-choice-swatch" });
			swatch.setCssStyles({ backgroundColor: item.color });
		}
		row.createSpan({ cls: "atlas-choice-popup-label", text: item.label });
		row.addEventListener("click", (evt) => {
			evt.stopPropagation();
			opts.onSelect(item);
			activePopupClose?.();
		});
	}
	activePopupClose = positionAndBindClose(popup, opts.anchor);
}

/** PR 16: status-specific wrapper over `openChoicePopup` — maps a `StatusSet`'s own statuses to
 * choice items and resolves the picked id back to the real `StatusDefinition` before calling the
 * caller's `onSelect`, matching the reference plugin's own status-popup wrapper (including its
 * exact empty-state copy) rather than reusing the generic empty message. */
export function openStatusPickerPopup(opts: {
	anchor: HTMLElement;
	statusSet: StatusSet;
	currentStatusId: string | null;
	onSelect: (status: StatusDefinition) => void;
}): void {
	openChoicePopup({
		anchor: opts.anchor,
		items: opts.statusSet.statuses.map((s) => ({ id: s.id, label: s.label, color: s.color })),
		currentId: opts.currentStatusId,
		emptyMessage: "No statuses defined yet — add some in settings.",
		onSelect: (item) => {
			const status = opts.statusSet.statuses.find((s) => s.id === item.id);
			if (status) opts.onSelect(status);
		},
	});
}

/** Positions the popup just below-left of `anchor`, flipping above/clamping right if it would
 * overflow the viewport (checked one frame later, once the popup has real dimensions) — then wires
 * outside-click (capture phase, deferred registration so the same click that opened it doesn't
 * immediately close it) and Escape to close. Exact port of the reference plugin's own positioning
 * function. */
function positionAndBindClose(popup: HTMLElement, anchor: HTMLElement): () => void {
	const win = anchor.ownerDocument.defaultView ?? window;
	const doc = anchor.ownerDocument;
	const anchorRect = anchor.getBoundingClientRect();
	popup.setCssStyles({
		position: "fixed",
		left: `${Math.round(anchorRect.left)}px`,
		top: `${Math.round(anchorRect.bottom + 4)}px`,
	});
	win.requestAnimationFrame(() => {
		const popupRect = popup.getBoundingClientRect();
		if (popupRect.bottom > win.innerHeight) {
			popup.setCssStyles({ top: `${Math.max(4, Math.round(anchorRect.top - popupRect.height - 4))}px` });
		}
		if (popupRect.right > win.innerWidth) {
			popup.setCssStyles({ left: `${Math.max(4, Math.round(win.innerWidth - popupRect.width - 4))}px` });
		}
	});

	const close = () => {
		popup.remove();
		doc.removeEventListener("mousedown", onMouseDown, true);
		doc.removeEventListener("keydown", onKeyDown, true);
		if (activePopupClose === close) activePopupClose = null;
	};
	const onMouseDown = (evt: MouseEvent) => {
		if (!popup.contains(evt.target as Node)) close();
	};
	const onKeyDown = (evt: KeyboardEvent) => {
		if (evt.key === "Escape") close();
	};
	win.setTimeout(() => {
		doc.addEventListener("mousedown", onMouseDown, true);
		doc.addEventListener("keydown", onKeyDown, true);
	}, 0);

	return close;
}
