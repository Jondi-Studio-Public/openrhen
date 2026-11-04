import { describe, expect, it } from "vitest";
import { PLAN_FORECAST_CONTRACT_VERSION, planForecastRequestSchema, portalStateSchema } from "@openrhen/contracts";
import { calculatePlanAndForecast } from "../../src/index.js";

/**
 * The day plan surfaces design note invariant 6: the leave-by marker Today draws from
 * `commitmentTimelines[].leaveBy`/`journeyBefore` must equal what Now's travel panel draws from the
 * same-moment `currentDirective` (a `TravelDirective`). Today and Now read different engine outputs
 * for the same commitment (`portal/features/today/day-plan.ts` vs
 * `portal/features/now/components/travel-panel.tsx`); this test proves those two outputs never
 * disagree, on one real `calculatePlanAndForecast` response.
 *
 * The portal-side echo of these same fields (each surface renders them unchanged) is covered by
 * `portal/features/today/leave-by-parity.test.tsx`, which cannot run the engine itself (the portal
 * package does not depend on `@openrhen/engine-core`).
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const now = new Date("2026-08-19T00:00:00.000Z");
const iso = (offsetMs: number) => new Date(now.getTime() + offsetMs).toISOString();

/** No samples at all: the journey store's padding on top of a stored figure, rounded up. */
const padded = (minutes: number) => Math.ceil(minutes + Math.max(3, 0.15 * minutes));

const TRAVEL_MINUTES_TO_OFFICE = 30;
// The commitment starts an hour from the fixture's epoch; the leave-by marker for it sits
// `padded(30)` minutes earlier. Choosing `calculatedAt` one minute after that leave-by moment puts
// "now" inside the travel window, so the engine's `currentDirective` is the trip itself.
const LEAVE_BY_OFFSET_MS = 60 * MINUTE - padded(TRAVEL_MINUTES_TO_OFFICE) * MINUTE;
const CALCULATED_AT = iso(LEAVE_BY_OFFSET_MS + MINUTE);

function request() {
  const state = portalStateSchema.parse({
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
      conditionCatalog: ["home", "office"],
      preferredBedtime: "23:00",
      preferredWakeTime: "07:00",
      desiredSleepMinutes: 480,
      minimumSleepMinutes: 420,
      maxAwakeHours: 16,
      lastWokeAt: iso(-1 * HOUR),
      homeLocationId: "home"
    },
    areas: [],
    outcomes: [],
    projects: [],
    actions: [],
    commitments: [
      {
        id: "meeting",
        title: "Meeting",
        status: "confirmed" as const,
        startsAt: iso(60 * MINUTE),
        endsAt: iso(90 * MINUTE),
        locationId: "office",
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0
      }
    ],
    routineSteps: [],
    routinePresets: [],
    conditionDefinitions: [
      { id: "home", name: "Home", kind: "location", status: "active" },
      { id: "office", name: "Office", kind: "location", status: "active", travelMinutes: TRAVEL_MINUTES_TO_OFFICE }
    ],
    currentSituation: {
      locationId: "home",
      locationSetAt: iso(-1 * HOUR),
      transportModes: ["car"]
    },
    occurrences: [],
    sleepPlans: [],
    captures: [],
    completedToday: [],
    assertedConditions: [],
    currentEnergy: "medium",
    horizonEnd: iso(3 * DAY),
    activeSession: null
  });
  return planForecastRequestSchema.parse({
    contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
    requestId: "00000000-0000-4000-8000-0000000000e1",
    inputVersion: "leave-by-parity-fixture",
    calculatedAt: CALCULATED_AT,
    horizonEnd: iso(3 * DAY),
    state,
    journeys: { cells: [], latest: [] }
  });
}

describe("leave-by marker vs Now's travel panel (invariant 6)", () => {
  it("reads the same leaveBy and minute figures from commitmentTimelines and from currentDirective", () => {
    const response = calculatePlanAndForecast(request());

    const timeline = (
      response.derivedState.commitmentTimelines as Array<{
        id: string;
        leaveBy?: string;
        journeyBefore?: { typicalMinutes: number; minutes: number };
      }>
    ).find((entry) => entry.id === "meeting")!;
    expect(timeline).toBeDefined();
    expect(timeline.leaveBy).toBeDefined();
    expect(timeline.journeyBefore).toBeDefined();

    const directive = response.currentDirective as {
      kind: "travel";
      toLocationId: string;
      leaveBy?: string;
      typicalMinutes?: number;
      recommendedMinutes: number;
    } | null;
    expect(directive).not.toBeNull();
    expect(directive!.kind).toBe("travel");
    expect(directive!.toLocationId).toBe("office");

    // The three facts Today's leave-by marker and Now's travel panel each show for this commitment.
    expect(timeline.leaveBy).toBe(directive!.leaveBy);
    expect(timeline.journeyBefore!.typicalMinutes).toBe(directive!.typicalMinutes);
    expect(timeline.journeyBefore!.minutes).toBe(directive!.recommendedMinutes);

    // Sanity: this is the padded (allowing), not the bare typical, figure — the same distinction
    // `travel-time-model.test.ts` exercises for `commitmentTimelines` alone.
    expect(timeline.journeyBefore!.minutes).toBe(padded(TRAVEL_MINUTES_TO_OFFICE));
    expect(timeline.journeyBefore!.typicalMinutes).toBe(TRAVEL_MINUTES_TO_OFFICE);
  });
});
