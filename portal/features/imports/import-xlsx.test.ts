import ExcelJS from "exceljs";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { createImportWorkbook, parseImportWorkbook } from "./import-xlsx";
import { describeImportRecordSource } from "./import-record-source";
import { validateImportRecords } from "@/features/imports/import-validation";

const SPREADSHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

/** Rewrites a workbook the way the Open XML SDK emits one: main namespace bound to an `x:` prefix. */
async function prefixNamespace(data: ArrayBuffer): Promise<ArrayBuffer> {
  const zip = await JSZip.loadAsync(data);
  for (const part of Object.values(zip.files)) {
    if (part.dir || !/^xl\/.+\.xml$/.test(part.name)) continue;
    const xml = await part.async("string");
    if (!xml.includes(`xmlns="${SPREADSHEET_NS}"`)) continue;
    zip.file(
      part.name,
      xml
        .replaceAll(/<(\/?)([a-zA-Z]\w*)([\s/>])/g, "<$1x:$2$3")
        .replaceAll(`xmlns="${SPREADSHEET_NS}"`, `xmlns:x="${SPREADSHEET_NS}"`)
    );
  }
  return zip.generateAsync({ type: "arraybuffer" });
}

/**
 * A workbook the way Excel writes one when the person typed dates rather than pasting the example
 * strings: the cells carry real Dates, whose UTC face is the clock the sheet shows.
 */
async function workbookWithDateCells(): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  const actions = workbook.addWorksheet("Actions");
  actions.addRow([
    "import_key",
    "project_key",
    "title",
    "status",
    "optimistic_minutes",
    "expected_minutes",
    "pessimistic_minutes",
    "remaining_minutes",
    "energy",
    "minimum_session_minutes",
    "maximum_session_minutes",
    "splittable",
    "setup_minutes",
    "importance",
    "consequence",
    "deadline_at",
    "notes"
  ]);
  actions.addRow([
    "typed-deadline",
    "network-assignment",
    "Submit the assignment",
    "planned",
    20,
    30,
    45,
    30,
    "medium",
    20,
    45,
    true,
    5,
    4,
    4,
    new Date(Date.UTC(2026, 7, 20, 17, 0)),
    "Bring the marking rubric"
  ]);
  const recurrences = workbook.addWorksheet("Recurring Commitments");
  recurrences.addRow([
    "import_key",
    "title",
    "timezone",
    "start_date",
    "end_date",
    "interval_days",
    "local_start_time",
    "local_end_time",
    "setup_before_minutes",
    "transition_after_minutes"
  ]);
  recurrences.addRow([
    "typed-recurrence",
    "Piano lesson",
    "Australia/Sydney",
    new Date(Date.UTC(2026, 7, 14)),
    "",
    14,
    new Date(Date.UTC(1899, 11, 30, 14, 0)),
    new Date(Date.UTC(1899, 11, 30, 15, 0)),
    10,
    15
  ]);
  const buffer = await workbook.xlsx.writeBuffer();
  return buffer as ArrayBuffer;
}

describe("XLSX import", () => {
  it("creates every template sheet and parses the example hierarchy", async () => {
    const workbook = await createImportWorkbook();
    const records = await parseImportWorkbook(
      workbook.buffer.slice(workbook.byteOffset, workbook.byteOffset + workbook.byteLength) as ArrayBuffer
    );

    expect(new Set(records.map((record) => record.entityType))).toEqual(
      new Set([
        "area",
        "outcome",
        "project",
        "deliverable",
        "deliverable_dependency",
        "action",
        "dependency",
        "fixed_commitment",
        "fixed_commitment_recurrence",
        "condition_definition"
      ])
    );
    expect(records.find((record) => record.importKey === "assessment-2")).toMatchObject({
      entityType: "deliverable",
      relationships: { projectKey: "network-assignment" }
    });
    expect(records.find((record) => record.importKey === "assessment-2")?.fields.status?.value).toBe("needs_breakdown");
    expect(records.find((record) => record.importKey === "assessment-2-after-1")).toMatchObject({
      entityType: "deliverable_dependency",
      relationships: { deliverableKey: "assessment-2", dependsOnDeliverableKey: "assessment-1" }
    });
    expect(records.find((record) => record.importKey === "draft-section-1")?.relationships.projectKey).toBe(
      "network-assignment"
    );
    expect(records.find((record) => record.importKey === "draft-section-1")?.fields.contexts?.value).toEqual([
      "laptop",
      "home"
    ]);
    expect(records.find((record) => record.importKey === "draft-section-1")?.fields.requirementPathways?.value).toEqual(
      [{ id: "p1", contextIds: ["laptop", "home"] }]
    );
    const piano = records.find((record) => record.importKey === "piano-fortnightly");
    expect(piano?.entityType).toBe("fixed_commitment_recurrence");
    expect(piano?.fields.intervalDays?.value).toBe(14);
    expect(piano?.fields.localStartTime?.value).toBe("14:00");
  });

  it("reads a workbook whose SpreadsheetML tags carry a namespace prefix", async () => {
    const workbook = await createImportWorkbook();
    const prefixed = await prefixNamespace(
      workbook.buffer.slice(workbook.byteOffset, workbook.byteOffset + workbook.byteLength) as ArrayBuffer
    );
    const records = await parseImportWorkbook(prefixed);

    expect(records.find((record) => record.importKey === "draft-section-1")?.relationships.projectKey).toBe(
      "network-assignment"
    );
    expect(records.find((record) => record.importKey === "piano-fortnightly")?.fields.intervalDays?.value).toBe(14);
  });

  it("reads a typed date cell as wall time in the batch timezone, not as UTC", async () => {
    const seedZone = await parseImportWorkbook(await workbookWithDateCells(), "Australia/Sydney");
    const action = seedZone.find((record) => record.importKey === "typed-deadline");
    // 5 pm on the sheet in the seed zone is 07:00Z — read as UTC it landed at 3 am the next day.
    expect(action?.fields.deadlineAt?.value).toBe("2026-08-20T07:00:00.000Z");
    expect(action?.fields.notes?.value).toBe("Bring the marking rubric");

    const newYork = await parseImportWorkbook(await workbookWithDateCells(), "America/New_York");
    expect(newYork.find((record) => record.importKey === "typed-deadline")?.fields.deadlineAt?.value).toBe(
      "2026-08-20T21:00:00.000Z"
    );
    const utc = await parseImportWorkbook(await workbookWithDateCells(), "UTC");
    expect(utc.find((record) => record.importKey === "typed-deadline")?.fields.deadlineAt?.value).toBe(
      "2026-08-20T17:00:00.000Z"
    );
  });

  it("reads typed time-only and date-only cells as HH:MM and YYYY-MM-DD", async () => {
    const records = await parseImportWorkbook(await workbookWithDateCells(), "Australia/Sydney");
    const recurrence = records.find((record) => record.importKey === "typed-recurrence");
    expect(recurrence?.fields.localStartTime?.value).toBe("14:00");
    expect(recurrence?.fields.localEndTime?.value).toBe("15:00");
    expect(recurrence?.fields.startDate?.value).toBe("2026-08-14");
    expect(validateImportRecords(records).find((record) => record.importKey === "typed-recurrence")?.errors).toEqual(
      []
    );
  });

  it("ignores a byte-order mark left on the first header cell", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Areas");
    sheet.addRow(["﻿import_key", "name", "description", "status", "sort_order"]);
    sheet.addRow(["study", "Study", "", "active", 0]);
    const records = await parseImportWorkbook((await workbook.xlsx.writeBuffer()) as ArrayBuffer);
    expect(records[0]?.importKey).toBe("study");
  });
});

describe("XLSX column presence", () => {
  it("records a column the sheet does not carry as absent, and a blank cell in one it does as a cell", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Areas");
    sheet.addRow(["import_key", "name", "description"]);
    sheet.addRow(["study", "Study", ""]);
    const records = await parseImportWorkbook((await workbook.xlsx.writeBuffer()) as ArrayBuffer);
    expect(records[0]?.fields.description).toMatchObject({ value: null, basis: "missing", source: "cell" });
    expect(records[0]?.fields.status).toMatchObject({
      value: null,
      basis: "missing",
      source: "absent",
      needsReview: false
    });
    expect(records[0]?.fields.name).toMatchObject({ value: "Study", source: "cell" });
  });
});

describe("XLSX row addresses and diagnostics", () => {
  async function workbookOf(sheets: Record<string, (string | number)[][]>) {
    const workbook = new ExcelJS.Workbook();
    for (const [name, rows] of Object.entries(sheets)) {
      const sheet = workbook.addWorksheet(name);
      for (const row of rows) sheet.addRow(row);
    }
    return (await workbook.xlsx.writeBuffer()) as ArrayBuffer;
  }

  it("keeps the sheet and row each record was read from", async () => {
    const records = await parseImportWorkbook(
      await workbookOf({
        Areas: [
          ["import_key", "name"],
          ["study", "Study"],
          ["work", "Work"]
        ]
      })
    );
    expect(describeImportRecordSource(records[0]!)).toBe("Row 2 · Areas");
    expect(describeImportRecordSource(records[1]!)).toBe("Row 3 · Areas");
  });

  it("reports a misspelt column on the sheet it appears on", async () => {
    const diagnostics: string[] = [];
    await parseImportWorkbook(
      await workbookOf({
        Areas: [
          ["import_key", "name", "sort_ordr"],
          ["study", "Study", 0]
        ]
      }),
      "UTC",
      diagnostics
    );
    expect(diagnostics).toContain(
      'Areas: the column "sort_ordr" is not an import column and was ignored. Did you mean "sort_order"?'
    );
  });

  it("reports a sheet nothing read, and suggests the import sheet it was nearly named as", async () => {
    const diagnostics: string[] = [];
    await parseImportWorkbook(
      await workbookOf({
        Areas: [
          ["import_key", "name"],
          ["study", "Study"]
        ],
        Action: [
          ["import_key", "title"],
          ["one", "One"]
        ],
        Notes: [["anything"]]
      }),
      "UTC",
      diagnostics
    );
    expect(diagnostics).toContain('The sheet "Action" is not an import sheet and was ignored. Did you mean "Actions"?');
    expect(diagnostics).toContain('The sheet "Notes" is not an import sheet and was ignored.');
  });

  it("says nothing about the sheets it read, or about Instructions and Reference snapshots", async () => {
    const diagnostics: string[] = [];
    await parseImportWorkbook(
      await workbookOf({
        Instructions: [["OpenRhen import", "Version 1"]],
        "Reference Actions": [
          ["import_key", "title"],
          ["kept", "Kept"]
        ],
        Areas: [
          ["import_key", "name", "description", "status", "sort_order"],
          ["study", "Study", "", "active", 0]
        ]
      }),
      "UTC",
      diagnostics
    );
    expect(diagnostics).toEqual([]);
  });

  it("assigns record ids on a plain-http origin, where crypto.randomUUID does not exist", async () => {
    const bytes = await workbookOf({
      Areas: [
        ["import_key", "name"],
        ["study", "Study"]
      ]
    });
    Object.defineProperty(globalThis.crypto, "randomUUID", { value: undefined, configurable: true });
    try {
      const records = await parseImportWorkbook(bytes);
      expect(records[0]!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally {
      delete (globalThis.crypto as { randomUUID?: unknown }).randomUUID;
    }
  });
});
