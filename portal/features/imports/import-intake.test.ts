import { describe, expect, it } from "vitest";
import {
  detectCsvEntity,
  hashImportSource,
  isWorkbookFile,
  parseImportFiles,
  validateAiIntake,
  validateImportFileSelection
} from "./import-intake";
import { importTemplateHeaders } from "./import-spec";

const file = (name: string, size = 10) => ({ name, size });
const image = (type: string, size = 10) => ({ type, size });

describe("validateImportFileSelection", () => {
  it("accepts a single workbook or several CSV templates", () => {
    expect(validateImportFileSelection([file("plan.xlsx")])).toBeNull();
    expect(validateImportFileSelection([file("areas.csv"), file("actions.csv")])).toBeNull();
  });

  it("reports the size limit before anything else", () => {
    expect(validateImportFileSelection([file("plan.xlsx", 6 * 1024 * 1024)])).toBe(
      "Workbook or combined CSV input must be 5 MB or smaller."
    );
  });

  it("rejects unsupported extensions", () => {
    expect(validateImportFileSelection([file("notes.txt")])).toBe("Select an XLSX workbook or CSV templates.");
  });

  it("refuses a workbook mixed with other files", () => {
    expect(validateImportFileSelection([file("plan.xlsx"), file("areas.csv")])).toBe(
      "Upload one XLSX workbook, or one or more CSV files—not both in the same batch."
    );
  });

  it("recognises a workbook by extension regardless of case", () => {
    expect(isWorkbookFile(file("Plan.XLSX"))).toBe(true);
    expect(isWorkbookFile(file("plan.csv"))).toBe(false);
  });
});

describe("detectCsvEntity", () => {
  const headerRow = (entity: string) =>
    `# Remove this line before importing.\r\n${importTemplateHeaders(entity).join(",")}\r\n`;

  it("reads the entity from a downloaded template filename", () => {
    expect(detectCsvEntity("openrhen-actions.csv")).toBe("actions");
    expect(detectCsvEntity("openrhen-fixed_commitments.csv")).toBe("fixed_commitments");
  });

  it("survives the copies and renames a browser or a person makes", () => {
    expect(detectCsvEntity("openrhen-actions (1).csv")).toBe("actions");
    expect(detectCsvEntity("OpenRhen-Actions - Copy.csv")).toBe("actions");
    expect(detectCsvEntity("actions-week2.csv")).toBe("actions");
    expect(detectCsvEntity("Actions.csv")).toBe("actions");
  });

  it("prefers the longer entity name when one contains another", () => {
    expect(detectCsvEntity("openrhen-deliverable_dependencies (2).csv")).toBe("deliverable_dependencies");
    expect(detectCsvEntity("openrhen-dependencies.csv")).toBe("dependencies");
  });

  it("falls back to the header row when the filename says nothing", () => {
    expect(detectCsvEntity("export.csv", headerRow("actions"))).toBe("actions");
    expect(detectCsvEntity("Book1.csv", headerRow("fixed_commitment_recurrences"))).toBe(
      "fixed_commitment_recurrences"
    );
    expect(detectCsvEntity("sheet.csv", `﻿${importTemplateHeaders("areas").join(",")}\r\nstudy,Study,,active,0`)).toBe(
      "areas"
    );
  });

  it("gives up when neither the name nor the headers identify an entity", () => {
    expect(detectCsvEntity("export.csv")).toBeNull();
    expect(detectCsvEntity("export.csv", "first,second,third\r\n1,2,3")).toBeNull();
    expect(detectCsvEntity("export.csv", "import_key\r\nstudy")).toBeNull();
  });
});

describe("validateAiIntake", () => {
  it("accepts text alone or supported images alone", () => {
    expect(validateAiIntake("Some notes", [])).toBeNull();
    expect(validateAiIntake("   ", [image("image/png")])).toBeNull();
  });

  it("requires at least one of text or images", () => {
    expect(validateAiIntake("  ", [])).toBe("Paste text or select at least one image.");
  });

  it("caps the pasted text length", () => {
    expect(validateAiIntake("x".repeat(100001), [])).toBe("Text input must be 100,000 characters or fewer.");
  });

  it("caps the number, type, and size of images", () => {
    expect(
      validateAiIntake(
        "notes",
        Array.from({ length: 6 }, () => image("image/png"))
      )
    ).toBe("Upload at most five images.");
    expect(validateAiIntake("notes", [image("image/gif")])).toBe("Images must be JPEG, PNG, or WebP.");
    expect(validateAiIntake("notes", [image("image/png", 9 * 1024 * 1024)])).toBe(
      "Each image must be at most 8 MB and all images together at most 20 MB."
    );
    expect(
      validateAiIntake(
        "notes",
        Array.from({ length: 4 }, () => image("image/png", 7 * 1024 * 1024))
      )
    ).toBe("Each image must be at most 8 MB and all images together at most 20 MB.");
  });
});

const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

describe("hashImportSource", () => {
  it("hashes the content, so the same bytes under another name or a later save are the same upload", async () => {
    const first = await hashImportSource([{ name: "actions.csv", bytes: bytes("import_key,title\r\na,A") }]);
    const renamed = await hashImportSource([{ name: "actions (1).csv", bytes: bytes("import_key,title\r\na,A") }]);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(renamed).toBe(first);
  });

  it("changes when a single byte of the content changes", async () => {
    const first = await hashImportSource([{ name: "actions.csv", bytes: bytes("import_key,title\r\na,A") }]);
    const edited = await hashImportSource([{ name: "actions.csv", bytes: bytes("import_key,title\r\na,B") }]);
    expect(edited).not.toBe(first);
  });

  it("does not depend on the order a multi-file selection was picked in", async () => {
    const one = { name: "areas.csv", bytes: bytes("import_key,name\r\nwork,Work") };
    const two = { name: "projects.csv", bytes: bytes("import_key,title\r\np,P") };
    expect(await hashImportSource([one, two])).toBe(await hashImportSource([two, one]));
  });

  it("keeps file boundaries apart, so moving bytes between two files is a different upload", async () => {
    const split = await hashImportSource([
      { name: "a.csv", bytes: bytes("ab") },
      { name: "b.csv", bytes: bytes("c") }
    ]);
    const other = await hashImportSource([
      { name: "a.csv", bytes: bytes("a") },
      { name: "b.csv", bytes: bytes("bc") }
    ]);
    expect(split).not.toBe(other);
  });
});

describe("parseImportFiles", () => {
  it("reads one CSV per entity into one record list, numbered across files, in the batch timezone", async () => {
    const parsed = await parseImportFiles(
      [
        { name: "openrhen-areas.csv", bytes: bytes("import_key,name,status,sort_order\r\nwork,Work,active,0") },
        {
          name: "projects (1).csv",
          bytes: bytes(
            "import_key,outcome_key,title,status,uncertainty,consequence,internal_deadline_at\r\np,o,P,active,some,3,2026-08-20T17:00:00"
          )
        }
      ],
      "Australia/Sydney"
    );
    expect(parsed.sourceType).toBe("csv");
    expect(parsed.records.map((record) => [record.entityType, record.sortOrder])).toEqual([
      ["area", 0],
      ["project", 1]
    ]);
    expect(parsed.records[1]?.fields.internalDeadlineAt?.value).toBe("2026-08-20T07:00:00.000Z");
    expect(parsed.source).toMatchObject({ filename: "openrhen-areas.csv, projects (1).csv", mimeType: "text/csv" });
    expect(parsed.source.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a CSV whose entity neither the name nor the header can tell", async () => {
    await expect(parseImportFiles([{ name: "sheet.csv", bytes: bytes("a,b\r\n1,2") }], "UTC")).rejects.toThrow(
      /Cannot determine entity type from sheet.csv/
    );
  });

  it("gathers what every file in the selection gave up into one list", async () => {
    const parsed = await parseImportFiles(
      [
        { name: "areas.csv", bytes: bytes("import_key,name,sort_ordr\r\nwork,Work,0") },
        { name: "actions.csv", bytes: bytes("import_key,project_key,title\r\none,p,One,spilled") }
      ],
      "UTC"
    );
    expect(parsed.diagnostics).toEqual([
      'Areas: the column "sort_ordr" is not an import column and was ignored. Did you mean "sort_order"?',
      "Actions: row 2 has 4 cells but the header row has 3; the extra values were ignored."
    ]);
  });

  it("has nothing to report about files that match their templates", async () => {
    const parsed = await parseImportFiles(
      [{ name: "areas.csv", bytes: bytes("import_key,name,description,status,sort_order\r\nwork,Work,,active,0") }],
      "UTC"
    );
    expect(parsed.diagnostics).toEqual([]);
  });
});
