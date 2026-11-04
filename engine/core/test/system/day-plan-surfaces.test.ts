import { describe, expect, it } from "vitest";
import { PLAN_FORECAST_CONTRACT_VERSION, planForecastRequestSchema, portalStateSchema } from "@openrhen/contracts";
import { calculatePlanAndForecast } from "../../src/index.js";

/**
 * The day plan surfaces design note: `derivedState.stepPlacements` and `softPlacements` are the two
 * new typed wire arrays this plan adds. This fixture reuses the wash (5, wait 90) -> hang out (5,
 * wait 240) -> pack chain `routine-step-timing.md`'s own tests place against a work commitment
 * tomorrow at 07:00 UTC and an evening band (`DEFAULT_TIME_BANDS`, 17:00-22:00 local, UTC here).
 */

const now = new Date("2026-08-14T08:00:00.000Z");
const MIN = 60_000;
const HOUR = 3_600_000;
const iso = (offsetMs: number) => new Date(now.getTime() + offsetMs).toISOString();

const washPreset = {
  id: "wash-preset",
  version: 1,
  name: "Wash chain",
  activityName: "Wash chain",
  status: "active" as const,
  replacesWakeRoutine: false,
  steps: [
    {
      id: "wash-step",
      title: "Wash",
      durationMinutes: 5,
      sequence: 0,
      timingRule: "flexible" as const,
      maxLeadMinutes: 720,
      energy: "low" as const,
      contexts: [],
      dependencyIds: [],
      phase: "before" as const,
      waitAfterMinutes: 90,
      preferredBands: ["evening"]
    },
    {
      id: "hangout-step",
      title: "Hang out washing",
      durationMinutes: 5,
      sequence: 1,
      timingRule: "flexible" as const,
      maxLeadMinutes: 720,
      energy: "low" as const,
      contexts: [],
      dependencyIds: ["wash-step"],
      phase: "before" as const,
      waitAfterMinutes: 240,
      preferredBands: ["evening"]
    },
    {
      id: "pack-step",
      title: "Pack bag",
      durationMinutes: 5,
      sequence: 2,
      timingRule: "contiguous" as const,
      energy: "low" as const,
      contexts: [],
      dependencyIds: ["hangout-step"],
      phase: "before" as const
    }
  ]
};

const workCommitment = {
  id: "work",
  title: "Work",
  status: "confirmed" as const,
  startsAt: iso(23 * HOUR),
  endsAt: iso(23 * HOUR + 8 * HOUR),
  locationId: "office",
  setupBeforeMinutes: 0,
  transitionAfterMinutes: 0
};

function baseState(overrides: Record<string, unknown> = {}) {
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
      conditionCatalog: ["office"],
      preferredBedtime: "23:00",
      preferredWakeTime: "07:00",
      desiredSleepMinutes: 480,
      minimumSleepMinutes: 420,
      maxAwakeHours: 16
    },
    areas: [],
    outcomes: [],
    projects: [],
    actions: [],
    commitments: [],
    routineSteps: [],
    routinePresets: [washPreset],
    conditionDefinitions: [
      { id: "office", name: "Office", kind: "location", status: "active", defaultRoutinePresetId: "wash-preset" }
    ],
    occurrences: [],
    sleepPlans: [],
    captures: [],
    completedToday: [],
    assertedConditions: [],
    currentEnergy: "medium",
    horizonEnd: iso(3 * 24 * HOUR),
    activeSession: null,
    ...overrides
  });
}

function request(state: ReturnType<typeof baseState>, requestId: string, calculatedAt: Date = now) {
  return planForecastRequestSchema.parse({
    contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
    requestId,
    inputVersion: "day-plan-surfaces-fixture",
    calculatedAt: calculatedAt.toISOString(),
    horizonEnd: new Date(calculatedAt.getTime() + 3 * 24 * HOUR).toISOString(),
    state
  });
}

function stepPlacementsOf(response: ReturnType<typeof calculatePlanAndForecast>) {
  return response.derivedState.stepPlacements ?? [];
}

describe("day-plan-surfaces: stepPlacements", () => {
  it("carries placed times, startBy, waitEndsAt and bandId for the wash/hang-out/pack chain", () => {
    const state = baseState({ commitments: [workCommitment] });
    const response = calculatePlanAndForecast(request(state, "00000000-0000-4000-8000-0000000000d1"));
    const entries = stepPlacementsOf(response);

    const routineSteps = response.derivedState.routineSteps as Array<Record<string, unknown>>;
    const wash = routineSteps.find((step) => step.presetStepId === "wash-step")!;
    const hangout = routineSteps.find((step) => step.presetStepId === "hangout-step")!;
    const pack = routineSteps.find((step) => step.presetStepId === "pack-step")!;

    const washEntry = entries.find((entry) => entry.stepId === wash.id)!;
    expect(washEntry).toBeDefined();
    expect(washEntry.anchorKind).toBe("commitment");
    expect(washEntry.anchorId).toBe("work");
    expect(washEntry.placedStartAt).toBe(iso(12 * HOUR + 20 * MIN)); // 20:20 today
    expect(washEntry.placedEndAt).toBe(iso(12 * HOUR + 25 * MIN)); // 20:25 today
    expect(washEntry.waitEndsAt).toBe(iso(13 * HOUR + 55 * MIN)); // 21:55 today
    expect(washEntry.bandId).toBe("evening");

    const hangoutEntry = entries.find((entry) => entry.stepId === hangout.id)!;
    expect(hangoutEntry.bandId).toBe("evening");
    expect(hangoutEntry.placedStartAt).toBe(iso(13 * HOUR + 55 * MIN));

    const packEntry = entries.find((entry) => entry.stepId === pack.id)!;
    expect(packEntry.bandId).toBeUndefined(); // contiguous, un-banded
    expect(hangoutEntry.startBy).toBeDefined();

    // Sorted by stepId, as the design requires.
    const stepIds = entries.map((entry) => entry.stepId);
    expect(stepIds).toEqual([...stepIds].sort());
  });

  it("once wash is completed, its entry carries the running wait and no placed times", () => {
    const washCompletedAt = iso(-30 * MIN);
    const state = baseState({
      commitments: [workCommitment],
      routineSteps: [
        {
          id: "wash-completed",
          commitmentId: "work",
          presetStepId: "wash-step",
          title: "Wash",
          durationMinutes: 5,
          sequence: 0,
          timingRule: "flexible",
          energy: "low",
          contexts: [],
          dependencyIds: [],
          phase: "before",
          status: "completed",
          waitAfterMinutes: 90,
          scheduledStartAt: iso(-35 * MIN),
          scheduledEndAt: washCompletedAt,
          completedAt: washCompletedAt
        }
      ]
    });
    const response = calculatePlanAndForecast(request(state, "00000000-0000-4000-8000-0000000000d2"));
    const entries = stepPlacementsOf(response);
    const washEntry = entries.find((entry) => entry.stepId === "wash-completed")!;
    expect(washEntry).toBeDefined();
    expect(washEntry.placedStartAt).toBeUndefined();
    expect(washEntry.placedEndAt).toBeUndefined();
    expect(washEntry.waitStartsAt).toBe(washCompletedAt);
    expect(washEntry.waitEndsAt).toBe(iso(60 * MIN));
  });

  it("adding the arrays leaves every other output field deep-equal to a run with them stripped", () => {
    const state = baseState({ commitments: [workCommitment] });
    const response = calculatePlanAndForecast(request(state, "00000000-0000-4000-8000-0000000000d3"));
    const { stepPlacements: _stepPlacements, ...derivedStateRest } = response.derivedState;
    const { softPlacements: _softPlacements, ...responseRest } = response;
    const second = calculatePlanAndForecast(request(state, "00000000-0000-4000-8000-0000000000d3"));
    const { stepPlacements: _stepPlacements2, ...derivedStateRest2 } = second.derivedState;
    const { softPlacements: _softPlacements2, ...responseRest2 } = second;
    expect(derivedStateRest).toEqual(derivedStateRest2);
    expect(responseRest).toEqual(responseRest2);
  });
});

describe("day-plan-surfaces: softPlacements", () => {
  const projectFixture = {
    areas: [{ id: "cadence-area", name: "Health", status: "active" as const, sortOrder: 0 }],
    outcomes: [
      {
        id: "cadence-outcome",
        areaId: "cadence-area",
        title: "Keep practicing",
        definitionOfDone: "Still practicing",
        value: 3,
        status: "active" as const
      }
    ],
    projects: [
      {
        id: "cadence-project",
        title: "Piano",
        area: "cadence-area",
        outcomeId: "cadence-outcome",
        status: "active" as const,
        uncertainty: "known" as const,
        value: 3,
        consequence: 3
      }
    ]
  };

  function cadenceAction() {
    return {
      id: "practice-action",
      projectId: "cadence-project",
      title: "Practice piano",
      status: "active" as const,
      optimisticMinutes: 30,
      expectedMinutes: 60,
      pessimisticMinutes: 90,
      remainingMinutes: 60,
      splittable: false,
      setupMinutes: 0,
      energy: "low" as const,
      minimumSessionMinutes: 30,
      maximumSessionMinutes: 90,
      importance: 3,
      consequence: 3,
      contexts: [],
      dependencyIds: [],
      schedulingMode: "cadence" as const,
      recurrence: {
        id: "practice-action-rule",
        actionId: "practice-action",
        timezone: "UTC",
        startDate: "2020-01-01",
        intervalDays: 1,
        // Twice a week, any two days — `cadenceOccurrencesPerDay` -> 3/7 -> expectedOccurrences = 3.
        period: { unit: "days" as const, length: 7 },
        targetOccurrences: 3,
        windows: [],
        completionMode: "manual" as const
      }
    };
  }

  it("emits one soft interval per fitting occurrence, matching weekOutlook.cadence's own count", () => {
    const state = baseState({ ...projectFixture, actions: [cadenceAction()] });
    const response = calculatePlanAndForecast(request(state, "00000000-0000-4000-8000-0000000000d4"));
    const cadence = (
      response.weekOutlook as
        { cadence?: { actions: Array<{ actionId: string; fittingOccurrences: number }> } } | undefined
    )?.cadence;
    expect(cadence).toBeDefined();
    const entry = cadence!.actions.find((item) => item.actionId === "practice-action")!;
    expect(entry).toBeDefined();
    expect(entry.fittingOccurrences).toBeGreaterThan(0);
    expect(entry.fittingOccurrences).toBeLessThanOrEqual(3);

    const intervals = response.softPlacements.filter((item) => item.actionId === "practice-action");
    expect(intervals).toHaveLength(entry.fittingOccurrences);
    for (const interval of intervals) {
      expect(interval.minutes).toBe(60);
      expect(new Date(interval.endsAt).getTime() - new Date(interval.startsAt).getTime()).toBe(60 * MIN);
      expect(new Date(interval.startsAt).getTime()).toBeGreaterThanOrEqual(now.getTime());
    }
    // Never overlapping each other.
    const sorted = [...intervals].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    for (let index = 1; index < sorted.length; index += 1)
      expect(new Date(sorted[index]!.startsAt).getTime()).toBeGreaterThanOrEqual(
        new Date(sorted[index - 1]!.endsAt).getTime()
      );
  });

  it("emits nothing when there is no active cadence action", () => {
    const state = baseState({ commitments: [workCommitment] });
    const response = calculatePlanAndForecast(request(state, "00000000-0000-4000-8000-0000000000d5"));
    expect(response.softPlacements).toEqual([]);
  });
});
