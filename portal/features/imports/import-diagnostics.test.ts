import { describe, expect, it } from "vitest";
import {
  editDistance,
  headerDiagnostics,
  nearestName,
  raggedRowDiagnostics,
  sheetDiagnostics
} from "./import-diagnostics";
import { importTemplateHeaders } from "./import-spec";

const actionHeaders = importTemplateHeaders("actions");

describe("editDistance", () => {
  it("counts insertions, deletions and substitutions", () => {
    expect(editDistance("actions", "actions")).toBe(0);
    expect(editDistance("expected_minute", "expected_minutes")).toBe(1);
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("kitten", "sitting")).toBe(3);
  });
});

describe("nearestName", () => {
  it("finds the name a typo most likely meant", () => {
    expect(nearestName("expected_minute", actionHeaders)).toBe("expected_minutes");
    expect(nearestName("Splitable", actionHeaders)).toBe("splittable");
  });

  it("says nothing when no known name is close", () => {
    expect(nearestName("owner_email", actionHeaders)).toBeNull();
  });

  it("does not match one short name to another on a single edit's tolerance", () => {
    expect(nearestName("kind", ["name", "title"])).toBeNull();
  });
});

describe("headerDiagnostics", () => {
  it("reports an unknown column and offers the column it resembles", () => {
    const [message, ...rest] = headerDiagnostics("Actions", ["import_key", "expected_minute"], actionHeaders);
    expect(message).toBe(
      'Actions: the column "expected_minute" is not an import column and was ignored. Did you mean "expected_minutes"?'
    );
    expect(rest).toEqual([]);
  });

  it("reports an unknown column with no suggestion when nothing is close", () => {
    expect(headerDiagnostics("Actions", ["owner_email"], actionHeaders)[0]).toBe(
      'Actions: the column "owner_email" is not an import column and was ignored.'
    );
  });

  it("says nothing about the columns it knows, and nothing about blank headers", () => {
    expect(headerDiagnostics("Actions", ["import_key", "title", ""], actionHeaders)).toEqual([]);
  });

  it("reports a repeated unknown column once", () => {
    expect(headerDiagnostics("Actions", ["owner_email", "owner_email"], actionHeaders)).toHaveLength(1);
  });
});

describe("raggedRowDiagnostics", () => {
  const row = (index: number, cells: string[]) => ({ row: index, cells });

  it("names a row carrying values past the last header column", () => {
    expect(raggedRowDiagnostics("Actions", 2, [row(17, ["a", "b", "c"])])[0]).toBe(
      "Actions: row 17 has 3 cells but the header row has 2; the extra values were ignored."
    );
  });

  it("ignores trailing cells that hold nothing", () => {
    expect(raggedRowDiagnostics("Actions", 2, [row(3, ["a", "b", "  "])])).toEqual([]);
  });

  it("names the first three overflowing rows and counts the rest", () => {
    const rows = [5, 6, 7, 8, 9].map((index) => row(index, ["a", "b", "spill"]));
    const messages = raggedRowDiagnostics("Actions", 2, rows);
    expect(messages).toHaveLength(4);
    expect(messages[3]).toBe("Actions: 2 further rows have values past the last header column.");
  });

  it("counts short rows rather than listing them", () => {
    const messages = raggedRowDiagnostics("Actions", 4, [row(2, ["a"]), row(3, ["a", "b"])]);
    expect(messages).toEqual([
      "Actions: 2 rows stop before the last header column; the missing cells were read as blank."
    ]);
  });

  it("puts a single short row in the singular", () => {
    expect(raggedRowDiagnostics("Actions", 4, [row(2, ["a"])])[0]).toBe(
      "Actions: 1 row stops before the last header column; the missing cells were read as blank."
    );
  });

  it("says nothing when every row matches the header", () => {
    expect(raggedRowDiagnostics("Actions", 2, [row(2, ["a", "b"])])).toEqual([]);
  });
});

describe("sheetDiagnostics", () => {
  const known = ["Areas", "Actions"];

  it("reports a sheet nothing read and suggests the import sheet it resembles", () => {
    expect(sheetDiagnostics(["Action"], [], known)[0]).toBe(
      'The sheet "Action" is not an import sheet and was ignored. Did you mean "Actions"?'
    );
  });

  it("says nothing about sheets that were read, instructions, or reference snapshots", () => {
    expect(sheetDiagnostics(["Actions", "Instructions", "Reference Areas", "Guide"], ["Actions"], known)).toEqual([]);
  });

  it("reports an unrelated sheet without a suggestion", () => {
    expect(sheetDiagnostics(["Sheet1"], [], known)).toEqual([
      'The sheet "Sheet1" is not an import sheet and was ignored.'
    ]);
  });
});
