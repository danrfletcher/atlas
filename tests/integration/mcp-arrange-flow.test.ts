import { createServer as createNetServer } from "node:net";
import { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, FileSystemAdapter, Platform } from "obsidian";
import AtlasPlugin from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { McpServer } from "../../src/mcp-server";
import { StatusesManager } from "../../src/statuses";
import { ViewsManager } from "../../src/views";
import { View, ViewNode } from "../../src/types";

/**
 * PR-3.F1: the five arranging tools (`add_node`/`move_node`/`remove_node`/`create_folder`/
 * `rename_folder`) driven over real JSON-RPC against the plugin's own production wiring
 * (`createMcpServer` in `src/main.ts`), the same way `tests/integration/mcp-status-tools.test.ts`
 * drives PR-2.F1's tools — GP3 end to end, GP7's rename race, F2's filesystem fence, and E8's
 * no-interleaving guarantee carried over to the two write-heavy tools most likely to race.
 */

function getFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createNetServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const addr = probe.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			probe.close(() => resolve(port));
		});
	});
}

function postJson(port: number, token: string, body: unknown): Promise<{ status: number; json: unknown }> {
	return new Promise((resolve, reject) => {
		const data = JSON.stringify(body);
		const req = request(
			{
				host: "127.0.0.1",
				port,
				method: "POST",
				path: "/",
				headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), Authorization: `Bearer ${token}` },
			},
			(res) => {
				let raw = "";
				res.on("data", (chunk) => (raw += chunk));
				res.on("end", () => {
					try {
						resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null });
					} catch (err) {
						reject(err);
					}
				});
			}
		);
		req.on("error", reject);
		req.write(data);
		req.end();
	});
}

interface ToolCallBody {
	result: { content: { type: string; text: string }[] };
}

function toolResult<T>(body: unknown): T {
	return JSON.parse((body as ToolCallBody).result.content[0].text) as T;
}

const servers: McpServer[] = [];
afterEach(async () => {
	Platform.isMobile = false;
	await Promise.all(servers.splice(0).map((s) => s.stop()));
});

const FIXTURE_VAULT_PATH = process.cwd();
const FIXTURE_VAULT_NAME = "Fixture Vault";
const FIXTURE_TOKEN = "mcp-arrange-tools-fixture-token";

function makeView(root: ViewNode[]): View {
	return { id: "view-job-hunt", name: "Job Hunt", inboxMode: "view", root };
}

/** Drives the plugin's own production wiring (`initMcpServer`/`createMcpServer`), the same way
 * `tests/integration/mcp-status-tools.test.ts` does — `viewsManager` pre-populated with `root`,
 * and the vault pre-seeded with every path in `vaultPaths` (folders end in "/"). */
async function startArrangeServer(
	root: ViewNode[],
	vaultPaths: string[] = []
): Promise<{ plugin: AtlasPlugin & Record<string, unknown>; server: McpServer; port: number; token: string; view: View; app: App }> {
	Platform.isMobile = false;
	const plugin = Object.create(AtlasPlugin.prototype) as AtlasPlugin & Record<string, unknown>;
	const app = new App();
	app.vault.name = FIXTURE_VAULT_NAME;
	app.vault.adapter = new FileSystemAdapter(FIXTURE_VAULT_PATH);
	for (const path of vaultPaths) {
		if (path.endsWith("/")) app.vault.seedFolder(path.slice(0, -1));
		else app.vault.seedFile(path);
	}
	plugin.app = app;
	plugin.manifest = { id: "atlas-explorer", name: "Atlas Explorer", version: "9.9.9", minAppVersion: "1.13.1", description: "", author: "", isDesktopOnly: false };
	plugin.folderLiveRefresh = { cancelAll: () => {} };
	plugin.externalMoveDetector = { cancelAll: () => {} };
	plugin.outsideFolderWatchers = { closeAll: () => {} };
	plugin.graduation = { dispose: () => {} };
	plugin.persistDebounced = undefined;
	plugin.linkSuggest = undefined;
	plugin.mcpServer = null;
	plugin.settings = { ...DEFAULT_SETTINGS, mcpServerEnabled: true };
	plugin.folderSourcePathStore = new Map<string, string>();

	const view = makeView(root);
	const persist = vi.fn();
	plugin.viewsManager = new ViewsManager(app, [view], view.id, persist);
	plugin.statusesManager = new StatusesManager([], [], persist);

	const port = await getFreePort();
	app.saveLocalStorage("atlas-mcp-server", { port, token: FIXTURE_TOKEN });

	await (plugin as unknown as { initMcpServer(): Promise<void> }).initMcpServer();
	const server = plugin.mcpServer as McpServer;
	servers.push(server);
	return { plugin, server, port, token: FIXTURE_TOKEN, view, app };
}

async function call<T>(port: number, token: string, name: string, args: Record<string, unknown> = {}): Promise<{ status: number; result?: T; error?: { code: number; message: string } }> {
	const response = await postJson(port, token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
	const body = response.json as { result?: ToolCallBody["result"]; error?: { code: number; message: string } };
	if (body.error) return { status: response.status, error: body.error };
	return { status: response.status, result: toolResult<T>({ result: body.result! }) };
}

function metaNode(id: string, label: string, children: ViewNode[] = []): ViewNode {
	return { id, type: "meta", label, children };
}

describe("GP3 — add_node end to end against a real ViewsManager and fixture vault file", () => {
	it("nests Recruiting/Datadog.md under the Recruiting meta-folder, persists, and list_nodes sees it with no reload", async () => {
		const recruitingFolder = metaNode("recruiting-folder", "Recruiting");
		const { port, token, plugin, view } = await startArrangeServer([recruitingFolder], ["Recruiting/", "Recruiting/Datadog.md"]);

		const addResult = await call<{ nodeId: string; parentNodeId: string; ref: unknown }>(port, token, "add_node", {
			view: "Job Hunt",
			path: "Recruiting/Datadog.md",
			parentNodeId: "recruiting-folder",
		});

		expect(addResult.result!.parentNodeId).toBe("recruiting-folder");
		expect(addResult.result!.ref).toEqual({ kind: "file", path: "Recruiting/Datadog.md" });
		const newNodeId = addResult.result!.nodeId;

		// Read-only PR-2.F1 tool, used only to assert the result (not re-tested here).
		const listResult = await call<{ nodes: { id: string }[] }>(port, token, "list_nodes");
		if (listResult.error) throw new Error(`list_nodes failed: ${JSON.stringify(listResult.error)}`);
		const topLevel = listResult.result!.nodes.find((n) => n.id === "recruiting-folder") as unknown as { children: { id: string }[] } | undefined;
		expect(topLevel?.children?.map((c) => c.id)).toEqual([newNodeId]);

		// The persisted data.json shape: the same in-memory tree ViewsManager.save() hands to the
		// plugin's own persist callback.
		expect((plugin.viewsManager as ViewsManager).getNode(view.id, "recruiting-folder")?.children.map((c) => c.id)).toEqual([newNodeId]);
	});
});

describe("GP7 — a rename landing at the same instant as an arranging call is already reflected in its reply", () => {
	it("move_node's reply ref already names the post-rename path, not the stale pre-rename one", async () => {
		const datadog: ViewNode = { id: "node-datadog", type: "unit", ref: { kind: "file", path: "Recruiting/Datadog.md" }, children: [] };
		const sibling: ViewNode = { id: "node-sibling", type: "unit", ref: { kind: "file", path: "Other.md" }, children: [] };
		const { port, token, plugin } = await startArrangeServer([datadog, sibling], ["Recruiting/", "Recruiting/Datadog.md", "Other.md"]);
		const viewsManager = plugin.viewsManager as ViewsManager;

		// Fire the move_node HTTP call (real network I/O — several event-loop ticks before the
		// server actually parses and dispatches it), then synchronously run the same
		// ViewsManager.onVaultRename rewrite production code runs from a real vault "rename" event
		// — both GP7 calls are plain synchronous functions, so whichever reaches ViewsManager first
		// always finishes first; this fires the rename in the same tick the HTTP call is in flight.
		const movePromise = call<{ ref: unknown }>(port, token, "move_node", { view: "Job Hunt", nodeId: "node-datadog", newParentId: null, index: 1 });
		viewsManager.onVaultRename("Recruiting/Datadog.md", "Recruiting/Renamed.md");

		const moveResult = await movePromise;
		expect(moveResult.result!.ref).toEqual({ kind: "file", path: "Recruiting/Renamed.md" });
	});
});

describe("F2/F3 — fence regression: no arranging tool ever touches the filesystem", () => {
	it("none of create/rename/createFolder/delete/modify is ever invoked by any of the five tools", async () => {
		const recruitingFolder = metaNode("recruiting-folder", "Recruiting");
		const datadog: ViewNode = { id: "node-datadog", type: "unit", ref: { kind: "file", path: "Recruiting/Datadog.md" }, children: [] };
		const { port, token, app } = await startArrangeServer([recruitingFolder, datadog], ["Recruiting/", "Recruiting/Datadog.md"]);

		const createSpy = vi.spyOn(app.vault, "create");
		const renameSpy = vi.spyOn(app.vault, "rename");
		const createFolderSpy = vi.spyOn(app.vault, "createFolder");
		const deleteSpy = vi.spyOn(app.vault, "delete");
		const modifySpy = vi.spyOn(app.vault, "modify");

		const add = await call<{ nodeId: string }>(port, token, "add_node", { view: "Job Hunt", path: "Recruiting/Datadog.md", parentNodeId: "recruiting-folder" });
		expect(add.result).toBeDefined();
		const addedNodeId = add.result!.nodeId;

		const move = await call(port, token, "move_node", { view: "Job Hunt", nodeId: addedNodeId, newParentId: null, index: 0 });
		expect(move.result).toBeDefined();

		const create = await call<{ nodeId: string }>(port, token, "create_folder", { view: "Job Hunt", label: "New folder" });
		expect(create.result).toBeDefined();

		const rename = await call(port, token, "rename_folder", { view: "Job Hunt", nodeId: create.result!.nodeId, label: "Renamed folder" });
		expect(rename.result).toBeDefined();

		const remove = await call(port, token, "remove_node", { view: "Job Hunt", nodeId: addedNodeId });
		expect(remove.result).toBeDefined();

		expect(createSpy).not.toHaveBeenCalled();
		expect(renameSpy).not.toHaveBeenCalled();
		expect(createFolderSpy).not.toHaveBeenCalled();
		expect(deleteSpy).not.toHaveBeenCalled();
		expect(modifySpy).not.toHaveBeenCalled();
	});
});

describe("E8 follow-on — two overlapping write calls against the same view apply sequentially, never interleaved", () => {
	it("two concurrent move_node calls to the front of the root each fully apply — final order is one of the two valid serializations, never a merged/corrupted third state", async () => {
		const p: ViewNode = { id: "node-p", type: "unit", ref: { kind: "file", path: "p.md" }, children: [] };
		const q: ViewNode = { id: "node-q", type: "unit", ref: { kind: "file", path: "q.md" }, children: [] };
		const { port, token, plugin, view } = await startArrangeServer([p, q], ["p.md", "q.md"]);
		void plugin;

		const [moveP, moveQ] = await Promise.all([
			call<{ nodeId: string }>(port, token, "move_node", { view: "Job Hunt", nodeId: "node-p", newParentId: null, index: 0 }),
			call<{ nodeId: string }>(port, token, "move_node", { view: "Job Hunt", nodeId: "node-q", newParentId: null, index: 0 }),
		]);

		expect(moveP.result!.nodeId).toBe("node-p");
		expect(moveQ.result!.nodeId).toBe("node-q");

		// Whichever call's handler actually ran last is the one at the front — "index 0" always
		// wins the front slot for whoever applies last. Exactly one of the two valid serializations
		// holds; a corrupted/interleaved apply would show a duplicated or missing id instead.
		const order = view.root.map((n) => n.id);
		const validOrders = [
			["node-q", "node-p"],
			["node-p", "node-q"],
		];
		expect(validOrders.some((candidate) => candidate.join(",") === order.join(","))).toBe(true);
		expect(order).toHaveLength(2); // neither duplicated nor dropped
	});
});
