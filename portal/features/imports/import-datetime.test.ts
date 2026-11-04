import { describe, expect, it } from "vitest";
import { excelDateCellText, normaliseImportDateText, stripBom, zonedWallClockToInstant } from "./import-datetime";

const wall = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0) => ({
  year,
  month,
  day,
  hour,
  minute,
  second
});
/** The Date shape ExcelJS hands back for a date cell: the sheet's wall clock on the UTC face. */
const cell = (year: number, month: number, day: number, hour = 0, minute = 0) =>
  new Date(Date.UTC(year, month - 1, day, hour, minute));

describe("zonedWallClockToInstant", () => {
  it("resolves a wall clock in a zone that shifts across daylight saving", () => {
    expect(zonedWallClockToInstant(wall(2026, 8, 20, 17, 0), "Australia/Sydney").toISOString()).toBe(
      "2026-08-20T07:00:00.000Z"
    );
    expect(zonedWallClockToInstant(wall(2026, 12, 20, 17, 0), "Australia/Sydney").toISOString()).toBe(
      "2026-12-20T06:00:00.000Z"
    );
  });

  it("resolves a wall clock in a negative-offset zone", () => {
    expect(zonedWallClockToInstant(wall(2026, 8, 20, 17, 0), "America/New_York").toISOString()).toBe(
      "2026-08-20T21:00:00.000Z"
    );
    expect(zonedWallClockToInstant(wall(2026, 1, 20, 17, 0), "America/New_York").toISOString()).toBe(
      "2026-01-20T22:00:00.000Z"
    );
  });

  it("leaves a UTC wall clock where it stands", () => {
    expect(zonedWallClockToInstant(wall(2026, 8, 20, 17, 0), "UTC").toISOString()).toBe("2026-08-20T17:00:00.000Z");
  });
});

describe("excelDateCellText", () => {
  it("reads a timestamp cell as wall time in the batch timezone", () => {
    expect(excelDateCellText(cell(2026, 8, 20, 17, 0), "datetime", "Australia/Sydney")).toBe(
      "2026-08-20T07:00:00.000Z"
    );
    expect(excelDateCellText(cell(2026, 8, 20, 17, 0), "datetime", "America/New_York")).toBe(
      "2026-08-20T21:00:00.000Z"
    );
    expect(excelDateCellText(cell(2026, 8, 20, 17, 0), "datetime", "UTC")).toBe("2026-08-20T17:00:00.000Z");
  });

  it("reads a time-only cell as HH:MM rather than a timestamp in 1899", () => {
    expect(excelDateCellText(cell(1899, 12, 30, 14, 0), "time", "Australia/Sydney")).toBe("14:00");
    expect(excelDateCellText(cell(1899, 12, 30, 14, 0), "text", "Australia/Sydney")).toBe("14:00");
    // A bare time typed into a timestamp column keeps its shape so validation can name it.
    expect(excelDateCellText(cell(1899, 12, 30, 14, 0), "datetime", "Australia/Sydney")).toBe("14:00");
  });

  it("reads a date-only cell as a calendar day, with no zone applied", () => {
    expect(excelDateCellText(cell(2026, 9, 1), "date", "Australia/Sydney")).toBe("2026-09-01");
    expect(excelDateCellText(cell(2026, 9, 1), "date", "America/New_York")).toBe("2026-09-01");
    expect(excelDateCellText(cell(2026, 9, 1), "text", "Australia/Sydney")).toBe("2026-09-01");
  });
});

describe("normaliseImportDateText", () => {
  it("reads an offset-less timestamp in the batch timezone", () => {
    expect(normaliseImportDateText("2026-08-20T17:00:00", "datetime", "Australia/Sydney")).toBe(
      "2026-08-20T07:00:00.000Z"
    );
    expect(normaliseImportDateText("2026-08-20 17:00", "datetime", "Australia/Sydney")).toBe(
      "2026-08-20T07:00:00.000Z"
    );
    expect(normaliseImportDateText("2026-12-20T17:00:00", "datetime", "Australia/Sydney")).toBe(
      "2026-12-20T06:00:00.000Z"
    );
    expect(normaliseImportDateText("2026-08-20T17:00:00", "datetime", "America/New_York")).toBe(
      "2026-08-20T21:00:00.000Z"
    );
    expect(normaliseImportDateText("2026-08-20T17:00:00", "datetime", "UTC")).toBe("2026-08-20T17:00:00.000Z");
  });

  it("reads a bare day in a timestamp column as local midnight", () => {
    expect(normaliseImportDateText("2026-08-20", "datetime", "Australia/Sydney")).toBe("2026-08-19T14:00:00.000Z");
  });

  it("leaves a value that already carries a zone, and every non-timestamp column, alone", () => {
    expect(normaliseImportDateText("2026-08-20T17:00:00+10:00", "datetime", "Australia/Sydney")).toBe(
      "2026-08-20T17:00:00+10:00"
    );
    expect(normaliseImportDateText("2026-08-20T07:00:00.000Z", "datetime", "Australia/Sydney")).toBe(
      "2026-08-20T07:00:00.000Z"
    );
    expect(normaliseImportDateText("2026-08-20", "date", "Australia/Sydney")).toBe("2026-08-20");
    expect(normaliseImportDateText("14:00", "time", "Australia/Sydney")).toBe("14:00");
    expect(normaliseImportDateText("Anything", "text", "Australia/Sydney")).toBe("Anything");
  });

  it("leaves everything as written when the batch timezone is unknown", () => {
    expect(normaliseImportDateText("2026-08-20T17:00:00", "datetime", undefined)).toBe("2026-08-20T17:00:00");
  });
});

describe("stripBom", () => {
  it("removes a leading byte-order mark and nothing else", () => {
    expect(stripBom("﻿import_key")).toBe("import_key");
    expect(stripBom("import_key")).toBe("import_key");
    expect(stripBom("import﻿key")).toBe("import﻿key");
  });
});

/**
 * A real migration workbook wrote its deadlines as unformatted numbers, so every one of its 28
 * action rows was rejected as an invalid timestamp while the projects and deliverables around them
 * imported cleanly. The numbers were dates all along.
 */
describe("Excel serial dates in a date column", () => {
  it("reads an unformatted serial as the date it stands for, in the batch's timezone", () => {
    expect(normaliseImportDateText("46293.58263888889", "datetime", "Australia/Sydney")).toBe(
      "2026-09-28T03:59:00.000Z"
    );
    expect(normaliseImportDateText("46293", "date", "Australia/Sydney")).toBe("2026-09-28");
    expect(normaliseImportDateText("0.5", "time", "Australia/Sydney")).toBe("12:00");
  });

  it("leaves alone a number that is not plausibly a serial, so the error still says why", () => {
    for (const bare of ["2026", "0", "5", "12345678", "-1"])
      expect(normaliseImportDateText(bare, "datetime", "Australia/Sydney")).toBe(bare);
  });

  it("never touches a column that does not mean a date", () => {
    expect(normaliseImportDateText("46293.58", "text", "Australia/Sydney")).toBe("46293.58");
  });

  it("still reads the text forms it always did", () => {
    expect(normaliseImportDateText("2026-09-28T17:00:00", "datetime", "Australia/Sydney")).toBe(
      "2026-09-28T07:00:00.000Z"
    );
    expect(normaliseImportDateText("2026-09-28T07:00:00Z", "datetime", "Australia/Sydney")).toBe(
      "2026-09-28T07:00:00Z"
    );
  });
});
