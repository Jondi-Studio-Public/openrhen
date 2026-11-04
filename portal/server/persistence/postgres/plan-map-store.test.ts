import { afterEach, describe, expect, it, vi } from "vitest";
import { listPlanMap } from "./plan-map-store";
import type { Sql } from "./sql-pool";

const CREATED = new Date("2026-10-01T00:00:00.000Z");

const linkRow = (id: string, proposer: string) => ({
  id,
  from_type: "action",
  from_id: "a1",
  to_type: "action",
  to_id: "a2",
  kind: "before",
  weight: null,
  status: "suggested",
  proposer,
  evidence: [],
  created_at: CREATED,
  decided_at: null,
  last_confirmed_at: null
});

const findingRow = (id: string, status: string) => ({
  id,
  check_name: "overlap",
  item_ids: [],
  text: "Two things overlap.",
  evidence: [],
  suggested_changes: [],
  questions: [],
  status,
  created_at: CREATED,
  decided_at: null
});

/** A `Sql` stand-in that answers each `listPlanMap` statement by what it selects from. */
function fakeSql(rows: { links: unknown[]; findings: unknown[]; live?: Record<string, string[]> }): Sql {
  const run = (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    // The handle existence checks (`existingIds`) select an id from the item's own table.
    for (const [table, ids] of Object.entries(rows.live ?? {}))
      if (text.includes(`FROM ${table} `)) return Promise.resolve(ids.map((id) => ({ id })));
    if (text.includes("FROM plan_subjects")) return Promise.resolve([]);
    if (text.includes("FROM plan_links")) return Promise.resolve(rows.links);
    if (text.includes("FROM plan_findings")) return Promise.resolve(rows.findings);
    return Promise.resolve([]);
  };
  return Object.assign(run, { unsafe: (text: string) => text, json: (value: unknown) => value }) as unknown as Sql;
}

afterEach(() => vi.restoreAllMocks());

describe("listPlanMap drops handles whose target is gone", () => {
  it("removes a deleted item's handle, keeping live ones and handles that name no plan item", async () => {
    const map = await listPlanMap(
      fakeSql({
        links: [],
        findings: [
          {
            ...findingRow("00000000-0000-4000-8000-000000000007", "open"),
            item_ids: ["project:p1", "project:gone", "action:a1", "action:a2", "bare-commitment-id", "mystery:1"]
          }
        ],
        live: { "projects p": ["p1"], "actions x": ["a1"] }
      }),
      "user"
    );
    expect(map.findings[0]!.itemIds).toEqual(["project:p1", "action:a1", "bare-commitment-id", "mystery:1"]);
  });
});

describe("listPlanMap tolerates a bad stored row", () => {
  it("skips a link and a finding that fail validation, warns by row id, and returns the good rows", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const map = await listPlanMap(
      fakeSql({
        links: [
          linkRow("00000000-0000-4000-8000-000000000001", "rule:unit-code"),
          linkRow("00000000-0000-4000-8000-000000000002", "test-agent")
        ],
        findings: [
          findingRow("00000000-0000-4000-8000-000000000003", "not-a-status"),
          findingRow("00000000-0000-4000-8000-000000000004", "open")
        ]
      }),
      "user"
    );

    expect(map.links.map((link) => link.id)).toEqual(["00000000-0000-4000-8000-000000000001"]);
    expect(map.findings.map((finding) => finding.id)).toEqual(["00000000-0000-4000-8000-000000000004"]);

    expect(warn).toHaveBeenCalledTimes(2);
    const lines = warn.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, string>);
    expect(lines.map((line) => [line.table, line.rowId])).toEqual([
      ["plan_links", "00000000-0000-4000-8000-000000000002"],
      ["plan_findings", "00000000-0000-4000-8000-000000000003"]
    ]);
    expect(lines[0]!.issue).toMatch(/^proposer:/);
    // Names the row and the issue only: nothing from the row's contents is logged.
    expect(warn.mock.calls.flat().join(" ")).not.toContain("test-agent");
    expect(warn.mock.calls.flat().join(" ")).not.toContain("Two things overlap");
  });

  it("returns every row, and logs nothing, when all rows are valid", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const map = await listPlanMap(
      fakeSql({
        links: [
          linkRow("00000000-0000-4000-8000-000000000005", "owner"),
          linkRow("00000000-0000-4000-8000-000000000006", "rule:unit-code")
        ],
        findings: []
      }),
      "user"
    );
    expect(map.links).toHaveLength(2);
    expect(warn).not.toHaveBeenCalled();
  });
});
