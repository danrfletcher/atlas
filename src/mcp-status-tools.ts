import { McpTool } from "./mcp-protocol";
import { McpAncestorChain, extractMcpAddress, pseudoNodeForApiItem, pseudoNodeForTarget, resolveMcpAddress } from "./mcp-node-resolver";
import { StatusDefinition, StatusesManager } from "./statuses";
import { ApiItemState, UnitRef, View, ViewNode } from "./types";
import { ViewsManager } from "./views";

/**
 * PR-2.F1: the read and status-write MCP tools built on top of PR-1.S1's HTTP/JSON-RPC scaffold —
 * `list_views`, `list_nodes`, `list_status_sets`, `get_node_status`, `set_node_status`. No file,
 * folder or node-placement mutation lives here (the PR's own fence, F2): every write only ever
 * assigns `ViewNode.explicitStatusId` (via the existing `ViewsManager.setExplicitStatus`) or an
 * API/CSV/markdown-table row's `apiItemState[rowId].explicitStatusId` (via the existing
 * `ViewsManager.setApiItemStatus`) — both already go through `ViewsManager`'s own save path
 * (`save()` -> `persist()` + `notifyChange()`), so a status write here re-renders and saves
 * exactly the way clicking a status dot in the explorer already does.
 */

export interface McpStatusToolsContext {
	getViewsManager: () => ViewsManager;
	getStatusesManager: () => StatusesManager;
	/** Q5: every reply names the vault this server is attached to, so an agent that reaches the
	 * wrong vault's server (several vaults, one device, each its own port) notices immediately. */
	getVaultName: () => string;
	getVaultPath: () => string;
}

interface VaultIdentity {
	name: string;
	path: string;
}

function vaultIdentity(ctx: McpStatusToolsContext): VaultIdentity {
	return { name: ctx.getVaultName(), path: ctx.getVaultPath() };
}

function viewIdentity(view: View): { id: string; name: string } {
	return { id: view.id, name: view.name };
}

/** Case/whitespace-insensitive view lookup by id first (exact), then by name — `view: "Job Hunt"`
 * in every spec example is a name, not an id, but accepting either costs nothing and matches how
 * every other address in this file (node id or path) already accepts more than one kind of key. */
function findView(viewsManager: ViewsManager, viewArg: string): View | null {
	const byId = viewsManager.getView(viewArg);
	if (byId) return byId;
	const lower = viewArg.trim().toLowerCase();
	return viewsManager.getViews().find((v) => v.name.trim().toLowerCase() === lower) ?? null;
}

/** Q3: read tools default to the open view when `view` is omitted. */
function resolveViewForRead(viewsManager: ViewsManager, viewArg: unknown): View {
	if (typeof viewArg === "string" && viewArg.trim().length > 0) {
		const view = findView(viewsManager, viewArg);
		if (!view) throw new Error(`No view named or with id "${viewArg}" was found.`);
		return view;
	}
	return viewsManager.getActiveView();
}

/** E7: write tools never fall back to the active view — a missing `view` argument is refused
 * outright, not silently defaulted. */
function resolveViewForWrite(viewsManager: ViewsManager, viewArg: unknown): View {
	if (typeof viewArg !== "string" || viewArg.trim().length === 0) {
		throw new Error('set_node_status requires a "view" argument naming the view to write to; unlike the read tools, it never falls back to the active view.');
	}
	const view = findView(viewsManager, viewArg);
	if (!view) throw new Error(`No view named or with id "${viewArg}" was found.`);
	return view;
}

function statusSummary(status: StatusDefinition): { id: string; label: string; color: string } {
	return { id: status.id, label: status.label, color: status.color };
}

/** PR-2.F1 (G7): one view's node tree, nested — a node's own placeholder (API/CSV/markdown-table)
 * rows are folded in as `"api-item"`-typed children right behind its real children, mirroring
 * `renderNodeList`'s own ordering, so `list_nodes` is the one place an agent discovers every id
 * `get_node_status`/`set_node_status` can later address (G3's placeholder rows have no `ViewNode`
 * of their own to otherwise be found by). */
export interface McpNodeSummary {
	id: string;
	type: "meta" | "unit" | "api-item";
	label?: string;
	ref?: UnitRef;
	explicitStatusId: string | null;
	resolvedStatus: { id: string; label: string; color: string } | null;
	children: McpNodeSummary[];
}

function summarizeApiItem(item: ApiItemState, ancestors: McpAncestorChain, sm: StatusesManager): McpNodeSummary {
	const pseudo = pseudoNodeForApiItem(item);
	const governor = sm.findGoverningAncestor(ancestors, pseudo);
	const resolved = governor ? sm.resolveNodeStatus(ancestors, pseudo) : null;
	return {
		id: item.id,
		type: "api-item",
		label: item.label,
		explicitStatusId: item.explicitStatusId ?? null,
		resolvedStatus: resolved ? statusSummary(resolved) : null,
		children: [],
	};
}

function summarizeNode(node: ViewNode, ancestors: McpAncestorChain, sm: StatusesManager): McpNodeSummary {
	const governor = sm.findGoverningAncestor(ancestors, node);
	const resolved = governor ? sm.resolveNodeStatus(ancestors, node) : null;
	const childAncestors: McpAncestorChain = [node, ...ancestors];
	const children = node.children.map((child) => summarizeNode(child, childAncestors, sm));
	if (node.apiItemOrder) {
		for (const itemId of node.apiItemOrder) {
			const item = node.apiItemState?.[itemId];
			if (item) children.push(summarizeApiItem(item, childAncestors, sm));
		}
	}
	return {
		id: node.id,
		type: node.type,
		label: node.label,
		ref: node.ref,
		explicitStatusId: node.explicitStatusId ?? null,
		resolvedStatus: resolved ? statusSummary(resolved) : null,
		children,
	};
}

/** G7: every view's id, name and `inboxMode`. */
export function createListViewsTool(ctx: McpStatusToolsContext): McpTool {
	return {
		name: "list_views",
		description: "Returns every view's id, name and inboxMode. Takes no arguments.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		handler: () => ({
			vault: vaultIdentity(ctx),
			views: ctx.getViewsManager().getViews().map((v) => ({ id: v.id, name: v.name, inboxMode: v.inboxMode })),
		}),
	};
}

/** G7: one view's node tree, nested, defaulting to the open view when `view` is omitted. A
 * `parentNodeId` narrows the result to that node's own children instead of the whole view root —
 * an unknown id is refused the same way `get_node_status`/`set_node_status` refuse one (E3), and a
 * placeholder/API row (which has no children of its own) is refused rather than silently returning
 * an empty list. */
export function createListNodesTool(ctx: McpStatusToolsContext): McpTool {
	return {
		name: "list_nodes",
		description:
			"Returns a nested tree of a view's nodes (id, type, label/ref, explicitStatusId, resolved status, children). " +
			'`view` (optional, name or id) defaults to the currently-open view. `parentNodeId` (optional) narrows the result to one node\'s own children.',
		inputSchema: {
			type: "object",
			properties: { view: { type: "string" }, parentNodeId: { type: "string" } },
			additionalProperties: false,
		},
		handler: (args) => {
			const viewsManager = ctx.getViewsManager();
			const statusesManager = ctx.getStatusesManager();
			const view = resolveViewForRead(viewsManager, args.view);

			let nodes: ViewNode[];
			let ancestors: McpAncestorChain;
			if (typeof args.parentNodeId === "string" && args.parentNodeId.length > 0) {
				const target = resolveMcpAddress(view, view.name, { nodeId: args.parentNodeId });
				if (target.kind !== "node") {
					throw new Error(`Node "${args.parentNodeId}" in view "${view.name}" is a placeholder row and has no children.`);
				}
				nodes = target.node.children;
				ancestors = [target.node, ...target.ancestors];
			} else {
				nodes = view.root;
				ancestors = [view];
			}

			return {
				vault: vaultIdentity(ctx),
				view: viewIdentity(view),
				nodes: nodes.map((node) => summarizeNode(node, ancestors, statusesManager)),
			};
		},
	};
}

/** G7: every status set, with its ordered statuses and default — a set with zero statuses still
 * returns normally, with an empty `statuses` array (not an error). */
export function createListStatusSetsTool(ctx: McpStatusToolsContext): McpTool {
	return {
		name: "list_status_sets",
		description: "Returns every status set: id, name, ordered statuses[] (id/label/color) and defaultStatusId. Takes no arguments.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		handler: () => ({
			vault: vaultIdentity(ctx),
			statusSets: ctx
				.getStatusesManager()
				.getStatusSets()
				.map((set) => ({
					id: set.id,
					name: set.name,
					statuses: set.statuses.map((s) => ({ id: s.id, label: s.label, color: s.color, isCompleted: !!s.isCompleted, isCancelled: !!s.isCancelled })),
					defaultStatusId: set.defaultStatusId,
				})),
		}),
	};
}

/** G2: a node's own `explicitStatusId`, its resolved/inherited status, and the governing status
 * set's id/name. `resolvedStatus: null` (no governor reaches this node, or its kind is excluded via
 * `applyTo`, E5) is a normal reply, never an error — unlike `set_node_status`, this tool never
 * refuses for that reason. */
export function createGetNodeStatusTool(ctx: McpStatusToolsContext): McpTool {
	return {
		name: "get_node_status",
		description:
			'Reads a node\'s own explicitStatusId, its resolved/inherited status, and the governing status set. Addressed by "nodeId", or by "path" ' +
			'only when that path matches exactly one node in the view. `view` (optional, name or id) defaults to the currently-open view.',
		inputSchema: {
			type: "object",
			properties: { view: { type: "string" }, nodeId: { type: "string" }, path: { type: "string" } },
			additionalProperties: false,
		},
		handler: (args) => {
			const viewsManager = ctx.getViewsManager();
			const statusesManager = ctx.getStatusesManager();
			const view = resolveViewForRead(viewsManager, args.view);
			const address = extractMcpAddress(args);
			const target = resolveMcpAddress(view, view.name, address);
			const pseudo = pseudoNodeForTarget(target);
			const governor = statusesManager.findGoverningAncestor(target.ancestors, pseudo);
			const resolved = governor ? statusesManager.resolveNodeStatus(target.ancestors, pseudo) : null;
			const governingSet = governor?.statusSetId ? statusesManager.getStatusSet(governor.statusSetId) : undefined;

			return {
				vault: vaultIdentity(ctx),
				view: viewIdentity(view),
				nodeId: target.id,
				explicitStatusId: pseudo.explicitStatusId ?? null,
				resolvedStatus: resolved ? statusSummary(resolved) : null,
				governingStatusSet: governingSet ? { id: governingSet.id, name: governingSet.name } : null,
			};
		},
	};
}

/** G3/GP4/GP5: writes a node's status by label, resolved case-insensitively against its governing
 * status set. Routes the write automatically — `ViewNode.explicitStatusId` for a real node,
 * `apiItemState[rowId].explicitStatusId` for a placeholder row — the caller never says which kind
 * it addressed. E7: `view` is required; this tool never falls back to the active view. E5: refused
 * outright (not a null reply, unlike `get_node_status`) when no status set governs the node. */
export function createSetNodeStatusTool(ctx: McpStatusToolsContext): McpTool {
	return {
		name: "set_node_status",
		description:
			'Writes a node\'s status by label (case-insensitive) against its governing status set. Addressed by "nodeId", or by "path" only when ' +
			'that path matches exactly one node in the view. "view" is required — this tool never falls back to the active view.',
		inputSchema: {
			type: "object",
			properties: { view: { type: "string" }, nodeId: { type: "string" }, path: { type: "string" }, statusLabel: { type: "string" } },
			required: ["view", "statusLabel"],
			additionalProperties: false,
		},
		handler: (args) => {
			const viewsManager = ctx.getViewsManager();
			const statusesManager = ctx.getStatusesManager();
			const view = resolveViewForWrite(viewsManager, args.view);
			const address = extractMcpAddress(args);
			const target = resolveMcpAddress(view, view.name, address);
			const pseudo = pseudoNodeForTarget(target);

			const governor = statusesManager.findGoverningAncestor(target.ancestors, pseudo);
			if (!governor?.statusSetId) {
				throw new Error(`No status set governs node "${target.id}" in view "${view.name}" — set_node_status requires a reachable governor.`);
			}
			const set = statusesManager.getStatusSet(governor.statusSetId);
			if (!set || set.statuses.length === 0) {
				throw new Error(`No status set governs node "${target.id}" in view "${view.name}" — its governor's status set has no statuses.`);
			}

			if (typeof args.statusLabel !== "string" || args.statusLabel.trim().length === 0) {
				throw new Error('set_node_status requires a "statusLabel" argument.');
			}
			const wanted = args.statusLabel.trim().toLowerCase();
			const match = set.statuses.find((s) => s.label.trim().toLowerCase() === wanted);
			if (!match) {
				throw new Error(`Unknown status label "${args.statusLabel}" for status set "${set.name}". Valid labels: ${set.statuses.map((s) => s.label).join(", ") || "(none)"}.`);
			}

			const previous = statusesManager.resolveNodeStatus(target.ancestors, pseudo);

			if (target.kind === "node") {
				viewsManager.setExplicitStatus(view.id, target.node.id, match.id);
			} else {
				viewsManager.setApiItemStatus(view.id, target.owner.id, target.item.id, match.id);
			}

			return {
				vault: vaultIdentity(ctx),
				view: viewIdentity(view),
				nodeId: target.id,
				previousStatus: previous ? statusSummary(previous) : null,
				newStatus: statusSummary(match),
			};
		},
	};
}
