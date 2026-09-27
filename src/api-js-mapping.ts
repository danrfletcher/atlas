import { API_ROW_CAP, MapResponseResult, toStringField } from "./api-mapping";
import { ApiFieldMapping, ApiMappedRow } from "./types";

/** G3: turns a saved drag `mapping` into equivalent JS source, pre-filling the editor on drag→js.
 * Mirrors `mapSampleRows`'s own field access/coercion exactly (`String(...)`, empty/missing → ""), so
 * running the generated code against the same sample the drag mapping used produces identical rows —
 * "pre-filled code round-trips" (G3). Defensive against a non-object raw item (`src = item &&
 * typeof item === "object" ? item : {}`) even though `mapSampleRows` skips those outright, since an
 * arbitrary hand-written response could otherwise throw `item[idField]` on a bare `null` entry.
 * `extra` is always emitted as `{}` — PR-4 has no drag-mapping extra-field UI to pre-fill from yet
 * (PR-5's job); this keeps the generated shape matching the spec's `{id, label, secondary, extra:{}}`
 * without inventing fields nothing maps to. */
export function generateJsFromMapping(mapping: ApiFieldMapping): string {
	const idKey = JSON.stringify(mapping.idField);
	const labelKey = JSON.stringify(mapping.labelField);
	const arrayExpr = mapping.arrayField
		? `Array.isArray(response) ? response : (response && typeof response === "object" ? response[${JSON.stringify(mapping.arrayField)}] : undefined)`
		: "response";
	const secondaryBlock = mapping.secondaryField
		? [
				"",
				`    const secondaryValue = src[${JSON.stringify(mapping.secondaryField)}];`,
				"    if (secondaryValue !== undefined && secondaryValue !== null) row.secondary = String(secondaryValue);",
			].join("\n")
		: "";
	return [
		"(response) => {",
		`  const items = ${arrayExpr};`,
		"  if (!Array.isArray(items)) return [];",
		"  return items.map((item) => {",
		'    const src = item && typeof item === "object" ? item : {};',
		"    const row = {",
		`      id: src[${idKey}] === undefined || src[${idKey}] === null ? "" : String(src[${idKey}]),`,
		`      label: src[${labelKey}] === undefined || src[${labelKey}] === null ? "" : String(src[${labelKey}]),`,
		"      extra: {},",
		"    };" + secondaryBlock,
		"    return row;",
		"  });",
		"};",
	].join("\n");
}

function jsErrorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return typeof err === "string" ? err : "Unknown JavaScript error";
}

/** The JS receives a deep copy of the response (G3), so mutating it inside the user's function can
 * never corrupt the sample or the last-fetched response held by the modal/controller. */
function deepCopy<T>(value: T): T {
	const cloner = (globalThis as { structuredClone?: (v: T) => T }).structuredClone;
	if (typeof cloner === "function") return cloner(value);
	return JSON.parse(JSON.stringify(value)) as T;
}

type CompiledMapper = (response: unknown) => unknown;

/** Compiles (but does not run) `source` as `(response) => [...]`. A syntax error — or the source not
 * evaluating to a function at all — surfaces here, before anything is ever executed, so both Save/Test
 * (E5: "a syntax error is caught at Save/Test") and a defensively-parsed `doRefresh` (E5: "JS throws ...
 * the dot turns red") can treat it the same way: a normal mapping failure, never an unhandled throw. */
export function compileJsMapper(source: string): { ok: true; fn: CompiledMapper } | { ok: false; error: string } {
	try {
		// F4: deliberately unsandboxed by design; see the spec's warning-only mitigation. `new Function`
		// never closes over this module's scope, so the compiled mapper has no access to anything here
		// beyond its own `response` argument (F1). A single trailing `;` is stripped first — both the
		// generated pre-fill (which ends its top-level statement with one) and ordinary hand-typed source
		// ("(response) => {...};") would otherwise break the `return (...)` expression wrapper below.
		const trimmed = source.trim().replace(/;\s*$/, "");
		const fn: unknown = new Function(`"use strict";\nreturn (\n${trimmed}\n);`)();
		if (typeof fn !== "function") return { ok: false, error: "JS source must be a function" };
		return { ok: true, fn: fn as CompiledMapper };
	} catch (err) {
		return { ok: false, error: jsErrorMessage(err) };
	}
}

/** G3: Save/Test-time syntax check — "the source is not saved with unusable code." */
export function validateJsSource(source: string): { ok: true } | { ok: false; error: string } {
	const compiled = compileJsMapper(source);
	return compiled.ok ? { ok: true } : { ok: false, error: compiled.error };
}

function coerceJsId(raw: unknown): string | null {
	if (raw === undefined || raw === null) return null;
	if (typeof raw === "string") return raw === "" ? null : raw;
	// E2 (stated rule): number/boolean ids are coerced via `String(...)`, matching drag mode's own
	// coercion — anything else (object, array, function, symbol) has no sensible string form and is
	// treated the same as a missing id.
	if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
	return null;
}

/** `extra`'s stated rule: missing/null/non-object is dropped (no extras, no crash); a non-scalar
 * nested value (object/array) is dropped field-by-field rather than flattened or rejecting the whole
 * row — "the output is one flat list" applies to `extra`'s own values too. */
function normalizeExtra(raw: unknown): Record<string, unknown> | undefined {
	if (raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
			result[key] = value;
		}
	}
	return result;
}

/** G3/E1/E2/E4: maps the JS function's own return value. E1 is a distinct, whole-refresh failure from
 * E2's per-item skip: a non-array return, or an array holding any non-object element, fails the entire
 * refresh with a "not a list" error (last good cache kept) — unlike drag mode's `mapSampleRows`, which
 * silently skips individual non-object items one at a time. Once the output's shape itself is
 * confirmed to be an array-of-objects, per-item id problems (missing/duplicate) fall back to the same
 * skip-and-count rule as drag mode (E2). */
export function mapJsOutputRows(output: unknown): MapResponseResult {
	if (!Array.isArray(output)) return { error: "JS output is not a list" };
	for (const raw of output) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "JS output is not a list" };
	}

	const seenIds = new Set<string>();
	const rows: ApiMappedRow[] = [];
	let skippedCount = 0;
	let truncated = false;

	for (const raw of output as Record<string, unknown>[]) {
		if (rows.length >= API_ROW_CAP) {
			truncated = true;
			break;
		}
		const id = coerceJsId(raw.id);
		if (id === null || seenIds.has(id)) {
			skippedCount++;
			continue;
		}
		seenIds.add(id);

		const row: ApiMappedRow = { id, label: toStringField(raw, "label") };
		if (raw.secondary !== undefined && raw.secondary !== null) row.secondary = String(raw.secondary);
		const extra = normalizeExtra(raw.extra);
		if (extra !== undefined) row.extra = extra;
		rows.push(row);
	}

	return { rows, skippedCount, truncated };
}

/** G3: compiles, runs (awaiting a Promise-returning function — the builder's stated choice for "async
 * or Promise-returning code is either awaited or rejected"), and maps `source` against `response`. Any
 * failure along the way — syntax error, thrown error, a rejected promise, an undefined-property access
 * — becomes a plain `{ error }` result; the caller (`ApiSourceController.doRefresh`, or the modal's
 * Test button) treats it exactly like any other mapping error (E5), never an unhandled rejection. */
export async function runJsMapping(source: string, response: unknown): Promise<MapResponseResult> {
	const compiled = compileJsMapper(source);
	if (!compiled.ok) return { error: compiled.error };
	let output: unknown;
	try {
		output = await compiled.fn(deepCopy(response));
	} catch (err) {
		return { error: jsErrorMessage(err) };
	}
	return mapJsOutputRows(output);
}
