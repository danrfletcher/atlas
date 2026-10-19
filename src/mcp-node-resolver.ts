import { ApiItemState, UnitRef, View, ViewNode } from "./types";

/**
 * PR-2.F1: the one piece of addressing logic every status tool shares (G7's own phrasing: "this
 * is the same rule G7's list_nodes/G2/G3 all share, tested once as shared addressing logic, not
 * duplicated per tool"). Works purely over a `View`'s own `root: ViewNode[]` tree — no
 * `ViewsManager`/`App` needed — so `tests/unit/mcp-node-resolver.test.ts` can build minimal
 * fixtures by hand.
 *
 * A node is addressed by node id, or by vault path only when that path matches exactly one node
 * in the view (Q2/E6) — ambiguous paths are refused, listing every match and its node id. Besides
 * real `ViewNode`s, every API/CSV/markdown-table placeholder row (`ViewNode.apiItemState`) is also
 * addressable by its own owner-qualified id — it has no real `ViewNode` of its own (see
 * `pseudoNodeForApiItem`), but the caller still needs some id to name it by (G3: "the right
 * storage location is chosen automatically from what was resolved, the caller never says which
 * kind it is").
 *
 * R1 fix: a placeholder row's own `ApiItemState.id` (the external source's own id field, or
 * `unitRefKey(ref)` for a demoted Folder-source row) is unique only *within* its owning node — two
 * different Folders/CSVs/tables in the same view can both have a row literally called "1". Node-id
 * lookup used to match on that raw id alone (`walkView(view).find((t) => t.id === address.nodeId)`),
 * so the wrong owner's row could silently be written to. Every placeholder row's address is now
 * `apiItemAddress(ownerId, itemId)` — an owner-qualified composite that is unique by construction
 * (a `ViewNode.id` is already unique within the view, and an item id is already unique within its
 * own owner's `apiItemState`) — see `docs/decisions.md` for the format and the alternative
 * considered. `resolveMcpAddress`'s id lookup also now refuses outright (`McpAmbiguousNodeIdError`)
 * if more than one target still shares an id, rather than silently taking the first — belt-and-
 * suspenders once the composite address already makes that practically unreachable.
 */

/** `ancestors[0]` is the nearest governor (the node's/item's direct container, or the view root
 * for a top-level item); `ancestors[ancestors.length - 1]` is the furthest — exactly the order
 * `StatusesManager.resolveNodeStatus`/`findGoverningAncestor` already expect. `View` and
 * `ViewNode` both satisfy `StatusGovernance` structurally, so this is interchangeable with a
 * `StatusGovernance[]` everywhere those two methods are called. */
export type McpAncestorChain = (View | ViewNode)[];

/** What `resolveMcpAddress` found: either a real `ViewNode`, or a synthetic placeholder row living
 * in some node's `apiItemState` (never a real `ViewNode` of its own). */
export type McpResolvedTarget =
	| { kind: "node"; id: string; node: ViewNode; ancestors: McpAncestorChain }
	| { kind: "api-item"; id: string; owner: ViewNode; item: ApiItemState; ancestors: McpAncestorChain };

/** R1 fix: the owner-qualified address a placeholder row is found and returned by — see this
 * file's own doc comment for why a bare `ApiItemState.id` isn't safe to address by alone.
 * `encodeURIComponent` escapes `:` (not in its unescaped set), so joining the two encoded halves
 * with a literal `"::"` can never itself appear inside either half — the composite can't collide
 * across two different (ownerId, itemId) pairs the way a single fixed-width separator could. */
export function apiItemAddress(ownerId: string, itemId: string): string {
	return `${encodeURIComponent(ownerId)}::${encodeURIComponent(itemId)}`;
}

/** G8 (ported here rather than imported from `explorer-view.ts`, which is UI code this module has
 * no business depending on): a throwaway pseudo-`ViewNode` so a placeholder row can go through the
 * exact same `resolveNodeStatus`/`findGoverningAncestor` machinery as a real node. Deliberately has
 * no `ref` — matches `ExplorerView.pseudoNodeForApiItem` exactly, so a status write made through
 * this MCP tool resolves applyTo-kind-exclusion identically to a click on the row's own dot in the
 * UI, rather than introducing a second, slightly different notion of "what kind is this row". */
export function pseudoNodeForApiItem(item: ApiItemState): ViewNode {
	return { id: item.id, type: "unit", children: [], explicitStatusId: item.explicitStatusId };
}

/** The `ViewNode`-shaped object whose `explicitStatusId`/kind governance machinery should actually
 * resolve against, for either kind of resolved target. */
export function pseudoNodeForTarget(target: McpResolvedTarget): ViewNode {
	return target.kind === "node" ? target.node : pseudoNodeForApiItem(target.item);
}

/** R3 fix: the two render-time visibility checks `ExplorerView.visibleFolderSourceRows` applies
 * before a row ever reaches the screen — reused here so the MCP's own node tree, and the ancestor
 * chain status resolution walks, match what the explorer actually shows rather than diverging from
 * it. Both default to "always visible" (see `alwaysVisible` below) so every hand-built fixture in
 * `tests/unit/mcp-node-resolver.test.ts` that doesn't care about this keeps working unchanged. */
export interface McpRowVisibility {
	/** True for a row hidden by its Folder source's own YAML rules (merge/overwrite, `managedRowFilterState`
	 * === "hidden") — mirrors `ExplorerView.visibleFolderSourceRows`'s `isHiddenRow`. */
	isHidden(node: ViewNode): boolean;
	/** True for an Outside-Vault-managed row whose source doesn't currently resolve on this device —
	 * mirrors `ExplorerView.isOutsideManagedAndUnresolved`. */
	isUnresolvedOutside(node: ViewNode): boolean;
}

/** The default used whenever no `McpRowVisibility` is supplied: every row is visible, matching
 * this module's pre-R3 behaviour exactly (no app/`ViewsManager` available, as in a bare unit-test
 * fixture with no Folder sources at all). */
export const alwaysVisible: McpRowVisibility = { isHidden: () => false, isUnresolvedOutside: () => false };

/** R3 fix: the exact row-visibility/ancestor-lifting rule `ExplorerView.visibleFolderSourceRows`
 * applies to one level of siblings, ported here so `walkView` (this file) and `list_nodes`'s own
 * tree-summarizing walk (`mcp-status-tools.ts`) both apply it identically instead of each guessing
 * at their own version of it.
 *
 * An Outside-Vault-managed row that doesn't currently resolve on this device is dropped along with
 * its whole subtree (the UI renders it "as if it doesn't exist" — see
 * `ExplorerView.isOutsideManagedAndUnresolved`'s own doc comment). A row hidden by its Folder
 * source's YAML rules is dropped and never itself addressable, but its own children are lifted
 * into its place — governed with the hidden row appended to the *end* of their ancestor chain
 * (the furthest governor, not the nearest: a closer, visible governor still wins), matching the
 * UI's own `liftedAncestors = [...ancestors, node]`. Bug-compatible with the UI on purpose: a
 * lifted child that is itself hidden/unresolved is dropped outright rather than lifted a second
 * level — `visibleFolderSourceRows` only checks one level of its own lifted children, so a doubly-
 * hidden row's own children never resurface in the UI either. */
export function visibleChildRows(nodes: ViewNode[], ancestors: McpAncestorChain, visibility: McpRowVisibility): { node: ViewNode; ancestors: McpAncestorChain }[] {
	const rows: { node: ViewNode; ancestors: McpAncestorChain }[] = [];
	for (const node of nodes) {
		if (visibility.isUnresolvedOutside(node)) continue;
		if (!visibility.isHidden(node)) {
			rows.push({ node, ancestors });
			continue;
		}
		const liftedAncestors: McpAncestorChain = [...ancestors, node];
		for (const child of node.children) {
			if (visibility.isUnresolvedOutside(child) || visibility.isHidden(child)) continue;
			rows.push({ node: child, ancestors: liftedAncestors });
		}
	}
	return rows;
}

/** Every addressable target in `view`, found by one flat walk — visible `ViewNode`s (meta and
 * unit) depth-first via `visibleChildRows` (R3: skips/lifts exactly as the explorer does), each
 * immediately followed by its own placeholder rows (if any, owner-qualified per `apiItemAddress`),
 * before descending into its children. Mirrors `ExplorerView.renderNodeList`'s own ancestor
 * bookkeeping: a node's placeholder rows and its real children both see `[node, ...ancestorsOfNode]`
 * as their own ancestor chain — a placeholder row behaves exactly like one more child of the node
 * that owns it. */
function walkView(view: View, visibility: McpRowVisibility): McpResolvedTarget[] {
	const out: McpResolvedTarget[] = [];
	const visit = (nodes: ViewNode[], ancestors: McpAncestorChain): void => {
		for (const { node, ancestors: rowAncestors } of visibleChildRows(nodes, ancestors, visibility)) {
			out.push({ kind: "node", id: node.id, node, ancestors: rowAncestors });
			const childAncestors: McpAncestorChain = [node, ...rowAncestors];
			if (node.apiItemOrder) {
				for (const itemId of node.apiItemOrder) {
					const item = node.apiItemState?.[itemId];
					if (!item) continue; // E7 fence: a stale order entry is skipped, never surfaced as a target
					out.push({ kind: "api-item", id: apiItemAddress(node.id, item.id), owner: node, item, ancestors: childAncestors });
				}
			} else if (node.apiItemState) {
				// Defensive fallback for a hand-built fixture/corrupt state with no `apiItemOrder` at
				// all — every real write path keeps the two in sync, but this still makes every stored
				// row addressable rather than silently invisible to these tools.
				for (const itemId of Object.keys(node.apiItemState)) {
					const item = node.apiItemState[itemId];
					out.push({ kind: "api-item", id: apiItemAddress(node.id, item.id), owner: node, item, ancestors: childAncestors });
				}
			}
			visit(node.children, childAncestors);
		}
	};
	visit(view.root, [view]);
	return out;
}

/** `ref`'s own "vault path" string for addressing purposes: a file/folder's path verbatim, or a
 * block's `path#subpath` (the same shape as an Obsidian link target) — a judgement call where the
 * spec names "vault path" without pinning down a block's own string form. */
function vaultPathOf(ref: UnitRef): string {
	return ref.kind === "block" ? `${ref.path}#${ref.subpath}` : ref.path;
}

/** A short, human-readable breadcrumb for a resolved target — used only to make an ambiguous-path
 * or ambiguous-id refusal's "every match and its ancestry context" (GP6) readable, never persisted
 * or compared. */
export function describeMcpTarget(target: McpResolvedTarget): string {
	const trail: string[] = [];
	for (let i = target.ancestors.length - 1; i >= 0; i--) {
		const ancestor = target.ancestors[i];
		trail.push("root" in ancestor ? ancestor.name : ancestor.label ?? ancestor.ref?.path ?? ancestor.id);
	}
	trail.push(target.kind === "node" ? target.node.label ?? target.node.ref?.path ?? target.node.id : target.item.label ?? target.item.id);
	return trail.join(" > ");
}

/** E3: a node id that doesn't exist anywhere in `view`. */
export class McpNodeNotFoundError extends Error {}
/** E6: a path that matches more than one node in `view` — `matches` is every resolved target found,
 * in the order `walkView` found them, so the caller can list each one's id and ancestry context. */
export class McpAmbiguousPathError extends Error {
	constructor(
		path: string,
		viewName: string,
		public readonly matches: McpResolvedTarget[]
	) {
		super(
			`Path "${path}" matches ${matches.length} nodes in view "${viewName}": ` +
				matches.map((m) => `nodeId "${m.id}" (${describeMcpTarget(m)})`).join("; ") +
				`. Retry with one specific nodeId.`
		);
	}
}
/** R1 fix: a node id that, in principle, still matched more than one target — unreachable in
 * practice now that a placeholder row's id is owner-qualified by construction (see this file's
 * own doc comment), but refused explicitly rather than silently resolving the first match, the
 * same "nothing is refused" guarantee E6 already gives ambiguous paths. */
export class McpAmbiguousNodeIdError extends Error {
	constructor(
		nodeId: string,
		viewName: string,
		public readonly matches: McpResolvedTarget[]
	) {
		super(
			`Node id "${nodeId}" matches ${matches.length} targets in view "${viewName}": ` +
				matches.map((m) => describeMcpTarget(m)).join("; ") +
				`. This should not be possible — please report it.`
		);
	}
}

/**
 * Resolves `address` (exactly one of `nodeId`/`path` must be set — enforced by the caller, not
 * here) against `view`. Throws `McpNodeNotFoundError` for an unknown id or a path with zero
 * matches (E3), `McpAmbiguousPathError` for a path with more than one match (E6), or
 * `McpAmbiguousNodeIdError` for an id with more than one match (R1) — all three carry a message
 * naming `viewName` (the view actually searched), per E3/E6's own wording. `visibility` (R3)
 * defaults to "every row visible" when omitted, matching this function's pre-R3 behaviour.
 */
export function resolveMcpAddress(view: View, viewName: string, address: { nodeId?: string; path?: string }, visibility: McpRowVisibility = alwaysVisible): McpResolvedTarget {
	if (address.nodeId !== undefined) {
		const matches = walkView(view, visibility).filter((t) => t.id === address.nodeId);
		if (matches.length === 0) throw new McpNodeNotFoundError(`No node with id "${address.nodeId}" was found in view "${viewName}".`);
		if (matches.length > 1) throw new McpAmbiguousNodeIdError(address.nodeId, viewName, matches);
		return matches[0];
	}
	const path = address.path as string;
	const matches = walkView(view, visibility).filter((t) => t.kind === "node" && t.node.type === "unit" && t.node.ref && vaultPathOf(t.node.ref) === path);
	if (matches.length === 0) throw new McpNodeNotFoundError(`No node at path "${path}" was found in view "${viewName}".`);
	if (matches.length > 1) throw new McpAmbiguousPathError(path, viewName, matches);
	return matches[0];
}

/** Validates that exactly one of `nodeId`/`path` was given in a tool call's raw arguments —
 * shared by every tool that addresses a single node (`get_node_status`, `set_node_status`,
 * `list_nodes`'s optional `parentNodeId` uses only the `nodeId` half of this contract directly). */
export function extractMcpAddress(args: Record<string, unknown>): { nodeId?: string; path?: string } {
	const nodeId = typeof args.nodeId === "string" && args.nodeId.length > 0 ? args.nodeId : undefined;
	const path = typeof args.path === "string" && args.path.length > 0 ? args.path : undefined;
	if (nodeId !== undefined && path !== undefined) throw new Error('Provide either "nodeId" or "path", not both.');
	if (nodeId === undefined && path === undefined) throw new Error('Either "nodeId" or "path" must be provided to address a node.');
	return { nodeId, path };
}
