import { App, Notice } from "obsidian";
import { CreateOnDiskDeps, ParentExistsDeps, acquireParentLock, createOnDisk, parentExists } from "./create-and-nest";
import { openNameDialog } from "./name-dialog";
import { UnitRef, ViewNode } from "./types";

const ERROR_NOTICE_MS = 8000;
const CONFIRM_LABEL = "Add";

/** PR-3.F2 (G2): "Add under… > File" on the clicked row — a real note at the vault root, nested as
 * the clicked row's last child. Reuses PR-1.S1's shared create-and-hold foundation (`createOnDisk`,
 * `acquireParentLock`, `parentExists` — all from `create-and-nest.ts`) and Create's own name dialog
 * (`openNameDialog`), but never copies `createFromMeta`'s replace-in-place step: the clicked row
 * stays exactly where it is, and the new file becomes its child instead. The dialog opens empty
 * (unlike Create, which prefills a meta folder's current label) and reads "Add" instead of
 * "Create" (G2's wording option on `NameDialogOptions`, PR-3.F2). */
export interface AddUnderFileDeps extends CreateOnDiskDeps, ParentExistsDeps {
	app: App;
	getExcludedFolders(): string[];
	/** The clicked row's own displayed label, right now — a Folder's `label`, or the same resolved
	 * text its row currently shows (basename, or a free block's title/first line). Used verbatim in
	 * the dialog's title ("Add file under <parent>"); computed fresh rather than cached, so a
	 * rename that happened since the row last rendered is still reflected. */
	getParentLabel(viewId: string, parentId: string): Promise<string>;
	/** `ViewsManager.placeUnit` — nests `ref` as the clicked row's last child and returns the new
	 * node, or `null` only if the view itself is gone (not expected mid-flow, but handled the same
	 * way as a vanished parent: a Notice, no node). */
	placeUnit(viewId: string, ref: UnitRef, parentId: string): ViewNode | null;
	/** Expands the clicked row so the new child is visible without a further click (G2). */
	expandParent(viewId: string, parentId: string): void;
	/** Replaces the current bucket selection with exactly the new node's id (E5). */
	selectOnly(nodeId: string): void;
}

function fail(reason: string, extra = ""): void {
	new Notice(`Atlas: couldn't add a file here: ${reason}${extra}`, ERROR_NOTICE_MS);
}

/** PR-3.F2 (G2/E1/E2/E4/E5/E6/F5): takes the same per-parent lock every add-under kind shares
 * (`viewId:parentId`), checks the parent still exists before the name dialog opens and again
 * immediately before nesting (E4 — `placeUnit`'s own silent fallback to the view root must never be
 * reachable from here), then — once the dialog resolves a name (Cancel/Escape/close resolve `null`,
 * G8/E1) — creates `<name>.md` at the vault root with body `# <name>` via the shared `createOnDisk`,
 * nests it as the clicked row's last child, expands the parent and selects the new row. Never opens
 * the file and never replaces or moves the clicked row (F5). Resolves to the new node on success, or
 * `null` on a held lock, cancel, or any failure — the lock is released on every path, and the
 * selection is left untouched by every failing path. */
export async function startAddUnderFile(deps: AddUnderFileDeps, viewId: string, parentId: string): Promise<ViewNode | null> {
	const release = acquireParentLock(viewId, parentId, true);
	if (!release) return null;
	try {
		if (!parentExists(deps, viewId, parentId)) {
			fail("the parent no longer exists");
			return null;
		}
		const parentLabel = await deps.getParentLabel(viewId, parentId);
		const name = await openNameDialog(deps.app, {
			title: `Add file under ${parentLabel}`,
			confirmLabel: CONFIRM_LABEL,
			initialValue: "",
			poolFolder: deps.getPoolFolder(),
			excludedFolders: deps.getExcludedFolders(),
		});
		if (name === null) return null;

		// The parent may have gone while the dialog was open.
		if (!parentExists(deps, viewId, parentId)) {
			fail("the parent no longer exists");
			return null;
		}
		const made = await createOnDisk(deps, "file", name);
		if (!made.ok) {
			fail(made.reason, made.leftover);
			return null;
		}

		// The parent may have gone while the disk step ran (a data sync): don't leave an orphan
		// file behind, and never let `placeUnit` silently fall back to the view root.
		if (!parentExists(deps, viewId, parentId)) {
			const leftover = await made.rollback();
			made.release();
			fail("the parent no longer exists", leftover);
			return null;
		}
		// `deps.placeUnit` is `ViewsManager.placeUnit` in production — synchronous and never throws —
		// but a test double (or a future caller) could; treating a thrown error the same as a null
		// return keeps the rollback/release path the one thing every failure after create goes
		// through, so the new file is never left behind unplaced.
		let node: ViewNode | null;
		try {
			node = deps.placeUnit(viewId, made.ref, parentId);
		} catch {
			node = null;
		}
		if (!node) {
			const leftover = await made.rollback();
			made.release();
			fail("the parent no longer exists", leftover);
			return null;
		}
		// The unit stays held through the nest and is released right after it, so any redraw (the
		// release tells the index's listeners) sees the new node and the unit together, never the
		// unit while it's still unplaced (E7 — the new note must never flash into the Inbox).
		made.release();
		deps.expandParent(viewId, parentId);
		deps.selectOnly(node.id);
		return node;
	} finally {
		release();
	}
}
