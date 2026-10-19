import { createServer as createNetServer } from "node:net";
import { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, FileSystemAdapter, Platform } from "obsidian";
import AtlasPlugin from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { McpServer } from "../../src/mcp-server";
import { StatusesManager } from "../../src/statuses";
import type { AtlasSettings } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
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
 * and the vault pre-seeded with every path in `vaultPaths` (folders end in "/").
 *
 * R6(b) review: `persistDebounced` is wired to the plugin's own real `persistNow` (through the
 * same prototype-chain cast `initMcpServer` already needs), not a bare no-op — so a write really
 * does reach `AtlasPlugin.saveData` with the real persisted `data.json` shape, exactly as
 * production's `() => this.persistDebounced()` callback does, and `persistDebounced` itself is a
 * `vi.fn()` so a test can inspect call count/order directly (R6a/b). */
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
	plugin.graduation = { dispose: () => {}, handleModify: () => {}, handleDelete: () => {}, handleRename: () => {} };
	plugin.linkSuggest = undefined;
	plugin.mcpServer = null;
	plugin.expandedModuleFolders = new Set<string>();
	plugin.settings = { ...DEFAULT_SETTINGS, mcpServerEnabled: true };
	plugin.apiHeadersStore = new Map<string, unknown>();
	plugin.folderSourcePathStore = new Map<string, string>();
	// R4 review (GP3): add_node validates against the plugin's real UnitIndex and promotes a
	// module-internal file through it, exactly as production does — a stub `{ getUnits: () => [] }`
	// would wrongly refuse every nested file as "not a unit".
	plugin.unitIndex = new UnitIndex(app, plugin.settings as AtlasSettings, []);
	(plugin.unitIndex as UnitIndex).rebuild();
	// `saveData` stands in for `Plugin.saveData` through the prototype chain, the same way
	// `tests/integration/explorer-view.test.ts` already does for a bare
	// `Object.create(AtlasPlugin.prototype)` fixture — real `persistNow()` calls straight through to it.
	plugin.saveData = vi.fn(async () => {});
	// R6(b) review: a `vi.fn()` wrapping the real `persistNow()` (private, reached via the same
	// prototype-chain cast `initMcpServer` below needs) — every write's `ViewsManager.save()` reaches
	// this exact callback, so a test can inspect both how many times it ran and, via `saveData`'s own
	// mock calls once the fire-and-forget `persistNow()` promise settles, the real persisted shape.
	plugin.persistDebounced = vi.fn(() => {
		void (plugin as unknown as { persistNow(): Promise<void> }).persistNow();
	});

	const view = makeView(root);
	plugin.viewsManager = new ViewsManager(app, [view], view.id, () => plugin.persistDebounced());
	plugin.statusesManager = new StatusesManager([], [], () => plugin.persistDebounced());

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

		// R6(b) review: the in-memory tree, confirmed as before —
		expect((plugin.viewsManager as ViewsManager).getNode(view.id, "recruiting-folder")?.children.map((c) => c.id)).toEqual([newNodeId]);

		// — but also the *persisted* `data.json` shape itself: `add_node`'s write reaches
		// `persistDebounced` (asserted called), which fires the plugin's own real `persistNow()`
		// (awaited here for a deterministic snapshot rather than racing its fire-and-forget promise),
		// landing in `saveData` with the exact `views` shape that would be written to disk.
		expect(plugin.persistDebounced).toHaveBeenCalled();
		await (plugin as unknown as { persistNow(): Promise<void> }).persistNow();
		const saveData = plugin.saveData as ReturnType<typeof vi.fn>;
		expect(saveData).toHaveBeenCalled();
		const persisted = saveData.mock.calls.at(-1)![0] as { views: View[] };
		const persistedView = persisted.views.find((v) => v.id === view.id)!;
		const persistedFolder = persistedView.root.find((n) => n.id === "recruiting-folder");
		expect(persistedFolder?.children.map((c) => c.id)).toEqual([newNodeId]);
	});
});

describe("GP7 — a rename landing at the same instant as an arranging call is already reflected in its reply", () => {
	it("move_node's reply ref and the live node agree on the same path, whichever side of a genuine race the rename landed on", async () => {
		const datadog: ViewNode = { id: "node-datadog", type: "unit", ref: { kind: "file", path: "Recruiting/Datadog.md" }, children: [] };
		const sibling: ViewNode = { id: "node-sibling", type: "unit", ref: { kind: "file", path: "Other.md" }, children: [] };
		const { port, token, plugin, app } = await startArrangeServer([datadog, sibling], ["Recruiting/", "Recruiting/Datadog.md", "Other.md"]);
		const viewsManager = plugin.viewsManager as ViewsManager;

		// R6(c) review: exercises the real production path a vault rename takes — the registered
		// `vault.on("rename", ...)` listener calling `AtlasPlugin.onVaultRenameEvent` — rather than
		// calling `ViewsManager.onVaultRename` directly, and races it against the in-flight HTTP call
		// with `setImmediate` (a real I/O-callback-ordered macrotask, scheduled only once `call`'s own
		// synchronous request-send has returned) instead of firing it synchronously before any network
		// I/O has even started — a genuine race rather than a deterministically pre-sequenced rename.
		app.vault.on("rename", (file: unknown, oldPath: string) =>
			(plugin as unknown as { onVaultRenameEvent(f: unknown, o: string): void }).onVaultRenameEvent(file, oldPath)
		);
		const datadogFile = app.vault.getAbstractFileByPath("Recruiting/Datadog.md")!;

		const movePromise = call<{ ref: { path: string } }>(port, token, "move_node", { view: "Job Hunt", nodeId: "node-datadog", newParentId: null, index: 1 });
		setImmediate(() => void app.vault.rename(datadogFile, "Recruiting/Renamed.md"));

		const moveResult = await movePromise;
		const node = viewsManager.getNode("view-job-hunt", "node-datadog");
		// Whichever order the race actually landed in, the reply and the live node must agree with
		// each other — never a reply naming the old path while the node itself already shows the new
		// one (or vice versa), and always one of the two genuinely possible paths.
		expect(moveResult.result!.ref).toEqual(node?.ref);
		expect(["Recruiting/Datadog.md", "Recruiting/Renamed.md"]).toContain(moveResult.result!.ref.path);
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

describe("E8 follow-on (R6a review) — two overlapping calls against the same view resolve and persist in the same order, never interleaved", () => {
	it("a concurrent add_node and move_node resolve in some order, and the mocked save path's call order matches exactly that resolve order", async () => {
		const p: ViewNode = { id: "node-p", type: "unit", ref: { kind: "file", path: "p.md" }, children: [] };
		const q: ViewNode = { id: "node-q", type: "unit", ref: { kind: "file", path: "q.md" }, children: [] };
		const { port, token, plugin, view } = await startArrangeServer([p, q], ["p.md", "q.md", "r.md"]);

		// R6(a) review: a snapshot of `view.root`'s own id order taken synchronously inside
		// `persistDebounced` itself (already a `vi.fn()` from `startArrangeServer`, re-wrapped here
		// so the wrapper still delegates to the real one underneath) — by the time it fires for a
		// given call, that call's mutation has already landed (`ViewsManager.save()` mutates, then
		// calls `persist()` inline), so this is exactly "the shape handed to the mocked save path"
		// the spec asks for, per call.
		const persistSnapshots: string[][] = [];
		const realPersistDebounced = plugin.persistDebounced as () => void;
		plugin.persistDebounced = vi.fn(() => {
			persistSnapshots.push(view.root.map((n) => n.id));
			realPersistDebounced();
		});

		const resolveOrder: string[] = [];
		const addPromise = call<{ nodeId: string }>(port, token, "add_node", { view: "Job Hunt", path: "r.md" }).then((r) => {
			resolveOrder.push("add");
			return r;
		});
		const movePromise = call<{ nodeId: string }>(port, token, "move_node", { view: "Job Hunt", nodeId: "node-q", newParentId: null, index: 0 }).then((r) => {
			resolveOrder.push("move");
			return r;
		});

		const [addResult] = await Promise.all([addPromise, movePromise]);
		expect(addResult.result).toBeDefined();
		const newNodeId = addResult.result!.nodeId;

		// Exactly one persist per write, and the FIRST call to actually resolve over the wire is
		// exactly the one whose effect (the new node's id) shows up in the FIRST persist snapshot —
		// proving the two calls' handlers ran fully sequentially (one save completing before the
		// other's handler starts), never interleaved. (`persistSnapshots` is populated below.)
		expect(persistSnapshots).toHaveLength(2);
		expect(persistSnapshots[0].includes(newNodeId)).toBe(resolveOrder[0] === "add");
		expect(persistSnapshots[1]).toContain(newNodeId);
		expect(persistSnapshots[1]).toContain("node-p");
		expect(persistSnapshots[1]).toContain("node-q");
		expect(view.root).toHaveLength(3); // neither duplicated nor dropped
	});
});
