import type { Vault } from "obsidian";
import { TFile, TFolder } from "obsidian";
import { McpTool } from "./mcp-protocol";
import { resolveViewForWrite, vaultIdentity, viewIdentity } from "./mcp-status-tools";
import { UnitRef } from "./types";
import { ViewsManager } from "./views";

/**
 * PR-3.F1: the five arranging MCP tools — `add_node`, `move_node`, `remove_node`, `create_folder`,
 * `rename_folder`. Every one of these is a thin wrapper around an existing `ViewsManager` method
 * (`placeUnit`, `moveNode`, `unplaceNode`, `addMetaFolder`, `renameMetaFolder`) — the same methods
 * the explorer's own drag-and-drop and context menus already call — plus the vault-path and
 * meta/real-folder validation the spec's fence (F2/F3) requires before any of them run. None of
 * these tools ever calls `app.vault.create`/`rename`/`createFolder`/`delete`, or edits file
 * content: `resolveVaultPathToRef` below only ever *reads* via `Vault.getAbstractFileByPath`, and
 * every `ViewsManager` method called from here only ever mutates the in-memory view tree and saves
 * through its own normal `save()` path (`persist()` + `notifyChange()`).
 *
 * Every handler here is a plain, synchronous function (no internal `await`) — exactly like
 * `set_node_status`'s own handler already is. That is what makes two concurrent arranging calls
 * serialize rather than interleave (the E8/E8-follow-on rule) and what makes a reply that lands in
 * the same instant as an unrelated vault rename see the rename's effect rather than a stale one
 * (GP7): Node's single-threaded event loop can never pause a synchronous handler partway through
 * to run `ViewsManager.onVaultRename` (also fully synchronous, registered as a plain `vault.on`
 * callback) — whichever of the two was scheduled first always finishes first.
 */

export interface McpArrangeToolsContext {
	getViewsManager: () => ViewsManager;
	/** Q5: every reply names the vault this server is attached to, matching the read/status tools. */
	getVaultName: () => string;
	getVaultPath: () => string;
	/** G4: the one piece of real vault knowledge `add_node` needs — read-only, never a write method. */
	getVault: () => Pick<Vault, "getAbstractFileByPath">;
}

/** E3/E9-style: a node id argument (parent or target) that doesn't resolve in the named view. */
export class McpArrangeNodeNotFoundError extends Error {}
/** E9: a vault path `add_node` was given that doesn't resolve to any file or folder at all. */
export class McpUnitNotFoundError extends Error {}
/** G4: a vault path that does exist, but not as the kind the caller said (or implied) it was. */
export class McpWrongUnitKindError extends Error {}

function requireString(args: Record<string, unknown>, key: string, toolName: string): string {
	const value = args[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${toolName} requires a "${key}" argument (a non-empty string).`);
	}
	return value;
}

function requireNonBlankString(args: Record<string, unknown>, key: string, toolName: string): string {
	const value = requireString(args, key, toolName);
	if (value.trim().length === 0) {
		throw new Error(`${toolName} requires a non-empty, non-whitespace "${key}" argument.`);
	}
	return value;
}

/** `null`/omitted both mean "the view root" throughout this file — a present-but-wrong-typed value
 * is a schema error (wrong type), never silently coerced. */
function optionalNodeId(args: Record<string, unknown>, key: string, toolName: string): string | null {
	const value = args[key];
	if (value === undefined || value === null) return null;
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${toolName}: "${key}" must be a string node id, or null/omitted for the view root.`);
	}
	return value;
}

function optionalIndex(args: Record<string, unknown>, toolName: string): number {
	const value = args.index;
	// No "index" argument means "append at the end" — `ViewsManager.moveNode`'s own clamp
	// (`Math.max(0, Math.min(index, targetChildren.length))`) turns this into exactly that.
	if (value === undefined) return Number.MAX_SAFE_INTEGER;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${toolName}: "index" must be a finite number when given.`);
	}
	return value;
}

function optionalKindHint(args: Record<string, unknown>, toolName: string): "file" | "folder" | "block" | undefined {
	const value = args.kind;
	if (value === undefined) return undefined;
	if (value === "file" || value === "folder" || value === "block") return value;
	throw new Error(`${toolName}: "kind" must be one of "file", "folder" or "block" when given.`);
}

/** G4: fails outright (E3-style, distinct from `McpUnitNotFoundError`/`McpWrongUnitKindError`) for
 * a `parentNodeId`/`newParentId` that doesn't resolve in `view` — `ViewsManager.placeUnit`/
 * `addMetaFolder` would otherwise silently fall back to the view root for exactly this case
 * (`parentId ? this.findNode(...) : null` — a *found* `null` and a *not-found* lookup both take the
 * "no parent" branch), which is the specific silent-misplacement bug this check exists to prevent. */
function requireParentExists(viewsManager: ViewsManager, view: { id: string; name: string }, parentNodeId: string | null, toolName: string, argName: string): void {
	if (parentNodeId === null) return;
	if (!viewsManager.getNode(view.id, parentNodeId)) {
		throw new McpArrangeNodeNotFoundError(`${toolName}: no node with id "${parentNodeId}" (the "${argName}" argument) was found in view "${view.name}".`);
	}
}

function splitBlockPath(path: string): { base: string; subpath: string } | null {
	const hash = path.indexOf("#");
	if (hash < 0) return null;
	return { base: path.slice(0, hash), subpath: path.slice(hash + 1) };
}

/**
 * G4: resolves a vault path string to a `UnitRef`, the way `add_node` must before ever calling
 * `ViewsManager.placeUnit` — via `Vault.getAbstractFileByPath` (or, for a `path#subpath` block
 * reference, the same lookup against the base path). Throws `McpUnitNotFoundError` (E9) for a path
 * that resolves to nothing at all, or `McpWrongUnitKindError` for a path that does resolve but not
 * as `kindHint` says (when given) — e.g. `kind: "file"` against a path that is actually a folder,
 * or a `path#subpath` block reference whose base path is a folder rather than a file.
 */
export function resolveVaultPathToRef(vault: Pick<Vault, "getAbstractFileByPath">, path: string, kindHint?: "file" | "folder" | "block"): UnitRef {
	const split = splitBlockPath(path);
	const basePath = split ? split.base : path;
	const file = vault.getAbstractFileByPath(basePath);
	if (!file) {
		throw new McpUnitNotFoundError(`No vault unit exists at path "${path}". Create it with the Obsidian CLI first, then retry add_node.`);
	}
	if (split) {
		if (!(file instanceof TFile)) {
			throw new McpWrongUnitKindError(`Path "${path}" names a folder, not a file — a block reference needs a file as its base path.`);
		}
		if (kindHint !== undefined && kindHint !== "block") {
			throw new McpWrongUnitKindError(`Path "${path}" names a block (it has a "#" subpath), not a "${kindHint}" as given.`);
		}
		return { kind: "block", path: basePath, subpath: split.subpath };
	}
	const actualKind: "file" | "folder" = file instanceof TFolder ? "folder" : "file";
	if (kindHint !== undefined && kindHint !== actualKind) {
		throw new McpWrongUnitKindError(`Path "${path}" is a ${actualKind}, not a "${kindHint}" as given.`);
	}
	return actualKind === "folder" ? { kind: "folder", path: basePath } : { kind: "file", path: basePath };
}

const PARENT_NODE_ID_SCHEMA = { type: ["string", "null"] } as const;

/** G4/GP1/GP3/E9: places an existing vault unit (file, block or module/folder) under a parent node
 * (or the view root) in a named view. Never creates anything — a path absent from the vault, or a
 * `parentNodeId` absent from the view, is refused outright (E9 and its follow-on), and
 * `ViewsManager.placeUnit`'s own existing "move it, don't duplicate" behaviour is unchanged (the
 * ref is resolved and handed to it exactly as every other caller of `placeUnit` already does). */
export function createAddNodeTool(ctx: McpArrangeToolsContext): McpTool {
	return {
		name: "add_node",
		description:
			'Places an existing vault unit (file, block or module/folder) under a parent node (or the view root when "parentNodeId" is omitted/null) in a named view. ' +
			'"path" must already exist in the vault — create it with the Obsidian CLI first; add_node never creates, renames or moves a real file. "kind" ("file"/"folder"/"block") ' +
			"is an optional hint that is checked against the path's actual kind, never trusted blindly.",
		inputSchema: {
			type: "object",
			properties: {
				view: { type: "string" },
				path: { type: "string" },
				kind: { type: "string", enum: ["file", "folder", "block"] },
				parentNodeId: PARENT_NODE_ID_SCHEMA,
			},
			required: ["view", "path"],
			additionalProperties: false,
		},
		handler: (args) => {
			const viewsManager = ctx.getViewsManager();
			const view = resolveViewForWrite(viewsManager, args.view, "add_node");
			const path = requireString(args, "path", "add_node");
			const kindHint = optionalKindHint(args, "add_node");
			const parentNodeId = optionalNodeId(args, "parentNodeId", "add_node");
			requireParentExists(viewsManager, view, parentNodeId, "add_node", "parentNodeId");

			const ref = resolveVaultPathToRef(ctx.getVault(), path, kindHint);
			viewsManager.placeUnit(view.id, ref, parentNodeId);
			const nodeId = viewsManager.getNodeIdForRef(view.id, ref);
			if (!nodeId) {
				throw new Error(`add_node: placement into view "${view.name}" succeeded but the new node could not be found afterward — please report this.`);
			}

			return { vault: vaultIdentity(ctx), view: viewIdentity(view), nodeId, ref, parentNodeId };
		},
	};
}

/** G5/F3: reparents or reorders an existing node (unit or meta) within one view via
 * `ViewsManager.moveNode` — arrangement only, never the drag-onto-module-icon disk move the
 * Obsidian UI offers elsewhere. An unknown `nodeId`/`newParentId` is refused as "not found" before
 * `moveNode` is even called (so the two cases get distinct messages); once both are confirmed to
 * exist, a `false` return from `moveNode` can only mean its own self-or-descendant guard fired. */
export function createMoveNodeTool(ctx: McpArrangeToolsContext): McpTool {
	return {
		name: "move_node",
		description:
			'Reparents or reorders an existing node (unit or meta/Atlas-only folder) within one view. "newParentId" (optional, null/omitted = view root) and "index" ' +
			'(optional, omitted = append at the end) match ViewsManager.moveNode\'s own semantics, including its out-of-range index clamp. Refuses moving a node into itself ' +
			"or its own descendant. Never touches the filesystem.",
		inputSchema: {
			type: "object",
			properties: {
				view: { type: "string" },
				nodeId: { type: "string" },
				newParentId: PARENT_NODE_ID_SCHEMA,
				index: { type: "number" },
			},
			required: ["view", "nodeId"],
			additionalProperties: false,
		},
		handler: (args) => {
			const viewsManager = ctx.getViewsManager();
			const view = resolveViewForWrite(viewsManager, args.view, "move_node");
			const nodeId = requireString(args, "nodeId", "move_node");
			const newParentId = optionalNodeId(args, "newParentId", "move_node");
			const index = optionalIndex(args, "move_node");

			if (!viewsManager.getNode(view.id, nodeId)) {
				throw new McpArrangeNodeNotFoundError(`move_node: no node with id "${nodeId}" was found in view "${view.name}".`);
			}
			requireParentExists(viewsManager, view, newParentId, "move_node", "newParentId");

			const moved = viewsManager.moveNode(view.id, nodeId, newParentId, index);
			if (!moved) {
				throw new Error(`move_node: node "${nodeId}" cannot be moved into itself or its own descendant.`);
			}

			const node = viewsManager.getNode(view.id, nodeId)!;
			return {
				vault: vaultIdentity(ctx),
				view: viewIdentity(view),
				nodeId,
				type: node.type,
				ref: node.ref ?? null,
				label: node.label ?? null,
				parentNodeId: newParentId,
				index,
			};
		},
	};
}

/** G5: removes exactly one node instance by id via `ViewsManager.unplaceNode` — its children lift
 * up one level into its old slot (the UI's own "Remove from view" behaviour), including
 * `unplaceNode`'s own `promotableChildren` filter for a Folder-source-owner's managed children. The
 * reply's `liftedChildIds` is only the subset of the removed node's own direct children that are
 * still findable in the view immediately afterward — a managed child `promotableChildren` dropped
 * along with its Outside-Vault owner is correctly absent from it, never misreported as "lifted". */
export function createRemoveNodeTool(ctx: McpArrangeToolsContext): McpTool {
	return {
		name: "remove_node",
		description:
			'Removes exactly one node instance by id from a view. Its children lift up one level into its old slot — matching "Remove from view" in the UI — never discarded ' +
			"silently. Never touches the filesystem.",
		inputSchema: {
			type: "object",
			properties: { view: { type: "string" }, nodeId: { type: "string" } },
			required: ["view", "nodeId"],
			additionalProperties: false,
		},
		handler: (args) => {
			const viewsManager = ctx.getViewsManager();
			const view = resolveViewForWrite(viewsManager, args.view, "remove_node");
			const nodeId = requireString(args, "nodeId", "remove_node");

			const node = viewsManager.getNode(view.id, nodeId);
			if (!node) {
				throw new McpArrangeNodeNotFoundError(`remove_node: no node with id "${nodeId}" was found in view "${view.name}".`);
			}
			const directChildIds = node.children.map((c) => c.id);

			viewsManager.unplaceNode(view.id, nodeId);

			const liftedChildIds = directChildIds.filter((id) => viewsManager.getNode(view.id, id) !== null);
			return { vault: vaultIdentity(ctx), view: viewIdentity(view), removedNodeId: nodeId, liftedChildIds };
		},
	};
}

/** G6: creates an Atlas-only meta node (`ViewNode.type === "meta"`, no `ref`) via
 * `ViewsManager.addMetaFolder` under a named parent (or the view root). Never creates anything on
 * disk — a meta folder is a label, not a real folder. An empty/whitespace-only label is refused
 * before `addMetaFolder` is even called, rather than silently saved as its own "New folder"
 * fallback (which exists for a different caller — the UI's own "+ folder" button, which has no
 * label yet to validate against). */
export function createCreateFolderTool(ctx: McpArrangeToolsContext): McpTool {
	return {
		name: "create_folder",
		description:
			'Creates an Atlas-only meta folder (not a real folder on disk) under a named parent node (or the view root when "parentNodeId" is omitted/null), and returns its ' +
			"new node id. The label must be non-empty after trimming.",
		inputSchema: {
			type: "object",
			properties: { view: { type: "string" }, label: { type: "string" }, parentNodeId: PARENT_NODE_ID_SCHEMA },
			required: ["view", "label"],
			additionalProperties: false,
		},
		handler: (args) => {
			const viewsManager = ctx.getViewsManager();
			const view = resolveViewForWrite(viewsManager, args.view, "create_folder");
			const label = requireNonBlankString(args, "label", "create_folder");
			const parentNodeId = optionalNodeId(args, "parentNodeId", "create_folder");
			requireParentExists(viewsManager, view, parentNodeId, "create_folder", "parentNodeId");

			const node = viewsManager.addMetaFolder(view.id, parentNodeId, label);
			if (!node) {
				throw new Error(`create_folder: view "${view.name}" could not be found when creating the folder — please report this.`);
			}

			return { vault: vaultIdentity(ctx), view: viewIdentity(view), nodeId: node.id, label: node.label };
		},
	};
}

/** G6: renames an existing meta node's label via `ViewsManager.renameMetaFolder`. Distinguishes
 * "node id not found in this view" from "node exists but is not a meta folder" — `renameMetaFolder`
 * itself returns `false` for both, so this tool looks the node up itself first to tell the two
 * apart. A `type: "unit"` target (a real file, block or module) is refused with a message pointing
 * at the Obsidian CLI, never silently coerced into a label edit — Atlas never renames a real file
 * or module folder on disk. */
export function createRenameFolderTool(ctx: McpArrangeToolsContext): McpTool {
	return {
		name: "rename_folder",
		description:
			'Renames an existing Atlas-only meta folder\'s label. Refused — pointing at the Obsidian CLI instead — if "nodeId" names a real file, block or module ' +
			"(type: \"unit\"); Atlas never renames anything on disk. The label must be non-empty after trimming.",
		inputSchema: {
			type: "object",
			properties: { view: { type: "string" }, nodeId: { type: "string" }, label: { type: "string" } },
			required: ["view", "nodeId", "label"],
			additionalProperties: false,
		},
		handler: (args) => {
			const viewsManager = ctx.getViewsManager();
			const view = resolveViewForWrite(viewsManager, args.view, "rename_folder");
			const nodeId = requireString(args, "nodeId", "rename_folder");
			const label = requireNonBlankString(args, "label", "rename_folder");

			const node = viewsManager.getNode(view.id, nodeId);
			if (!node) {
				throw new McpArrangeNodeNotFoundError(`rename_folder: no node with id "${nodeId}" was found in view "${view.name}".`);
			}
			if (node.type !== "meta") {
				throw new McpWrongUnitKindError(
					`rename_folder: node "${nodeId}" in view "${view.name}" is a unit (a real file, block or module), not an Atlas-only meta folder — rename it with the Obsidian CLI instead, not rename_folder.`
				);
			}

			const renamed = viewsManager.renameMetaFolder(view.id, nodeId, label);
			if (!renamed) {
				throw new Error(`rename_folder: node "${nodeId}" in view "${view.name}" could not be renamed — please report this.`);
			}

			return { vault: vaultIdentity(ctx), view: viewIdentity(view), nodeId, label: label.trim() };
		},
	};
}
