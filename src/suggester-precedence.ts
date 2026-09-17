import { App, EditorSuggest } from "obsidian";

/**
 * F6 — winning precedence over Obsidian's native `[[` suggester. `Workspace.editorSuggest` is not
 * part of the public typings; Obsidian registers the core link suggester before community plugins,
 * and its manager picks the FIRST registered suggest whose `onTrigger` fires (one popup, never a
 * merge) — so moving our instance to the front of that array is what lets Atlas's suggestions win.
 * Touched only through this narrow interface, wrapped in try/catch: if the internal shape ever
 * changes, the catch just leaves Atlas registered at ordinary precedence (native wins for `[[`,
 * degraded functionality) rather than throwing or producing a second popup. See docs/decisions.md.
 */
interface EditorSuggestManager {
	suggests: unknown[];
}

interface WorkspaceWithSuggest {
	editorSuggest?: EditorSuggestManager;
}

function getSuggestList(app: App): unknown[] | null {
	const manager = (app.workspace as unknown as WorkspaceWithSuggest).editorSuggest;
	return Array.isArray(manager?.suggests) ? manager.suggests : null;
}

/** Call once, after layout is ready (so the native suggester is already registered). */
export function applySuggesterPrecedence(app: App, suggester: EditorSuggest<unknown>): void {
	try {
		const list = getSuggestList(app);
		if (!list) return;
		const idx = list.indexOf(suggester);
		if (idx !== -1) list.splice(idx, 1);
		list.unshift(suggester);
	} catch {
		// Internal shape changed — leave it as an ordinary registered suggest.
	}
}

/** Call on unload — restores original relative order rather than leaving the array permanently
 * mutated. `registerEditorSuggest`'s own disposer handles actually deregistering the instance. */
export function removeSuggesterPrecedence(app: App, suggester: EditorSuggest<unknown>): void {
	try {
		const list = getSuggestList(app);
		if (!list) return;
		const idx = list.indexOf(suggester);
		if (idx !== -1) {
			list.splice(idx, 1);
			list.push(suggester);
		}
	} catch {
		// Nothing to restore if the internal shape changed.
	}
}
