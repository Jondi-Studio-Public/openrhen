import { describe, expect, it, vi } from "vitest";
import { PLAN_FORECAST_CONTRACT_VERSION, planForecastRequestSchema, portalStateSchema } from "@openrhen/contracts";
import { calculatePlanAndForecast, planSchedule } from "../../src/index.js";
import * as continuationModule from "../../src/recommendation/continuation.js";

// Records what the engine hands the continuation, and otherwise runs the real thing.
const received: Parameters<typeof continuationModule.simulateContinuation>[] = [];
vi.mock("../../src/recommendation/continuation.js", async (importOriginal) => {
  const original = await importOriginal<typeof continuationModule>();
  return {
    ...original,
    simulateContinuation: (...args: Parameters<typeof original.simulateContinuation>) => {
      received.push(args);
      return original.simulateContinuation(...args);
    }
  };
});

/**
 * the continuation is judged against the plan the person is looking at, so it must plan with the
 * same arguments that plan used. It used to restate them and left out `sessionBreakMinutes` and the
 * occurrence history, falling back to the default break and to no history whatever the request said.
 * The engine now hands it the plan's own arguments and the plan itself as the baseline.
 *
 * A missing break or history rarely changes the verdict — a break reshapes sessions without changing
 * the capacity margin that makes a project Behind — so this pins what the engine passes rather than
 * searching for a request whose answer happens to flip.
 */

// 14:00 on Friday 14 August in the seed zone.
const now = new Date("2026-08-14T04:00:00.000Z");
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const iso = (offsetMs: number) => new Date(now.getTime() + offsetMs).toISOString();

function work(id: string, projectId: string) {
  return {
    id,
    projectId,
    title: id,
    status: "active",
    optimisticMinutes: 60,
    expectedMinutes: 60,
    remainingMinutes: 60,
    pessimisticMinutes: 60,
    energy: "medium",
    minimumSessionMinutes: 15,
    maximumSessionMinutes: 30,
    importance: 3,
    consequence: 3,
    contexts: [],
    dependencyIds: [],
    splittable: true,
    setupMinutes: 0
  };
}

function project(id: string, deadlineOffsetMs: number, consequence: number) {
  return {
    id,
    title: id,
    area: "area-1",
    outcomeId: "outcome-1",
    status: "active",
    uncertainty: "known",
    value: 3,
    consequence,
    internalDeadlineAt: iso(deadlineOffsetMs)
  };
}

function continueFor(sessionBreakMinutes?: number) {
  const state = portalStateSchema.parse({
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
      ...(sessionBreakMinutes !== undefined ? { sessionBreakMinutes } : {})
    },
    areas: [{ id: "area-1", name: "Work", status: "active", sortOrder: 0 }],
    outcomes: [
      { id: "outcome-1", areaId: "area-1", title: "Done", definitionOfDone: "Done", value: 3, status: "active" }
    ],
    projects: [project("current", 10 * DAY, 1), project("urgent", 2 * HOUR, 5)],
    actions: [work("current-work", "current"), work("urgent-work", "urgent")],
    // Only now to two hours from now is free: the rest of the automatic day, and every day after it
    // through the horizon, is blocked.
    commitments: [
      {
        id: "before",
        title: "Blocked before",
        status: "confirmed",
        startsAt: iso(-14 * HOUR),
        endsAt: iso(0),
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0
      },
      {
        id: "after",
        title: "Blocked after",
        status: "confirmed",
        startsAt: iso(2 * HOUR),
        endsAt: iso(15 * DAY),
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0
      }
    ],
    routineSteps: [],
    occurrences: [],
    sleepPlans: [],
    captures: [],
    completedToday: [],
    assertedConditions: ["home"],
    currentEnergy: "medium",
    horizonEnd: iso(14 * DAY),
    activeSession: null
  });
  const response = calculatePlanAndForecast(
    planForecastRequestSchema.parse({
      contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
      requestId: "00000000-0000-4000-8000-000000000097",
      inputVersion: "continuation-settings",
      calculatedAt: now.toISOString(),
      horizonEnd: iso(14 * DAY),
      state,
      continuation: { actionId: "current-work", requestedMinutes: 30 }
    })
  );
  return response;
}

describe("continuation plans with the same arguments as the plan", () => {
  it("passes the configured session break and the occurrence history, and the plan as its baseline", () => {
    received.length = 0;
    const response = continueFor(45);
    expect(response.continuation).not.toBeNull();
    expect(received).toHaveLength(1);
    const [args, baseline] = received[0]!;
    expect(args.sessionBreakMinutes).toBe(45);
    expect(args.occurrences).toBeDefined();
    expect(args.actionId).toBe("current-work");
    expect(args.requestedMinutes).toBe(30);
    // The baseline is the plan of exactly these arguments, so reusing it saves a re-plan and changes
    // nothing.
    expect(baseline).toEqual(planSchedule(args));
  });

  it("answers the same as a continuation that plans its own baseline", async () => {
    received.length = 0;
    const response = continueFor(45);
    const [args] = received[0]!;
    const original = await vi.importActual<typeof continuationModule>("../../src/recommendation/continuation.js");
    expect(JSON.stringify(response.continuation)).toBe(JSON.stringify(original.simulateContinuation(args)));
  });
});
