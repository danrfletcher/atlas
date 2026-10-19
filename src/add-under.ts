import { Menu } from "obsidian";
import { View, ViewNode } from "./types";

/** PR-2.F1 (G7): what "Add under…" can create, in menu order. Distinct from create-and-nest's/
 * create-from-meta's `CreateKind` (block/file/module only): Add under also offers Folder — a
 * data-only meta node with no disk create — which "Replace with…"/"Create" never offer, since a
 * Folder can't replace itself with another Folder. PR-2.F2 (Folder) and PR-3.F1-F3
 * (Block/File/Module) give each kind its own create-and-nest flow; this PR only defines the list
 * and the no-op seam below. */
export type AddUnderKind = "block" | "file" | "module" | "folder";

export const ADD_UNDER_KINDS: ReadonlyArray<{ kind: AddUnderKind; label: string; icon: string }> = [
	{ kind: "block", label: "Block", icon: "square" },
	{ kind: "file", label: "File", icon: "file" },
	{ kind: "module", label: "Module", icon: "folder" },
	{ kind: "folder", label: "Folder", icon: "layers" },
];

export const ADD_UNDER_ITEM_TITLE = "Add under…";

export interface CanAddUnderDeps {
	/** The same owner lookup `ExplorerView.isOutsideManagedUnit` already uses, lifted to a plain
	 * function so the eligibility rule below needs neither the view's own private method nor any
	 * Obsidian API — a test can stub it with a plain `ViewNode` fixture map. */
	getNode(viewId: string, nodeId: string): ViewNode | null | undefined;
}

/** The two pieces of render-time state `canAddUnder` can't derive from a bare `ViewNode` (G7:
 * "not offered on a missing row or a greyed 'filtered out' row"). Callers must compute both fresh
 * from the live node right before building the menu — never reuse state captured at the row's last
 * render — so a row that became ineligible since then (e.g. a data source was just added) is judged
 * correctly at menu-build time, not render time. */
export interface AddUnderRowState {
	missing?: boolean;
	filteredOut?: boolean;
}

/** True only for a `folderSourceManaged` node whose owning source is specifically Outside-Vault —
 * mirrors `ExplorerView.isOutsideManagedUnit` exactly. A hand-made Folder nested under an
 * Outside-Vault source is never `folderSourceManaged`, so it falls through untouched and stays
 * eligible: only `isOutsideManagedUnit` rows themselves are excluded. */
function isOutsideManagedUnit(deps: CanAddUnderDeps, viewId: string, node: ViewNode): boolean {
	if (!node.folderSourceManaged || !node.folderSourceOwnerId) return false;
	const owner = deps.getNode(viewId, node.folderSourceOwnerId);
	return owner?.folderSource?.location === "outside";
}

/** The one eligibility rule for "Add under…" (G6/G7/E8). Both `showUnitMenu` and
 * `showMetaFolderMenu` call this at menu-build time, and every test drives it directly, so the rule
 * lives in exactly one place. Excludes: any node with a data source configured (`folderSource`,
 * `apiSource`, `csvSource` or `markdownTableSource`), a missing or filtered-out row (`rowState`),
 * and a child of an Outside-Vault Folder source. A unit row (block, file or module) or a Folder row,
 * at any nesting depth — including a child of an Inside-Vault Folder source, and a hand-made Folder
 * nested under an Outside-Vault source — stays eligible. */
export function canAddUnder(deps: CanAddUnderDeps, viewId: string, node: ViewNode, rowState: AddUnderRowState = {}): boolean {
	if (rowState.missing || rowState.filteredOut) return false;
	if (node.apiSource || node.csvSource || node.markdownTableSource || node.folderSource) return false;
	if (isOutsideManagedUnit(deps, viewId, node)) return false;
	return true;
}

/** Adds "Add under…" to a unit or Folder row's menu. Placement (G6: directly above "Duplicate
 * (Meta)" on a unit row, directly above "Replace with…" on a Folder row) is entirely the caller's
 * job — this only builds the one item. Obsidian's `Menu` has no submenu API, so choosing it pops a
 * second menu with Block, File, Module and Folder at the same click position, exactly as
 * "Replace with…"/"Create" already does. Every choice calls `onChoose` with its own kind and
 * nothing else — dismissing the chooser (Esc or click-away) calls nothing. */
export function addAddUnderItem(menu: Menu, evt: Pick<MouseEvent, "clientX" | "clientY">, onChoose: (kind: AddUnderKind) => void): void {
	menu.addItem((item) =>
		item
			.setTitle(ADD_UNDER_ITEM_TITLE)
			.setIcon("corner-down-right")
			.onClick(() => {
				const chooser = new Menu();
				for (const { kind, label, icon } of ADD_UNDER_KINDS) {
					chooser.addItem((entry) => entry.setTitle(label).setIcon(icon).onClick(() => onChoose(kind)));
				}
				chooser.showAtPosition({ x: evt.clientX, y: evt.clientY });
			})
	);
}

/** PR-2.F1: the seam every "Add under" choice calls, with the clicked row's own `view`/`node`. Left
 * a no-op here — no dialog, no Notice, no disk or tree change — until PR-2.F2 (Folder) and
 * PR-3.F1-F3 (Block/File/Module) fill it in with the real create-and-nest flow for each kind. */
export function startAddUnder(kind: AddUnderKind, view: View, node: ViewNode): void {
	// Intentional no-op (PR-2.F1 scope: menu entry, eligibility and placement only).
}
