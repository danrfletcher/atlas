import { McpTool } from "./mcp-protocol";

export interface AtlasStatusContext {
	getVaultName: () => string;
	getVaultPath: () => string;
	getPluginVersion: () => string;
	/** The names of every tool currently registered on the running server, `atlas_status` itself
	 * included — later PRs' tools are gated on-or-off independently of this one. */
	getToolNames: () => string[];
}

export interface AtlasStatusResult {
	vaultName: string;
	vaultPath: string;
	pluginVersion: string;
	tools: string[];
}

/**
 * G8/GP2: identifies the server to a calling agent before it issues any other call — the vault
 * name and absolute path let it confirm it reached the vault it intended (Q5: several open vaults
 * can each run their own server on this device). Callable with no arguments.
 */
export function createAtlasStatusTool(ctx: AtlasStatusContext): McpTool {
	return {
		name: "atlas_status",
		description: "Returns this vault's display name, absolute path, the Atlas plugin's version and the list of currently-enabled MCP tool names. Takes no arguments.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		handler: (): AtlasStatusResult => ({
			vaultName: ctx.getVaultName(),
			vaultPath: ctx.getVaultPath(),
			pluginVersion: ctx.getPluginVersion(),
			tools: ctx.getToolNames(),
		}),
	};
}
