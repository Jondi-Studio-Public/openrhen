import { describe, expect, it } from "vitest";
import {
  describeImportRecordSource,
  importRecordSource,
  isInternalRelationship,
  sourceRelationships
} from "./import-record-source";

describe("sourceRelationships", () => {
  it("writes the sheet and row as relationship strings a batch can carry", () => {
    expect(sourceRelationships("Actions", 14)).toEqual({ _sourceSheet: "Actions", _sourceRow: "14" });
  });

  it("marks its names as internal so the review screen never offers them for editing", () => {
    for (const name of Object.keys(sourceRelationships("Actions", 14))) expect(isInternalRelationship(name)).toBe(true);
    expect(isInternalRelationship("projectKey")).toBe(false);
  });
});

describe("importRecordSource", () => {
  it("reads back what a parser wrote", () => {
    expect(importRecordSource({ relationships: sourceRelationships("Recurring Commitments", 3) })).toEqual({
      sheet: "Recurring Commitments",
      row: 3
    });
  });

  it("answers nothing for a record no file produced", () => {
    expect(importRecordSource({ relationships: {} })).toEqual({ sheet: null, row: null });
    expect(describeImportRecordSource({ relationships: {} })).toBeNull();
  });

  it("refuses a row that is not a whole positive number rather than showing nonsense", () => {
    expect(importRecordSource({ relationships: { _sourceRow: "0" } }).row).toBeNull();
    expect(importRecordSource({ relationships: { _sourceRow: "-2" } }).row).toBeNull();
    expect(importRecordSource({ relationships: { _sourceRow: "two" } }).row).toBeNull();
    expect(importRecordSource({ relationships: { _sourceRow: null } }).row).toBeNull();
  });
});

describe("describeImportRecordSource", () => {
  it("names the row and the sheet it sat on", () => {
    expect(describeImportRecordSource({ relationships: sourceRelationships("Actions", 14) })).toBe("Row 14 · Actions");
  });

  it("names whichever half it has", () => {
    expect(describeImportRecordSource({ relationships: { _sourceRow: "9" } })).toBe("Row 9");
    expect(describeImportRecordSource({ relationships: { _sourceSheet: "Areas" } })).toBe("Areas");
  });
});
