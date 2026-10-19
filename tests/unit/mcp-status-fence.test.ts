import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { App } from "obsidian";
import { App as MockApp } from "../mocks/obsidian";
import { ViewsManager } from "../../src/views";
import { StatusSet, StatusesManager } from "../../src/statuses";
import { View, ViewNode } from "../../src/types";
import {
	McpStatusToolsContext,
	createGetNodeStatusTool,
	createListNodesTool,
	createListStatusSetsTool,
	createListViewsTool,
	createSetNodeStatusTool,
} from "../../src/mcp-status-tools";

/**
 * PR-2.F1's own fence (F2): "No file, folder or node-placement mutation — every write only ever
 * assigns `explicitStatusId`". Combines a static source-text check (no disk-write API call
 * anywhere in the new MCP status-tool files) with a behavioral one (actually driving every tool,
 * including `set_node_status`, against the mock `Vault`'s own `calls` tracker and a full
 * before/after snapshot of every file it holds) — the same pattern `tests/unit/fence-checks.test.ts`
 * (F5) uses for Folder sources.
 *
 * R2 fix: this file used to also assert against a real file in a freshly `mkdtemp`'d directory
 * with no connection to the mock vault built by `setup()` — nothing the tool does could ever reach
 * that path, so the assertion could never fail regardless of what the code did. Removed in favor
 * of a `vaultSnapshot` taken before and after against the one vault the tools actually see, which
 * a stray write *would* change.
 */

const root = join(__dirname, "../..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

const DISK_WRITE_CALL = /\.(create|createFolder|createBinary|modify|modifyBinary|append|delete|trash|rename|copy)\s*\(|renameFile\s*\(|fileManager\s*\./;

describe("F2 static check — the new MCP status-tool files touch no disk-write API", () => {
	it("src/mcp-status-tools.ts has no disk-write call anywhere", () => {
		expect(read("src/mcp-status-tools.ts")).not.toMatch(DISK_WRITE_CALL);
	});

	it("src/mcp-node-resolver.ts has no disk-write call anywhere", () => {
		expect(read("src/mcp-node-resolver.ts")).not.toMatch(DISK_WRITE_CALL);
	});
});

const STATUS_SET: StatusSet = {
	id: "set-recruiting",
	name: "Recruiting",
	statuses: [
		{ id: "s-prospect", label: "Prospect", color: "#111" },
		{ id: "s-applied", label: "Applied", color: "#222" },
	],
	defaultStatusId: "s-prospect",
};

function setup() {
	const app = new MockApp();
	app.vault.seedFolder("Recruiting");
	app.vault.seedFile("Recruiting/Datadog.md");
	const node: ViewNode = { id: "node-datadog", type: "unit", ref: { kind: "file", path: "Recruiting/Datadog.md" }, children: [] };
	const view: View = { id: "view-1", name: "Job Hunt", inboxMode: "view", root: [node], statusEnabled: true, statusSetId: "set-recruiting" };
	const persist = vi.fn();
	const viewsManager = new ViewsManager(app as unknown as App, [view], view.id, persist);
	const statusesManager = new StatusesManager([STATUS_SET], [], persist);
	const ctx: McpStatusToolsContext = {
		getViewsManager: () => viewsManager,
		getStatusesManager: () => statusesManager,
		getVaultName: () => "Fixture Vault",
		getVaultPath: () => "/tmp/fixture",
		getFolderSourcePath: () => "",
	};
	return { app, ctx };
}

/** A snapshot of every file the mock vault currently holds — path, extension, stat (ctime/mtime/
 * size) and, where it exists, the content `vault.create` would have written. Equal before/after
 * snapshots are a real guarantee here: any stray `vault.create`/`modify`/etc. call against *this*
 * vault (the one the tools actually see) would change one of these fields. */
function vaultSnapshot(app: MockApp): unknown {
	return app.vault.getFiles().map((f) => ({ path: f.path, extension: f.extension, stat: { ...f.stat }, content: app.vault.contents.get(f.path) }));
}

describe("F2 behavioral check — driving every status tool, including set_node_status, never records a Vault write", () => {
	it("list_views/list_nodes/list_status_sets/get_node_status/set_node_status leave vault.calls empty, and every file's own stat/content untouched", () => {
		const { app, ctx } = setup();
		const before = vaultSnapshot(app);

		createListViewsTool(ctx).handler({});
		createListNodesTool(ctx).handler({});
		createListStatusSetsTool(ctx).handler({});
		createGetNodeStatusTool(ctx).handler({ nodeId: "node-datadog" });
		createSetNodeStatusTool(ctx).handler({ view: "Job Hunt", nodeId: "node-datadog", statusLabel: "Applied" });

		expect(app.vault.calls).toEqual([]);
		// R2: the mock vault's own file list, every file's stat and any written content are
		// byte-for-byte identical before and after — a stray write to a file this fixture actually
		// owns would change this, unlike the old mkdtemp-dir check which nothing could ever reach.
		expect(vaultSnapshot(app)).toEqual(before);
	});
});
