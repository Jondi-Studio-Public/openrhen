import { describe, expect, it } from "vitest";
import type { ImportBatch, ImportRecord } from "@openrhen/contracts";
import { buildImportErrorCsv, csvCell } from "./import-downloads";
import { sourceRelationships } from "./import-record-source";

function record(overrides: Partial<ImportRecord>): ImportRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    importKey: "action:one",
    entityType: "action",
    operation: "create",
    expectedVersion: null,
    matchedEntityId: null,
    fields: {},
    relationships: {},
    errors: [],
    warnings: [],
    removed: false,
    sortOrder: 0,
    ...overrides
  };
}

const batch = (records: ImportRecord[]) =>
  ({
    id: "22222222-2222-4222-8222-222222222222",
    sourceType: "csv",
    inputKind: "planning_data",
    timezone: "Australia/Sydney",
    templateVersion: "1",
    status: "blocked",
    version: 1,
    records,
    source: {}
  }) as ImportBatch;

describe("buildImportErrorCsv", () => {
  it("writes one row per error and skips records that have none", () => {
    const csv = buildImportErrorCsv(
      batch([
        record({ importKey: "action:one", errors: ["title is required", "expectedMinutes is required"] }),
        record({ importKey: "action:two" })
      ])
    );
    expect(csv.split("\r\n")).toEqual([
      "sheet,row,entity_type,import_key,error",
      '"","","action","action:one","title is required"',
      '"","","action","action:one","expectedMinutes is required"'
    ]);
  });

  it("addresses each error by the sheet and row the record was read from", () => {
    const csv = buildImportErrorCsv(
      batch([
        record({
          importKey: "action:one",
          relationships: sourceRelationships("Actions", 14),
          errors: ["title is required"]
        })
      ])
    );
    expect(csv.split("\r\n")[1]).toBe('"Actions","14","action","action:one","title is required"');
  });

  it("escapes embedded quotes so a quoted error cannot break the row", () => {
    const csv = buildImportErrorCsv(batch([record({ errors: ['status "done" is not accepted'] })]));
    expect(csv).toContain('"status ""done"" is not accepted"');
  });
});

describe("csvCell", () => {
  it("neutralises formula-leading text and leaves numbers and plain text alone", () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    for (const lead of ["+1", "-1", "@SUM(A1)", "\tx", "\rx"]) expect(csvCell(lead)).toBe(`"'${lead}"`);
    expect(csvCell(-3)).toBe('"-3"');
    expect(csvCell("plain")).toBe('"plain"');
  });

  it("applies to every column of the error report", () => {
    const csv = buildImportErrorCsv(batch([record({ importKey: "=cmd|x", errors: ["@bad"] })]));
    expect(csv).toContain(`"'=cmd|x","'@bad"`);
  });
});
