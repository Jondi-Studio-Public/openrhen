import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import type { PlanChangeSummary } from "@/features/planning/plan-diff";
import { assessDisruption, BEDTIME_SHIFT_RENEGOTIATE_THRESHOLD_MINUTES } from "./disruption-impact";

const now = new Date("2026-08-18T10:00:00.000Z");
const state = createSeedState(now);
const landedAt = now;

const summary = (overrides: Partial<PlanChangeSummary> = {}): PlanChangeSummary => ({
  available: true,
  moved: [],
  dropped: [],
  added: [],
  sleepShiftMinutes: 0,
  // An hour ahead of `landedAt` by default, so tests exercising `sleepShiftMinutes` alone (the
  // threshold tests below) keep hitting the "moved by the disruption" branch without each having to
  // set this explicitly. The landedAt-attribution tests further down override it.
  beforeNightPlannedStartAt: "2026-08-18T11:00:00.000Z",
  newlyDisplaced: [],
  ...overrides
});

describe("assessDisruption", () => {
  it("is absorbed when nothing changed", () => {
    expect(assessDisruption(summary(), state, landedAt).tier).toBe("absorbed");
  });

  it("is absorbed when the diff is unavailable, whatever else the response happens to carry", () => {
    const impact = assessDisruption(summary({ available: false }), state, landedAt);
    expect(impact.tier).toBe("absorbed");
    expect(impact.newlyDisplaced).toEqual([]);
  });

  it("renegotiates when a target is newly displaced", () => {
    const impact = assessDisruption(
      summary({ newlyDisplaced: [{ targetId: "networking-section-one", firstPlannedAt: "2026-08-18T09:00:00.000Z" }] }),
      state,
      landedAt
    );
    expect(impact.tier).toBe("renegotiate");
    expect(impact.newlyDisplaced).toEqual([
      {
        targetId: "networking-section-one",
        title: "Draft networking assignment section 1",
        kind: "action",
        movable: true
      }
    ]);
  });

  it("stays absorbed at exactly the bedtime threshold", () => {
    const impact = assessDisruption(
      summary({ sleepShiftMinutes: BEDTIME_SHIFT_RENEGOTIATE_THRESHOLD_MINUTES }),
      state,
      landedAt
    );
    expect(impact.tier).toBe("absorbed");
  });

  it("renegotiates one minute past the bedtime threshold", () => {
    const impact = assessDisruption(
      summary({ sleepShiftMinutes: BEDTIME_SHIFT_RENEGOTIATE_THRESHOLD_MINUTES + 1 }),
      state,
      landedAt
    );
    expect(impact.tier).toBe("renegotiate");
  });

  it("renegotiates on a bedtime shift earlier than the threshold too, by magnitude not sign", () => {
    const impact = assessDisruption(
      summary({ sleepShiftMinutes: -(BEDTIME_SHIFT_RENEGOTIATE_THRESHOLD_MINUTES + 1) }),
      state,
      landedAt
    );
    expect(impact.tier).toBe("renegotiate");
  });

  it("resolves a deliverable target as movable", () => {
    const withDeliverable = {
      ...state,
      deliverables: [
        {
          id: "deliverable-1",
          projectId: "networking-assignment",
          title: "Submit the report",
          status: "in_progress" as const,
          uncertainty: "known" as const,
          importance: 4,
          consequence: 4,
          contractVersion: 1,
          planVersion: 1,
          sortOrder: 0,
          dependencyIds: [],
          sourceIds: [],
          sourceFiles: [],
          criteria: [],
          steps: [],
          blockers: [],
          contractProposals: []
        }
      ]
    };
    const impact = assessDisruption(
      summary({ newlyDisplaced: [{ targetId: "deliverable-1", firstPlannedAt: "2026-08-18T09:00:00.000Z" }] }),
      withDeliverable,
      landedAt
    );
    expect(impact.movable).toEqual([
      { targetId: "deliverable-1", title: "Submit the report", kind: "deliverable", movable: true }
    ]);
    expect(impact.immovable).toEqual([]);
  });

  it("resolves a fixed commitment as immovable", () => {
    const impact = assessDisruption(
      summary({ newlyDisplaced: [{ targetId: "dinner", firstPlannedAt: "2026-08-18T09:00:00.000Z" }] }),
      state,
      landedAt
    );
    expect(impact.immovable).toEqual([
      { targetId: "dinner", title: "Dinner and reset", kind: "commitment", movable: false }
    ]);
    expect(impact.movable).toEqual([]);
  });

  it("carries a displaced commitment's contactId, and never puts one on an action", () => {
    const withContact = {
      ...state,
      commitments: state.commitments.map((item) => (item.id === "dinner" ? { ...item, contactId: "sam" } : item))
    };
    const impact = assessDisruption(
      summary({ newlyDisplaced: [{ targetId: "dinner", firstPlannedAt: "2026-08-18T09:00:00.000Z" }] }),
      withContact,
      landedAt
    );
    expect(impact.immovable).toEqual([
      { targetId: "dinner", title: "Dinner and reset", kind: "commitment", movable: false, contactId: "sam" }
    ]);

    const actionImpact = assessDisruption(
      summary({ newlyDisplaced: [{ targetId: "networking-section-one", firstPlannedAt: "2026-08-18T09:00:00.000Z" }] }),
      withContact,
      landedAt
    );
    expect(actionImpact.newlyDisplaced[0]).not.toHaveProperty("contactId");
  });

  it("resolves an unrecognised target as immovable rather than dropping it", () => {
    const impact = assessDisruption(
      summary({ newlyDisplaced: [{ targetId: "ghost", firstPlannedAt: "2026-08-18T09:00:00.000Z" }] }),
      state,
      landedAt
    );
    expect(impact.immovable).toEqual([
      { targetId: "ghost", title: "something no longer in the plan", kind: "unknown", movable: false }
    ]);
  });

  it("partitions a mix of movable and immovable targets", () => {
    const impact = assessDisruption(
      summary({
        newlyDisplaced: [
          { targetId: "networking-section-one", firstPlannedAt: "2026-08-18T09:00:00.000Z" },
          { targetId: "dinner", firstPlannedAt: "2026-08-18T09:00:00.000Z" }
        ]
      }),
      state,
      landedAt
    );
    expect(impact.movable.map((item) => item.targetId)).toEqual(["networking-section-one"]);
    expect(impact.immovable.map((item) => item.targetId)).toEqual(["dinner"]);
  });

  // Three long-overdue trip actions, all deadlined before a disruption that landed
  // at local midnight, dropped out of the plan the same day from ordinary day-shrinkage and were
  // blamed on the disruption forever because `diffDayPlans` has no notion of the disruption at all —
  // it only sees "not displaced before, displaced after". This is the seam that catches it.
  it("excludes a target whose deadline had already passed when the disruption landed", () => {
    const overdue = {
      ...state,
      actions: state.actions.map((item) =>
        item.id === "networking-section-one" ? { ...item, deadlineAt: "2026-08-10T00:00:00.000Z" } : item
      )
    };
    const impact = assessDisruption(
      summary({ newlyDisplaced: [{ targetId: "networking-section-one", firstPlannedAt: "2026-08-18T09:00:00.000Z" }] }),
      overdue,
      landedAt
    );
    expect(impact.newlyDisplaced).toEqual([]);
    expect(impact.tier).toBe("absorbed");
  });

  it("still renegotiates a target whose deadline is still ahead of the disruption's landing", () => {
    const impact = assessDisruption(
      summary({ newlyDisplaced: [{ targetId: "networking-section-one", firstPlannedAt: "2026-08-18T09:00:00.000Z" }] }),
      state,
      landedAt
    );
    expect(impact.tier).toBe("renegotiate");
    expect(impact.newlyDisplaced.map((item) => item.targetId)).toEqual(["networking-section-one"]);
  });

  it("excludes a deliverable target too when its own deadline had already passed at landing", () => {
    const overdueDeliverable = {
      ...state,
      deliverables: [
        {
          id: "deliverable-1",
          projectId: "networking-assignment",
          title: "Submit the report",
          status: "in_progress" as const,
          uncertainty: "known" as const,
          importance: 4,
          consequence: 4,
          contractVersion: 1,
          planVersion: 1,
          sortOrder: 0,
          dependencyIds: [],
          sourceIds: [],
          sourceFiles: [],
          criteria: [],
          steps: [],
          blockers: [],
          contractProposals: [],
          externalDeadlineAt: "2026-08-10T00:00:00.000Z"
        }
      ]
    };
    const impact = assessDisruption(
      summary({ newlyDisplaced: [{ targetId: "deliverable-1", firstPlannedAt: "2026-08-18T09:00:00.000Z" }] }),
      overdueDeliverable,
      landedAt
    );
    expect(impact.newlyDisplaced).toEqual([]);
  });

  it("does not exclude a target with no resolvable deadline (a commitment, or an unknown target)", () => {
    const impact = assessDisruption(
      summary({
        newlyDisplaced: [
          { targetId: "dinner", firstPlannedAt: "2026-08-18T09:00:00.000Z" },
          { targetId: "ghost", firstPlannedAt: "2026-08-18T09:00:00.000Z" }
        ]
      }),
      state,
      landedAt
    );
    expect(impact.newlyDisplaced.map((item) => item.targetId)).toEqual(["dinner", "ghost"]);
  });

  // A repeated "displaced something" warning with no change made. A five-a-day,
  // one-minute recurring action (no deadline, so the overdue filter above never touches it)
  // never got a plan slot at all, in either run — the plan simply doesn't reach it, hours after the
  // disruption landed, with nothing the person did in between. `firstPlannedAt: null` says exactly
  // that: nothing was moved, because nothing was ever placed.
  it("excludes a target that never held a slot in the plan at all", () => {
    const impact = assessDisruption(
      summary({ newlyDisplaced: [{ targetId: "networking-section-one", firstPlannedAt: null }] }),
      state,
      landedAt
    );
    expect(impact.newlyDisplaced).toEqual([]);
    expect(impact.tier).toBe("absorbed");
  });

  it("still renegotiates a target that held a slot and lost it, alongside one that never had one", () => {
    const impact = assessDisruption(
      summary({
        newlyDisplaced: [
          { targetId: "networking-section-one", firstPlannedAt: null },
          { targetId: "dinner", firstPlannedAt: "2026-08-18T09:00:00.000Z" }
        ]
      }),
      state,
      landedAt
    );
    expect(impact.newlyDisplaced.map((item) => item.targetId)).toEqual(["dinner"]);
    expect(impact.tier).toBe("renegotiate");
  });

  // A "Bedtime moves 488 min later" warning while the person had made no change and was
  // following the plan exactly. `landedAt` fell in the small hours; `before`'s "upcoming night" was
  // the night already under way at that moment (its `plannedStartAt` at or before `landedAt`), and
  // `diffDayPlans` matched it against the *next* night in `after` — a real gap, but not one the
  // disruption caused. A night already due to start at or before landing was not moved by it.
  it("does not attribute a bedtime shift to the disruption when before's night was already due at or before landing", () => {
    const impact = assessDisruption(
      summary({
        sleepShiftMinutes: 488,
        beforeNightPlannedStartAt: "2026-08-18T10:00:00.000Z" // == landedAt
      }),
      state,
      landedAt
    );
    expect(impact.bedtimeShiftMinutes).toBe(0);
    expect(impact.tier).toBe("absorbed");
  });

  it("does not attribute a bedtime shift to the disruption when before had no upcoming night at all", () => {
    const impact = assessDisruption(
      summary({ sleepShiftMinutes: 488, beforeNightPlannedStartAt: null }),
      state,
      landedAt
    );
    expect(impact.bedtimeShiftMinutes).toBe(0);
    expect(impact.tier).toBe("absorbed");
  });

  it("still attributes a bedtime shift to the disruption when before's night was still ahead of landing", () => {
    const impact = assessDisruption(
      summary({
        sleepShiftMinutes: 30,
        beforeNightPlannedStartAt: "2026-08-18T10:00:00.001Z" // just after landedAt
      }),
      state,
      landedAt
    );
    expect(impact.bedtimeShiftMinutes).toBe(30);
    expect(impact.tier).toBe("renegotiate");
  });
});
