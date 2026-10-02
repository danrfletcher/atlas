/** PR-7 (G17-G19/G22): a from-scratch CSV parser — no CSV library exists anywhere in this codebase.
 * Deliberately not a full RFC4180 validator: it supports the cases the spec actually asks for
 * (quoted fields containing commas/newlines, `""` as an escaped quote, CRLF/LF line endings, a UTF-8
 * BOM, duplicate/blank headers, ragged rows) and treats anything else leniently rather than erroring.
 *
 * The first row is always the header row (G19 — no toggle). Rows are returned as plain
 * `Record<string, string>` objects, the same flat shape `mapSampleRows`/`runJsMapping` already accept
 * for a top-level-array response, so CSV rows flow through that unmodified pipeline with no
 * `arrayField` needed. */

export interface CsvParseOk {
	ok: true;
	rows: Record<string, string>[];
	/** Rows dropped because they could never be tokenized (G22) — currently only the single trailing
	 * row left behind by a quote that opens and is never closed, which consumes the rest of the file.
	 * Ragged rows (too few/many fields) are NOT malformed and are never counted here — they are padded/
	 * truncated instead (see `parseCsv`). */
	skippedCount: number;
}

export interface CsvParseError {
	ok: false;
	error: string;
}

export type CsvParseOutcome = CsvParseOk | CsvParseError;

interface TokenizeResult {
	/** Each inner array is one row's raw fields, in source order. */
	rows: string[][];
	/** True when the text ends while still inside an open quote — that row's fields (if any were
	 * already completed on the current row) are NOT included in `rows`. */
	unterminatedQuote: boolean;
}

function tokenize(text: string): TokenizeResult {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let inQuotes = false;
	let i = 0;
	const n = text.length;

	while (i < n) {
		const c = text[i];
		if (inQuotes) {
			if (c === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i += 2;
					continue;
				}
				inQuotes = false;
				i++;
				continue;
			}
			field += c;
			i++;
			continue;
		}
		if (c === '"') {
			inQuotes = true;
			i++;
			continue;
		}
		if (c === ",") {
			row.push(field);
			field = "";
			i++;
			continue;
		}
		if (c === "\r") {
			if (text[i + 1] === "\n") i++;
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
			i++;
			continue;
		}
		if (c === "\n") {
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
			i++;
			continue;
		}
		field += c;
		i++;
	}

	if (inQuotes) return { rows, unterminatedQuote: true };

	// Flush a final field/row with no trailing newline — skip entirely for a truly empty file so it
	// stays a clean zero-row result rather than one phantom empty row.
	if (field !== "" || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return { rows, unterminatedQuote: false };
}

/** Blank headers fall back to "column"; any header (blank-fallback or not) that collides with an
 * earlier one is suffixed `_2`, `_3`, ... so every key `mapSampleRows` sees is unique. */
function dedupeHeaders(headers: string[]): string[] {
	const seen = new Map<string, number>();
	return headers.map((raw) => {
		const base = raw.trim() === "" ? "column" : raw.trim();
		const count = seen.get(base) ?? 0;
		seen.set(base, count + 1);
		return count === 0 ? base : `${base}_${count + 1}`;
	});
}

/** Parses `text` (a whole `.csv` file's contents) into header-keyed row objects. Never throws —
 * every failure mode is reported through the returned `CsvParseOutcome`. */
export function parseCsv(text: string): CsvParseOutcome {
	const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

	if (stripped.includes("\u0000")) {
		return { ok: false, error: "This file doesn't look like a CSV text file (it contains binary data)." };
	}

	const { rows: rawRows, unterminatedQuote } = tokenize(stripped);

	if (unterminatedQuote && rawRows.length === 0) {
		return { ok: false, error: "Couldn't read a header row: a quoted field is opened but never closed." };
	}

	if (rawRows.length === 0) return { ok: true, rows: [], skippedCount: 0 };

	const headers = dedupeHeaders(rawRows[0]);
	const dataRows = rawRows.slice(1);
	const rows: Record<string, string>[] = dataRows.map((raw) => {
		const obj: Record<string, string> = {};
		for (let i = 0; i < headers.length; i++) obj[headers[i]] = raw[i] ?? "";
		return obj;
	});

	return { ok: true, rows, skippedCount: unterminatedQuote ? 1 : 0 };
}
