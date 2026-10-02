import { describe, expect, it } from "vitest";
import { mapSampleRows } from "../../src/api-mapping";
import { planApiRefresh } from "../../src/api-refresh-plan";
import { parseCsv } from "../../src/csv-parsing";
import { ApiItemState } from "../../src/types";

const NOW = "2026-01-01T00:00:00.000Z";

function state(id: string, overrides: Partial<ApiItemState> = {}): ApiItemState {
	return { id, label: `Row ${id}`, lastSeenAt: "2025-12-31T00:00:00.000Z", ...overrides };
}

describe("planApiRefresh — PR-7: a file-change-triggered CSV refresh reuses the pipeline unmodified", () => {
	it("appends newly parsed CSV rows exactly as an API append refresh would", () => {
		const parsed = parseCsv("id,name\n1,One\n2,Two\n");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const mapped = mapSampleRows(parsed.rows, { idField: "id", labelField: "name" });

		const plan = planApiRefresh({
			prevState: { "1": state("1") },
			prevOrder: ["1"],
			rows: mapped.rows,
			mode: "append",
			truncated: mapped.truncated,
			nowIso: NOW,
			keepOnEmpty: true,
			confirmBeforeDelete: true,
		});

		expect(plan.needsConfirmation).toBe(false);
		expect(plan.result.order).toEqual(["1", "2"]);
		expect(plan.result.itemState["2"].label).toBe("Two");
	});

	it("an overwrite re-parse of an edited CSV file that drops a row asks for confirmation, same as an API overwrite would", () => {
		const editedCsv = parseCsv("id,name\n1,One\n");
		expect(editedCsv.ok).toBe(true);
		if (!editedCsv.ok) return;
		const mapped = mapSampleRows(editedCsv.rows, { idField: "id", labelField: "name" });

		const plan = planApiRefresh({
			prevState: { "1": state("1"), "2": state("2") },
			prevOrder: ["1", "2"],
			rows: mapped.rows,
			mode: "overwrite",
			truncated: mapped.truncated,
			nowIso: NOW,
			keepOnEmpty: true,
			confirmBeforeDelete: true,
		});

		expect(plan.needsConfirmation).toBe(true);
		expect(plan.deletedCount).toBe(1);
	});

	it("an empty CSV file (header-only) with keepOnEmpty leaves prior overwrite rows untouched, same as an empty API response would", () => {
		const emptied = parseCsv("id,name\n");
		expect(emptied.ok).toBe(true);
		if (!emptied.ok) return;
		const mapped = mapSampleRows(emptied.rows, { idField: "id", labelField: "name" });
		expect(mapped.rows).toEqual([]);

		const plan = planApiRefresh({
			prevState: { "1": state("1") },
			prevOrder: ["1"],
			rows: mapped.rows,
			mode: "overwrite",
			truncated: false,
			nowIso: NOW,
			keepOnEmpty: true,
			confirmBeforeDelete: true,
		});

		expect(plan.noChange).toBe(true);
		expect(plan.result.order).toEqual(["1"]);
	});
});
