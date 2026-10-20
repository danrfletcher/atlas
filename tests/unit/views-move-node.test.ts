/** PR-3 — `moveNode`'s same-parent index fix (G1, E1, E2), plus the pre-existing cross-parent and
 * root-parent behaviour it must leave unchanged. Drives the real `ViewsManager`, not a mock — same
 * pattern as `tests/unit/sort-setting.test.ts`. */
import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { App as MockApp } from "../mocks/obsidian";
import { ViewsManager } from "../../src/views";

function labelsOf(nodes: { type: string; label?: string; ref?: { kind: string; path?: string } }[]): (string | undefined)[] {
	return nodes.map((n) => (n.type === "meta" ? n.label : n.ref && "path" in n.ref ? (n.ref as { path: string }).path : undefined));
}

/** Builds N plain file siblings directly under `parentId` (or the view root), named "0.md".."N-1.md"
 * in that manual order, and returns their node ids in the same order. */
function buildSiblings(views: ViewsManager, viewId: string, parentId: string | null, n: number): string[] {
	const ids: string[] = [];
	for (let i = 0; i < n; i++) {
		views.placeUnit(viewId, { kind: "file", path: `${i}.md` }, parentId);
	}
	const children = parentId ? views.getNode(viewId, parentId)!.children : views.getView(viewId)!.root;
	for (const c of children) ids.push(c.id);
	return ids;
}

describe("PR-3 — moveNode: for every (from, to) pair in N siblings, the result matches the line's indicated position", () => {
	const N = 5;
	// `targetIndex` here is the position the edge-drop caller would compute from the CURRENT
	// (pre-removal) array: `p` for "insert before the row currently at index p", `p + 1` for
	// "insert after it". Exercises every from/to pair, including the first and last slot.
	for (let from = 0; from < N; from++) {
		for (let to = 0; to <= N; to++) {
			it(`moving sibling at index ${from} to target index ${to} (pre-removal) lands where expected`, () => {
				const app = new MockApp();
				const views = new ViewsManager(app as unknown as App, [], "v1", () => {});
				const viewId = views.getViews()[0].id;
				const ids = buildSiblings(views, viewId, null, N);
				const names = Array.from({ length: N }, (_, i) => `${i}.md`);

				const ok = views.moveNode(viewId, ids[from], null, to);
				expect(ok).toBe(true);

				// Expected: remove `from`, then insert it at `to`, adjusted for the removal exactly the
				// way the real `handleDrop` -> `moveNode` call site means it (pre-removal target index).
				const expected = [...names];
				const [moved] = expected.splice(from, 1);
				let insertAt = to;
				if (from < to) insertAt -= 1;
				expected.splice(Math.max(0, Math.min(insertAt, expected.length)), 0, moved);

				const result = labelsOf(views.getView(viewId)!.root);
				expect(result).toEqual(expected);
			});
		}
	}
});

describe("PR-3 (E1) — moving to the slot just before or just after its own position leaves the order unchanged, with no save", () => {
	it("dropping on its own top edge (target index == own index) is a no-op", () => {
		const app = new MockApp();
		const persist = () => void 0;
		const views = new ViewsManager(app as unknown as App, [], "v1", persist);
		const viewId = views.getViews()[0].id;
		const ids = buildSiblings(views, viewId, null, 3); // 0.md, 1.md, 2.md
		const before = JSON.stringify(views.getView(viewId)!.root);

		const ok = views.moveNode(viewId, ids[1], null, 1); // "1.md" dropped on its own top edge
		expect(ok).toBe(true);
		expect(JSON.stringify(views.getView(viewId)!.root)).toBe(before);
	});

	it("dropping on its own bottom edge (target index == own index + 1) is a no-op", () => {
		const app = new MockApp();
		const views = new ViewsManager(app as unknown as App, [], "v1", () => {});
		const viewId = views.getViews()[0].id;
		const ids = buildSiblings(views, viewId, null, 3);
		const before = JSON.stringify(views.getView(viewId)!.root);

		expect(views.moveNode(viewId, ids[1], null, 2)).toBe(true);
		expect(JSON.stringify(views.getView(viewId)!.root)).toBe(before);
	});

	it("dropping on the previous sibling's bottom edge is a no-op", () => {
		const app = new MockApp();
		const views = new ViewsManager(app as unknown as App, [], "v1", () => {});
		const viewId = views.getViews()[0].id;
		const ids = buildSiblings(views, viewId, null, 3);
		const before = JSON.stringify(views.getView(viewId)!.root);

		// "1.md"'s previous sibling is "0.md" at index 0; its bottom edge is target index 1.
		expect(views.moveNode(viewId, ids[1], null, 1)).toBe(true);
		expect(JSON.stringify(views.getView(viewId)!.root)).toBe(before);
	});

	it("dropping on the next sibling's top edge is a no-op", () => {
		const app = new MockApp();
		const views = new ViewsManager(app as unknown as App, [], "v1", () => {});
		const viewId = views.getViews()[0].id;
		const ids = buildSiblings(views, viewId, null, 3);
		const before = JSON.stringify(views.getView(viewId)!.root);

		// "1.md"'s next sibling is "2.md" at index 2; its top edge is target index 2.
		expect(views.moveNode(viewId, ids[1], null, 2)).toBe(true);
		expect(JSON.stringify(views.getView(viewId)!.root)).toBe(before);
	});

	it("a true no-op never calls the persist callback", () => {
		const app = new MockApp();
		let saved = false;
		const views = new ViewsManager(app as unknown as App, [], "v1", () => {
			saved = true;
		});
		const viewId = views.getViews()[0].id;
		const ids = buildSiblings(views, viewId, null, 3);
		saved = false; // ignore the saves from buildSiblings's own placeUnit calls

		views.moveNode(viewId, ids[1], null, 1);
		expect(saved).toBe(false);
	});
});

describe("PR-3 (E2) — moving into a descendant is refused and leaves children untouched", () => {
	it("refuses dropping a folder onto an edge of its own child, with no structural change", () => {
		const app = new MockApp();
		const views = new ViewsManager(app as unknown as App, [], "v1", () => {});
		const viewId = views.getViews()[0].id;
		const parent = views.addMetaFolder(viewId, null, "Parent")!;
		const child = views.addMetaFolder(viewId, parent.id, "Child")!;
		const before = JSON.stringify(views.getView(viewId)!.root);

		const ok = views.moveNode(viewId, parent.id, child.id, 0);
		expect(ok).toBe(false);
		expect(JSON.stringify(views.getView(viewId)!.root)).toBe(before);
	});

	it("refuses dropping a node onto itself as its own new parent", () => {
		const app = new MockApp();
		const views = new ViewsManager(app as unknown as App, [], "v1", () => {});
		const viewId = views.getViews()[0].id;
		const folder = views.addMetaFolder(viewId, null, "Folder")!;

		expect(views.moveNode(viewId, folder.id, folder.id, 0)).toBe(false);
	});
});

describe("PR-3 — cross-parent moves are unchanged (always a real move, always restamps)", () => {
	it("moving a node from one folder to a different folder lands at the given index and restamps placedAt", () => {
		const app = new MockApp();
		const views = new ViewsManager(app as unknown as App, [], "v1", () => {});
		const viewId = views.getViews()[0].id;
		const folderA = views.addMetaFolder(viewId, null, "A")!;
		const folderB = views.addMetaFolder(viewId, null, "B")!;
		views.placeUnit(viewId, { kind: "file", path: "x.md" }, folderA.id);
		views.placeUnit(viewId, { kind: "file", path: "b1.md" }, folderB.id);
		views.placeUnit(viewId, { kind: "file", path: "b2.md" }, folderB.id);
		const xId = views.getNode(viewId, folderA.id)!.children[0].id;

		const ok = views.moveNode(viewId, xId, folderB.id, 1);
		expect(ok).toBe(true);
		expect(labelsOf(views.getNode(viewId, folderA.id)!.children)).toEqual([]);
		expect(labelsOf(views.getNode(viewId, folderB.id)!.children)).toEqual(["b1.md", "x.md", "b2.md"]);
		expect(views.getNode(viewId, folderB.id)!.children[1].placedAt).toBeTypeOf("number");
	});
});

describe("PR-3 — the root parent (null) behaves like any other parent", () => {
	it("a same-root-parent downward move adjusts its index exactly like a same-meta-folder move", () => {
		const app = new MockApp();
		const views = new ViewsManager(app as unknown as App, [], "v1", () => {});
		const viewId = views.getViews()[0].id;
		const ids = buildSiblings(views, viewId, null, 4); // A B C D (0..3.md)

		// Move "0.md" (index 0) to target index 3 ("before 3.md" pre-removal) -> expect 1,2,0,3.
		expect(views.moveNode(viewId, ids[0], null, 3)).toBe(true);
		expect(labelsOf(views.getView(viewId)!.root)).toEqual(["1.md", "2.md", "0.md", "3.md"]);
	});

	it("moving from a folder to the root (null) behaves as any other cross-parent move", () => {
		const app = new MockApp();
		const views = new ViewsManager(app as unknown as App, [], "v1", () => {});
		const viewId = views.getViews()[0].id;
		const folder = views.addMetaFolder(viewId, null, "Folder")!;
		views.placeUnit(viewId, { kind: "file", path: "child.md" }, folder.id);
		const childId = views.getNode(viewId, folder.id)!.children[0].id;

		expect(views.moveNode(viewId, childId, null, 0)).toBe(true);
		expect(labelsOf(views.getView(viewId)!.root)).toEqual(["child.md", "Folder"]);
	});
});
