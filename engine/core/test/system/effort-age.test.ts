import { describe, expect, it } from "vitest";
import {
  PLAN_FORECAST_CONTRACT_VERSION,
  portalStateSchema,
  planForecastRequestSchema,
  type PlanForecastResponse
} from "@openrhen/contracts";
import { calculatePlanAndForecast } from "../../src/index.js";
import type { ProjectForecast } from "../../src/index.js";

/**
 * Effort age: an estimate nobody has confirmed in 14 days is
 * still a number the plan uses, so ranking and placement never move. On a project that is behind or at risk the
 * forecast lists it as an aged input and trusts itself one band less. Each case runs the whole engine twice on the
 * same state, once with the estimate set long ago and once set this morning, so what differs is only the age.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// 12:00 on a Friday in UTC, so every clock here is the plain wall clock.
const now = new Date("2026-08-14T12:00:00.000Z");
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

function action(id: string, title: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    projectId: "project-1",
    title,
    status: "active",
    optimisticMinutes: 45,
    expectedMinutes: 45,
    remainingMinutes: 45,
    pessimisticMinutes: 45,
    energy: "medium",
    minimumSessionMinutes: 15,
    maximumSessionMinutes: 45,
    importance: 3,
    consequence: 3,
    contexts: [],
    dependencyIds: [],
    splittable: true,
    setupMinutes: 0,
    ...overrides
  };
}

/** Three days to a deadline that `workMinutes` of remaining effort either fits (small) or cannot (large). */
function state(actions: Record<string, unknown>[]) {
  return portalStateSchema.parse({
    settings: {
      timezone: "UTC",
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
      preferredWakeTime: "06:00",
      desiredSleepMinutes: 480,
      minimumSleepMinutes: 420,
      maxAwakeHours: 16,
      arrivalMarginMinutes: 0,
      lastWokeAt: ago(2 * HOUR)
    },
    areas: [{ id: "area-1", name: "Study", status: "active", sortOrder: 0 }],
    outcomes: [
      { id: "outcome-1", areaId: "area-1", title: "Pass", definitionOfDone: "Done", value: 3, status: "active" }
    ],
    projects: [
      {
        id: "project-1",
        title: "Networking",
        area: "area-1",
        outcomeId: "outcome-1",
        status: "active",
        uncertainty: "known",
        value: 3,
        consequence: 3,
        externalDeadlineAt: new Date(now.getTime() + 3 * DAY).toISOString()
      }
    ],
    actions,
    commitments: [],
    routineSteps: [],
    routinePresets: [],
    occurrences: [],
    sleepPlans: [],
    captures: [],
    completedToday: [],
    assertedConditions: ["home"],
    currentEnergy: "medium",
    horizonEnd: new Date(now.getTime() + 3 * DAY).toISOString(),
    activeSession: null,
    conditionDefinitions: [{ id: "home", name: "Home", kind: "location", status: "active" }],
    currentSituation: {
      locationId: "home",
      locationSetAt: ago(HOUR),
      energySetAt: ago(HOUR),
      transportModes: ["car"]
    }
  });
}

function run(wire: ReturnType<typeof state>) {
  return calculatePlanAndForecast(
    planForecastRequestSchema.parse({
      contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
      requestId: "00000000-0000-4000-8000-0000000ef0a1",
      inputVersion: "effort-age-fixture",
      calculatedAt: now.toISOString(),
      horizonEnd: new Date(now.getTime() + 3 * DAY).toISOString(),
      state: wire
    })
  );
}

const forecastOf = (response: PlanForecastResponse) =>
  (response.schedule as unknown as { forecasts: ProjectForecast[] }).forecasts.find(
    (item) => item.projectId === "project-1"
  )!;

/** The same actions with the big one's estimate set `days` ago. */
function withAge(days: number | undefined, extra: Record<string, unknown>[] = [], remaining = 4000) {
  return state([
    action("action-big", "Write the report", {
      expectedMinutes: remaining,
      optimisticMinutes: remaining,
      pessimisticMinutes: remaining,
      remainingMinutes: remaining,
      maximumSessionMinutes: 240,
      ...(days === undefined ? {} : { remainingSetAt: ago(days * DAY) })
    }),
    action("action-small", "Lab 8: routing"),
    ...extra
  ]);
}

/**
 * What the engine returned, without the one input it merely echoes: the recommendation carries each candidate action
 * as it was given, `remainingSetAt` included, and that date is the only thing these runs vary. With `forecastTrust`
 * off, a forecast's own confidence line (confidence, its reason and the aged inputs) is left out as well.
 */
function comparable(response: PlanForecastResponse, { forecastTrust = true } = {}) {
  const copy = JSON.parse(
    JSON.stringify(response, (key, value) => (key === "remainingSetAt" ? undefined : value))
  ) as PlanForecastResponse;
  if (!forecastTrust)
    for (const forecast of (copy.schedule as unknown as { forecasts: Record<string, unknown>[] }).forecasts) {
      delete forecast.agedInputs;
      delete forecast.confidence;
      delete forecast.reasons;
    }
  return copy;
}

describe("an old estimate on a project that is at risk", () => {
  const fresh = run(withAge(0));
  const aged = run(withAge(21));

  it("is a project the forecast says is behind or at risk", () => {
    expect(["behind", "at_risk"]).toContain(forecastOf(fresh).health);
  });

  it("is listed as an aged input, oldest first, with the day it was set", () => {
    expect(forecastOf(fresh).agedInputs).toBeUndefined();
    expect(forecastOf(aged).agedInputs).toEqual([
      { actionId: "action-big", title: "Write the report", setAt: ago(21 * DAY) }
    ]);
    const reasons = forecastOf(aged).reasons;
    expect(reasons).toContain(
      "The remaining time on Write the report was last set 21 days ago; it is used as given and confidence drops one band."
    );
    expect(forecastOf(fresh).reasons.join(" ")).not.toContain("last set");
  });

  it("drops the forecast's confidence exactly one band", () => {
    const ladder = ["high", "medium_high", "medium", "low_medium", "low"];
    const before = forecastOf(fresh).confidence!;
    expect(before).toBeTruthy();
    expect(ladder.indexOf(forecastOf(aged).confidence!)).toBe(Math.min(ladder.length - 1, ladder.indexOf(before) + 1));
    expect(forecastOf(aged).reasons).toContain(
      `Forecast confidence is ${forecastOf(aged).confidence!.replace("_", " ")}.`
    );
  });

  it("changes nothing else: not health, ranking, placement, the day plan or when the plan expires", () => {
    expect(forecastOf(aged).health).toBe(forecastOf(fresh).health);
    expect(comparable(aged, { forecastTrust: false })).toEqual(comparable(fresh, { forecastTrust: false }));
    expect(aged.validUntil).toBe(fresh.validUntil);
    expect(aged.currentDirective).toEqual(fresh.currentDirective);
  });

  it("counts an estimate of 14 days as aged and one of 13 days as current", () => {
    expect(forecastOf(run(withAge(14))).agedInputs).toHaveLength(1);
    expect(forecastOf(run(withAge(13.9))).agedInputs).toBeUndefined();
  });

  it("lists several, the oldest first, and still drops only one band for them", () => {
    const response = run(
      withAge(21, [
        action("action-mid", "Read the spec", {
          remainingSetAt: ago(30 * DAY),
          remainingMinutes: 120,
          expectedMinutes: 120,
          optimisticMinutes: 120,
          pessimisticMinutes: 120
        })
      ])
    );
    expect(forecastOf(response).agedInputs?.map((item) => item.actionId)).toEqual(["action-mid", "action-big"]);
    expect(forecastOf(response).confidence).toBe(forecastOf(aged).confidence);
    expect(forecastOf(response).reasons.join(" ")).toContain(
      "2 remaining times were last set 14 days ago or more, the oldest on Read the spec (30 days)"
    );
  });
});

describe("an old estimate that does not put the forecast in doubt", () => {
  it("leaves a project that is on track exactly as it was", () => {
    const small = (days: number) => withAge(days, [], 60);
    const fresh = run(small(0));
    expect(["on_track", "ahead"]).toContain(forecastOf(fresh).health);
    const aged = run(small(60));
    expect(forecastOf(aged).agedInputs).toBeUndefined();
    expect(comparable(aged)).toEqual(comparable(fresh));
  });

  it("treats an estimate with no date as unknown, so a request from before the column flags nothing", () => {
    expect(comparable(run(withAge(undefined)))).toEqual(comparable(run(withAge(0))));
  });

  it("does not age an action that is done or has nothing left", () => {
    const response = run(
      state([
        action("action-big", "Write the report", {
          expectedMinutes: 4000,
          optimisticMinutes: 4000,
          pessimisticMinutes: 4000,
          remainingMinutes: 4000,
          maximumSessionMinutes: 240
        }),
        action("action-done", "Old draft", { status: "done", remainingMinutes: 0, remainingSetAt: ago(90 * DAY) }),
        action("action-empty", "Spent", { remainingMinutes: 0, remainingSetAt: ago(90 * DAY) })
      ])
    );
    expect(forecastOf(response).agedInputs).toBeUndefined();
  });
});

describe("an old estimate beside blocked work", () => {
  it("drops one band for each cause, and stops at the bottom of the ladder", () => {
    const blocked = (days: number) =>
      run(withAge(days, [action("action-blocked", "Waiting on the lab", { status: "blocked" })]));
    const ladder = ["high", "medium_high", "medium", "low_medium", "low"];
    const base = ladder.indexOf(forecastOf(blocked(0)).confidence!);
    expect(ladder.indexOf(forecastOf(blocked(21)).confidence!)).toBe(Math.min(ladder.length - 1, base + 1));
  });
});
