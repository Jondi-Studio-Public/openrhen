import { describe, expect, it } from "vitest";
import {
  earliestRoutineWindowStart,
  earliestRoutineWindowStarts,
  routineStepMootness
} from "../../src/recommendation/routine-step-mootness.js";

/**
 * Findings 19/20/42: the one arrival-mootness predicate now shared (in spirit — see the module's own
 * comment on why literal sharing across package boundaries is impossible here) by the read-time
 * directive check, the write-time arrival skip, and the periodic sweep. The read-time check's old
 * defect — no time bound at all — is what finding 20 named: a before-phase step of a home-located
 * commitment reads as moot the instant the person is home, which is most of the day, so it is never
 * directed at all.
 */

const MIN = 60_000;
const now = new Date("2026-09-02T09:00:00.000Z");
const at = (offsetMinutes: number) => new Date(now.getTime() + offsetMinutes * MIN);

const baseCommitment = { locationId: "home", endsAt: at(9 * 60) }; // 18:00, i.e. 9 hours from "now"
const routineWindowStart = at(8.5 * 60); // 17:30
const freshHomeLocation = { locationId: "home", locationSetAt: now };

describe("routineStepMootness", () => {
  it("is not moot before the routine's own preparation window opens, even at the matching location (finding 20)", () => {
    // The exact home-located-commitment case: at home at 09:00, the commitment is at 18:00, and its
    // own routine block does not start until 17:30. Nothing about being home right now should retire
    // its prep steps before that block has even opened.
    const result = routineStepMootness({
      step: { phase: "before" },
      commitment: baseCommitment,
      routineWindowStart,
      currentLocation: freshHomeLocation,
      now,
      staleAfterMinutes: 480
    });
    expect(result).toEqual({ moot: false });
  });

  it("is moot once the routine window has opened and the location matches", () => {
    const result = routineStepMootness({
      step: { phase: "before" },
      commitment: baseCommitment,
      routineWindowStart,
      currentLocation: { locationId: "home", locationSetAt: at(8.5 * 60) },
      now: at(8.75 * 60), // 17:45, inside [17:30, 18:00)
      staleAfterMinutes: 480
    });
    expect(result).toEqual({ moot: true, reason: "already_at_location" });
  });

  it("is not moot once the commitment has ended, even at the matching location and past the window start", () => {
    const result = routineStepMootness({
      step: { phase: "before" },
      commitment: baseCommitment,
      routineWindowStart,
      currentLocation: { locationId: "home", locationSetAt: at(9 * 60 + 5) },
      now: at(9 * 60 + 5), // 18:05, one minute after the commitment ends
      staleAfterMinutes: 480
    });
    expect(result).toEqual({ moot: false });
  });

  it("is not moot at the exact instant the commitment ends (the upper bound is exclusive)", () => {
    const result = routineStepMootness({
      step: { phase: "before" },
      commitment: baseCommitment,
      routineWindowStart,
      currentLocation: { locationId: "home", locationSetAt: at(9 * 60) },
      now: baseCommitment.endsAt,
      staleAfterMinutes: 480
    });
    expect(result).toEqual({ moot: false });
  });

  it("is moot at the exact instant the routine window opens (the lower bound is inclusive)", () => {
    const result = routineStepMootness({
      step: { phase: "before" },
      commitment: baseCommitment,
      routineWindowStart,
      currentLocation: { locationId: "home", locationSetAt: routineWindowStart },
      now: routineWindowStart,
      staleAfterMinutes: 480
    });
    expect(result).toEqual({ moot: true, reason: "already_at_location" });
  });

  it("never applies to an after-phase step", () => {
    const result = routineStepMootness({
      step: { phase: "after" },
      commitment: baseCommitment,
      routineWindowStart,
      currentLocation: { locationId: "home", locationSetAt: at(8.75 * 60) },
      now: at(8.75 * 60),
      staleAfterMinutes: 480
    });
    expect(result).toEqual({ moot: false });
  });

  it("is not moot when the commitment has no fixed location", () => {
    const result = routineStepMootness({
      step: { phase: "before" },
      commitment: { locationId: null, endsAt: at(9 * 60) },
      routineWindowStart,
      currentLocation: { locationId: "home", locationSetAt: at(8.75 * 60) },
      now: at(8.75 * 60),
      staleAfterMinutes: 480
    });
    expect(result).toEqual({ moot: false });
  });

  it("is not moot when there is no current location assertion", () => {
    const result = routineStepMootness({
      step: { phase: "before" },
      commitment: baseCommitment,
      routineWindowStart,
      currentLocation: null,
      now: at(8.75 * 60),
      staleAfterMinutes: 480
    });
    expect(result).toEqual({ moot: false });
  });

  it("is not moot when the asserted location does not match the commitment's own place", () => {
    const result = routineStepMootness({
      step: { phase: "before" },
      commitment: baseCommitment,
      routineWindowStart,
      currentLocation: { locationId: "office", locationSetAt: at(8.75 * 60) },
      now: at(8.75 * 60),
      staleAfterMinutes: 480
    });
    expect(result).toEqual({ moot: false });
  });

  it("is not moot when the location assertion is missing its timestamp — matching the sweep's own strictness", () => {
    const result = routineStepMootness({
      step: { phase: "before" },
      commitment: baseCommitment,
      routineWindowStart,
      currentLocation: { locationId: "home", locationSetAt: undefined },
      now: at(8.75 * 60),
      staleAfterMinutes: 480
    });
    expect(result).toEqual({ moot: false });
  });

  it("is not moot when the location assertion's timestamp is unparseable", () => {
    const result = routineStepMootness({
      step: { phase: "before" },
      commitment: baseCommitment,
      routineWindowStart,
      currentLocation: { locationId: "home", locationSetAt: "not-a-date" },
      now: at(8.75 * 60),
      staleAfterMinutes: 480
    });
    expect(result).toEqual({ moot: false });
  });

  it("is not moot once the assertion has aged past staleAfterMinutes", () => {
    const result = routineStepMootness({
      step: { phase: "before" },
      commitment: baseCommitment,
      routineWindowStart,
      currentLocation: { locationId: "home", locationSetAt: at(8.75 * 60 - 481) },
      now: at(8.75 * 60),
      staleAfterMinutes: 480
    });
    expect(result).toEqual({ moot: false });
  });

  it("is still fresh at exactly staleAfterMinutes old", () => {
    const result = routineStepMootness({
      step: { phase: "before" },
      commitment: baseCommitment,
      routineWindowStart,
      currentLocation: { locationId: "home", locationSetAt: at(8.75 * 60 - 480) },
      now: at(8.75 * 60),
      staleAfterMinutes: 480
    });
    expect(result).toEqual({ moot: true, reason: "already_at_location" });
  });
});

describe("earliestRoutineWindowStart", () => {
  it("finds the minimum scheduled start among a commitment's own before-phase steps", () => {
    const steps = [
      { commitmentId: "c1", phase: "before" as const, scheduledStartAt: at(20).toISOString() },
      { commitmentId: "c1", phase: "before" as const, scheduledStartAt: at(5).toISOString() },
      { commitmentId: "c1", phase: "after" as const, scheduledStartAt: at(-100).toISOString() },
      { commitmentId: "c2", phase: "before" as const, scheduledStartAt: at(-50).toISOString() }
    ];
    expect(earliestRoutineWindowStart(steps, "c1")).toEqual(at(5));
  });

  it("is undefined when the commitment has no before-phase steps with a scheduled start", () => {
    const steps = [{ commitmentId: "c1", phase: "after" as const, scheduledStartAt: at(5).toISOString() }];
    expect(earliestRoutineWindowStart(steps, "c1")).toBeUndefined();
  });
});

describe("earliestRoutineWindowStarts", () => {
  it("gives every commitment the same start the single lookup does, in one pass", () => {
    const steps = [
      { commitmentId: "c1", phase: "before" as const, scheduledStartAt: at(20).toISOString() },
      { commitmentId: "c1", phase: "before" as const, scheduledStartAt: at(5).toISOString() },
      { commitmentId: "c1", phase: "after" as const, scheduledStartAt: at(-100).toISOString() },
      { commitmentId: "c2", phase: "before" as const, scheduledStartAt: at(-50).toISOString() },
      { commitmentId: "c3", phase: "before" as const, scheduledStartAt: "not a date" },
      { commitmentId: "c4", phase: "before" as const, scheduledStartAt: null },
      { phase: "before" as const, scheduledStartAt: at(1).toISOString() }
    ];
    const starts = earliestRoutineWindowStarts(steps);
    expect(starts).toEqual(
      new Map([
        ["c1", at(5)],
        ["c2", at(-50)]
      ])
    );
    for (const commitmentId of ["c1", "c2", "c3", "c4"]) {
      expect(starts.get(commitmentId)).toEqual(earliestRoutineWindowStart(steps, commitmentId));
    }
  });
});
