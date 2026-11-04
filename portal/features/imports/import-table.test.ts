import "@/test/example-calendar-sources";
import { describe, expect, it } from "vitest";
import type { ImportField, ImportRecord } from "@openrhen/contracts";
import { SOURCE_ROW, SOURCE_SHEET } from "./import-record-source";
import {
  IMPORT_TABLE_SOURCE_KEY,
  IMPORT_TABLE_STATUS_KEY,
  buildImportTableGroups,
  importBlockerTargets,
  importCellText,
  importRowMatches,
  importRowMessages,
  importRowStatus,
  importTableColumns,
  importTableRows,
  nextImportTableSort,
  resolveImportReviewView,
  sortImportTableRows,
  stepBlockerIndex,
  supportsImportTableView
} from "./import-table";

const explicit = (value: unknown): ImportField => ({
  value,
  basis: "explicit",
  confidence: "high",
  evidence: [],
  needsReview: false,
  source: "cell"
});

function record(overrides: Partial<ImportRecord> = {}): ImportRecord {
  return {
    id: "record-1",
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

const at = (sheet: string, row: number) => ({ [SOURCE_SHEET]: sheet, [SOURCE_ROW]: String(row) });

describe("import review view", () => {
  it("offers a table only for a file with named columns", () => {
    expect(supportsImportTableView("xlsx")).toBe(true);
    expect(supportsImportTableView("csv")).toBe(true);
    expect(supportsImportTableView("ai_text")).toBe(false);
    expect(supportsImportTableView("example_shared")).toBe(false);
  });

  it("opens a workbook of more than a dozen rows as a table and a short one as cards", () => {
    expect(resolveImportReviewView("xlsx", 40, null, true)).toBe("table");
    expect(resolveImportReviewView("xlsx", 12, null, true)).toBe("cards");
  });

  it("keeps cards for a source whose provenance the cards carry, however many rows", () => {
    expect(resolveImportReviewView("example_shared", 200, "table", true)).toBe("cards");
    expect(resolveImportReviewView("ai_text", 200, null, true)).toBe("cards");
  });

  it("falls back to cards on a narrow screen even when the table was chosen", () => {
    expect(resolveImportReviewView("xlsx", 200, "table", false)).toBe("cards");
  });

  it("lets a remembered choice beat the size of the batch in either direction", () => {
    expect(resolveImportReviewView("csv", 200, "cards", true)).toBe("cards");
    expect(resolveImportReviewView("csv", 3, "table", true)).toBe("table");
  });
});

describe("importTableColumns", () => {
  it("gives the key, then the relationships, then the spec's columns in template order", () => {
    const columns = importTableColumns("action", []);
    expect(columns.slice(0, 4).map((column) => column.header)).toEqual([
      "import_key",
      "project_key",
      "title",
      "status"
    ]);
    expect(columns[0]!.readOnly).toBe(true);
    expect(columns[1]).toMatchObject({ name: "projectKey", relation: true, targetType: "project" });
    expect(columns[3]).toMatchObject({ name: "status", kind: "enum" });
  });

  it("appends a field the spec has never heard of rather than hiding what the batch holds", () => {
    const columns = importTableColumns("area", [record({ entityType: "area", fields: { legacyNote: explicit("x") } })]);
    expect(columns.at(-1)).toMatchObject({ name: "legacyNote", header: "legacyNote", kind: "text" });
  });
});

describe("importCellText", () => {
  const columns = importTableColumns("action", []);
  const column = (name: string) => columns.find((item) => item.name === name)!;

  it("reads the key, a relationship and a field the way the card's input would", () => {
    const row = record({
      relationships: { projectKey: "project:one" },
      fields: { contexts: explicit(["home", "laptop"]), expectedMinutes: explicit(45) }
    });
    expect(importCellText(row, column("importKey"))).toBe("action:one");
    expect(importCellText(row, column("projectKey"))).toBe("project:one");
    expect(importCellText(row, column("contexts"))).toBe("home|laptop");
    expect(importCellText(row, column("expectedMinutes"))).toBe("45");
  });

  it("reads a blank cell as empty text rather than as null", () => {
    expect(importCellText(record(), column("title"))).toBe("");
  });
});

describe("importRowStatus", () => {
  it("ranks removed, blocked, warned and ready apart", () => {
    expect(importRowStatus(record({ removed: true, errors: ["x"] }))).toBe("removed");
    expect(importRowStatus(record({ errors: ["x"] }))).toBe("blocked");
    expect(importRowStatus(record({ operation: "conflict" }))).toBe("blocked");
    expect(importRowStatus(record({ warnings: ["x"] }))).toBe("warning");
    expect(importRowStatus(record())).toBe("ready");
  });
});

describe("sortImportTableRows", () => {
  const columns = importTableColumns("action", []);
  const rows = [
    record({ id: "a", fields: { expectedMinutes: explicit(30), status: explicit("done") } }),
    record({ id: "b", fields: { expectedMinutes: explicit(120), status: explicit("inbox") } }),
    record({ id: "c", fields: { status: explicit("active") } }),
    record({ id: "d", fields: { expectedMinutes: explicit(90), status: explicit("inbox") } })
  ];
  const ids = (sorted: ImportRecord[]) => sorted.map((row) => row.id);

  it("sorts a number as a number, not as text", () => {
    expect(ids(sortImportTableRows(rows, columns, { key: "expectedMinutes", direction: "asc" }))).toEqual([
      "a",
      "d",
      "b",
      "c"
    ]);
  });

  it("keeps blanks last in both directions", () => {
    expect(ids(sortImportTableRows(rows, columns, { key: "expectedMinutes", direction: "desc" }))).toEqual([
      "b",
      "d",
      "a",
      "c"
    ]);
  });

  it("sorts an enum by the ladder its spec lists rather than alphabetically", () => {
    // inbox, planned, active, ..., done — so `inbox` leads and `done` trails.
    expect(ids(sortImportTableRows(rows, columns, { key: "status", direction: "asc" }))).toEqual(["b", "d", "c", "a"]);
  });

  it("is stable: rows a sort cannot tell apart keep the order the file gave them", () => {
    const sorted = sortImportTableRows(rows, columns, { key: "status", direction: "desc" });
    expect(ids(sorted).slice(-2)).toEqual(["b", "d"]);
  });

  it("puts the blockers first when asked, and the removed rows last", () => {
    const mixed = [
      record({ id: "ready" }),
      record({ id: "removed", removed: true }),
      record({ id: "blocked", errors: ["title is required."] }),
      record({ id: "warned", warnings: ["check me"] })
    ];
    expect(ids(sortImportTableRows(mixed, columns, { key: IMPORT_TABLE_STATUS_KEY, direction: "asc" }))).toEqual([
      "blocked",
      "warned",
      "ready",
      "removed"
    ]);
  });

  it("sorts by the row the file numbered", () => {
    const numbered = [
      record({ id: "late", relationships: at("Actions", 30) }),
      record({ id: "early", relationships: at("Actions", 4) })
    ];
    expect(ids(sortImportTableRows(numbered, columns, { key: IMPORT_TABLE_SOURCE_KEY, direction: "asc" }))).toEqual([
      "early",
      "late"
    ]);
  });

  it("leaves the order alone when nothing is sorted, or the key names no column", () => {
    expect(ids(sortImportTableRows(rows, columns, null))).toEqual(["a", "b", "c", "d"]);
    expect(ids(sortImportTableRows(rows, columns, { key: "nothing", direction: "asc" }))).toEqual(["a", "b", "c", "d"]);
  });
});

describe("nextImportTableSort", () => {
  it("cycles ascending, descending, then back to the order the file was read in", () => {
    expect(nextImportTableSort(null, "title")).toEqual({ key: "title", direction: "asc" });
    expect(nextImportTableSort({ key: "title", direction: "asc" }, "title")).toEqual({
      key: "title",
      direction: "desc"
    });
    expect(nextImportTableSort({ key: "title", direction: "desc" }, "title")).toBeNull();
    expect(nextImportTableSort({ key: "title", direction: "desc" }, "status")).toEqual({
      key: "status",
      direction: "asc"
    });
  });
});

describe("importRowMatches", () => {
  const columns = importTableColumns("action", []);
  const row = record({
    importKey: "action:draft",
    relationships: { projectKey: "project:thesis", ...at("Actions", 14) },
    fields: { title: explicit("Draft section one") }
  });

  it("matches a cell, the key, a relationship and the row address, whatever the case", () => {
    expect(importRowMatches(row, columns, "SECTION")).toBe(true);
    expect(importRowMatches(row, columns, "action:dr")).toBe(true);
    expect(importRowMatches(row, columns, "thesis")).toBe(true);
    expect(importRowMatches(row, columns, "Row 14")).toBe(true);
  });

  it("matches everything when nothing is searched for, and nothing that is absent", () => {
    expect(importRowMatches(row, columns, "  ")).toBe(true);
    expect(importRowMatches(row, columns, "missing")).toBe(false);
  });
});

describe("buildImportTableGroups", () => {
  const records = [
    record({ id: "a1", entityType: "action", importKey: "action:one" }),
    record({ id: "p1", entityType: "project", importKey: "project:one" }),
    record({ id: "a2", entityType: "action", importKey: "action:two" })
  ];

  it("gives one table per entity type, parents before the rows that point at them", () => {
    const groups = buildImportTableGroups(records);
    expect(groups.map((group) => group.label)).toEqual(["Projects", "Actions"]);
    expect(groups[1]!.rows.map((row) => row.id)).toEqual(["a1", "a2"]);
  });

  it("drops a table the search emptied rather than leaving a bare heading", () => {
    const groups = buildImportTableGroups(records, { query: "action:two" });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.rows.map((row) => row.id)).toEqual(["a2"]);
  });

  it("flattens to what the bulk actions reach, in the order the tables show", () => {
    expect(importTableRows(buildImportTableGroups(records)).map((row) => row.id)).toEqual(["p1", "a1", "a2"]);
  });
});

describe("importRowMessages", () => {
  const columns = importTableColumns("action", []);

  it("puts a message that names its field against that cell", () => {
    const { byField, row } = importRowMessages(record({ errors: ["expectedMinutes is required."] }), columns);
    expect(byField.expectedMinutes).toEqual(["expectedMinutes is required."]);
    expect(row).toEqual([]);
  });

  it("reads a header as well as a field name", () => {
    const { byField } = importRowMessages(
      record({ errors: ["requirements has an empty pathway — remove the extra | or add contexts to it."] }),
      columns
    );
    expect(byField.requirementPathways).toHaveLength(1);
  });

  it("outlines every cell a rule spanning several columns is about", () => {
    const { byField, row } = importRowMessages(
      record({ errors: ["Effort must follow optimistic ≤ expected ≤ pessimistic."] }),
      columns
    );
    expect(Object.keys(byField).sort()).toEqual(["expectedMinutes", "optimisticMinutes", "pessimisticMinutes"]);
    expect(row).toEqual([]);
  });

  it("gives a message no cell owns to the row", () => {
    const { byField, row } = importRowMessages(record({ errors: ["Imported dependencies contain a cycle."] }), columns);
    expect(byField).toEqual({});
    expect(row).toEqual(["Imported dependencies contain a cycle."]);
  });

  it("keeps a warning about a relationship key against that key", () => {
    const { byField } = importRowMessages(
      record({ warnings: ["projectKey must resolve to an existing record or another row in this batch."] }),
      columns
    );
    expect(byField.projectKey).toHaveLength(1);
  });
});

describe("importBlockerTargets", () => {
  it("visits every blocking cell in the order the tables show them", () => {
    const groups = buildImportTableGroups([
      record({ id: "a1", errors: ["title is required.", "energy must be one of: high, medium, low, recovery."] }),
      record({ id: "a2" }),
      record({ id: "a3", errors: ["Imported dependencies contain a cycle."] })
    ]);
    expect(importBlockerTargets(groups)).toEqual([
      { recordId: "a1", field: "title" },
      { recordId: "a1", field: "energy" },
      { recordId: "a3", field: null }
    ]);
  });

  it("does not stop at a warning, or at a row already removed", () => {
    const groups = buildImportTableGroups([
      record({ id: "warned", warnings: ["title is odd."] }),
      record({ id: "gone", removed: true, errors: ["title is required."] })
    ]);
    expect(importBlockerTargets(groups)).toEqual([]);
  });
});

describe("stepBlockerIndex", () => {
  it("starts at either end and wraps around", () => {
    expect(stepBlockerIndex(3, -1, 1)).toBe(0);
    expect(stepBlockerIndex(3, -1, -1)).toBe(2);
    expect(stepBlockerIndex(3, 2, 1)).toBe(0);
    expect(stepBlockerIndex(3, 0, -1)).toBe(2);
    expect(stepBlockerIndex(0, -1, 1)).toBe(-1);
  });
});
