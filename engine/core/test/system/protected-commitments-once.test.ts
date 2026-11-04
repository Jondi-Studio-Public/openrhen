import { describe, expect, it } from "vitest";
import { PLAN_FORECAST_CONTRACT_VERSION, planForecastRequestSchema, portalStateSchema } from "@openrhen/contracts";
import { calculatePlanAndForecast } from "../../src/index.js";

/**
 * F1-05: `protectedCommitments()` depends only on (state, commitment repeats, now), so one calculation
 * builds it once. Each build maps every confirmed commitment and reads its `preferredLocationId`, a
 * field nothing else in the engine reads on a wire commitment, so reads of it count builds.
 */
/** FNV-1a over the UTF-16 code units: a dependency-free fingerprint (engine-core carries no node types). */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16)}:${text.length}`;
}

const now = new Date("2026-08-11T05:00:00.000Z");

function stateWith(commitments: Record<string, unknown>[]) {
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
      maxAwakeHours: 16
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
        externalDeadlineAt: new Date(now.getTime() + 3 * 24 * 60 * 60_000).toISOString()
      }
    ],
    actions: [
      {
        id: "action-1",
        projectId: "project-1",
        title: "Lab 7",
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
        setupMinutes: 0
      }
    ],
    commitmentRecurrenceRules: [
      {
        id: "standing-work",
        title: "Standing work block",
        timezone: "UTC",
        startDate: "2026-08-01",
        repeat: { unit: "days", intervalDays: 1 },
        localStartTime: "14:00",
        localEndTime: "15:00",
        setupBeforeMinutes: 10,
        transitionAfterMinutes: 5,
        status: "active"
      }
    ],
    commitments,
    routineSteps: [],
    routinePresets: [],
    occurrences: [],
    sleepPlans: [],
    captures: [],
    completedToday: [],
    assertedConditions: ["home"],
    currentEnergy: "medium",
    horizonEnd: new Date(now.getTime() + 3 * 24 * 60 * 60_000).toISOString(),
    activeSession: null,
    conditionDefinitions: [{ id: "home", name: "Home", kind: "location", status: "active" }],
    currentSituation: { locationId: "home", transportModes: ["car"] }
  });
}

function request(state: ReturnType<typeof stateWith>) {
  return planForecastRequestSchema.parse({
    contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
    requestId: "00000000-0000-4000-8000-0000000f1005",
    inputVersion: "protected-commitments-once",
    calculatedAt: now.toISOString(),
    horizonEnd: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
    state
  });
}

const commitment = {
  id: "dentist",
  title: "Dentist",
  status: "confirmed",
  startsAt: "2026-08-11T08:00:00.000Z",
  endsAt: "2026-08-11T09:00:00.000Z",
  setupBeforeMinutes: 0,
  transitionAfterMinutes: 0
};

describe("protected commitments are built once per calculation (F1-05)", () => {
  it("reads each confirmed commitment's fields for one build, not five", () => {
    let reads = 0;
    const counted = new Proxy(commitment, {
      get(target, key, receiver) {
        if (key === "preferredLocationId") reads += 1;
        return Reflect.get(target, key, receiver);
      }
    });
    const req = request(stateWith([counted]));
    // The schema parse copies the object, so wrap the parsed commitment itself.
    const parsed = req.state.commitments[0] as Record<string, unknown>;
    req.state.commitments[0] = new Proxy(parsed, {
      get(target, key, receiver) {
        if (key === "preferredLocationId") reads += 1;
        return Reflect.get(target, key, receiver);
      }
    }) as never;
    reads = 0;
    calculatePlanAndForecast(req);
    expect(reads).toBe(1);
  });

  it("leaves the calculation result byte-identical to the pre-memoisation engine", () => {
    const json = JSON.stringify(calculatePlanAndForecast(request(stateWith([commitment]))));
    expect(fingerprint(json)).toBe("2c038b2e:41593");
  });
});
