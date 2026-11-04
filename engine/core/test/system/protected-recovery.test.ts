import { describe, expect, it } from "vitest";
import { PLAN_FORECAST_CONTRACT_VERSION, planForecastRequestSchema, portalStateSchema } from "@openrhen/contracts";
import { calculatePlanAndForecast } from "../../src/index.js";

// 14:00 on Friday 14 August in the seed zone. The recovery window is 14:00 to 15:00 local, 04:00Z to 05:00Z.
const now = new Date("2026-08-14T04:00:00.000Z");
const HOUR = 60 * 60_000;
const windowStart = now.getTime();
const windowEnd = now.getTime() + HOUR;

function action(id: string, energy: "medium" | "recovery", minutes: number) {
  return {
    id,
    projectId: "project-1",
    title: id,
    status: "active",
    optimisticMinutes: minutes,
    expectedMinutes: minutes,
    remainingMinutes: minutes,
    pessimisticMinutes: minutes,
    energy,
    minimumSessionMinutes: 15,
    maximumSessionMinutes: minutes,
    importance: 3,
    consequence: 3,
    contexts: [],
    dependencyIds: [],
    splittable: true,
    setupMinutes: 0
  };
}

function state(
  overrides: { actions?: unknown[]; commitments?: unknown[]; dailyPlan?: unknown; recovery?: boolean } = {}
) {
  return portalStateSchema.parse({
    settings: {
      timezone: "Australia/Sydney",
      planningHorizonEnd: "22:00",
      defaultUsableFraction: 1,
      defaultSetupBufferMinutes: 0,
      defaultTransitionBufferMinutes: 0,
      submissionBufferMinutes: 0,
      submissionBufferPercent: 0,
      energyMeanings: { high: "high", medium: "medium", low: "low", recovery: "recovery" },
      estimateBucketsMinutes: [15, 30, 60],
      conditionCatalog: ["home"],
      preferredBedtime: "23:00",
      preferredWakeTime: "07:00",
      desiredSleepMinutes: 480,
      minimumSleepMinutes: 420,
      maxAwakeHours: 16,
      arrivalMarginMinutes: 0,
      ...(overrides.recovery === false ? {} : { recoveryStartTime: "14:00", recoveryEndTime: "15:00" })
    },
    areas: [{ id: "area-1", name: "Life", status: "active", sortOrder: 0 }],
    outcomes: [
      { id: "outcome-1", areaId: "area-1", title: "Rested", definitionOfDone: "Done", value: 3, status: "active" }
    ],
    projects: [
      {
        id: "project-1",
        title: "Project",
        area: "area-1",
        outcomeId: "outcome-1",
        status: "active",
        uncertainty: "known",
        value: 3,
        consequence: 3,
        externalDeadlineAt: new Date(now.getTime() + 40 * HOUR).toISOString()
      }
    ],
    actions: overrides.actions ?? [],
    commitments: overrides.commitments ?? [],
    routineSteps: [],
    routinePresets: [],
    occurrences: [],
    sleepPlans: [],
    captures: [],
    completedToday: [],
    assertedConditions: ["home"],
    currentEnergy: "medium",
    horizonEnd: new Date(now.getTime() + 2 * 24 * HOUR).toISOString(),
    activeSession: null,
    ...(overrides.dailyPlan ? { dailyPlan: overrides.dailyPlan } : {})
  });
}

function run(input: ReturnType<typeof state>) {
  return calculatePlanAndForecast(
    planForecastRequestSchema.parse({
      contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
      requestId: "00000000-0000-4000-8000-000000000024",
      inputVersion: "protected-recovery-fixture",
      calculatedAt: now.toISOString(),
      horizonEnd: new Date(now.getTime() + 2 * 24 * HOUR).toISOString(),
      state: input
    })
  );
}

interface Allocation {
  actionId: string;
  startsAt: string;
  endsAt: string;
}
const allocations = (response: ReturnType<typeof run>) =>
  (response.schedule as unknown as { allocations: Allocation[] }).allocations;
const insideTodaysWindow = (block: Allocation) =>
  new Date(block.startsAt).getTime() < windowEnd && new Date(block.endsAt).getTime() > windowStart;

describe("protected recovery (AT-J)", () => {
  it("directs deliberate recovery for the whole window when no recovery action is ready", () => {
    const response = run(state({ actions: [action("work", "medium", 60)] }));
    expect(response.currentDirective.kind).toBe("recovery");
    expect(response.currentDirective.recommendedMinutes).toBe(60);
    expect(allocations(response).filter(insideTodaysWindow)).toEqual([]);
  });

  it("schedules a recovery action only inside the window and ordinary work never", () => {
    const response = run(state({ actions: [action("work", "medium", 60), action("rest", "recovery", 30)] }));
    expect(response.currentDirective).toMatchObject({ kind: "action", targetId: "rest" });
    const blocks = allocations(response);
    expect(blocks.some((block) => block.actionId === "rest")).toBe(true);
    for (const block of blocks) {
      const local = new Date(block.startsAt).getUTCHours();
      // 04:00Z is 14:00 in the seed zone on every date in the horizon (no daylight-saving change in August).
      const inWindow = local === 4;
      expect(inWindow).toBe(block.actionId === "rest");
    }
  });

  it("never offers a recovery action outside the window, whatever the current energy", () => {
    // 16:00 local, after today's window: only ordinary capacity is open.
    const later = new Date(windowEnd + HOUR);
    // Energy only counts while it is dated and recent (`resolveFreshness`), so say when it was said.
    const input = {
      ...state({ actions: [action("rest", "recovery", 30)] }),
      currentEnergy: "high" as const,
      currentSituation: { energySetAt: later.toISOString() }
    };
    const response = calculatePlanAndForecast(
      planForecastRequestSchema.parse({
        contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
        requestId: "00000000-0000-4000-8000-000000000025",
        inputVersion: "protected-recovery-outside",
        calculatedAt: later.toISOString(),
        horizonEnd: new Date(later.getTime() + 24 * HOUR).toISOString(),
        state: input
      })
    );
    expect(response.currentDirective).not.toMatchObject({ targetId: "rest" });
    const rest = (
      response.recommendation as unknown as {
        candidates: { action: { id: string }; eligible: boolean; exclusionReasons: string[] }[];
      }
    ).candidates.find((candidate) => candidate.action.id === "rest");
    expect(rest?.eligible).toBe(false);
    expect(rest?.exclusionReasons).toContain("Current energy is high; this action requires recovery.");
  });

  it("shrinks the window when a commitment overlaps it", () => {
    const response = run(
      state({
        commitments: [
          {
            id: "call",
            title: "Call",
            status: "confirmed",
            startsAt: new Date(windowStart + 30 * 60_000).toISOString(),
            endsAt: new Date(windowEnd).toISOString(),
            setupBeforeMinutes: 0,
            transitionAfterMinutes: 0
          }
        ]
      })
    );
    expect(response.currentDirective.kind).toBe("recovery");
    expect(response.currentDirective.recommendedMinutes).toBe(30);
  });

  it("plans work inside a skipped date's window, and only that date's", () => {
    const response = run(
      state({
        actions: [action("work", "medium", 600)],
        dailyPlan: {
          id: "plan",
          localDate: "2026-08-14",
          desiredActionIds: [],
          deferredItems: [],
          recoverySkipped: true
        }
      })
    );
    expect(response.currentDirective).toMatchObject({ kind: "action", targetId: "work" });
    const blocks = allocations(response);
    expect(blocks.length).toBeGreaterThan(0);
    const tomorrow = { start: windowStart + 24 * HOUR, end: windowEnd + 24 * HOUR };
    expect(
      blocks.some(
        (block) =>
          new Date(block.startsAt).getTime() < tomorrow.end && new Date(block.endsAt).getTime() > tomorrow.start
      )
    ).toBe(false);
  });

  it("never improves a project's margin by turning recovery on", () => {
    const margin = (response: ReturnType<typeof run>) =>
      (response.schedule as unknown as { forecasts: { projectId: string; expectedMarginMinutes: number | null }[] })
        .forecasts[0]!.expectedMarginMinutes ?? 0;
    const work = [action("work", "medium", 120)];
    const off = run(state({ actions: work, recovery: false }));
    const on = run(state({ actions: work }));
    expect(margin(on)).toBeLessThanOrEqual(margin(off));
  });
});
