import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "obsidian";
import { StatusesManager } from "../../src/statuses";
import { ViewsManager } from "../../src/views";
import { StatusGovernance, UnitRef, View, ViewNode } from "../../src/types";

const unit = (id: string, ref: UnitRef, extra: Partial<ViewNode> = {}): ViewNode => ({ id, type: "unit", ref, children: [], ...extra });
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** FX-META */
function fixtureNodes(): { A: ViewNode; M: ViewNode; B: ViewNode } {
	return {
		A: unit("A", { kind: "file", path: "A.md" }),
		M: {
			id: "m-field",
			type: "meta",
			label: "Field tech",
			collapsed: true,
			statusEnabled: true,
			statusSetId: "set1",
			inheritToSubfolders: true,
			hideCompleted: true,
			hideCancelled: false,
			applyTo: { block: true, file: false, module: true, metaFolder: true },
			truncatedStatuses: { "s-done": { enabled: true, label: "Done stuff" } },
			sortMode: "status",
			sortReverse: true,
			explicitStatusId: "s-doing",
			children: [
				unit("C1", { kind: "folder", path: "Quarry drone LiDAR" }),
				{ id: "C2", type: "meta", label: "Inner", children: [unit("C3", { kind: "file", path: "Inner.md" })] },
			],
		},
		B: unit("B", { kind: "file", path: "B.md" }),
	};
}

const CARRIED = [
	"collapsed",
	"statusEnabled",
	"statusSetId",
	"inheritToSubfolders",
	"hideCompleted",
	"hideCancelled",
	"applyTo",
	"truncatedStatuses",
	"sortMode",
	"sortReverse",
	"explicitStatusId",
] as const;

const FOLDER: UnitRef = { kind: "folder", path: "Field tech" };
const FILE: UnitRef = { kind: "file", path: "Field tech.md" };
const BLOCK: UnitRef = { kind: "file", path: "_pool/20260925143012-k3xq.md" };

let app: App;
let persist: ReturnType<typeof vi.fn>;
let listener: ReturnType<typeof vi.fn>;

function manager(root: ViewNode[]): ViewsManager {
	const view: View = { id: "v1", name: "Default", inboxMode: "view", root };
	const m = new ViewsManager(app, [view], "v1", persist);
	m.onChange(listener);
	return m;
}

beforeEach(() => {
	app = new App();
	persist = vi.fn();
	listener = vi.fn();
});

describe("replaceMetaNodeWithUnit", () => {
	it("IT-M1 replaces in place: same index, type unit, same id, new ref, no label", () => {
		const { A, M, B } = fixtureNodes();
		const m = manager([A, M, B]);
		expect(m.replaceMetaNodeWithUnit("v1", "m-field", FOLDER)).toBe(true);
		const root = m.getView("v1")!.root;
		expect(root).toHaveLength(3);
		expect(root.map((n) => n.id)).toEqual(["A", "m-field", "B"]);
		expect(root[1].type).toBe("unit");
		expect(root[1].ref).toEqual(FOLDER);
		expect("label" in root[1]).toBe(false);
	});

	it("IT-M2 every carried field is unchanged", () => {
		const { A, M, B } = fixtureNodes();
		const original = clone(M);
		const m = manager([A, M, B]);
		m.replaceMetaNodeWithUnit("v1", "m-field", FOLDER);
		const after = m.getNode("v1", "m-field")!;
		for (const field of CARRIED) expect(after[field], field).toEqual(original[field]);
	});

	it("IT-M3 children stay nested in order (same objects); siblings untouched", () => {
		const { A, M, B } = fixtureNodes();
		const [c1, c2] = M.children;
		const snapshots = [clone(A), clone(B)];
		const m = manager([A, M, B]);
		m.replaceMetaNodeWithUnit("v1", "m-field", FOLDER);
		const after = m.getNode("v1", "m-field")!;
		expect(after.children[0]).toBe(c1);
		expect(after.children[1]).toBe(c2);
		expect(after.children[1].children[0].id).toBe("C3");
		expect([A, B]).toEqual(snapshots);
	});

	it("IT-M4 works with a file ref and with a free-block ref (kind file)", () => {
		for (const ref of [FILE, BLOCK]) {
			const { A, M, B } = fixtureNodes();
			const m = manager([A, M, B]);
			expect(m.replaceMetaNodeWithUnit("v1", "m-field", ref)).toBe(true);
			expect(m.getNode("v1", "m-field")!.ref).toEqual(ref);
			expect(m.getNode("v1", "m-field")!.children.map((c) => c.id)).toEqual(["C1", "C2"]);
		}
	});

	it("IT-M5 keeps the exact index at root start/end, nested under a meta, and under a governed unit", () => {
		const indexOf = (m: ViewsManager, parent: ViewNode | null) => (parent ? parent.children : m.getView("v1")!.root).findIndex((n) => n.id === "m-field");
		// root index 0 and last
		for (const first of [true, false]) {
			const { A, M, B } = fixtureNodes();
			const m = manager(first ? [M, A, B] : [A, B, M]);
			m.replaceMetaNodeWithUnit("v1", "m-field", FOLDER);
			expect(indexOf(m, null)).toBe(first ? 0 : 2);
		}
		// nested under a meta
		{
			const { A, M, B } = fixtureNodes();
			const outer: ViewNode = { id: "outer", type: "meta", label: "Outer", children: [A, M, B] };
			const m = manager([outer]);
			m.replaceMetaNodeWithUnit("v1", "m-field", FOLDER);
			expect(indexOf(m, outer)).toBe(1);
			expect(outer.children.map((n) => n.id)).toEqual(["A", "m-field", "B"]);
		}
		// nested under a governed unit node
		{
			const { A, M, B } = fixtureNodes();
			const host = unit("host", { kind: "folder", path: "Host" }, { statusEnabled: true, statusSetId: "set1", children: [A, M, B] });
			const m = manager([host]);
			m.replaceMetaNodeWithUnit("v1", "m-field", FOLDER);
			expect(indexOf(m, host)).toBe(1);
			expect(host.statusEnabled).toBe(true);
		}
	});

	it("IT-M6 empty meta, and an unset `collapsed` stays unset", () => {
		const empty: ViewNode = { id: "e", type: "meta", label: "Empty", children: [] };
		const m = manager([empty]);
		expect(m.replaceMetaNodeWithUnit("v1", "e", FOLDER)).toBe(true);
		const after = m.getNode("v1", "e")!;
		expect(after.children).toEqual([]);
		expect(after.collapsed).toBeUndefined();
		expect("collapsed" in after).toBe(false);
	});

	it("IT-M7 unknown node, unknown view, or a unit node returns false and changes nothing", () => {
		const { A, M, B } = fixtureNodes();
		const m = manager([A, M, B]);
		const before = JSON.stringify(m.getViews());
		expect(m.replaceMetaNodeWithUnit("v1", "nope", FOLDER)).toBe(false);
		expect(m.replaceMetaNodeWithUnit("nope", "m-field", FOLDER)).toBe(false);
		expect(m.replaceMetaNodeWithUnit("v1", "A", FOLDER)).toBe(false);
		expect(JSON.stringify(m.getViews())).toBe(before);
		expect(persist).not.toHaveBeenCalled();
		expect(listener).not.toHaveBeenCalled();
	});

	it("IT-M8 persists and notifies exactly once", () => {
		const { A, M, B } = fixtureNodes();
		const m = manager([A, M, B]);
		m.replaceMetaNodeWithUnit("v1", "m-field", FOLDER);
		expect(persist).toHaveBeenCalledTimes(1);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("IT-M9 makes no disk calls and leaves child paths alone; a duplicate ref elsewhere isn't merged", () => {
		const { A, M, B } = fixtureNodes();
		const twin = unit("twin", FOLDER);
		const m = manager([A, M, B, twin]);
		m.replaceMetaNodeWithUnit("v1", "m-field", FOLDER);
		expect(app.vault.calls).toEqual([]);
		expect(m.getNode("v1", "C1")!.ref).toEqual({ kind: "folder", path: "Quarry drone LiDAR" });
		expect(m.getView("v1")!.root.map((n) => n.id)).toEqual(["A", "m-field", "B", "twin"]);
	});
});

describe("inherited status follows the parent's settings for the new kind", () => {
	const statuses = () =>
		new StatusesManager(
			[
				{
					id: "set1",
					name: "Set",
					defaultStatusId: "s-idea",
					statuses: [
						{ id: "s-idea", label: "Idea", color: "#888888" },
						{ id: "s-doing", label: "Doing", color: "#0088ff" },
						{ id: "s-done", label: "Done", color: "#00cc00" },
					],
				} as never,
			],
			[],
			() => {}
		);

	const resolve = (applyTo: StatusGovernance["applyTo"], ref: UnitRef | null, explicit?: string) => {
		const { M } = fixtureNodes();
		M.explicitStatusId = explicit;
		if (explicit === undefined) delete M.explicitStatusId;
		const viewRoot: StatusGovernance = { statusEnabled: true, statusSetId: "set1", inheritToSubfolders: true, applyTo };
		const m = manager([M]);
		const sm = statuses();
		const before = sm.resolveNodeStatus([viewRoot], M)?.label ?? null;
		if (ref) m.replaceMetaNodeWithUnit("v1", "m-field", ref);
		const after = sm.resolveNodeStatus([viewRoot], m.getNode("v1", "m-field")!)?.label ?? null;
		return { before, after };
	};

	it("IT-S1 module on / metaFolder on: meta 'Doing' stays 'Doing' as a module", () => {
		expect(resolve({ file: false, module: true, metaFolder: true }, FOLDER, "s-doing")).toEqual({ before: "Doing", after: "Doing" });
	});
	it("IT-S2 file off: the status disappears when replaced by a file", () => {
		expect(resolve({ file: false, module: true, metaFolder: true }, FILE, "s-doing")).toEqual({ before: "Doing", after: null });
	});
	it("IT-S3 module off, file on", () => {
		expect(resolve({ file: true, module: false, metaFolder: true }, FOLDER, "s-doing")).toEqual({ before: "Doing", after: null });
		expect(resolve({ file: true, module: false, metaFolder: true }, FILE, "s-doing")).toEqual({ before: "Doing", after: "Doing" });
	});
	it("IT-S4 a free block (kind file) follows the file switch, not the block switch", () => {
		expect(resolve({ block: false, file: true, metaFolder: true }, BLOCK, "s-doing")).toEqual({ before: "Doing", after: "Doing" });
		expect(resolve({ block: true, file: false, metaFolder: true }, BLOCK, "s-doing")).toEqual({ before: "Doing", after: null });
	});
	it("IT-S5 without an explicit status the set default resolves before and after", () => {
		expect(resolve({ file: true, module: true, metaFolder: true }, FOLDER)).toEqual({ before: "Idea", after: "Idea" });
	});
	it("IT-S6 an explicit status is kept and resolves per the module switch", () => {
		expect(resolve({ module: true }, FOLDER, "s-done")).toEqual({ before: "Done", after: "Done" });
		expect(resolve({ module: false }, FOLDER, "s-done")).toEqual({ before: "Done", after: null });
	});

	it("IT-S7 children resolve to the same status before and after", () => {
		const viewRoot: StatusGovernance = { statusEnabled: true, statusSetId: "set1", inheritToSubfolders: true };
		const sm = statuses();
		const { M } = fixtureNodes();
		const before = M.children.map((c) => sm.resolveNodeStatus([M, viewRoot], c)?.label ?? null);
		const m = manager([M]);
		m.replaceMetaNodeWithUnit("v1", "m-field", FOLDER);
		const replaced = m.getNode("v1", "m-field")!;
		const after = replaced.children.map((c) => sm.resolveNodeStatus([replaced, viewRoot], c)?.label ?? null);
		expect(after).toEqual(before);
		expect(before.every((l) => l !== null)).toBe(true);
	});
});
