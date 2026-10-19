import { createServer as createNetServer } from "node:net";
import { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, FileSystemAdapter, Platform } from "obsidian";
import AtlasPlugin from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { McpServer } from "../../src/mcp-server";
import { StatusSet, StatusesManager } from "../../src/statuses";
import { ViewsManager } from "../../src/views";
import { View, ViewNode } from "../../src/types";

/**
 * PR-2.F1: real JSON-RPC 2.0 requests against the running server from PR-1.S1, driving
 * `list_views`/`list_nodes`/`list_status_sets` reply shape and vault/view naming (G7/GP5), two
 * concurrent `set_node_status` calls on the same node serializing rather than interleaving (E8),
 * and the shared token middleware still rejecting an unauthenticated call to a new tool.
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
const FIXTURE_TOKEN = "mcp-status-tools-fixture-token";

const STATUS_SET: StatusSet = {
	id: "set-recruiting",
	name: "Recruiting",
	statuses: [
		{ id: "s-prospect", label: "Prospect", color: "#111111" },
		{ id: "s-applied", label: "Applied", color: "#222222" },
		{ id: "s-screen", label: "Screen", color: "#333333" },
	],
	defaultStatusId: "s-prospect",
};

function makeView(): View {
	const datadog: ViewNode = { id: "node-datadog", type: "unit", ref: { kind: "file", path: "Recruiting/Datadog.md" }, children: [] };
	return { id: "view-job-hunt", name: "Job Hunt", inboxMode: "view", root: [datadog], statusEnabled: true, statusSetId: "set-recruiting" };
}

/** Drives the plugin's own production wiring (`initMcpServer`/`createMcpServer`) the same way
 * `tests/integration/mcp-atlas-status.test.ts` does, with `viewsManager`/`statusesManager` also
 * pre-populated (unlike that file's bare atlas_status-only fixture) so the new status tools have
 * real data to read/write. */
async function startPluginBackedServer(): Promise<{ plugin: AtlasPlugin & Record<string, unknown>; server: McpServer; port: number; token: string; view: View }> {
	Platform.isMobile = false;
	const plugin = Object.create(AtlasPlugin.prototype) as AtlasPlugin & Record<string, unknown>;
	const app = new App();
	app.vault.name = FIXTURE_VAULT_NAME;
	app.vault.adapter = new FileSystemAdapter(FIXTURE_VAULT_PATH);
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

	const view = makeView();
	const persist = vi.fn();
	plugin.viewsManager = new ViewsManager(app, [view], view.id, persist);
	plugin.statusesManager = new StatusesManager([STATUS_SET], [], persist);

	const port = await getFreePort();
	app.saveLocalStorage("atlas-mcp-server", { port, token: FIXTURE_TOKEN });

	await (plugin as unknown as { initMcpServer(): Promise<void> }).initMcpServer();
	const server = plugin.mcpServer as McpServer;
	servers.push(server);
	return { plugin, server, port, token: FIXTURE_TOKEN, view };
}

async function call<T>(port: number, token: string, name: string, args: Record<string, unknown> = {}): Promise<{ status: number; result?: T; error?: { code: number; message: string } }> {
	const response = await postJson(port, token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
	const body = response.json as { result?: ToolCallBody["result"]; error?: { code: number; message: string } };
	if (body.error) return { status: response.status, error: body.error };
	return { status: response.status, result: toolResult<T>({ result: body.result! }) };
}

describe("G7 — list_views/list_nodes/list_status_sets, driven through the real plugin wiring", () => {
	it("list_views returns every view's id/name/inboxMode, naming the vault", async () => {
		const { port, token } = await startPluginBackedServer();
		const { result } = await call<{ vault: { name: string }; views: { id: string; name: string; inboxMode: string }[] }>(port, token, "list_views");

		expect(result!.vault.name).toBe(FIXTURE_VAULT_NAME);
		expect(result!.views).toEqual([{ id: "view-job-hunt", name: "Job Hunt", inboxMode: "view" }]);
	});

	it("list_nodes defaults to the open view and returns the nested tree, naming the view used", async () => {
		const { port, token } = await startPluginBackedServer();
		const { result } = await call<{ view: { id: string; name: string }; nodes: { id: string; resolvedStatus: unknown }[] }>(port, token, "list_nodes");

		expect(result!.view).toEqual({ id: "view-job-hunt", name: "Job Hunt" });
		expect(result!.nodes).toEqual([
			expect.objectContaining({ id: "node-datadog", resolvedStatus: { id: "s-prospect", label: "Prospect", color: "#111111" } }),
		]);
	});

	it("list_status_sets returns every set's ordered statuses and defaultStatusId", async () => {
		const { port, token } = await startPluginBackedServer();
		const { result } = await call<{ statusSets: { id: string; statuses: unknown[]; defaultStatusId: string }[] }>(port, token, "list_status_sets");

		expect(result!.statusSets).toEqual([
			{
				id: "set-recruiting",
				name: "Recruiting",
				statuses: [
					{ id: "s-prospect", label: "Prospect", color: "#111111", isCompleted: false, isCancelled: false },
					{ id: "s-applied", label: "Applied", color: "#222222", isCompleted: false, isCancelled: false },
					{ id: "s-screen", label: "Screen", color: "#333333", isCompleted: false, isCancelled: false },
				],
				defaultStatusId: "s-prospect",
			},
		]);
	});
});

describe("GP4/GP5 — set_node_status over real HTTP", () => {
	it("writes the status, re-renders are observable via get_node_status with no separate reload, and names the view/previous/new status", async () => {
		const { port, token } = await startPluginBackedServer();

		const setResult = await call<{ view: { name: string }; previousStatus: { label: string }; newStatus: { id: string; label: string } }>(
			port,
			token,
			"set_node_status",
			{ view: "Job Hunt", nodeId: "node-datadog", statusLabel: "Applied" }
		);
		expect(setResult.result!.view.name).toBe("Job Hunt");
		expect(setResult.result!.previousStatus.label).toBe("Prospect");
		expect(setResult.result!.newStatus).toEqual({ id: "s-applied", label: "Applied", color: "#222222" });

		const getResult = await call<{ resolvedStatus: { label: string } }>(port, token, "get_node_status", { view: "Job Hunt", nodeId: "node-datadog" });
		expect(getResult.result!.resolvedStatus.label).toBe("Applied");
	});
});

describe("E8 — two concurrent set_node_status calls on the same node serialize rather than interleave", () => {
	it("both writes apply, one strictly after the other — never interleaved, never silently dropped", async () => {
		const { port, token } = await startPluginBackedServer();

		const [applied, screen] = await Promise.all([
			call<{ previousStatus: { label: string } | null; newStatus: { label: string } }>(port, token, "set_node_status", {
				view: "Job Hunt",
				nodeId: "node-datadog",
				statusLabel: "Applied",
			}),
			call<{ previousStatus: { label: string } | null; newStatus: { label: string } }>(port, token, "set_node_status", {
				view: "Job Hunt",
				nodeId: "node-datadog",
				statusLabel: "Screen",
			}),
		]);

		const a = applied.result!;
		const b = screen.result!;
		// Exactly one serialization order is internally consistent: whichever call ran second saw
		// the first call's own new status as its "previous" — proving the two writes ran one after
		// the other against a shared, consistent view of the node, never interleaved or corrupted.
		const appliedRanFirst = a.previousStatus?.label === "Prospect" && b.previousStatus?.label === "Applied";
		const screenRanFirst = b.previousStatus?.label === "Prospect" && a.previousStatus?.label === "Screen";
		expect(appliedRanFirst || screenRanFirst).toBe(true);

		const getResult = await call<{ resolvedStatus: { label: string } }>(port, token, "get_node_status", { view: "Job Hunt", nodeId: "node-datadog" });
		// The final state is whichever write actually ran last — never some third, impossible value.
		const finalLabel = appliedRanFirst ? "Screen" : "Applied";
		expect(getResult.result!.resolvedStatus.label).toBe(finalLabel);
	});
});

describe("E1 — the shared bearer-token middleware still gates every new tool", () => {
	it("an invalid token on list_nodes gets the same 401 atlas_status already gets", async () => {
		const { port } = await startPluginBackedServer();
		const response = await postJson(port, "not-the-real-token", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_nodes" } });
		expect(response.status).toBe(401);
	});

	it("an invalid token on set_node_status gets a 401 too, with nothing written", async () => {
		const { port, token } = await startPluginBackedServer();
		const response = await postJson(port, "not-the-real-token", {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "set_node_status", arguments: { view: "Job Hunt", nodeId: "node-datadog", statusLabel: "Applied" } },
		});
		expect(response.status).toBe(401);

		const getResult = await call<{ resolvedStatus: { label: string } }>(port, token, "get_node_status", { view: "Job Hunt", nodeId: "node-datadog" });
		expect(getResult.result!.resolvedStatus.label).toBe("Prospect"); // unchanged — the 401'd call wrote nothing
	});
});
