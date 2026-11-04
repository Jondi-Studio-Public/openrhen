import "@/test/example-calendar-sources";
import { describe, expect, it } from "vitest";
import type { ImportRecord } from "@openrhen/contracts";
import { isCalendarImportRecord, setCalendarRecordsSelected } from "./calendar-selection";

const record = (patch: Partial<ImportRecord> = {}): ImportRecord => ({
  id: "record",
  importKey: "example_shared:event:abc",
  entityType: "fixed_commitment",
  operation: "create",
  expectedVersion: null,
  matchedEntityId: null,
  fields: { title: { value: "Class", basis: "explicit", confidence: "high", evidence: [], needsReview: false } },
  relationships: {},
  errors: [],
  warnings: [],
  removed: false,
  sortOrder: 0,
  ...patch
});

describe("calendar event selection", () => {
  it("recognises Example Shared event proposals", () => {
    expect(isCalendarImportRecord(record())).toBe(true);
    expect(isCalendarImportRecord(record({ importKey: "manual", entityType: "action" }))).toBe(false);
  });
  it("recognises Example Shared recurring-series proposals", () => {
    expect(
      isCalendarImportRecord(
        record({ importKey: "example_shared:series:123", entityType: "fixed_commitment_recurrence" })
      )
    ).toBe(true);
  });
  it("selects or clears only calendar events", () => {
    const other = record({ id: "other", importKey: "manual", entityType: "action" });
    const cleared = setCalendarRecordsSelected([record(), other], false);
    expect(cleared[0]?.removed).toBe(true);
    expect(cleared[1]?.removed).toBe(false);
    expect(setCalendarRecordsSelected(cleared, true)[0]?.removed).toBe(false);
  });
});
