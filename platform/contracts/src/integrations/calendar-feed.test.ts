import { describe, expect, it } from "vitest";
import { connectionFailureReasonSchema } from "../connections/wire.js";
import {
  calendarFeedExtrasSchema,
  calendarFeedFailureReasonSchema,
  calendarFeedProofResultSchema,
  calendarFeedSeriesSchema
} from "./calendar-feed.js";

describe("calendar feed contracts", () => {
  it("keeps its failure reasons inside the shared connection reasons", () => {
    for (const reason of calendarFeedFailureReasonSchema.options)
      expect(connectionFailureReasonSchema.safeParse(reason).success, reason).toBe(true);
  });

  it("parses the three proof answers and names the host, not a URL", () => {
    const checkedAt = "2026-11-04T00:00:00.000Z";
    expect(
      calendarFeedProofResultSchema.parse({ status: "not_configured", missing: ["CALENDAR_FEED_URL"] })
    ).toBeDefined();
    expect(
      calendarFeedProofResultSchema.parse({ status: "connected", checkedAt, host: "calendar.example.com" })
    ).toEqual({
      status: "connected",
      checkedAt,
      host: "calendar.example.com"
    });
    expect(
      calendarFeedProofResultSchema.parse({ status: "failed", checkedAt, message: "no", reason: "unreachable" })
    ).toBeDefined();
    expect(calendarFeedProofResultSchema.safeParse({ status: "connected", checkedAt }).success).toBe(false);
    expect(
      calendarFeedProofResultSchema.safeParse({ status: "failed", checkedAt, message: "x", reason: "other" }).success
    ).toBe(false);
  });

  it("parses the read extras and rejects a missing completeness flag", () => {
    const extras = {
      host: "calendar.example.com",
      transportComplete: true,
      veventCount: 2,
      skipped: [{ idPrefix: null, reason: "unreadable event" }],
      veventCapHit: false,
      occurrenceCapHit: false,
      timeBudgetHit: false
    };
    expect(calendarFeedExtrasSchema.parse(extras)).toEqual(extras);
    const { transportComplete: _omitted, ...without } = extras;
    expect(calendarFeedExtrasSchema.safeParse(without).success).toBe(false);
  });

  it("parses a series descriptor, rejects a repeat the commitment rule cannot hold, and keeps extras backward compatible", () => {
    const series = {
      uid: "a@example.com",
      idPrefix: "a@example.com",
      timezone: "Europe/London",
      status: "confirmed",
      title: "Standup",
      location: "",
      startDate: "2026-11-03",
      endDate: null,
      repeat: { unit: "weeks", intervalWeeks: 1, weekdays: [2, 4] },
      localStartTime: "09:00",
      localEndTime: "10:00",
      exceptions: [
        { kind: "cancelled", date: "2026-11-10" },
        {
          kind: "changed",
          date: "2026-11-17",
          title: "Moved",
          location: "",
          startDate: "2026-11-17",
          localStartTime: "14:00",
          endDate: "2026-11-17",
          localEndTime: "15:00"
        }
      ]
    };
    expect(calendarFeedSeriesSchema.parse(series)).toEqual(series);
    expect(
      calendarFeedSeriesSchema.safeParse({ ...series, repeat: { unit: "weeks", intervalWeeks: 1, weekdays: [4, 2] } })
        .success
    ).toBe(false);
    expect(calendarFeedSeriesSchema.safeParse({ ...series, localStartTime: "9:00" }).success).toBe(false);
    const extras = {
      host: "h.example.com",
      transportComplete: true,
      veventCount: 0,
      skipped: [],
      veventCapHit: false,
      occurrenceCapHit: false,
      timeBudgetHit: false
    };
    expect(calendarFeedExtrasSchema.parse(extras)).toEqual(extras);
    const withReasons = { ...extras, unrepresentableSeries: [{ idPrefix: "a", reason: "all-day repeating event" }] };
    expect(calendarFeedExtrasSchema.parse(withReasons)).toEqual(withReasons);
  });
});
