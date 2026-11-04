import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { addDays, reviewProgress } from "./review-progress";
import { periodFor } from "./planning-focus-period";

const now = new Date("2026-10-28T09:00:00+11:00");
const seed = createSeedState(now);
const week = periodFor("weekly", now, seed.settings.timezone);

const undated = (id: string, lastWorkedAt: string) => {
  const { internalDeadlineAt: _i, externalDeadlineAt: _e, ...rest } = seed.projects[0]!;
  return { ...rest, id, status: "active" as const, lastWorkedAt } as (typeof seed.projects)[number];
};

describe("addDays", () => {
  it("steps a plain date, across a month end", () => {
    expect(addDays("2026-10-28", 7)).toBe("2026-11-04");
    expect(addDays("2026-10-26", -7)).toBe("2026-10-19");
  });
});

describe("reviewProgress", () => {
  const recent = now.toISOString();

  it("counts a step as open for each thing left, and is due until the week is reviewed", () => {
    const state = { ...seed, projects: [undated("p1", recent)], planningFocus: [] };
    const progress = reviewProgress(state, [], now);
    expect(progress.stepsOpen).toEqual([false, false, true]);
    expect(progress.stepsLeft).toBe(1);
    expect(progress.due).toBe(true);
  });

  it("treats a saved empty focus as done, and nothing to choose from as done", () => {
    const empty = { id: "w", kind: "weekly" as const, periodStart: week.start, periodEnd: week.end, projectIds: [] };
    const saved = reviewProgress({ ...seed, projects: [undated("p1", recent)], planningFocus: [empty] }, [], now);
    expect(saved.focusDone).toBe(true);
    expect(saved.due).toBe(false);
    expect(reviewProgress({ ...seed, projects: [], planningFocus: [] }, [], now).focusDone).toBe(true);
  });

  it("stops being due once the week carries a reviewed-on date, though a step shows", () => {
    const record = {
      id: "w",
      kind: "weekly" as const,
      periodStart: week.start,
      periodEnd: week.end,
      projectIds: [],
      reviewedOn: "2026-10-27"
    };
    const state = {
      ...seed,
      projects: [undated("p1", recent), undated("p2", "2026-01-01T00:00:00.000Z")],
      planningFocus: [record]
    };
    const progress = reviewProgress(state, [], now);
    expect(progress.stepsLeft).toBe(1);
    expect(progress.reviewedOn).toBe("2026-10-27");
    expect(progress.due).toBe(false);
  });

  it("offers last week's focus, minus projects that can no longer hold it", () => {
    const last = {
      id: "l",
      kind: "weekly" as const,
      periodStart: addDays(week.start, -7),
      periodEnd: addDays(week.end, -7),
      projectIds: ["p1", "gone"]
    };
    const progress = reviewProgress({ ...seed, projects: [undated("p1", recent)], planningFocus: [last] }, [], now);
    expect(progress.lastWeekIds).toEqual(["p1"]);
  });

  it("stops listing an outcome whose review was pushed out, even with its deadline passed", () => {
    const outcome = { ...seed.outcomes[0]!, status: "active" as const, deadlineAt: "2026-10-01T00:00:00.000Z" };
    const due = reviewProgress({ ...seed, outcomes: [outcome] }, [], now);
    expect(due.dueOutcomes).toHaveLength(1);
    const later = reviewProgress({ ...seed, outcomes: [{ ...outcome, reviewOn: "2026-11-25" }] }, [], now);
    expect(later.dueOutcomes).toHaveLength(0);
    // A review date older than the passed deadline does not hide it.
    const older = reviewProgress({ ...seed, outcomes: [{ ...outcome, reviewOn: "2026-10-20" }] }, [], now);
    expect(older.dueOutcomes).toHaveLength(1);
  });

  describe("review dates are days in the portal timezone, not UTC midnight", () => {
    const newYork = { ...seed, settings: { ...seed.settings, timezone: "America/New_York" } };
    const outcome = { ...seed.outcomes[0]!, status: "active" as const, deadlineAt: undefined };
    const eveningBefore = new Date("2026-11-04T03:00:00Z"); // 10 pm on 3 Nov in New York

    it("does not call a date-only review due the evening before", () => {
      const early = reviewProgress(
        { ...newYork, outcomes: [{ ...outcome, reviewOn: "2026-11-04" }] },
        [],
        eveningBefore
      );
      expect(early.dueOutcomes).toHaveLength(0);
      const morning = new Date("2026-11-04T14:00:00Z"); // 9 am on 4 Nov in New York
      const onTheDay = reviewProgress({ ...newYork, outcomes: [{ ...outcome, reviewOn: "2026-11-04" }] }, [], morning);
      expect(onTheDay.dueOutcomes).toHaveLength(1);
    });

    it("reads a datetime review date as the day it falls on in that timezone", () => {
      const reviewOn = "2026-11-04T15:00:00.000Z"; // 10 am on 4 Nov in New York
      const early = reviewProgress({ ...newYork, outcomes: [{ ...outcome, reviewOn }] }, [], eveningBefore);
      expect(early.dueOutcomes).toHaveLength(0);
    });

    it("compares a date-only review against a passed deadline by day in that timezone", () => {
      const passed = { ...outcome, deadlineAt: "2026-11-04T01:00:00.000Z" }; // 9 pm on 3 Nov in New York
      const now = new Date("2026-11-04T03:00:00Z");
      // Reviewed on 3 Nov, the deadline's own day: not later than the deadline, so it still shows.
      const sameDay = reviewProgress({ ...newYork, outcomes: [{ ...passed, reviewOn: "2026-11-03" }] }, [], now);
      expect(sameDay.dueOutcomes).toHaveLength(1);
      // Pushed to 5 Nov: a later day, so the passed deadline is quieted.
      const pushed = reviewProgress({ ...newYork, outcomes: [{ ...passed, reviewOn: "2026-11-05" }] }, [], now);
      expect(pushed.dueOutcomes).toHaveLength(0);
    });
  });
});
