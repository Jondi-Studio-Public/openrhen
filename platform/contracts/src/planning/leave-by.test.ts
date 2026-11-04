import { describe, expect, it } from "vitest";
import {
  leaveByPrompts,
  LEAVE_BY_GRACE_MINUTES,
  type LeaveByCommitment,
  type LeaveByLeg,
  type LeaveByPromptsInput
} from "./leave-by.js";
import type { CommitmentTimelineWire } from "./plan-forecast.js";

const NEVER_AWAY = () => false;

/** Every test here expects exactly one leg back; asserts that and hands back a non-optional one. */
function only(legs: readonly LeaveByLeg[]): LeaveByLeg {
  expect(legs).toHaveLength(1);
  return legs[0] as LeaveByLeg;
}

function timeline(overrides: Partial<CommitmentTimelineWire> = {}): CommitmentTimelineWire {
  return {
    id: "c1",
    setupStartsAt: "2026-09-26T07:30:00.000Z",
    leaveBy: "2026-09-26T08:00:00.000Z",
    arriveBy: "2026-09-26T08:25:00.000Z",
    startsAt: "2026-09-26T08:30:00.000Z",
    endsAt: "2026-09-26T09:00:00.000Z",
    effectiveEndsAt: "2026-09-26T09:00:00.000Z",
    freeAt: "2026-09-26T09:00:00.000Z",
    protectedUntil: "2026-09-26T09:00:00.000Z",
    overtime: false,
    latenessMatters: true,
    journeyBefore: {
      fromLocationId: "home",
      toLocationId: "dentist",
      mode: "car",
      minutes: 28,
      typicalMinutes: 22,
      source: "typical",
      sampleCount: 5
    },
    ...overrides
  };
}

function commitment(overrides: Partial<LeaveByCommitment> = {}): LeaveByCommitment {
  return { id: "c1", startsAt: "2026-09-26T08:30:00.000Z", status: "confirmed", title: "Dentist", ...overrides };
}

function input(overrides: Partial<LeaveByPromptsInput> = {}): LeaveByPromptsInput {
  return {
    timelines: [timeline()],
    commitments: [commitment()],
    situation: { locationId: "home", locationSetAt: "2026-09-26T06:00:00.000Z", stale: false, underway: null },
    observationsAwayFromOrigin: NEVER_AWAY,
    leadMinutes: 10,
    now: new Date("2026-09-26T07:00:00.000Z"),
    ...overrides
  };
}

describe("leaveByPrompts", () => {
  it("never fires for a remote commitment, even from a stale plan that still carries a leg", () => {
    const now = new Date("2026-09-26T07:55:00.000Z");
    expect(leaveByPrompts(input({ now, commitments: [commitment({ attendance: "remote" })] }))).toEqual([]);
    // Control: the same plan for the same commitment in person does prompt.
    expect(only(leaveByPrompts(input({ now, commitments: [commitment({ attendance: "in_person" })] }))).phase).toBe(
      "remind"
    );
  });

  it("is upcoming before the remind slot", () => {
    const leg = only(leaveByPrompts(input({ now: new Date("2026-09-26T07:00:00.000Z") })));
    expect(leg.phase).toBe("upcoming");
    expect(leg.remindAt.toISOString()).toBe("2026-09-26T07:50:00.000Z");
  });

  it("is remind from remindAt until leaveBy", () => {
    const leg = only(leaveByPrompts(input({ now: new Date("2026-09-26T07:50:00.000Z") })));
    expect(leg.phase).toBe("remind");
    const stillRemind = only(leaveByPrompts(input({ now: new Date("2026-09-26T07:59:59.000Z") })));
    expect(stillRemind.phase).toBe("remind");
  });

  it("is leave from leaveBy until leaveBy + grace", () => {
    const atLeaveBy = only(leaveByPrompts(input({ now: new Date("2026-09-26T08:00:00.000Z") })));
    expect(atLeaveBy.phase).toBe("leave");
    const nearGrace = only(leaveByPrompts(input({ now: new Date("2026-09-26T08:00:00.000Z"), leadMinutes: 10 })));
    expect(nearGrace.phase).toBe("leave");
  });

  it("is dropped once leaveBy + grace has passed", () => {
    const now = new Date(new Date("2026-09-26T08:00:00.000Z").getTime() + (LEAVE_BY_GRACE_MINUTES + 1) * 60_000);
    expect(leaveByPrompts(input({ now }))).toHaveLength(0);
  });

  it("lead 0 goes straight from upcoming to leave with no remind window", () => {
    const remindAt = new Date("2026-09-26T08:00:00.000Z");
    const beforeLeaveBy = only(leaveByPrompts(input({ leadMinutes: 0, now: new Date(remindAt.getTime() - 60_000) })));
    expect(beforeLeaveBy.phase).toBe("upcoming");
    const atLeaveBy = only(leaveByPrompts(input({ leadMinutes: 0, now: remindAt })));
    expect(atLeaveBy.phase).toBe("leave");
    expect(atLeaveBy.remindAt.toISOString()).toBe(atLeaveBy.leaveBy.toISOString());
  });

  it("suppresses a moved commitment (startsAt changed) as moved", () => {
    const leg = only(leaveByPrompts(input({ commitments: [commitment({ startsAt: "2026-09-26T09:00:00.000Z" })] })));
    expect(leg.suppressedBy).toBe("moved");
  });

  it("suppresses a cancelled commitment", () => {
    const leg = only(leaveByPrompts(input({ commitments: [commitment({ status: "cancelled" })] })));
    expect(leg.suppressedBy).toBe("cancelled");
  });

  it("suppresses a commitment missing from the commitments list as cancelled", () => {
    const leg = only(leaveByPrompts(input({ commitments: [] })));
    expect(leg.suppressedBy).toBe("cancelled");
  });

  it("marks arrival as done when the destination is asserted and fresh", () => {
    const leg = only(
      leaveByPrompts(
        input({
          situation: { locationId: "dentist", locationSetAt: "2026-09-26T07:55:00.000Z", stale: false, underway: null }
        })
      )
    );
    expect(leg.phase).toBe("done");
    expect(leg.suppressedBy).toBe("arrived");
  });

  it("a stale destination assertion does not suppress", () => {
    const leg = only(
      leaveByPrompts(
        input({
          situation: { locationId: "dentist", locationSetAt: "2026-09-26T01:00:00.000Z", stale: true, underway: null }
        })
      )
    );
    expect(leg.suppressedBy).toBeUndefined();
  });

  it("underway via the stored On my way assertion suppresses", () => {
    const leg = only(
      leaveByPrompts(
        input({
          situation: {
            locationId: "home",
            locationSetAt: "2026-09-26T06:00:00.000Z",
            stale: false,
            underway: {
              commitmentId: "c1",
              occurrenceStartsAt: "2026-09-26T08:30:00.000Z",
              fromLocationId: "home",
              departedAt: "2026-09-26T07:56:00.000Z"
            }
          }
        })
      )
    );
    expect(leg.suppressedBy).toBe("underway");
    expect(leg.phase).toBe("done");
  });

  it("underway does not apply to a different occurrence of the same commitment", () => {
    const leg = only(
      leaveByPrompts(
        input({
          situation: {
            locationId: "home",
            locationSetAt: "2026-09-26T06:00:00.000Z",
            stale: false,
            underway: {
              commitmentId: "c1",
              occurrenceStartsAt: "2026-09-25T08:30:00.000Z",
              fromLocationId: "home",
              departedAt: "2026-09-25T07:56:00.000Z"
            }
          }
        })
      )
    );
    expect(leg.suppressedBy).toBeUndefined();
  });

  it("underway via a location assertion since the reminder window, matching neither origin nor destination", () => {
    const leg = only(
      leaveByPrompts(
        input({
          now: new Date("2026-09-26T07:55:00.000Z"),
          situation: {
            locationId: "cafe",
            locationSetAt: "2026-09-26T07:52:00.000Z",
            stale: false,
            underway: null
          }
        })
      )
    );
    expect(leg.suppressedBy).toBe("underway");
  });

  it("a same-window assertion of the destination is arrival, not underway", () => {
    const leg = only(
      leaveByPrompts(
        input({
          now: new Date("2026-09-26T07:55:00.000Z"),
          situation: { locationId: "dentist", locationSetAt: "2026-09-26T07:52:00.000Z", stale: false, underway: null }
        })
      )
    );
    expect(leg.suppressedBy).toBe("arrived");
  });

  it("a location assertion before the reminder window opened does not count as underway", () => {
    const leg = only(
      leaveByPrompts(
        input({
          now: new Date("2026-09-26T07:55:00.000Z"),
          situation: { locationId: "cafe", locationSetAt: "2026-09-26T07:00:00.000Z", stale: false, underway: null }
        })
      )
    );
    expect(leg.suppressedBy).toBeUndefined();
  });

  it("unambiguous device evidence away from the origin suppresses", () => {
    const leg = only(leaveByPrompts(input({ observationsAwayFromOrigin: (originId) => originId === "home" })));
    expect(leg.suppressedBy).toBe("underway");
  });

  it("a leg without a journey is not eligible", () => {
    expect(
      leaveByPrompts(input({ timelines: [timeline({ leaveBy: undefined, journeyBefore: undefined })] }))
    ).toHaveLength(0);
  });

  it("a leg whose journeyBefore.minutes is 0 is not eligible", () => {
    expect(
      leaveByPrompts(
        input({
          timelines: [
            timeline({
              journeyBefore: {
                fromLocationId: "home",
                toLocationId: "dentist",
                mode: "car",
                minutes: 0,
                typicalMinutes: 0,
                source: "typical",
                sampleCount: 0
              }
            })
          ]
        })
      )
    ).toHaveLength(0);
  });

  it("carries originAssumed through from the journey edge", () => {
    const leg = only(
      leaveByPrompts(
        input({
          timelines: [
            timeline({
              journeyBefore: {
                fromLocationId: "home",
                toLocationId: "dentist",
                mode: "car",
                minutes: 28,
                typicalMinutes: 22,
                source: "typical",
                sampleCount: 5,
                originAssumed: true
              }
            })
          ]
        })
      )
    );
    expect(leg.originAssumed).toBe(true);
  });
});
