/** A stable reference to a unit, persisted in plugin data (manual promotions, later views). */
export type UnitRef =
	| { kind: "file"; path: string }
	| { kind: "folder"; path: string }
	| { kind: "block"; path: string; subpath: string };

export function unitRefKey(ref: UnitRef): string {
	return ref.kind === "block" ? `block:${ref.path}#${ref.subpath}` : `${ref.kind}:${ref.path}`;
}

export function unitRefsEqual(a: UnitRef, b: UnitRef): boolean {
	return unitRefKey(a) === unitRefKey(b);
}

/** F9 rename integrity: rewrite `path` if it's an exact match for `oldPath`, or a descendant of it
 * (`oldPath/...`) — the same rule Obsidian applies to link paths on rename. Returns the same string
 * instance, unchanged, if neither applies (so callers can cheaply detect "did this change"). Shared
 * by `rewriteRefPath` (below) and PR-4's `folderSource.path`, a plain vault-relative string with the
 * same rename-integrity requirement but no surrounding `UnitRef` to rewrite. */
export function rewritePathString(path: string, oldPath: string, newPath: string): string {
	if (path === oldPath) return newPath;
	if (path.startsWith(`${oldPath}/`)) return `${newPath}${path.slice(oldPath.length)}`;
	return path;
}

/** F9 rename integrity: rewrite `ref.path` if it's an exact match for `oldPath`, or a descendant
 * of it (`oldPath/...`) — the same rule Obsidian applies to link paths on rename. Returns the same
 * `ref` instance, unchanged, if neither applies (so callers can cheaply detect "did this change"). */
export function rewriteRefPath(ref: UnitRef, oldPath: string, newPath: string): UnitRef {
	const rewritten = rewritePathString(ref.path, oldPath, newPath);
	return rewritten === ref.path ? ref : { ...ref, path: rewritten };
}

/** PR-4 (R8): rewrites the path embedded in a `unitRefKey` string (`'file:Proj/a.md'`,
 * `'folder:Proj'`, `'block:Proj/a.md#^abc'`) using the same rename-integrity rule as
 * `rewritePathString`. `FolderSourceConfig.removedRefs` stores these keys rather than `UnitRef`s
 * (it only needs to test membership), but still needs to stay in sync on rename like every other
 * ref in the view — otherwise a removed row's key stops matching the renamed path and the row comes
 * back on the next refresh. Returns the same string instance, unchanged, if the embedded path
 * doesn't match `oldPath`. */
export function rewriteRefKeyPath(key: string, oldPath: string, newPath: string): string {
	const colon = key.indexOf(":");
	if (colon < 0) return key;
	const kind = key.slice(0, colon);
	const rest = key.slice(colon + 1);
	if (kind === "block") {
		const hash = rest.indexOf("#");
		if (hash < 0) return key;
		const path = rest.slice(0, hash);
		const subpath = rest.slice(hash + 1);
		const rewritten = rewritePathString(path, oldPath, newPath);
		return rewritten === path ? key : `block:${rewritten}#${subpath}`;
	}
	const rewritten = rewritePathString(rest, oldPath, newPath);
	return rewritten === rest ? key : `${kind}:${rewritten}`;
}

/** A unit as classified by the index — the computed shape the explorer (F8) will render. */
export type Unit =
	| { type: "root-file"; path: string }
	| { type: "free-block"; path: string }
	| { type: "folder-unit"; path: string }
	| { type: "promoted-file"; path: string; topLevelFolder: string }
	| { type: "promoted-folder"; path: string; topLevelFolder: string }
	| { type: "promoted-block"; path: string; subpath: string };

export function unitKey(unit: Unit): string {
	return unit.type === "promoted-block" ? `block:${unit.path}#${unit.subpath}` : `${unit.type}:${unit.path}`;
}

export function unitToRef(unit: Unit): UnitRef {
	if (unit.type === "promoted-block") {
		return { kind: "block", path: unit.path, subpath: unit.subpath };
	}
	if (unit.type === "folder-unit" || unit.type === "promoted-folder") {
		return { kind: "folder", path: unit.path };
	}
	return { kind: "file", path: unit.path };
}

/** PR 17: which unit kinds actually receive status treatment from a governor's assignment. Absent
 * (or an absent individual field) defaults to `true` — matches the reference plugin's own default
 * (`applyToFiles`/`applyToFolders` both default on) — so a governor created before this PR existed
 * keeps applying to everything, not silently narrowing. "Module" is a real on-disk folder (Atlas's
 * own term for a folder-unit); "metaFolder" is the organizational, no-disk-presence kind — the two
 * are genuinely different things in Atlas even though the reference plugin only has one "Folders"
 * concept, since it has no meta-folder equivalent at all. */
export interface ApplyToConfig {
	block?: boolean;
	file?: boolean;
	module?: boolean;
	metaFolder?: boolean;
}

/** PR 17: whether one particular status's matching items should collapse into a single summary row
 * instead of listing individually — ported from the reference plugin's `truncatedStatuses` shape,
 * keyed by status id within whichever set this governor is currently assigned. Capture-only in this
 * PR (the modal saves it, nothing reads it yet) — PR 19 wires it into actual rendering. */
export interface TruncatedStatusConfig {
	enabled: boolean;
	label?: string;
}

/** PR 15-17: the full set of status-related fields a "governor" (something with "Statuses" turned
 * on for what's underneath it) carries. Shared between `ViewNode` (an item governing its own direct
 * children) and `View` (the view root, governing its top-level items) — `resolveNodeStatus` walks a
 * mixed chain of both without needing to know which kind of governor it's looking at at each step,
 * since the fields and their meaning are identical either way. */
export interface StatusGovernance {
	/** PR 15: master toggle — governs this governor's own *direct children*, never the governor's
	 * own displayed status (a `ViewNode`'s own display comes from *its* governor, one level up). */
	statusEnabled?: boolean;
	statusSetId?: string;
	/** PR 17: when on, this governor's assignment cascades past direct children to every descendant,
	 * until a closer governor (with its own `statusEnabled`+`statusSetId`) takes over for its own
	 * subtree — same "nearest ancestor wins" precedence an inherited CSS property would have. Off by
	 * default (the reference plugin defaults this on; Dan explicitly wants the opposite for Atlas). */
	inheritToSubfolders?: boolean;
	/** PR 17 (capture only — PR 19 wires this into actual rendering): hide items whose current
	 * status is flagged completed/cancelled from the tree entirely. */
	hideCompleted?: boolean;
	hideCancelled?: boolean;
	applyTo?: ApplyToConfig;
	/** PR 17 (capture only — PR 19 wires this into actual rendering). */
	truncatedStatuses?: Record<string, TruncatedStatusConfig>;
	/** PR 22: ranks this governor's children ascending by their resolved status's own position
	 * within the governing status set's `statuses[]` (index 0 = highest rank) instead of the
	 * existing manual/drag-ordered arrangement. Absent (or `"manual"`) is today's default —
	 * unaffected by this field entirely. */
	sortMode?: "manual" | "status";
	/** PR 22: reverses the rank order from `sortMode: "status"` — meaningless (and left unset/
	 * ignored) while `sortMode` isn't `"status"`; not a general "flip manual order" toggle. */
	sortReverse?: boolean;
}

/** F9 — a node in a view's bucket tree. Unit nodes have no children; meta nodes are labels with
 * no disk presence and nest without limit. */
export interface ViewNode extends StatusGovernance {
	id: string;
	type: "meta" | "unit";
	label?: string; // meta only
	ref?: UnitRef; // unit only
	children: ViewNode[]; // meta nodes only; unit nodes always []
	collapsed?: boolean;
	/** PR 16: which status within a *governing parent's* set this exact node currently shows —
	 * never about this node's own children (that's `statusEnabled`/`statusSetId`, inherited from
	 * `StatusGovernance`, above). Absent means "show the governing set's own default status," the
	 * same as before this PR existed. */
	explicitStatusId?: string;
	/** PR-2 (API-backed Atlas Folders): request/mapping config for a "Folder" (meta node) whose rows
	 * are pulled from a JSON API instead of (or alongside) manually placed children. Only ever set on
	 * a `type: "meta"` node. Headers (including any bearer token) are deliberately absent from this
	 * shape — see `ApiHeadersStore` — so this object is safe to persist in synced `data.json` (G13).
	 *
	 * E7 (ticket 34n6ct71muguncxk, not yet built anywhere in this repo as of PR-3 either): whatever code
	 * converts a meta Folder into a real disk-backed folder must copy this field (including PR-3's
	 * `overwrite`/guard/refresh-every additions), `apiCache`, `apiItemState`, `apiItemOrder` and
	 * `apiAwaitingConfirmation` onto the resulting node unchanged, and must leave any already-placed/
	 * pulled children alone — the conversion affects only the Folder node itself. */
	apiSource?: ApiSourceConfig;
	/** Last-refresh outcome. Holds mapped rows only, never the raw response (G13/E9: cache contents
	 * assertion). */
	apiCache?: ApiCache;
	/** Per-API-row durable state (status, note, "not found" flag), keyed by the API's own row id —
	 * survives refreshes independently of whatever the API currently reports. */
	apiItemState?: Record<string, ApiItemState>;
	/** Display order of `apiItemState`'s keys — a plain `Record` has no reliable iteration order
	 * across a JSON round-trip, so order is tracked explicitly alongside it. */
	apiItemOrder?: string[];
	/** PR-3 (G6b): true only while an automatic refresh (timer or view-load) found rows it would need
	 * to delete under Overwrite, asked for confirmation, and got no answer (dismissed via Escape/view
	 * close). Drives the amber "waiting for confirmation" dot and suppresses re-asking on further
	 * automatic refreshes for this Folder — cleared the moment any refresh is actually answered
	 * (confirmed or cancelled), including a later manual "Refresh now", which always asks again
	 * regardless of this flag. Meaningless (and always cleared) once `apiSource` itself is absent. */
	apiAwaitingConfirmation?: boolean;
	/** PR-4 (G3-G5/G10/G16): an Inside-Vault "Folder" source — unlike `apiSource`, this never produces
	 * placeholder/API-item rows; it only decides which real `ViewNode` unit children belong under this
	 * meta node (via `buildFolderSourceChildren`/`reconcileManagedChildren` in `folder-source.ts`), so
	 * those children go through the exact same place/nest/reorder/status/missing-ref machinery as any
	 * other unit (G7/G9/G16). Only ever set on a `type: "meta"` node. */
	folderSource?: FolderSourceConfig;
	/** PR-4: true only on a `type: "unit"` child this Folder's own reconciliation created/owns, so a
	 * later refresh can tell its managed rows apart from anything the user separately nested in here by
	 * hand, without needing new dedup logic (E2 is handled entirely by existing multi-placement
	 * support). Absent/false means "not mine" — never cleared or removed by reconciliation. */
	folderSourceManaged?: boolean;
	/** PR-4 (R1 fix): the id of the meta node whose `folderSource` created this row, set alongside
	 * `folderSourceManaged` and never cleared by moving/nesting it elsewhere in the view (G7) — this is
	 * what lets a refresh find a managed row again no matter where the user dragged or nested it,
	 * instead of only looking at the source's own direct children. */
	folderSourceOwnerId?: string;
}

/** A single request header, e.g. `Authorization: Bearer …`. Never persisted in `data.json` — see
 * `ApiHeadersStore` (G13: device-local only). */
export interface ApiHeader {
	key: string;
	value: string;
}

/** PR-5 (G9b): which action to perform when an API row is clicked. */
export type ApiClickAction = "none" | "open-attachment" | "run-command";

/** Which sample field maps to which target (G2). `arrayField` is set only when the raw response is
 * a plain object rather than a list — the top-level key whose value is the array to read rows from. */
export interface ApiFieldMapping {
	idField: string;
	labelField: string;
	secondaryField?: string;
	arrayField?: string;
	/** PR-5 (G2): extra named fields mapped beyond id/label/secondary. Key is the extra field name
	 * (letters, digits, underscore, e.g. "path"), value is the sample item's field name. */
	extraFields?: Record<string, string>;
}

/** PR-3 (G1): the data-source modal's type selector. `ApiSourceConfig` is the only shape this PR
 * actually builds — `folder`/`markdown-table`/`csv` are stub shapes with nothing but the discriminant
 * itself, existing purely so the union/mechanism is in place for PR-4 through PR-8 to grow into
 * without altering this PR's code. */
export type DataSourceType = "api" | "folder" | "markdown-table" | "csv";

export interface ApiSourceConfig {
	/** PR-3 (G1): optional, not required, so a source persisted before this PR (with no `type` at all)
	 * still loads as an API source — only the modal's own in-memory state treats "no type selected" as
	 * meaningfully different from "api". */
	type?: "api";
	url: string;
	/** GET only in this PR (G1) — the type exists so a later PR's JS/other-method work has somewhere to
	 * grow into, without this PR's own code ever producing or accepting anything else. */
	method: "GET";
	mapping: ApiFieldMapping;
	mode: "append" | "merge" | "overwrite";
	/** G5a. */
	refreshOnViewLoad: boolean;
	/** G5b: "Refresh every [X] minutes", off by default with no fixed value — independent of
	 * `refreshOnViewLoad`/"Refresh now" (G5). `refreshEveryMinutes` is only meaningful while this is
	 * on; below-minimum/blank/non-numeric values are rejected by the modal before they ever reach this
	 * field (`validateRefreshMinutes`), and a value that reaches here some other way (hand-edited
	 * `data.json`) is clamped up to `MIN_REFRESH_MINUTES` on load, never rejected outright. */
	refreshEveryMinutesEnabled?: boolean;
	refreshEveryMinutes?: number;
	/** G6b(i): Overwrite-only, default on (absent/`undefined` means on — only an explicit `false`
	 * turns it off). With this on, a refresh whose response is an empty list leaves every row as-is
	 * instead of following Overwrite's normal "replace everything" rule. */
	keepOnEmpty?: boolean;
	/** G6b(ii): Overwrite-only, default on. With this on, a refresh that would delete one or more rows
	 * asks for confirmation first (`ApiSourceController`'s confirm-delete flow) instead of deleting
	 * outright. */
	confirmBeforeDelete?: boolean;
	/** PR-4 (G3): "drag" (default, absent) maps via `mapping` exactly as PR-2/PR-3; "js" replaces the
	 * mapping step with `jsSource` instead. `mapping` is kept as-is while in "js" mode (never cleared),
	 * so switching back to drag restores whatever drag mapping was last set. */
	mappingMode?: "drag" | "js";
	/** PR-4 (G3): the JS mapper's full source, `(response) => [{id, label, secondary, extra}]` — only
	 * meaningful while `mappingMode` is "js". Not a secret (covered by the modal's own warning instead);
	 * stored in synced `data.json` like the rest of `source`, unlike headers (`ApiHeadersStore`). */
	jsSource?: string;
	/** PR-5 (G9b): click action on an API row — "none", "open-attachment" (default), or "run-command"
	 * (desktop only). */
	action?: ApiClickAction;
	/** PR-5 (G9b): alias for `action`, matching PR-5 spec/brief phrases interchangeably. */
	clickAction?: ApiClickAction;
	/** PR-5 (G9b): command string executed in the background when action is "run-command". */
	command?: string;
}

/** PR-4 (G3-G5/G10/G16): the Inside-Vault "Folder" source's config. Outside Vault (external
 * filesystem) is PR-5's job — `location` already carries that discriminant so this PR's code can
 * stub it out (the modal blocks Save while it's selected) without a later PR having to widen this
 * shape's own fields. */
export interface FolderSourceConfig {
	type?: "folder";
	/** G4: defaults to "inside". "outside" (PR-5) reconciles children against a device-local absolute
	 * path instead — see `FolderSourcePathStore`, never this object's own `path` field. */
	location: "inside" | "outside";
	/** G5: vault-relative path to the target folder — never absolute. Only meaningful while
	 * `location` is "inside"; meaningless while "outside" (see `FolderSourcePathStore`). */
	path: string;
	/** G4: both default true, independent of each other. */
	showFiles: boolean;
	showFolders: boolean;
	/** G10: reuses the exact same refresh-toggle fields/semantics as `ApiSourceConfig` — no new
	 * refresh UI or scheduler for Folder sources. */
	refreshOnViewLoad: boolean;
	refreshEveryMinutesEnabled?: boolean;
	refreshEveryMinutes?: number;
	/** PR-4 (R1 fix): `unitRefKey`-keyed refs the user has explicitly removed from this source's
	 * managed set (via "Remove from view", the Delete key, or dragging to the inbox) — reconcile never
	 * recreates one of these, the same way any other removed ref stays gone rather than being
	 * resurrected on the next refresh. */
	removedRefs?: string[];
}

export interface MarkdownTableSourceConfigStub {
	type: "markdown-table";
}
export interface CsvSourceConfigStub {
	type: "csv";
}

/** PR-3 (G1): the sibling-shapes union `ApiSourceConfig`'s new `type` field exists to support —
 * `ViewNode.apiSource`/`ViewNode.folderSource` stay their own concretely-typed fields rather than
 * this union, which is exercised today only inside `ApiSourceModal`. */
export type DataSourceConfig = ApiSourceConfig | FolderSourceConfig | MarkdownTableSourceConfigStub | CsvSourceConfigStub;

/** A row exactly as mapped from a response — this is all the cache ever holds, never the raw
 * response (G13, E9). */
export interface ApiMappedRow {
	id: string;
	label: string;
	secondary?: string;
	/** PR-4/PR-5: extra named fields alongside id/label/secondary — populated by JS mode now; a
	 * drag-mapping equivalent is PR-5's job. Carried through the cache unchanged for PR-5's click
	 * action to read once it exists. */
	extra?: Record<string, unknown>;
}

export interface ApiCache {
	fetchedAt: number | null;
	ok: boolean;
	error: string | null;
	rows: ApiMappedRow[];
	/** E2: items skipped for a missing/duplicate id, this refresh. */
	skippedCount: number;
	/** E4: true when the response had more than 5,000 valid rows. */
	truncated: boolean;
	/** R3/G11: the time of the *last successful* refresh, carried through subsequent failures so the
	 * dot's tooltip can keep reporting it ("unreachable, last updated 3 h ago") instead of the failed
	 * attempt's own time. `undefined`/absent means never successfully refreshed. */
	lastSuccessAt?: number;
}

/** G29: the one general placeholder-row kind tag every placeholder row carries — shared by
 * API-sourced rows today and (future) Table-sourced rows, so menu-enablement (Remove,
 * Remove attachment) gates on this tag plus `notFound`/`noteRef` instead of on an API-specific
 * check that wouldn't extend to Table rows. There is only one value because there is only one
 * general kind — API and Table rows are never distinguished by it. */
export const PLACEHOLDER_ROW_KIND = "placeholder" as const;
export type PlaceholderRowKind = typeof PLACEHOLDER_ROW_KIND;

/** One API row's durable, per-id state (G6c: status and note never change on refresh; label and
 * secondary text always follow the API). */
export interface ApiItemState {
	id: string;
	label: string;
	/** G29: always `PLACEHOLDER_ROW_KIND` — see its doc comment. */
	kind: PlaceholderRowKind;
	secondary?: string;
	explicitStatusId?: string;
	noteRef?: UnitRef;
	/** Merge mode only (G6): the row vanished from the API but is kept, marked "not found". */
	notFound?: boolean;
	/** R13: stamped to the refresh time every time the API actually reports this row present —
	 * including the moment it reappears (G6c) — never to the time a later refresh notices it's
	 * gone. So while `notFound` is true, this is the last time the row was truly seen, which is what
	 * "not found, last seen <date>" reports. */
	lastSeenAt?: string;
}

/** PR 17: extends `StatusGovernance` so the view root itself can be a governor — "Statuses" on the
 * view-name selector assigns statuses to top-level bucket items the same way right-clicking any
 * other item assigns them to its children. */
export interface View extends StatusGovernance {
	id: string;
	name: string;
	root: ViewNode[];
	inboxMode: "view" | "global";
}

export const DEFAULT_VIEW_NAME = "Default";

export function createEmptyView(id: string, name: string): View {
	return { id, name, root: [], inboxMode: "view" };
}
