import "@/test/example-calendar-sources";
import { describe, expect, it } from "vitest";
import { calendarsWaiting, type CalendarReviewCount } from "./calendar-review-count";

const review = (overrides: Partial<CalendarReviewCount>): CalendarReviewCount => ({
  counts: { google_calendar: 0, example_shared: 0 },
  batchIds: { google_calendar: null, example_shared: null },
  total: 0,
  ...overrides
});

describe("calendarsWaiting", () => {
  it("lists one calendar per held batch, however many events it holds", () => {
    const waiting = calendarsWaiting(
      review({
        counts: { google_calendar: 0, example_shared: 3 },
        batchIds: { google_calendar: null, example_shared: "b1" },
        total: 3
      })
    );
    expect(waiting).toEqual(["example_shared"]);
  });

  it("leaves out a calendar with events but no batch to open, and one with a batch but no events", () => {
    const waiting = calendarsWaiting(
      review({
        counts: { google_calendar: 2, example_shared: 0 },
        batchIds: { google_calendar: null, example_shared: "b1" },
        total: 2
      })
    );
    expect(waiting).toEqual([]);
  });
});
