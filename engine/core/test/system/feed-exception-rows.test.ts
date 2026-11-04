import { describe, expect, it } from "vitest";
import {
  PLAN_FORECAST_CONTRACT_VERSION,
  commitmentOccurrenceRowId,
  planForecastRequestSchema,
  portalStateSchema
} from "@openrhen/contracts";
import { calculatePlanAndForecast } from "../../src/index.js";

// The calendar feed writes exception rows (a cancelled date, a changed date) straight into `commitments` under the id
// the contracts function names, and the planner must find them. This runs the real engine: the id it derives for every
// generated date is `commitmentOccurrenceRowId`, and a stored row under that id overlays the date.

const now = new Date("2026-09-03T12:00:00.000Z");
const horizonEnd = new Date(now.getTime() + 20 * 24 * 60 * 60_000).toISOString();
const rule = {
  id: "22222222-2222-4222-8222-222222222222",
  title: "Team meeting",
  timezone: "Australia/Sydney",
  startDate: "2026-09-04",
  repeat: { unit: "weeks" as const, intervalWeeks: 1, weekdays: [5] },
  localStartTime: "10:00",
  localEndTime: "11:00",
  setupBeforeMinutes: 0,
  transitionAfterMinutes: 0,
  status: "active" as const
};

function state(commitments: unknown[], ruleOver: Record<string, unknown> = {}, horizon = horizonEnd) {
  return portalStateSchema.parse({
    settings: {
      timezone: "Australia/Sydney",
      planningHorizonEnd: "22:00",
      defaultUsableFraction: 0.85,
      defaultSetupBufferMinutes: 0,
      defaultTransitionBufferMinutes: 0,
      submissionBufferMinutes: 0,
      submissionBufferPercent: 0,
      energyMeanings: { high: "high", medium: "medium", low: "low", recovery: "recovery" },
      estimateBucketsMinutes: [15, 30, 60],
      conditionCatalog: ["home"],
      preferredBedtime: "22:30",
      preferredWakeTime: "07:00",
      desiredSleepMinutes: 480,
      minimumSleepMinutes: 420,
      maxAwakeHours: 16,
      lastWokeAt: "2026-09-03T00:00:00.000Z"
    },
    areas: [],
    outcomes: [],
    projects: [],
    actions: [],
    commitments,
    commitmentRecurrenceRules: [{ ...rule, ...ruleOver }],
    routineSteps: [],
    routinePresets: [],
    occurrences: [],
    sleepPlans: [],
    captures: [],
    completedToday: [],
    assertedConditions: ["home"],
    currentEnergy: "medium",
    horizonEnd: horizon,
    activeSession: null
  });
}

function derive(commitments: unknown[]) {
  return (plan(commitments).derivedState.commitmentRepeats as Record<string, unknown>[] | undefined) ?? [];
}

function plan(commitments: unknown[], over: { rule?: Record<string, unknown>; horizon?: string } = {}) {
  return calculatePlanAndForecast(
    planForecastRequestSchema.parse({
      contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
      requestId: "00000000-0000-4000-8000-000000000008",
      inputVersion: "feed-exception-rows-fixture",
      calculatedAt: now.toISOString(),
      horizonEnd: over.horizon ?? horizonEnd,
      state: state(commitments, over.rule, over.horizon)
    })
  );
}

describe("exception rows written under the contracts occurrence id", () => {
  it("derives every date under commitmentOccurrenceRowId", () => {
    const repeats = derive([]);
    expect(repeats.map((row) => row.localDate)).toEqual(["2026-09-04", "2026-09-11", "2026-09-18"]);
    for (const row of repeats) expect(row.id).toBe(commitmentOccurrenceRowId(rule.id, String(row.localDate)));
  });

  it("applies a changed row stored under that id, and leaves the other dates alone", () => {
    const stored = (date: string, over: Record<string, unknown>) => ({
      id: commitmentOccurrenceRowId(rule.id, date),
      title: rule.title,
      startsAt: "2026-09-11T00:00:00.000Z",
      endsAt: "2026-09-11T01:00:00.000Z",
      status: "confirmed",
      setupBeforeMinutes: 0,
      transitionAfterMinutes: 0,
      recurrenceRuleId: rule.id,
      localDate: date,
      scheduleSource: "custom",
      ...over
    });
    const repeats = derive([
      stored("2026-09-11", { status: "cancelled" }),
      // 14:00 to 15:30 in the feed zone (UTC+10 in September).
      stored("2026-09-18", {
        title: "Moved meeting",
        startsAt: "2026-09-18T04:00:00.000Z",
        endsAt: "2026-09-18T05:30:00.000Z"
      })
    ]);
    const byDate = new Map(repeats.map((row) => [String(row.localDate), row]));
    expect(byDate.get("2026-09-11")?.title).toBe("Team meeting");
    expect(byDate.get("2026-09-18")?.title).toBe("Moved meeting");
    expect(byDate.get("2026-09-18")?.startsAt).toBe("2026-09-18T04:00:00.000Z");
    expect(byDate.get("2026-09-04")?.title).toBe("Team meeting");
    expect(byDate.size).toBe(3);
  });

  it("treats a stored cancelled row under that id as cancelled: it no longer constrains sleep", () => {
    // A rule that runs through the night (01:00 to 06:30) pins tonight's sleep; cancelling that date by the contracts id
    // must release it, exactly as the owner's own cancel does.
    const night = { startDate: "2026-09-04", localStartTime: "01:00", localEndTime: "06:30" };
    const tonight = "2026-09-04";
    const horizon = new Date(now.getTime() + 24 * 60 * 60_000).toISOString();
    const live = plan([], { rule: night, horizon }).derivedState.sleepPlans[0] as Record<string, unknown>;
    expect(live.wakeConstraint).toBeDefined();
    const cancelled = plan(
      [
        {
          id: commitmentOccurrenceRowId(rule.id, tonight),
          title: rule.title,
          startsAt: "2026-09-03T15:00:00.000Z",
          endsAt: "2026-09-03T20:30:00.000Z",
          status: "cancelled",
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0,
          recurrenceRuleId: rule.id,
          localDate: tonight,
          scheduleSource: "custom"
        }
      ],
      { rule: night, horizon }
    ).derivedState.sleepPlans[0] as Record<string, unknown>;
    expect(cancelled.wakeConstraint).toBeUndefined();
  });
});
