import { describe, expect, it } from "vitest";
import { PLAN_FORECAST_CONTRACT_VERSION, planForecastRequestSchema, portalStateSchema } from "@openrhen/contracts";
import { calculatePlanAndForecast } from "../../src/index.js";

/**
 * A `live` context end to end: `study`'s requirement is satisfied by either pathway — being
 * physically at College, or the class actually being live (joinable by zoom from anywhere) — and only
 * the second one depends on the clock. The class is a confirmed commitment with `presence: "anchor"`,
 * so its own window still reopens for other work the moment nothing is recorded engaging it (§ the
 * same mechanism `commitment-presence.test.ts` exercises), which is what lets "study" actually be
 * offered while the class is running rather than the whole hour locking out.
 */
const now = new Date("2026-08-14T04:00:00.000Z");
const HOUR = 3_600_000;
const CLASS_STARTS_AT = now;
const CLASS_ENDS_AT = new Date(now.getTime() + 2 * HOUR);
const iso = (date: Date) => date.toISOString();

function request(at: Date, locationId: string) {
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
      conditionCatalog: ["home", "college"],
      preferredBedtime: "23:00",
      preferredWakeTime: "07:00",
      desiredSleepMinutes: 480,
      minimumSleepMinutes: 420,
      maxAwakeHours: 16,
      homeLocationId: "home"
    },
    areas: [{ id: "area-1", name: "Study", status: "active", sortOrder: 0 }],
    outcomes: [
      {
        id: "outcome-1",
        areaId: "area-1",
        title: "Finish the cert",
        definitionOfDone: "Passed",
        value: 3,
        status: "active"
      }
    ],
    projects: [
      {
        id: "project-1",
        title: "Cert IV",
        area: "area-1",
        outcomeId: "outcome-1",
        status: "active",
        uncertainty: "known",
        value: 3,
        consequence: 3
      }
    ],
    actions: [
      {
        id: "study",
        projectId: "project-1",
        title: "Attend the College class",
        status: "active",
        optimisticMinutes: 20,
        expectedMinutes: 30,
        remainingMinutes: 30,
        pessimisticMinutes: 45,
        energy: "medium",
        minimumSessionMinutes: 15,
        maximumSessionMinutes: 45,
        importance: 3,
        consequence: 3,
        contexts: [],
        requirementPathways: [
          { id: "in-person", contextIds: ["college"] },
          { id: "via-zoom", contextIds: ["ctx-zoom"] }
        ],
        dependencyIds: [],
        splittable: true,
        setupMinutes: 0
      }
    ],
    // A one-off row rather than a recurring occurrence: `protectedCommitments()` (engine.ts) only
    // ever reads a *recurring* commitment back from a freshly regenerated occurrence, never from its
    // own materialised `state.commitments` row (that row exists only to carry a per-occurrence
    // override) — so a fixture wanting a specific, easy-to-place window uses a plain one-off and
    // matches it by `commitmentId`, exercising exactly the same `context-match.ts` code path a
    // recurring `recurrenceRuleId` match would.
    commitments: [
      {
        id: "class-occ-1",
        title: "College class",
        status: "confirmed",
        startsAt: iso(CLASS_STARTS_AT),
        endsAt: iso(CLASS_ENDS_AT),
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0,
        // Anchor, not blocking: the class occupies the schedule like any commitment, but its own
        // live window reopens for other work the instant nothing is recorded engaging it — otherwise
        // "study" could never be offered *during* the class, only ever before or after it.
        presence: "anchor"
      },
      // Automatic capacity spans the whole local day; these reproduce the old manual window above
      // (now-6h to now+9h) by blocking its complement across the planning horizon — local midnight up
      // to the window's start, and the window's end well past every horizon these tests request.
      {
        id: "before-window",
        title: "Blocked (before window)",
        status: "confirmed",
        startsAt: iso(new Date(now.getTime() - 14 * HOUR)),
        endsAt: iso(new Date(now.getTime() - 6 * HOUR)),
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0
      },
      {
        id: "after-window",
        title: "Blocked (after window)",
        status: "confirmed",
        startsAt: iso(new Date(now.getTime() + 9 * HOUR)),
        endsAt: iso(new Date(now.getTime() + 20 * 24 * HOUR)),
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0
      }
    ],
    routineSteps: [],
    routinePresets: [],
    occurrences: [],
    sleepPlans: [],
    captures: [],
    completedToday: [],
    assertedConditions: ["home"],
    currentEnergy: "medium",
    horizonEnd: iso(new Date(now.getTime() + 14 * 24 * HOUR)),
    activeSession: null,
    conditionDefinitions: [
      { id: "home", name: "Home", kind: "location", status: "active" },
      { id: "college", name: "College campus", kind: "location", status: "active" },
      { id: "ctx-zoom", name: "College class (zoom)", kind: "live", status: "active", commitmentId: "class-occ-1" }
    ],
    currentSituation: {
      locationId,
      locationSetAt: at.toISOString(),
      overrides: {},
      carrying: {},
      transportModes: ["car"],
      travel: {}
    }
  });
  return planForecastRequestSchema.parse({
    contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
    requestId: "00000000-0000-4000-8000-0000000000c1",
    inputVersion: "commitment-context-fixture",
    calculatedAt: at.toISOString(),
    horizonEnd: iso(new Date(at.getTime() + 14 * 24 * HOUR)),
    state
  });
}

function primaryActionId(at: Date, locationId: string): string | null {
  const response = calculatePlanAndForecast(request(at, locationId));
  return (
    (response.recommendation as unknown as { primary: { action: { id: string } } | null }).primary?.action.id ?? null
  );
}

describe("a live context gates on the live class, not merely on being enrolled in it", () => {
  it("is unavailable at home before the class has started", () => {
    expect(primaryActionId(new Date(CLASS_STARTS_AT.getTime() - 4 * HOUR), "home")).not.toBe("study");
  });

  it("is unavailable at home after the class has ended", () => {
    expect(primaryActionId(new Date(CLASS_ENDS_AT.getTime() + 4 * HOUR), "home")).not.toBe("study");
  });

  it("is available at home while the class is actually live", () => {
    expect(primaryActionId(new Date(CLASS_STARTS_AT.getTime() + HOUR), "home")).toBe("study");
  });

  it("is available at College whether or not the class is currently live", () => {
    expect(primaryActionId(new Date(CLASS_STARTS_AT.getTime() + HOUR), "college")).toBe("study");
    expect(primaryActionId(new Date(CLASS_ENDS_AT.getTime() + 4 * HOUR), "college")).toBe("study");
  });
});
