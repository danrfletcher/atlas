/** PR-4: shared "drive a real edge/nest drop through AtlasExplorerView's private drag handlers"
 * harness. Mirrors the shape of the locally-scoped helpers `explorer-view.test.ts` already
 * defines for its own PR-3/PR-4 drag tests, extracted here so other test files
 * (`explorer-view-sort.test.ts`, `folder-source-outside-children-behavior.test.ts`) can drive the
 * same real code path (`makeDropZone`/`handleDrop`/`assessDrop`/...) without re-deriving the
 * `dragMethodNames` cast themselves. Not itself a `*.test.ts` file, so vitest's
 * `tests/**\/*.test.ts` include glob skips it. */
import { vi } from "vitest";
import type { App } from "obsidian";
import { AtlasExplorerView } from "../../src/explorer-view";
import { StatusesManager } from "../../src/statuses";
import { ViewNode } from "../../src/types";
import { ViewsManager } from "../../src/views";
import { App as MockApp } from "../mocks/obsidian";

// Every other private method `makeDropZone`'s own closures reach via `this.xxx(...)`
// (`handleDrop`, `findNodeAnywhere`, `findNodeParent`, `isCycleDrop`, `nodeContainsDescendant`,
// `showDropIndicator`, `clearDropIndicator`, and PR-4's own `assessDrop`/`batchHasInFolderRow`/
// `effectiveSortForParent`/`ancestorChainFor`/`isOutsideSourceFolder`/`sortedParentLabel`/
// `showSortedDropRefusedNotice`/`showSortedDropOutline`/`clearSortedDropOutline`/`resolveRef`)
// must be assigned onto the fake too -- a closure's captured `this` is whatever `this` was when
// `makeDropZone` itself was *called* (`fake`, since it's invoked as `fake.makeDropZone(...)`
// below), not just whichever one property is read here.
const dragMethodNames = [
	"makeDropZone",
	"handleDrop",
	"findNodeAnywhere",
	"findNodeParent",
	"isCycleDrop",
	"nodeContainsDescendant",
	"showDropIndicator",
	"clearDropIndicator",
	"assessDrop",
	"batchHasInFolderRow",
	"effectiveSortForParent",
	"ancestorChainFor",
	"isOutsideSourceFolder",
	"sortedParentLabel",
	"showSortedDropRefusedNotice",
	"showSortedDropOutline",
	"clearSortedDropOutline",
	"resolveRef",
] as const;
const dragProto = AtlasExplorerView.prototype as unknown as Record<(typeof dragMethodNames)[number], (...a: unknown[]) => unknown>;

export interface DropFake {
	plugin: { viewsManager: ViewsManager; statusesManager?: StatusesManager };
	dragPayload: unknown;
	dropIndicatorEl: HTMLElement | null;
	sortedDropOutlineEl: HTMLElement | null;
	selectedBucketNodeIds: Set<string>;
	selectedInboxRefKeys: Set<string>;
	queueRender: ReturnType<typeof vi.fn>;
	removeUnitsFromView: ReturnType<typeof vi.fn>;
	unitsByRefKey: Map<string, unknown>;
	makeDropZone: (...a: unknown[]) => unknown;
	handleDrop: (...a: unknown[]) => unknown;
}

export function makeDropFake(viewsManager: ViewsManager, statusesManager?: StatusesManager): DropFake {
	const fake: Record<string, unknown> = {
		plugin: { viewsManager, statusesManager },
		dragPayload: null,
		dropIndicatorEl: null,
		sortedDropOutlineEl: null,
		selectedBucketNodeIds: new Set(),
		selectedInboxRefKeys: new Set(),
		queueRender: vi.fn(),
		removeUnitsFromView: vi.fn(),
		// `sortedParentLabel`'s unit branch calls the real `resolveRef`, which needs
		// `this.unitsByRefKey` -- empty rather than wired to a real index unless a caller needs it.
		unitsByRefKey: new Map(),
	};
	for (const name of dragMethodNames) fake[name] = dragProto[name];
	return fake as unknown as DropFake;
}

export function makeRow(height = 100): HTMLElement {
	const row = document.createElement("div");
	row.getBoundingClientRect = () =>
		({ top: 0, bottom: height, height, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
	return row;
}

export function dragOverAt(row: HTMLElement, clientY: number): void {
	row.dispatchEvent(new MouseEvent("dragover", { bubbles: true, cancelable: true, clientY }));
}

/** PR-4: `handleDrop`'s refusal path fires `void this.showSortedDropRefusedNotice(...)`
 * fire-and-forget, and that chain defers its `new Notice(...)` call to a microtask even for a
 * synchronous label lookup. Two drained ticks comfortably clears that one-`await`-deep chain
 * before a test asserts on `Notice.instances`. */
export async function flushNoticeMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

export function makeVm(root: ViewNode[]): ViewsManager {
	const app = new MockApp() as unknown as App;
	return new ViewsManager(app, [{ id: "v1", name: "Default", inboxMode: "view", root }], "v1", () => {});
}

export function node(id: string, path: string, children: ViewNode[] = []): ViewNode {
	return { id, type: "unit", ref: { kind: "file", path }, children };
}

export function folderNode(id: string, label: string, children: ViewNode[], extra: Partial<ViewNode> = {}): ViewNode {
	return { id, type: "meta", label, children, ...extra };
}
