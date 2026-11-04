import { describe, expect, it } from "vitest";
import { PLAN_FORECAST_CONTRACT_VERSION, planForecastRequestSchema, portalStateSchema } from "@openrhen/contracts";
import { calculatePlanAndForecast } from "../../src/index.js";

/**
 * The projected day: `simulateDayPlan` re-runs `selectCurrentDirective` at every step, so
 * a late commitment's precedence must carry over, with block 0 still equal to the live directive.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const now = new Date("2026-08-19T00:00:00.000Z");
const iso = (offsetMs: number) => new Date(now.getTime() + offsetMs).toISOString();

describe("day plan: a late commitment follows the new precedence", () => {
  it("block 0 is the live directive, naming the overdue prerequisite rather than sleep or recovery", () => {
    // Ten minutes into a located commitment, still at home, with one before-phase step whose own
    // scheduled window has already elapsed. `simulateDayPlan` re-runs
    // `selectCurrentDirective` at every step (day-plan.ts), so the precedence fix carries over
    // automatically: block 0 must still name the overdue prerequisite, and must still match whatever
    // the live directive itself reports.
    const commitments = [
      {
        id: "college-class",
        title: "College Class",
        status: "confirmed" as const,
        startsAt: iso(-10 * MINUTE),
        endsAt: iso(3 * HOUR),
        locationId: "college",
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0
      }
    ];
    const request = planForecastRequestSchema.parse({
      contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
      requestId: "00000000-0000-4000-8000-00000000da72",
      inputVersion: "late-precedence-day-plan-fixture",
      calculatedAt: now.toISOString(),
      horizonEnd: iso(30 * DAY),
      state: portalStateSchema.parse({
        settings: {
          timezone: "Australia/Sydney",
          planningHorizonEnd: "20:00",
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
          maxAwakeHours: 16
        },
        areas: [{ id: "area", name: "Everything", status: "active", sortOrder: 0 }],
        outcomes: [
          { id: "outcome", areaId: "area", title: "Outcome", definitionOfDone: "Done.", value: 3, status: "active" }
        ],
        projects: [],
        actions: [],
        commitments,
        routineSteps: [
          {
            id: "pack",
            commitmentId: "college-class",
            title: "Pack Bag",
            durationMinutes: 10,
            sequence: 0,
            timingRule: "flexible" as const,
            energy: "medium" as const,
            contexts: [],
            dependencyIds: [],
            phase: "before" as const,
            status: "pending" as const,
            scheduledStartAt: iso(-30 * MINUTE),
            scheduledEndAt: iso(-15 * MINUTE)
          }
        ],
        sleepPlans: [],
        captures: [],
        completedToday: [],
        assertedConditions: ["home"],
        currentEnergy: "medium",
        horizonEnd: iso(30 * DAY),
        activeSession: null,
        conditionDefinitions: [
          { id: "home", name: "Home", kind: "location", status: "active" },
          { id: "college", name: "College", kind: "location", status: "active", travelMinutes: 8 }
        ],
        currentSituation: {
          locationId: "home",
          locationSetAt: now.toISOString(),
          overrides: {},
          carrying: {},
          transportModes: ["car"],
          travel: {}
        }
      })
    });
    const response = calculatePlanAndForecast(request);
    const recommendation = response.recommendation as unknown as { protectedCommitment?: { late?: boolean } };
    expect(recommendation.protectedCommitment?.late).toBe(true);
    expect(response.currentDirective).toMatchObject({ kind: "routine_step", targetId: "pack" });
    const plan = response.dayPlan!;
    const first = plan.blocks[0]!;
    // The invariant the whole describe block above holds everywhere else: block 0 is the live
    // directive.
    expect(first.kind).toBe("routine_step");
    expect(first.targetId).toBe("pack");
    expect(first.startsAt).toBe(response.calculatedAt);
  });
});
