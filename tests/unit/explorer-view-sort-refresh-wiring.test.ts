import { describe, expect, it, vi } from "vitest";
import type { WorkspaceLeaf } from "obsidian";
import { AtlasExplorerView } from "../../src/explorer-view";
import { SortRefreshGate } from "../../src/sort";

/** PR-2 (R2/R3, G9/E4): wires the four real refresh triggers — pane regains focus, the view loads,
 * a sort changes and the tree changes — through `AtlasExplorerView.onOpen`'s own listeners, not just
 * the `SortRefreshGate` class in isolation (`sort-refresh-gate.test.ts`'s own doc comment flags this
 * gap). `plugin.viewsManager.onChange`'s callback is driven directly with the `persisted` flag the
 * real `ViewsManager` now passes (proven separately in `views-on-change-persisted.test.ts`), so this
 * file's job is purely "does the explorer react to that flag, and to the other three triggers,
 * correctly" — never re-sorting on a plain vault modify/autosave or a render-only notify, and always
 * queuing the render each real trigger promises (R2: marking the gate dirty alone did nothing in a
 * view with no data sources, since nothing else would render next). */

type Fields = {
	sortRefreshGate: SortRefreshGate;
	leaf: WorkspaceLeaf;
	queueRender: () => void;
	render: () => Promise<void>;
	onOpen: () => Promise<void>;
};

function buildExplorer() {
	let unitIndexCb: (() => void) | null = null;
	let viewsManagerCb: ((persisted: boolean) => void) | null = null;
	const handlers = new Map<string, (...args: unknown[]) => void>();

	const plugin = {
		unitIndex: { onChange: (cb: () => void) => ((unitIndexCb = cb), () => {}) },
		viewsManager: { onChange: (cb: (persisted: boolean) => void) => ((viewsManagerCb = cb), () => {}) },
		app: {
			workspace: {
				on: (event: string, cb: (...args: unknown[]) => void) => {
					handlers.set(event, cb);
					return {};
				},
			},
		},
	};

	const explorer = new AtlasExplorerView({} as WorkspaceLeaf, plugin as never);
	Object.assign(explorer, {
		render: vi.fn(async () => {}),
		updateActiveHighlight: vi.fn(),
		refreshApiSourcesOnViewLoad: vi.fn(),
		refreshOutsideFolderSourcesOnFocus: vi.fn(),
		queueRender: vi.fn(),
		registerEvent: vi.fn(),
		registerDomEvent: vi.fn(),
	});

	const fields = explorer as unknown as Fields & { queueRender: ReturnType<typeof vi.fn>; render: ReturnType<typeof vi.fn> };
	return {
		explorer,
		fields,
		fireUnitIndexChange: () => unitIndexCb?.(),
		fireViewsManagerChange: (persisted: boolean) => viewsManagerCb?.(persisted),
		fireActiveLeafChange: (leaf: unknown) => handlers.get("active-leaf-change")?.(leaf),
	};
}

describe("PR-2 (R2/R3, G9/E4) — the real onOpen listeners mark the sort-refresh gate dirty only on the four allowed triggers", () => {
	it("the pane's very first open ('the view loads') marks the gate dirty", async () => {
		const { explorer, fields } = buildExplorer();
		await explorer.onOpen();
		// The initial render already consumed this via `await this.render()` in real code, but
		// `render` is stubbed here — the gate itself is the thing under test.
		expect(fields.sortRefreshGate.consume(false)).toBe(true);
	});

	it("R3: a plain vault modify/autosave (unitIndex's own onChange) never marks the gate dirty", async () => {
		const { explorer, fields, fireUnitIndexChange } = buildExplorer();
		await explorer.onOpen();
		fields.sortRefreshGate.consume(false); // clear the initial 'view loads' dirty flag

		fireUnitIndexChange();

		expect(fields.sortRefreshGate.consume(false)).toBe(false);
		expect(fields.queueRender).toHaveBeenCalled(); // still repaints, just doesn't re-sort
	});

	it("R3: a render-only viewsManager notify (persisted=false — a metadata resolve with nothing changed) never marks the gate dirty", async () => {
		const { explorer, fields, fireViewsManagerChange } = buildExplorer();
		await explorer.onOpen();
		fields.sortRefreshGate.consume(false);
		fields.queueRender.mockClear();

		fireViewsManagerChange(false);

		expect(fields.sortRefreshGate.consume(false)).toBe(false);
		expect(fields.queueRender).toHaveBeenCalled();
	});

	it("'a sort changes' and 'the tree changes' (a real save(), persisted=true) mark the gate dirty and queue a render", async () => {
		const { explorer, fields, fireViewsManagerChange } = buildExplorer();
		await explorer.onOpen();
		fields.sortRefreshGate.consume(false);
		fields.queueRender.mockClear();

		fireViewsManagerChange(true);

		expect(fields.sortRefreshGate.consume(false)).toBe(true);
		expect(fields.queueRender).toHaveBeenCalled();
	});

	it("R2: the pane regaining focus marks the gate dirty AND queues a render (not just the gate, which a view with no data sources would never otherwise render to consume)", async () => {
		const { explorer, fields, fireActiveLeafChange } = buildExplorer();
		await explorer.onOpen();
		fields.sortRefreshGate.consume(false);

		fireActiveLeafChange({}); // a different leaf becomes active — this pane loses focus
		fireActiveLeafChange(fields.leaf); // and now regains it
		fields.queueRender.mockClear();
		fireActiveLeafChange({}); // lose focus again
		fields.queueRender.mockClear();
		fireActiveLeafChange(fields.leaf); // regain focus — the trigger under test

		expect(fields.sortRefreshGate.consume(false)).toBe(true);
		expect(fields.queueRender).toHaveBeenCalled();
	});

	it("a leaf-change to some other leaf (this pane losing focus) does not itself mark the gate dirty", async () => {
		const { explorer, fields, fireActiveLeafChange } = buildExplorer();
		await explorer.onOpen();
		fields.sortRefreshGate.consume(false);

		fireActiveLeafChange({}); // some unrelated leaf becomes active

		expect(fields.sortRefreshGate.consume(false)).toBe(false);
	});
});
