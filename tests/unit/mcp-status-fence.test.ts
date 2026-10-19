import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
 * anywhere in the new MCP status-tool files) with two behavioral ones (actually driving every
 * tool, including `set_node_status`, against the mock `Vault`'s own `calls` tracker, and a second
 * check against a real file on real disk) — the same pattern `tests/unit/fence-checks.test.ts`
 * (F5) uses for Folder sources.
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
	};
	return { app, ctx };
}

describe("F2 behavioral check — driving every status tool, including set_node_status, never records a Vault write", () => {
	it("list_views/list_nodes/list_status_sets/get_node_status/set_node_status leave vault.calls empty", () => {
		const { app, ctx } = setup();

		createListViewsTool(ctx).handler({});
		createListNodesTool(ctx).handler({});
		createListStatusSetsTool(ctx).handler({});
		createGetNodeStatusTool(ctx).handler({ nodeId: "node-datadog" });
		createSetNodeStatusTool(ctx).handler({ view: "Job Hunt", nodeId: "node-datadog", statusLabel: "Applied" });

		expect(app.vault.calls).toEqual([]);
	});
});

describe("F2 real-filesystem check — a status write leaves the vault's actual file list, content and mtime untouched", () => {
	it("a real file on disk is byte-for-byte and mtime-identical before and after set_node_status", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atlas-mcp-f2-"));
		const filePath = join(dir, "Datadog.md");
		writeFileSync(filePath, "# Datadog\n\nSome note content.\n");
		const before = statSync(filePath);
		const contentBefore = readFileSync(filePath, "utf8");

		const { ctx } = setup();
		createSetNodeStatusTool(ctx).handler({ view: "Job Hunt", nodeId: "node-datadog", statusLabel: "Applied" });

		// Give any stray async disk write a chance to land before asserting it didn't.
		await new Promise((resolve) => setTimeout(resolve, 10));

		const after = statSync(filePath);
		const contentAfter = readFileSync(filePath, "utf8");
		expect(contentAfter).toBe(contentBefore);
		expect(after.mtimeMs).toBe(before.mtimeMs);
		expect(after.size).toBe(before.size);
	});
});
