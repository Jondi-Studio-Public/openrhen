import { describe, expect, it } from "vitest";
import { assertFixture, type Fixture } from "./assert-fixture.js";

/**
 * Regression cases for the engine's planning rules. Each is a synthetic reduction of a real reported
 * moment: the records the rule needs, with invented names and relocated coordinates, so the
 * public repository carries the rule and none of the day it came from. Make one with
 * `scripts/snapshots/synthesise.mjs` from a private capture (`scripts/snapshots/replay.mjs --promote`
 * writes those to `private/`, replayed by `private/private-replay.test.ts`).
 *
 * The engine is deterministic for a request, which carries its own `calculatedAt`, so these run
 * without a clock, a service, or a database. Fixtures are listed explicitly and imported as JSON so
 * this package keeps no filesystem dependency, matching `engine/core/test/replay/replay.test.ts`.
 * Add new files here.
 */
import replannedSleepStaysDirectable from "./synthetic/replanned-sleep-stays-directable.json" with { type: "json" };
import bedtimeRoutineSurvivesMidnightRollover from "./synthetic/bedtime-routine-survives-midnight-rollover.json" with { type: "json" };
import completedOverriddenSleepPlanStopsBlockingCapacity from "./synthetic/completed-overridden-sleep-plan-stops-blocking-capacity.json" with { type: "json" };
import overdueExternalOutranksUnknownForecast from "./synthetic/overdue-external-outranks-unknown-forecast.json" with { type: "json" };
import routineStepDirectiveHonorsUnmetPrerequisite from "./synthetic/routine-step-directive-honors-unmet-prerequisite.json" with { type: "json" };
import wakeOnlyCompletedSleepMustNotPinBedtime from "./synthetic/wake-only-completed-sleep-must-not-pin-bedtime.json" with { type: "json" };
import wakeEarlyPrepUniformThenSleep from "./synthetic/wake-early-prep-uniform-then-sleep.json" with { type: "json" };
import runningLateDirectsPackBag from "./synthetic/running-late-directs-pack-bag.json" with { type: "json" };
import arrivedPackBagNoLongerDirected from "./synthetic/arrived-pack-bag-no-longer-directed.json" with { type: "json" };
import cancelledRecurringCommitmentStillProtectsSleep from "./synthetic/cancelled-recurring-commitment-still-protects-sleep.json" with { type: "json" };
import behindPrepPaceForACommitment from "./synthetic/behind-prep-pace-for-a-commitment.json" with { type: "json" };
import afterWorkStepsFollowOvertimeFinish from "./synthetic/after-work-steps-follow-overtime-finish.json" with { type: "json" };
import sleepWalksBackBeforeARoutineChain from "./synthetic/sleep-walks-back-before-a-routine-chain.json" with { type: "json" };
import pendingReadyCheckOutrankedByTravel from "./synthetic/pending-ready-check-outranked-by-travel.json" with { type: "json" };

const fixtureFiles: Array<[string, unknown]> = [
  ["replanned-sleep-stays-directable.json", replannedSleepStaysDirectable],
  ["bedtime-routine-survives-midnight-rollover.json", bedtimeRoutineSurvivesMidnightRollover],
  ["completed-overridden-sleep-plan-stops-blocking-capacity.json", completedOverriddenSleepPlanStopsBlockingCapacity],
  ["overdue-external-outranks-unknown-forecast.json", overdueExternalOutranksUnknownForecast],
  ["routine-step-directive-honors-unmet-prerequisite.json", routineStepDirectiveHonorsUnmetPrerequisite],
  ["wake-only-completed-sleep-must-not-pin-bedtime.json", wakeOnlyCompletedSleepMustNotPinBedtime],
  ["wake-early-prep-uniform-then-sleep.json", wakeEarlyPrepUniformThenSleep],
  ["running-late-directs-pack-bag.json", runningLateDirectsPackBag],
  ["arrived-pack-bag-no-longer-directed.json", arrivedPackBagNoLongerDirected],
  ["cancelled-recurring-commitment-still-protects-sleep.json", cancelledRecurringCommitmentStillProtectsSleep],
  ["behind-prep-pace-for-a-commitment.json", behindPrepPaceForACommitment],
  ["after-work-steps-follow-overtime-finish.json", afterWorkStepsFollowOvertimeFinish],
  ["sleep-walks-back-before-a-routine-chain.json", sleepWalksBackBeforeARoutineChain],
  ["pending-ready-check-outranked-by-travel.json", pendingReadyCheckOutrankedByTravel]
];

describe("synthetic snapshot replay", () => {
  it("keeps every synthetic fixture loadable", () => {
    for (const [file, fixture] of fixtureFiles) {
      expect((fixture as Fixture).request, `${file} has no request`).toBeTruthy();
    }
  });

  for (const [file, raw] of fixtureFiles) {
    const fixture = raw as Fixture;
    it(`${file}: ${fixture.name}`, () => {
      assertFixture(file, fixture);
    });
  }
});
