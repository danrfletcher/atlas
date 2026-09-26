import { vi } from "vitest";
import { App, TFile } from "obsidian";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { UnitIndex } from "../../src/unit-index";
import { ViewsManager } from "../../src/views";
import { StatusSet, StatusesManager } from "../../src/statuses";
import { UnitRef, View, ViewNode } from "../../src/types";
import { CreateFromMetaDeps } from "../../src/create-from-meta";
import { seedRoot } from "../helpers";

/** The `atlas-pr4` fixture vault (root-level unless stated). */
export const ROOT_FILES = ["Existing.md", "MixedCase.md", "Reading list.md", "Report.pdf", "Ärger.md"];
export const ROOT_FOLDERS = ["Existing Folder", "Archive", "Sub", "_pool"];
export const NESTED_FILES = ["Sub/Nested Note.md", "Existing Folder/Existing Folder.md", "Archive/Archive.md", "_pool/20260101000000-aaaa.md"];

export const file = (path: string): UnitRef => ({ kind: "file", path });
export const folder = (path: string): UnitRef => ({ kind: "folder", path });
export const unit = (id: string, ref: UnitRef, extra: Partial<ViewNode> = {}): ViewNode => ({ id, type: "unit", ref, children: [], ...extra });
export const meta = (id: string, label: string, children: ViewNode[] = [], extra: Partial<ViewNode> = {}): ViewNode => ({ id, type: "meta", label, children, ...extra });
export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** T-empty */
export const tEmpty = (): ViewNode[] => [meta("ft", "Field tech")];

/** T-many: "Field tech" (index 1, expanded) holds a file, a module, a nested meta with a deeper meta, and a PDF. */
export const tMany = (): ViewNode[] => [
	meta("a", "Other A"),
	meta("ft", "Field tech", [
		unit("c-existing", file("Existing.md")),
		unit("c-archive", folder("Archive")),
		meta("c-sub", "Sub", [unit("c-nested", file("Sub/Nested Note.md")), meta("c-deep", "Deep", [unit("c-ef", folder("Existing Folder"))])]),
		unit("c-report", file("Report.pdf")),
	], { collapsed: false }),
	meta("b", "Other B"),
];

/** T-nested */
export const tNested = (): ViewNode[] => [
	meta("outer", "Outer", [meta("mid", "Mid", [meta("ft", "Field tech", [unit("c-existing", file("Existing.md"))])]), unit("c-mixed", file("MixedCase.md"))]),
];

/** T-gov: status sets S and S2, "Projects" governing "Field tech", which is a governor itself. */
export const STATUS_SETS: StatusSet[] = [
	{
		id: "S",
		name: "S",
		defaultStatusId: "idea",
		statuses: [
			{ id: "idea", label: "Idea", color: "#888888" },
			{ id: "doing", label: "Doing", color: "#0088ff" },
			{ id: "done", label: "Done", color: "#00cc00" },
		],
	},
	{
		id: "S2",
		name: "S2",
		defaultStatusId: "todo",
		statuses: [
			{ id: "todo", label: "Todo", color: "#888888" },
			{ id: "doing", label: "Doing", color: "#0088ff" },
			{ id: "done", label: "Done", color: "#00cc00" },
		],
	},
];

export const tGov = (parentApplyTo: ViewNode["applyTo"] = { block: true, file: true, module: true, metaFolder: true }): ViewNode[] => [
	meta(
		"projects",
		"Projects",
		[
			meta(
				"ft",
				"Field tech",
				[unit("c-existing", file("Existing.md"), { explicitStatusId: "done" }), unit("c-archive", folder("Archive")), meta("c-sub", "Sub")],
				{
					collapsed: true,
					explicitStatusId: "doing",
					statusEnabled: true,
					statusSetId: "S2",
					inheritToSubfolders: true,
					hideCompleted: true,
					hideCancelled: false,
					sortMode: "status",
					sortReverse: true,
					applyTo: { block: false, file: true, module: true, metaFolder: false },
					truncatedStatuses: { done: { enabled: true, label: "Finished" } },
				}
			),
		],
		{ statusEnabled: true, statusSetId: "S", inheritToSubfolders: false, applyTo: parentApplyTo }
	),
];

export const CARRIED = ["collapsed", "explicitStatusId", "statusEnabled", "statusSetId", "inheritToSubfolders", "hideCompleted", "hideCancelled", "applyTo", "truncatedStatuses", "sortMode", "sortReverse"] as const;

export interface Setup {
	app: App;
	views: ViewsManager;
	index: UnitIndex;
	statuses: StatusesManager;
	deps: CreateFromMetaDeps & { app: App };
	saved: View[][];
	persist: ReturnType<typeof vi.fn>;
	listing(): string[];
	contentOf(path: string): string | undefined;
}

export function setup(root: ViewNode[], options: { pool?: string; extraViews?: View[]; links?: boolean } = {}): Setup {
	const app = new App();
	seedRoot(app, [], ROOT_FOLDERS);
	seedRoot(app, [...ROOT_FILES, ...NESTED_FILES]);
	app.vault.config.alwaysUpdateLinks = options.links ?? true;
	const pool = options.pool ?? "_pool";
	const persist = vi.fn();
	const saved: View[][] = [];
	const views = new ViewsManager(app, [{ id: "default", name: "Default", inboxMode: "view", root }, ...(options.extraViews ?? [])], "default", persist);
	const index = new UnitIndex(app, { ...DEFAULT_SETTINGS, poolFolder: pool, excludedFolders: [pool, "_to_delete"] }, []);
	index.rebuild();
	app.vault.on("create", (f) => index.onVaultCreate(f));
	app.vault.on("delete", (f) => index.onVaultDelete(f.path));
	const statuses = new StatusesManager(clone(STATUS_SETS), [], () => {});
	const deps = {
		app,
		getPoolFolder: () => pool,
		getExcludedFolders: () => [pool, "_to_delete"],
		getNode: (viewId: string, nodeId: string) => views.getNode(viewId, nodeId),
		replaceMetaNodeWithUnit: (viewId: string, nodeId: string, ref: UnitRef) => views.replaceMetaNodeWithUnit(viewId, nodeId, ref),
		holdUnit: (path: string) => index.holdUnit(path),
		save: async () => void saved.push(clone(views.getViews())),
	};
	const listing = () => [
		...app.vault.getFiles().map((f) => f.path),
		...[...allFolders(app)].map((p) => `${p}/`),
	].sort();
	return { app, views, index, statuses, deps, saved, persist, listing, contentOf: (path) => app.vault.contents.get(path) };
}

function allFolders(app: App): string[] {
	const out: string[] = [];
	const walk = (folder: { children: unknown[] }) => {
		for (const child of folder.children) {
			if (child instanceof TFile) continue;
			const c = child as { path: string; children: unknown[] };
			out.push(c.path);
			walk(c);
		}
	};
	walk(app.vault.getRoot());
	return out;
}

/** Every node in a tree, depth first. */
export function walk(nodes: ViewNode[], visit: (n: ViewNode) => void): void {
	for (const n of nodes) {
		visit(n);
		walk(n.children, visit);
	}
}

/** Everything under a node, as ids in order (stands in for "the same children"). */
export const subtreeIds = (n: ViewNode): string[] => {
	const out: string[] = [];
	walk(n.children, (c) => out.push(c.id));
	return out;
};
