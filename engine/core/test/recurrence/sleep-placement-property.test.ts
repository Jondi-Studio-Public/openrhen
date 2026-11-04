import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { planSleep, type FixedCommitment, type SleepPreferences } from "../../src/index.js";

/**
 * The sleep placement design note "Property": every invariant listed under
 * "Invariants" must hold for any input `planSleep` can be given, not only the hand-picked cases in
 * `sleep.test.ts`. Fixed seed so a failure reproduces exactly, matching `test/system/properties.test.ts`'s
 * own convention.
 */

const SEED = 20_260_926;
// 120 runs per property: each run plans a week of nights, and at 300 the slowest property (two
// planSleep calls a run) took ~6s locally and timed out on a loaded CI runner. The seed is fixed, so
// the same 120 scenarios run every time and a failure still reproduces exactly.
const assertion = { numRuns: 120, seed: SEED } as const;

const now = new Date("2026-09-01T00:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function clock(minutesOfDay: number): string {
  const wrapped = ((minutesOfDay % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

interface Scenario {
  preferences: SleepPreferences;
  lastWokeAt: Date;
  commitments: FixedCommitment[];
}

/**
 * A gap before this commitment (possibly negative for the very first one only, so it can already be
 * under way) and its length. `toCommitments` turns a list of these into a real, sequential,
 * non-overlapping schedule — two commitments overlapping each other is a double-booked calendar,
 * which is data planSleep is never asked to reconcile; only real, disjoint protected ranges are its
 * own "never overlaps a protected range" invariant's concern.
 */
const commitmentShape = fc.record({
  gapMinutes: fc.integer({ min: 0, max: 400 }),
  lengthMinutes: fc.integer({ min: 15, max: 180 })
});

function toCommitments(shapes: { gapMinutes: number; lengthMinutes: number }[]): FixedCommitment[] {
  let cursor = -180 * MINUTE;
  return shapes.map((shape, index) => {
    const startOffset = cursor + shape.gapMinutes * MINUTE;
    const endOffset = startOffset + shape.lengthMinutes * MINUTE;
    cursor = endOffset;
    return {
      id: `commitment-${index}`,
      startsAt: new Date(now.getTime() + startOffset),
      endsAt: new Date(now.getTime() + endOffset),
      setupBeforeMinutes: 0,
      transitionAfterMinutes: 0
    };
  });
}

/**
 * Bedtime and wake are generated so the anchor span exactly equals the desired length (compromise
 * offset zero) — the property below is about placement and the invariants list, not about the
 * anchor-centering arithmetic `sleep.test.ts`'s unit cases already pin down directly.
 */
const generalScenarios = fc
  .record({
    preferredBedtimeMinutes: fc.integer({ min: 0, max: 1439 }),
    desiredHours: fc.integer({ min: 5, max: 10 }),
    minimumSlackMinutes: fc.integer({ min: 0, max: 90 }),
    maxAwakeHours: fc.integer({ min: 14, max: 22 }),
    bedtimeDeviationMinutes: fc.integer({ min: 0, max: 240 }),
    awakeSinceHours: fc.integer({ min: 0, max: 26 }),
    commitments: fc.array(commitmentShape, { maxLength: 4 })
  })
  .map((shape): Scenario => {
    const desiredSleepMinutes = shape.desiredHours * 60;
    const minimumSleepMinutes = Math.max(60, desiredSleepMinutes - shape.minimumSlackMinutes);
    const wakeMinutes = shape.preferredBedtimeMinutes + desiredSleepMinutes;
    const preferences: SleepPreferences = {
      preferredBedtime: clock(shape.preferredBedtimeMinutes),
      preferredWakeTime: clock(wakeMinutes),
      desiredSleepMinutes,
      minimumSleepMinutes,
      maxAwakeHours: shape.maxAwakeHours,
      bedtimeDeviationMinutes: shape.bedtimeDeviationMinutes,
      arrivalMarginMinutes: 2
    };
    return {
      preferences,
      lastWokeAt: new Date(now.getTime() - shape.awakeSinceHours * HOUR),
      commitments: toCommitments(shape.commitments)
    };
  });

describe("sleep placement properties", () => {
  it("never starts night 0 before now, never overlaps the previous night, and wakes after it starts", () => {
    fc.assert(
      fc.property(generalScenarios, ({ preferences, lastWokeAt, commitments }) => {
        const plans = planSleep({ now, timezone: "UTC", lastWokeAt, preferences, commitments });
        expect(plans.length).toBeGreaterThan(0);
        expect(plans[0]!.plannedStartAt.getTime()).toBeGreaterThanOrEqual(now.getTime());
        let previousWake = lastWokeAt;
        for (const plan of plans) {
          // Finding 9: nights never overlap — each starts no earlier than the previous night's wake.
          expect(plan.plannedStartAt.getTime()).toBeGreaterThanOrEqual(previousWake.getTime());
          // Wake always comes after start.
          expect(plan.plannedWakeAt.getTime()).toBeGreaterThan(plan.plannedStartAt.getTime());
          previousWake = plan.plannedWakeAt;
        }
      }),
      assertion
    );
  });

  it("never explains a start before now except as a missed start (finding 7)", () => {
    fc.assert(
      fc.property(generalScenarios, ({ preferences, lastWokeAt, commitments }) => {
        const plans = planSleep({ now, timezone: "UTC", lastWokeAt, preferences, commitments });
        for (const plan of plans) {
          if (plan.plannedStartAt.getTime() < now.getTime()) {
            expect(plan.replannedFromMissedStart).toBe(true);
          }
        }
      }),
      assertion
    );
  });

  it("keeps every night's id stable and distinct within one run", () => {
    fc.assert(
      fc.property(generalScenarios, ({ preferences, lastWokeAt, commitments }) => {
        const plans = planSleep({ now, timezone: "UTC", lastWokeAt, preferences, commitments });
        const ids = plans.map((plan) => plan.id);
        expect(new Set(ids).size).toBe(ids.length);
        // A second, identical call is a pure function of the same inputs: same ids, in the same order.
        const again = planSleep({ now, timezone: "UTC", lastWokeAt, preferences, commitments });
        expect(again.map((plan) => plan.id)).toEqual(ids);
      }),
      assertion
    );
  });

  // No upper bound at `desiredSleepMinutes`: the lapse mechanism (`replannedNowFromLapse`) can
  // legitimately compute a night's length as `targetWake - now`, which "more sleep's always better"
  // explicitly allows to exceed the desired length.
  // Only non-negativity and start/end/duration consistency are true for every reachable plan.
  it("keeps sleep length non-negative and consistent with its own start and wake", () => {
    fc.assert(
      fc.property(generalScenarios, ({ preferences, lastWokeAt, commitments }) => {
        const plans = planSleep({ now, timezone: "UTC", lastWokeAt, preferences, commitments });
        for (const plan of plans) {
          expect(plan.allowedMinutes).toBeGreaterThanOrEqual(0);
          const duration = Math.floor((plan.plannedWakeAt.getTime() - plan.plannedStartAt.getTime()) / MINUTE);
          expect(plan.allowedMinutes).toBe(duration);
        }
      }),
      assertion
    );
  });

  // With no stored answer ever supplied (the property generator's `answers` closure is left at its
  // default, always-undefined), `placementChoice: "early"` never happens, so the "unless the user
  // chose early" exception in the invariant ("A night that starts more than the bedtime deviation
  // before the preferred bedtime always carries its deviation warning, unless the user chose early")
  // never applies — every reachable branch that places a night at its early option (unanswered, or a
  // lapse that still gives more sleep than the near night) sets `warn: true`; only falling all the way
  // to the near night (an explicit `near` choice, or a lapsed early night that no longer beats it)
  // clears it.
  it("carries the deviation warning whenever a night is not placed at the near option (the warn invariant)", () => {
    fc.assert(
      fc.property(generalScenarios, ({ preferences, lastWokeAt, commitments }) => {
        const plans = planSleep({ now, timezone: "UTC", lastWokeAt, preferences, commitments });
        for (const plan of plans) {
          if (!plan.deviationOptions) continue;
          const placedAtNear = plan.plannedStartAt.getTime() === plan.deviationOptions.near.startsAt.getTime();
          expect(plan.deviationOptions.warn || placedAtNear).toBe(true);
        }
      }),
      assertion
    );
  });
});

/**
 * Finding 8: the bedtime routine (and the sleep itself) must never overlap a protected range. Kept
 * separate from the general property above, and away from a passed awake limit, so a genuine
 * routine/protected-range collision isn't masked by the missed-start/"sleep is a wall" safety net,
 * which is allowed to start a night immediately regardless of the routine (there is no earlier slot
 * left to protect a routine window inside).
 */
const routineAwareScenarios = fc
  .record({
    preferredBedtimeMinutes: fc.integer({ min: 0, max: 1439 }),
    desiredHours: fc.integer({ min: 5, max: 9 }),
    bedtimeRoutineMinutes: fc.integer({ min: 0, max: 60 }),
    commitments: fc.array(commitmentShape, { minLength: 1, maxLength: 3 })
  })
  .map((shape) => {
    const desiredSleepMinutes = shape.desiredHours * 60;
    const wakeMinutes = shape.preferredBedtimeMinutes + desiredSleepMinutes;
    const preferences: SleepPreferences = {
      preferredBedtime: clock(shape.preferredBedtimeMinutes),
      preferredWakeTime: clock(wakeMinutes),
      desiredSleepMinutes,
      minimumSleepMinutes: Math.max(60, desiredSleepMinutes - 60),
      // A generous awake limit and a wake far enough from `now` (`lastWokeAt` fixed at `now`) keeps
      // every generated night comfortably clear of the missed-start/stillStale safety net, so only
      // ordinary candidate placement is exercised here.
      maxAwakeHours: 22,
      bedtimeDeviationMinutes: 720,
      arrivalMarginMinutes: 2
    };
    return {
      preferences,
      bedtimeRoutineMinutes: shape.bedtimeRoutineMinutes,
      commitments: toCommitments(shape.commitments)
    };
  });

describe("sleep placement properties: routine awareness", () => {
  it("never lets the bedtime routine or the sleep itself overlap a protected range", () => {
    fc.assert(
      fc.property(routineAwareScenarios, ({ preferences, bedtimeRoutineMinutes, commitments }) => {
        const plans = planSleep({
          now,
          timezone: "UTC",
          lastWokeAt: now,
          preferences,
          commitments,
          bedtimeRoutineMinutes
        });
        for (const plan of plans) {
          if (plan.replannedFromMissedStart) continue;
          const routineStart = new Date(plan.plannedStartAt.getTime() - bedtimeRoutineMinutes * MINUTE);
          for (const commitment of commitments) {
            const overlapsRoutineOrSleep =
              commitment.startsAt.getTime() < plan.plannedStartAt.getTime() &&
              commitment.endsAt.getTime() > routineStart.getTime();
            expect(overlapsRoutineOrSleep).toBe(false);
          }
        }
      }),
      assertion
    );
  });
});
