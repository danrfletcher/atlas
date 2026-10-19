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
 * addressable by its own row id — it has no real `ViewNode` of its own (see
 * `pseudoNodeForApiItem`), but the caller still needs some id to name it by by (G3: "the right
 * storage location is chosen automatically from what was resolved, the caller never says which
 * kind it is").
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

/** Every addressable target in `view`, found by one flat walk — real `ViewNode`s (meta and unit)
 * depth-first, each immediately followed by its own placeholder rows (if any), before descending
 * into its children. Mirrors `ExplorerView.renderNodeList`'s own ancestor bookkeeping: a node's
 * placeholder rows and its real children both see `[node, ...ancestorsOfNode]` as their own
 * ancestor chain — a placeholder row behaves exactly like one more child of the node that owns it. */
function walkView(view: View): McpResolvedTarget[] {
	const out: McpResolvedTarget[] = [];
	const visit = (nodes: ViewNode[], ancestors: McpAncestorChain): void => {
		for (const node of nodes) {
			out.push({ kind: "node", id: node.id, node, ancestors });
			const childAncestors: McpAncestorChain = [node, ...ancestors];
			if (node.apiItemOrder) {
				for (const itemId of node.apiItemOrder) {
					const item = node.apiItemState?.[itemId];
					if (!item) continue; // E7 fence: a stale order entry is skipped, never surfaced as a target
					out.push({ kind: "api-item", id: item.id, owner: node, item, ancestors: childAncestors });
				}
			} else if (node.apiItemState) {
				// Defensive fallback for a hand-built fixture/corrupt state with no `apiItemOrder` at
				// all — every real write path keeps the two in sync, but this still makes every stored
				// row addressable rather than silently invisible to these tools.
				for (const itemId of Object.keys(node.apiItemState)) {
					const item = node.apiItemState[itemId];
					out.push({ kind: "api-item", id: item.id, owner: node, item, ancestors: childAncestors });
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
 * refusal's "every match and its ancestry context" (GP6) readable, never persisted or compared. */
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

/**
 * Resolves `address` (exactly one of `nodeId`/`path` must be set — enforced by the caller, not
 * here) against `view`. Throws `McpNodeNotFoundError` for an unknown id or a path with zero
 * matches (E3), or `McpAmbiguousPathError` for a path with more than one match (E6) — both carry a
 * message naming `viewName` (the view actually searched), per E3/E6's own wording.
 */
export function resolveMcpAddress(view: View, viewName: string, address: { nodeId?: string; path?: string }): McpResolvedTarget {
	if (address.nodeId !== undefined) {
		const found = walkView(view).find((t) => t.id === address.nodeId);
		if (!found) throw new McpNodeNotFoundError(`No node with id "${address.nodeId}" was found in view "${viewName}".`);
		return found;
	}
	const path = address.path as string;
	const matches = walkView(view).filter((t) => t.kind === "node" && t.node.type === "unit" && t.node.ref && vaultPathOf(t.node.ref) === path);
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
