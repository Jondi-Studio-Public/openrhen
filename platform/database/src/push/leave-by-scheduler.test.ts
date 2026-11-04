import { describe, expect, it } from "vitest";
import type { LeaveByLeg } from "@openrhen/contracts";
import {
  evidenceSourceOf,
  AWAY_MARGIN_METERS,
  MAX_EVIDENCE_ACCURACY_METERS,
  decideLeaveByTick,
  observationsAwayFromOrigin,
  type DeviceObservationForEvidence,
  type ExistingOutboxRow
} from "./leave-by-scheduler.js";

function leg(overrides: Partial<LeaveByLeg> = {}): LeaveByLeg {
  return {
    commitmentId: "c1",
    occurrenceStartsAt: "2026-09-26T08:30:00.000Z",
    title: "Dentist",
    leaveBy: new Date("2026-09-26T08:00:00.000Z"),
    remindAt: new Date("2026-09-26T07:50:00.000Z"),
    typicalMinutes: 22,
    allowingMinutes: 28,
    originAssumed: false,
    phase: "remind",
    ...overrides
  };
}

describe("decideLeaveByTick", () => {
  it("enqueues a reminder when there is no lead row and the origin is confirmed", () => {
    const action = decideLeaveByTick(leg(), []);
    expect(action).toMatchObject({ type: "enqueue", kind: "reminder" });
  });

  it("enqueues assumed_origin instead when the origin is assumed", () => {
    const action = decideLeaveByTick(leg({ originAssumed: true }), []);
    expect(action).toMatchObject({ type: "enqueue", kind: "assumed_origin" });
  });

  it("does nothing once a lead row already exists and no earlier condition applies", () => {
    const existing: ExistingOutboxRow[] = [{ kind: "reminder", announcedLeaveBy: leg().leaveBy, status: "sent" }];
    expect(decideLeaveByTick(leg(), existing)).toEqual({ type: "none" });
  });

  it("enqueues earlier once leaveBy has moved 5+ minutes earlier than the announced time", () => {
    const existing: ExistingOutboxRow[] = [
      { kind: "reminder", announcedLeaveBy: new Date("2026-09-26T08:10:00.000Z"), status: "sent" }
    ];
    const action = decideLeaveByTick(leg({ leaveBy: new Date("2026-09-26T08:00:00.000Z") }), existing);
    expect(action).toMatchObject({ type: "enqueue", kind: "earlier", minutesEarlier: 10 });
  });

  it("does not enqueue earlier for less than a 5-minute move", () => {
    const existing: ExistingOutboxRow[] = [
      { kind: "reminder", announcedLeaveBy: new Date("2026-09-26T08:03:00.000Z"), status: "sent" }
    ];
    const action = decideLeaveByTick(leg({ leaveBy: new Date("2026-09-26T08:00:00.000Z") }), existing);
    expect(action.type).not.toBe("enqueue");
  });

  it("does not enqueue a second earlier prompt", () => {
    const existing: ExistingOutboxRow[] = [
      { kind: "reminder", announcedLeaveBy: new Date("2026-09-26T08:20:00.000Z"), status: "sent" },
      { kind: "earlier", announcedLeaveBy: null, status: "sent" }
    ];
    const action = decideLeaveByTick(leg({ leaveBy: new Date("2026-09-26T08:00:00.000Z") }), existing);
    expect(action.type).toBe("none");
  });

  it("goes straight to due when downtime ends inside the leave phase, with no lead reminder first", () => {
    const action = decideLeaveByTick(leg({ phase: "leave" }), []);
    expect(action).toMatchObject({ type: "enqueue", kind: "due" });
  });

  it("retracts a delivered prompt once when its commitment is cancelled", () => {
    const sent: ExistingOutboxRow[] = [{ kind: "reminder", announcedLeaveBy: leg().leaveBy, status: "sent" }];
    expect(decideLeaveByTick(leg({ phase: "remind", suppressedBy: "cancelled" }), sent)).toMatchObject({
      type: "enqueue",
      kind: "retract",
      reason: "cancelled"
    });
    const retracted: ExistingOutboxRow[] = [
      ...sent,
      { kind: "earlier", announcedLeaveBy: null, status: "pending", dedupeKey: "leave_by:c1:x:cancelled" }
    ];
    expect(decideLeaveByTick(leg({ phase: "remind", suppressedBy: "cancelled" }), retracted)).toEqual({ type: "none" });
  });

  it("retracts a delivered prompt when the commitment moved, and nothing when none was delivered", () => {
    const sent: ExistingOutboxRow[] = [{ kind: "due", announcedLeaveBy: null, status: "sent" }];
    expect(decideLeaveByTick(leg({ phase: "leave", suppressedBy: "moved" }), sent)).toMatchObject({
      kind: "retract",
      reason: "moved"
    });
    expect(decideLeaveByTick(leg({ phase: "leave", suppressedBy: "moved" }), [])).toEqual({ type: "none" });
  });

  it("cancels pending rows before retracting, and never cancels the retraction itself", () => {
    const rows: ExistingOutboxRow[] = [
      { kind: "reminder", announcedLeaveBy: null, status: "sent" },
      { kind: "due", announcedLeaveBy: null, status: "pending" }
    ];
    expect(decideLeaveByTick(leg({ suppressedBy: "cancelled" }), rows)).toEqual({ type: "cancel_pending" });
    const onlyRetraction: ExistingOutboxRow[] = [
      { kind: "earlier", announcedLeaveBy: null, status: "pending", dedupeKey: "leave_by:c1:x:cancelled" }
    ];
    expect(decideLeaveByTick(leg({ suppressedBy: "cancelled" }), onlyRetraction)).toEqual({ type: "none" });
  });

  it("does not retract for arrived/underway: the person is already acting on the prompt", () => {
    const sent: ExistingOutboxRow[] = [{ kind: "reminder", announcedLeaveBy: null, status: "sent" }];
    expect(decideLeaveByTick(leg({ phase: "done", suppressedBy: "underway" }), sent)).toEqual({ type: "none" });
  });

  it("enqueues due once in the leave phase with a confirmed origin and no due row", () => {
    const existing: ExistingOutboxRow[] = [{ kind: "reminder", announcedLeaveBy: leg().leaveBy, status: "sent" }];
    const action = decideLeaveByTick(leg({ phase: "leave" }), existing);
    expect(action).toMatchObject({ type: "enqueue", kind: "due" });
  });

  it("never sends due while the origin is still assumed", () => {
    const existing: ExistingOutboxRow[] = [{ kind: "assumed_origin", announcedLeaveBy: leg().leaveBy, status: "sent" }];
    const action = decideLeaveByTick(leg({ phase: "leave", originAssumed: true }), existing);
    expect(action.type).toBe("none");
  });

  it("cancels pending rows once the leg is done", () => {
    const existing: ExistingOutboxRow[] = [{ kind: "reminder", announcedLeaveBy: leg().leaveBy, status: "pending" }];
    const action = decideLeaveByTick(leg({ phase: "done", suppressedBy: "underway" }), existing);
    expect(action).toEqual({ type: "cancel_pending" });
  });

  it("does nothing when done and nothing is pending", () => {
    const existing: ExistingOutboxRow[] = [{ kind: "reminder", announcedLeaveBy: leg().leaveBy, status: "sent" }];
    const action = decideLeaveByTick(leg({ phase: "done", suppressedBy: "arrived" }), existing);
    expect(action).toEqual({ type: "none" });
  });

  it("cancels pending rows for a moved or cancelled commitment", () => {
    const existing: ExistingOutboxRow[] = [{ kind: "reminder", announcedLeaveBy: leg().leaveBy, status: "pending" }];
    expect(decideLeaveByTick(leg({ suppressedBy: "cancelled" }), existing)).toEqual({ type: "cancel_pending" });
    expect(decideLeaveByTick(leg({ suppressedBy: "moved" }), existing)).toEqual({ type: "cancel_pending" });
  });

  it("a double tick with the same state enqueues the same action idempotently (dedupe key stable)", () => {
    const a = decideLeaveByTick(leg(), []);
    const b = decideLeaveByTick(leg(), []);
    expect(a).toEqual(b);
  });
});

function observation(overrides: Partial<DeviceObservationForEvidence>): DeviceObservationForEvidence {
  return {
    observedAt: new Date("2026-09-26T07:52:00.000Z"),
    matchedLocationId: null,
    accuracyMeters: 20,
    source: "phone",
    ...overrides
  };
}

describe("observationsAwayFromOrigin", () => {
  const since = new Date("2026-09-26T07:50:00.000Z");

  it("is false with no observations", () => {
    expect(observationsAwayFromOrigin([], "home", since)).toBe(false);
  });

  it("one observation matching another known place counts alone", () => {
    expect(observationsAwayFromOrigin([observation({ matchedLocationId: "cafe" })], "home", since)).toBe(true);
  });

  it("one observation matching the origin does not count", () => {
    expect(observationsAwayFromOrigin([observation({ matchedLocationId: "home" })], "home", since)).toBe(false);
  });

  it("one unmatched, tight-accuracy reading counts alone", () => {
    expect(
      observationsAwayFromOrigin(
        [observation({ matchedLocationId: null, accuracyMeters: AWAY_MARGIN_METERS })],
        "home",
        since
      )
    ).toBe(true);
  });

  it("one unmatched, sloppy-accuracy reading does not count alone", () => {
    expect(
      observationsAwayFromOrigin(
        [observation({ matchedLocationId: null, accuracyMeters: AWAY_MARGIN_METERS + 500 })],
        "home",
        since
      )
    ).toBe(false);
  });

  it("two consecutive sloppy unmatched readings do count", () => {
    const observations = [
      observation({ observedAt: new Date("2026-09-26T07:52:00.000Z"), matchedLocationId: null, accuracyMeters: 1000 }),
      observation({ observedAt: new Date("2026-09-26T07:54:00.000Z"), matchedLocationId: null, accuracyMeters: 1000 })
    ];
    expect(observationsAwayFromOrigin(observations, "home", since)).toBe(true);
  });

  it("a browser reading is never departure evidence, alone or as a pair", () => {
    expect(
      observationsAwayFromOrigin([observation({ matchedLocationId: "cafe", source: "browser" })], "home", since)
    ).toBe(false);
    const pair = [
      observation({ observedAt: new Date("2026-09-26T07:52:00.000Z"), source: "browser" }),
      observation({ observedAt: new Date("2026-09-26T07:54:00.000Z"), source: "browser" })
    ];
    expect(observationsAwayFromOrigin(pair, "home", since)).toBe(false);
  });

  it("ambiguous readings do not form a pair of failures to match the origin", () => {
    const pair = [
      observation({ observedAt: new Date("2026-09-26T07:52:00.000Z"), ambiguous: true, accuracyMeters: 800 }),
      observation({ observedAt: new Date("2026-09-26T07:54:00.000Z"), ambiguous: true, accuracyMeters: 800 })
    ];
    expect(observationsAwayFromOrigin(pair, "home", since)).toBe(false);
  });

  it("readings coarser than the evidence cap do not count", () => {
    expect(
      observationsAwayFromOrigin(
        [observation({ matchedLocationId: "cafe", accuracyMeters: MAX_EVIDENCE_ACCURACY_METERS + 1 })],
        "home",
        since
      )
    ).toBe(false);
  });

  it("an observation before the window opened does not count", () => {
    const observations = [observation({ observedAt: new Date("2026-09-26T07:00:00.000Z"), matchedLocationId: "cafe" })];
    expect(observationsAwayFromOrigin(observations, "home", since)).toBe(false);
  });
});

describe("evidenceSourceOf", () => {
  it("only trusts an explicit phone source as departure evidence", () => {
    expect(evidenceSourceOf("phone")).toBe("phone");
    expect(evidenceSourceOf("browser")).toBe("browser");
    expect(evidenceSourceOf("watch")).toBe("browser");
    expect(evidenceSourceOf(undefined)).toBe("browser");
  });
});
