import { describe, expect, it } from "vitest";
import { completedSleepMinutesEndingAt } from "../../src/index.js";
import type { WireState } from "../../src/recommendation/directive.js";

/**
 * A completed sleep row rewritten mid-sleep lost its `actualStartAt`, leaving a
 * `plannedStartAt` five hours *after* its own recorded wake. The negative span was clamped to 0,
 * which read as a zero-minute nap, re-armed the missed bedtime, and pinned a full new sleep to the
 * instant of calculation at 4:47 am. A self-contradictory window has an unknowable duration, and
 * unknown must stay unknown.
 */

const wokeAt = new Date("2027-08-28T18:27:16.118Z");

function plan(overrides: Partial<WireState["sleepPlans"][number]> = {}): WireState["sleepPlans"][number] {
  return {
    id: "night",
    plannedStartAt: "2027-08-28T09:27:16.118Z",
    plannedWakeAt: wokeAt.toISOString(),
    desiredMinutes: 540,
    allowedMinutes: 540,
    sleepDeficitMinutes: 0,
    anchorDeviationMinutes: 0,
    hardErrors: [],
    explanation: "test fixture",
    status: "completed",
    actualWakeAt: wokeAt.toISOString(),
    ...overrides
  };
}

describe("completedSleepMinutesEndingAt", () => {
  it("reports the actual duration of the night that ended at the wake", () => {
    expect(completedSleepMinutesEndingAt([plan({ actualStartAt: "2027-08-28T13:30:16.118Z" })], wokeAt)).toBe(297);
    // Falls back to the planned start when no actual start was recorded but the window is sane.
    expect(completedSleepMinutesEndingAt([plan()], wokeAt)).toBe(540);
  });
  it("returns unknown, not zero, for a window that starts at or after its own wake", () => {
    // The corrupted row observed live: completed, wake 18:27Z, planned window opening at 23:45Z.
    expect(
      completedSleepMinutesEndingAt([plan({ plannedStartAt: "2027-08-28T23:45:00.000Z" })], wokeAt)
    ).toBeUndefined();
    // An actual start at exactly the wake is just as unknowable.
    expect(completedSleepMinutesEndingAt([plan({ actualStartAt: wokeAt.toISOString() })], wokeAt)).toBeUndefined();
  });
  it("returns unknown when no completed sleep lines up with the wake", () => {
    expect(completedSleepMinutesEndingAt([], wokeAt)).toBeUndefined();
    expect(
      completedSleepMinutesEndingAt(
        [plan({ actualWakeAt: "2027-08-28T12:00:00.000Z", plannedWakeAt: "2027-08-28T12:00:00.000Z" })],
        wokeAt
      )
    ).toBeUndefined();
  });
});
