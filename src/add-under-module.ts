import { App, Notice } from "obsidian";
import { CreateOnDiskDeps, ParentExistsDeps, acquireParentLock, createOnDisk, parentExists } from "./create-and-nest";
import { openNameDialog } from "./name-dialog";
import { UnitRef, ViewNode } from "./types";

const ERROR_NOTICE_MS = 8000;
const CONFIRM_LABEL = "Add";

/** PR-3.F3 (G3): "Add under… > Module" on the clicked row — a real folder-plus-note module at the
 * vault root, nested as the clicked row's last child. Mirrors `add-under-file.ts` (PR-3.F2) almost
 * exactly: same shared create-and-hold foundation (`createOnDisk`, `acquireParentLock`,
 * `parentExists` — all from `create-and-nest.ts`), same name dialog (`openNameDialog`, title "Add
 * module under <parent>", button "Add", empty prefill, full validation, the same clash rule as
 * Create), same `placeNewUnit` nest (never `placeUnit` — see `add-under-file.ts`'s own doc comment
 * for why a brand-new node, not a relocation, is the only safe choice here too). The only
 * difference is the on-disk shape: `createOnDisk(deps, "module", name)` makes `<name>/<name>.md`
 * (folder plus its interface note) instead of a lone file, and the resulting ref is `{ kind:
 * "folder", path: "<name>" }`. Never copies `createFromMeta`'s replace-in-place step: the clicked
 * row stays exactly where it is, and the new module becomes its child instead. */
export interface AddUnderModuleDeps extends CreateOnDiskDeps, ParentExistsDeps {
	app: App;
	getExcludedFolders(): string[];
	/** The clicked row's own displayed label, right now — same contract as `AddUnderFileDeps.getParentLabel`. */
	getParentLabel(viewId: string, parentId: string): Promise<string>;
	/** `ViewsManager.placeNewUnit` — nests `ref` as a brand-new node, always the clicked row's last
	 * child, and returns it, or `null` only if the view itself is gone. See `add-under-file.ts`'s
	 * own doc comment on `placeNewUnit` for the full reasoning (never `placeUnit`: that would risk
	 * relocating an existing node sharing the same freshly-typed ref instead of creating a new one). */
	placeNewUnit(viewId: string, ref: UnitRef, parentId: string): ViewNode | null;
	/** Expands the clicked row so the new child is visible without a further click (G3). */
	expandParent(viewId: string, parentId: string): void;
	/** Replaces the current bucket selection with exactly the new node's id (E5). */
	selectOnly(nodeId: string): void;
}

function fail(reason: string, extra = ""): void {
	new Notice(`Atlas: couldn't add a module here: ${reason}${extra}`, ERROR_NOTICE_MS);
}

/** PR-3.F3 (G3/E1/E2/E4/E5/E6/F5): takes the same per-parent lock every add-under kind shares
 * (`viewId:parentId`), checks the parent still exists before the name dialog opens and again
 * immediately before nesting (E4), then — once the dialog resolves a name (Cancel/Escape/close
 * resolve `null`, G8/E1) — creates `<name>/<name>.md` at the vault root with body `# <name>` via
 * the shared `createOnDisk`, nests it as the clicked row's last child, expands the parent and
 * selects the new row. Never opens the module and never replaces or moves the clicked row (F5).
 * Resolves to the new node on success, or `null` on a held lock, cancel, or any failure — the lock
 * is released on every path, and the selection is left untouched by every failing path. */
export async function startAddUnderModule(deps: AddUnderModuleDeps, viewId: string, parentId: string): Promise<ViewNode | null> {
	const release = acquireParentLock(viewId, parentId, true);
	if (!release) return null;
	try {
		if (!parentExists(deps, viewId, parentId)) {
			fail("the parent no longer exists");
			return null;
		}
		const parentLabel = await deps.getParentLabel(viewId, parentId);
		const name = await openNameDialog(deps.app, {
			title: `Add module under ${parentLabel}`,
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
		const made = await createOnDisk(deps, "module", name);
		if (!made.ok) {
			fail(made.reason, made.leftover);
			return null;
		}

		// The parent may have gone while the disk step ran (a data sync): don't leave an orphan
		// module behind, and never let `placeNewUnit` silently fall back to the view root.
		if (!parentExists(deps, viewId, parentId)) {
			const leftover = await made.rollback();
			made.release();
			fail("the parent no longer exists", leftover);
			return null;
		}
		// `deps.placeNewUnit` is `ViewsManager.placeNewUnit` in production — synchronous and never
		// throws — but a test double (or a future caller) could; treating a thrown error the same
		// as a null return keeps the rollback/release path the one thing every failure after
		// create goes through, so the new module is never left behind unplaced.
		let node: ViewNode | null;
		try {
			node = deps.placeNewUnit(viewId, made.ref, parentId);
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
		// unit while it's still unplaced (E7 — the new module must never flash into the Inbox).
		made.release();
		deps.expandParent(viewId, parentId);
		deps.selectOnly(node.id);
		return node;
	} finally {
		release();
	}
}
