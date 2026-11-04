import { describe, expect, it } from "vitest";
import { planForecastResponseSchema, type DayPlanBlock, type PlanForecastResponse } from "@openrhen/contracts";
import { diffDayPlans } from "./plan-diff";

const TZ = "UTC";
const DAY_KEY = "2026-08-19";

const REQUEST_ID = "8fe5bba7-e436-429d-8011-67467b3ec55e";

function block(
  overrides: Partial<DayPlanBlock> & Pick<DayPlanBlock, "kind" | "targetId" | "startsAt" | "endsAt" | "title">
): DayPlanBlock {
  return {
    focusedMinutes: 0,
    wallClockMinutes: 30,
    reason: "test fixture",
    confidence: "firm",
    ...overrides
  };
}

function response(overrides: {
  calculatedAt?: string;
  blocks?: DayPlanBlock[];
  displaced?: Array<{ targetId: string; latestSafeStartAt: string; firstPlannedAt: string | null }>;
  sleepPlans?: unknown[];
  omitDayPlan?: boolean;
}): PlanForecastResponse {
  const raw = {
    contractVersion: "1",
    requestId: REQUEST_ID,
    inputVersion: "abc123",
    engineVersion: "1.2.0",
    calculatedAt: overrides.calculatedAt ?? "2026-08-19T00:00:00.000Z",
    validUntil: "2026-08-19T01:00:00.000Z",
    derivedState: {
      sleepPlans: overrides.sleepPlans ?? [],
      occurrences: [],
      routineSteps: [],
      commitmentRepeats: []
    },
    schedule: {},
    recommendation: {},
    currentDirective: { kind: "none", title: "Nothing to do", recommendedMinutes: 0 },
    upcomingDirectives: [],
    continuation: null,
    ...(overrides.omitDayPlan
      ? {}
      : {
          dayPlan: {
            through: "2026-08-20T00:00:00.000Z",
            mode: "policy_replay",
            blocks: overrides.blocks ?? [],
            truncated: false,
            displaced: overrides.displaced ?? [],
            locations: []
          }
        })
  };
  return planForecastResponseSchema.parse(raw);
}

describe("diffDayPlans", () => {
  it("reports available:false with empty lists when either run is missing", () => {
    const after = response({});
    expect(diffDayPlans(undefined, after, { dayKey: DAY_KEY, timezone: TZ })).toEqual({
      available: false,
      moved: [],
      dropped: [],
      added: [],
      sleepShiftMinutes: 0,
      beforeNightPlannedStartAt: null,
      newlyDisplaced: []
    });
    expect(diffDayPlans(after, undefined, { dayKey: DAY_KEY, timezone: TZ })).toEqual({
      available: false,
      moved: [],
      dropped: [],
      added: [],
      sleepShiftMinutes: 0,
      beforeNightPlannedStartAt: null,
      newlyDisplaced: []
    });
  });

  it("reports a block moved by more than 5 minutes, with the delta", () => {
    const before = response({
      blocks: [
        block({
          kind: "action",
          targetId: "action-1",
          title: "Write the report",
          startsAt: "2026-08-19T10:00:00.000Z",
          endsAt: "2026-08-19T10:30:00.000Z"
        })
      ]
    });
    const after = response({
      blocks: [
        block({
          kind: "action",
          targetId: "action-1",
          title: "Write the report",
          startsAt: "2026-08-19T10:20:00.000Z",
          endsAt: "2026-08-19T10:50:00.000Z"
        })
      ]
    });
    const summary = diffDayPlans(before, after, { dayKey: DAY_KEY, timezone: TZ });
    expect(summary.available).toBe(true);
    expect(summary.moved).toEqual([
      {
        kind: "action",
        targetId: "action-1",
        title: "Write the report",
        fromStartsAt: "2026-08-19T10:00:00.000Z",
        toStartsAt: "2026-08-19T10:20:00.000Z",
        deltaMinutes: 20
      }
    ]);
    expect(summary.dropped).toEqual([]);
    expect(summary.added).toEqual([]);
  });

  it("does not report a 4-minute nudge as moved (5-minute threshold)", () => {
    const before = response({
      blocks: [
        block({
          kind: "action",
          targetId: "action-1",
          title: "Write the report",
          startsAt: "2026-08-19T10:00:00.000Z",
          endsAt: "2026-08-19T10:30:00.000Z"
        })
      ]
    });
    const after = response({
      blocks: [
        block({
          kind: "action",
          targetId: "action-1",
          title: "Write the report",
          startsAt: "2026-08-19T10:04:00.000Z",
          endsAt: "2026-08-19T10:34:00.000Z"
        })
      ]
    });
    const summary = diffDayPlans(before, after, { dayKey: DAY_KEY, timezone: TZ });
    expect(summary.moved).toEqual([]);
  });

  it("reports a block dropped from before and absent from after", () => {
    const before = response({
      blocks: [
        block({
          kind: "action",
          targetId: "action-2",
          title: "Call the plumber",
          startsAt: "2026-08-19T11:00:00.000Z",
          endsAt: "2026-08-19T11:15:00.000Z"
        })
      ]
    });
    const after = response({ blocks: [] });
    const summary = diffDayPlans(before, after, { dayKey: DAY_KEY, timezone: TZ });
    expect(summary.dropped).toEqual([
      {
        kind: "action",
        targetId: "action-2",
        title: "Call the plumber",
        startsAt: "2026-08-19T11:00:00.000Z"
      }
    ]);
  });

  it("reports a block added in after that was absent from before", () => {
    const before = response({ blocks: [] });
    const after = response({
      blocks: [
        block({
          kind: "deliverable",
          targetId: "deliverable-1",
          title: "Ship the proposal",
          startsAt: "2026-08-19T13:00:00.000Z",
          endsAt: "2026-08-19T14:00:00.000Z"
        })
      ]
    });
    const summary = diffDayPlans(before, after, { dayKey: DAY_KEY, timezone: TZ });
    expect(summary.added).toEqual([
      {
        kind: "deliverable",
        targetId: "deliverable-1",
        title: "Ship the proposal",
        startsAt: "2026-08-19T13:00:00.000Z"
      }
    ]);
  });

  it("ignores a block that falls on a different local day", () => {
    const before = response({ blocks: [] });
    const after = response({
      blocks: [
        block({
          kind: "action",
          targetId: "action-3",
          title: "Tomorrow's task",
          startsAt: "2026-08-20T09:00:00.000Z",
          endsAt: "2026-08-20T09:30:00.000Z"
        })
      ]
    });
    const summary = diffDayPlans(before, after, { dayKey: DAY_KEY, timezone: TZ });
    expect(summary.added).toEqual([]);
    expect(summary.dropped).toEqual([]);
    expect(summary.moved).toEqual([]);
  });

  it("reports newly displaced targets, but not ones already displaced before", () => {
    const before = response({
      displaced: [{ targetId: "deliverable-old", latestSafeStartAt: "2026-08-19T09:00:00.000Z", firstPlannedAt: null }]
    });
    const after = response({
      displaced: [
        { targetId: "deliverable-old", latestSafeStartAt: "2026-08-19T09:00:00.000Z", firstPlannedAt: null },
        {
          targetId: "deliverable-new",
          latestSafeStartAt: "2026-08-19T12:00:00.000Z",
          firstPlannedAt: "2026-08-19T13:00:00.000Z"
        }
      ]
    });
    const summary = diffDayPlans(before, after, { dayKey: DAY_KEY, timezone: TZ });
    expect(summary.newlyDisplaced).toEqual([
      { targetId: "deliverable-new", firstPlannedAt: "2026-08-19T13:00:00.000Z" }
    ]);
  });

  // `firstPlannedAt` has to survive the diff unchanged, null included, so
  // `assessDisruption` can tell a target that never held a slot from one that lost one.
  it("carries a null firstPlannedAt through for a target the plan never reached at all", () => {
    const before = response({ displaced: [] });
    const after = response({
      displaced: [{ targetId: "deliverable-new", latestSafeStartAt: "2026-08-19T12:00:00.000Z", firstPlannedAt: null }]
    });
    const summary = diffDayPlans(before, after, { dayKey: DAY_KEY, timezone: TZ });
    expect(summary.newlyDisplaced).toEqual([{ targetId: "deliverable-new", firstPlannedAt: null }]);
  });

  it("reports the upcoming night's bedtime shift between the two runs", () => {
    const before = response({
      sleepPlans: [
        { id: "sleep-a", plannedStartAt: "2026-08-19T21:30:00.000Z", plannedWakeAt: "2026-08-20T05:30:00.000Z" }
      ]
    });
    const after = response({
      sleepPlans: [
        { id: "sleep-b", plannedStartAt: "2026-08-19T23:00:00.000Z", plannedWakeAt: "2026-08-20T07:00:00.000Z" }
      ]
    });
    const summary = diffDayPlans(before, after, { dayKey: DAY_KEY, timezone: TZ });
    expect(summary.sleepShiftMinutes).toBe(90);
  });

  it("reports a zero sleep shift when a run has no upcoming night", () => {
    const before = response({ sleepPlans: [] });
    const after = response({
      sleepPlans: [
        { id: "sleep-b", plannedStartAt: "2026-08-19T23:00:00.000Z", plannedWakeAt: "2026-08-20T07:00:00.000Z" }
      ]
    });
    const summary = diffDayPlans(before, after, { dayKey: DAY_KEY, timezone: TZ });
    expect(summary.sleepShiftMinutes).toBe(0);
  });

  // A "Bedtime moves 488 min later" warning while nothing had actually moved — `before`'s
  // "upcoming night" (first plan >= local midnight) was the night already under way when the
  // disruption landed in the small hours; `after`'s matching entry by mere position was the
  // *following* night entirely. Night identity (see `nightKeyFor`) must match before comparing.
  it("reports zero shift when before's upcoming night and after's are two different nights", () => {
    const before = response({
      // The tail of the previous evening's sleep, still in progress at local-day dayStart.
      sleepPlans: [
        {
          id: "sleep-in-progress",
          plannedStartAt: "2026-08-19T02:52:00.000Z",
          plannedWakeAt: "2026-08-19T11:00:00.000Z"
        }
      ]
    });
    const after = response({
      // Only the *next* night exists now — a different night from before's.
      sleepPlans: [
        { id: "sleep-next", plannedStartAt: "2026-08-20T01:00:00.000Z", plannedWakeAt: "2026-08-20T10:00:00.000Z" }
      ]
    });
    const summary = diffDayPlans(before, after, { dayKey: DAY_KEY, timezone: TZ });
    expect(summary.sleepShiftMinutes).toBe(0);
    expect(summary.beforeNightPlannedStartAt).toBe("2026-08-19T02:52:00.000Z");
  });

  it("reports the shift when both runs hold the same night", () => {
    const before = response({
      sleepPlans: [
        { id: "sleep-a", plannedStartAt: "2026-08-19T21:30:00.000Z", plannedWakeAt: "2026-08-20T05:30:00.000Z" }
      ]
    });
    const after = response({
      sleepPlans: [
        {
          id: "sleep-a-replanned",
          plannedStartAt: "2026-08-19T22:00:00.000Z",
          plannedWakeAt: "2026-08-20T06:00:00.000Z"
        }
      ]
    });
    const summary = diffDayPlans(before, after, { dayKey: DAY_KEY, timezone: TZ });
    expect(summary.sleepShiftMinutes).toBe(30);
  });

  it("reports zero shift when after has no plan at all for before's night", () => {
    const before = response({
      sleepPlans: [
        { id: "sleep-a", plannedStartAt: "2026-08-19T21:30:00.000Z", plannedWakeAt: "2026-08-20T05:30:00.000Z" }
      ]
    });
    const after = response({ sleepPlans: [] });
    const summary = diffDayPlans(before, after, { dayKey: DAY_KEY, timezone: TZ });
    expect(summary.sleepShiftMinutes).toBe(0);
  });

  it("tolerates a run whose dayPlan is absent (results stored before dayPlan shipped)", () => {
    const before = response({ omitDayPlan: true });
    const after = response({
      blocks: [
        block({
          kind: "action",
          targetId: "action-4",
          title: "New work",
          startsAt: "2026-08-19T09:00:00.000Z",
          endsAt: "2026-08-19T09:30:00.000Z"
        })
      ]
    });
    const summary = diffDayPlans(before, after, { dayKey: DAY_KEY, timezone: TZ });
    expect(summary.available).toBe(true);
    expect(summary.added).toEqual([
      { kind: "action", targetId: "action-4", title: "New work", startsAt: "2026-08-19T09:00:00.000Z" }
    ]);
  });
});
