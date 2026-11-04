import { describe, expect, it } from "vitest";
import type { ImportEntityType, ImportField, ImportRecord } from "@openrhen/contracts";
import { importRecordWeekday, isImportWeekdayField } from "./import-record-weekday";

const field = (value: unknown): ImportField => ({
  value,
  basis: "explicit",
  confidence: "high",
  evidence: [],
  needsReview: false
});

const record = (entityType: ImportEntityType, fields: Record<string, unknown>) =>
  ({
    entityType,
    fields: Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, field(value)]))
  }) satisfies Pick<ImportRecord, "entityType" | "fields">;

describe("isImportWeekdayField", () => {
  it("names the one field each dated record is read by", () => {
    expect(isImportWeekdayField("fixed_commitment", "startsAt")).toBe(true);
    expect(isImportWeekdayField("fixed_commitment", "endsAt")).toBe(false);
    expect(isImportWeekdayField("fixed_commitment_recurrence", "startDate")).toBe(true);
    expect(isImportWeekdayField("action", "dueAt")).toBe(false);
  });
});

describe("importRecordWeekday", () => {
  it("names the day an event starts on, in the zone the batch was read under", () => {
    const event = record("fixed_commitment", { startsAt: "2026-09-03T09:00:00+10:00" });
    expect(importRecordWeekday(event, "Australia/Sydney")).toBe("Thursday");
  });

  it("reads an instant in the batch's zone rather than the reader's", () => {
    // Nine in the morning in the seed zone is still the previous evening in New York.
    const event = record("fixed_commitment", { startsAt: "2026-09-03T09:00:00+10:00" });
    expect(importRecordWeekday(event, "America/New_York")).toBe("Wednesday");
  });

  it("reads a calendar day as written, through no zone at all", () => {
    const series = record("fixed_commitment_recurrence", { startDate: "2026-09-03" });
    expect(importRecordWeekday(series, "America/New_York")).toBe("Thursday");
    expect(importRecordWeekday(series, "Australia/Sydney")).toBe("Thursday");
  });

  it("says every Wednesday for a weekly series rather than one of them", () => {
    const weekly = record("fixed_commitment_recurrence", { startDate: "2026-09-02", intervalDays: 7 });
    expect(importRecordWeekday(weekly, "Australia/Sydney")).toBe("Wednesdays");
    const fortnightly = record("fixed_commitment_recurrence", { startDate: "2026-09-02", intervalDays: 14 });
    expect(importRecordWeekday(fortnightly, "Australia/Sydney")).toBe("Wednesday");
  });

  it("names every weekday of a weekly rule", () => {
    const weekdays = record("fixed_commitment_recurrence", {
      startDate: "2026-09-29",
      intervalUnit: "weeks",
      weekdays: [2, 4]
    });
    expect(importRecordWeekday(weekdays, "Australia/Sydney")).toBe("Tuesdays and Thursdays");
  });

  it("does not pluralise a monthly record, even if a stray field makes the arithmetic look weekly", () => {
    const monthly = record("fixed_commitment_recurrence", {
      startDate: "2026-09-02",
      intervalUnit: "months",
      intervalDays: 7
    });
    expect(importRecordWeekday(monthly, "Australia/Sydney")).toBe("Wednesday");
  });

  it("reads an offset-less wall clock as the day it names", () => {
    const typed = record("fixed_commitment", { startsAt: "2026-09-03T17:00" });
    expect(importRecordWeekday(typed, "Australia/Sydney")).toBe("Thursday");
  });

  it("says nothing for a date it cannot trust", () => {
    expect(importRecordWeekday(record("fixed_commitment", { startsAt: "" }), "Australia/Sydney")).toBeNull();
    expect(importRecordWeekday(record("fixed_commitment", { startsAt: "2026-09" }), "Australia/Sydney")).toBeNull();
    expect(
      importRecordWeekday(record("fixed_commitment", { startsAt: "next tuesday" }), "Australia/Sydney")
    ).toBeNull();
    expect(importRecordWeekday(record("fixed_commitment", { startsAt: "2026-09-31" }), "Australia/Sydney")).toBeNull();
    expect(
      importRecordWeekday(record("fixed_commitment", { startsAt: "2026-13-05T09:00:00+10:00" }), "Australia/Sydney")
    ).toBeNull();
    expect(importRecordWeekday(record("fixed_commitment", { startsAt: null }), "Australia/Sydney")).toBeNull();
    expect(importRecordWeekday(record("fixed_commitment", {}), "Australia/Sydney")).toBeNull();
  });

  it("says nothing for a record that carries no date of its own", () => {
    expect(importRecordWeekday(record("action", { startsAt: "2026-09-03T09:00:00+10:00" }), "Australia/Sydney")).toBe(
      null
    );
  });
});
