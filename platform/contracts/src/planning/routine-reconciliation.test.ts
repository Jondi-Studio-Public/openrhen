import { describe, expect, it } from "vitest";
import {
  planRoutineStepReconciliation,
  type CommitmentRoutineStepInput,
  type ExistingRoutineStepForPlan
} from "./routine-reconciliation.js";

/**
 * Pure-function coverage for the reconciliation core (the routine sync step level design note
 * and its `preset_step_id` follow-up): matching existing `commitment_routine_steps` rows to
 * `routine_preset_steps` by stable id first, falling back to absolute position only for a row with no
 * id, so a non-pending row locks only itself, not its siblings. The DB round-trip (writes, schedule,
 * dependency-edge cascade, the one-time backfill actually landing) is covered separately by
 * `routine-inheritance.integration.test.ts`.
 */

function existingStep(overrides: Partial<ExistingRoutineStepForPlan> & { id: string }): ExistingRoutineStepForPlan {
  return {
    status: "pending",
    sequence: 0,
    presetStepId: null,
    title: "Step",
    durationMinutes: 10,
    timingRule: "contiguous",
    maxLeadMinutes: null,
    energy: "low",
    phase: "before",
    contexts: [],
    actionWindowId: null,
    cadenceActionId: null,
    dependsOnIds: [],
    ...overrides
  };
}

function templateStep(overrides: Partial<CommitmentRoutineStepInput> = {}): CommitmentRoutineStepInput {
  return {
    title: "Step",
    durationMinutes: 10,
    timingRule: "contiguous",
    maxLeadMinutes: null,
    energy: "low",
    phase: "before",
    contexts: [],
    actionWindowId: null,
    cadenceActionId: null,
    presetStepId: null,
    dependsOn: [],
    ...overrides
  };
}

/** A deterministic id generator for assertions that need to know exactly which id got minted. */
function idSequence(...ids: string[]): () => string {
  let index = 0;
  return () => {
    const id = ids[index];
    if (id === undefined) throw new Error("idSequence exhausted");
    index += 1;
    return id;
  };
}

describe("planRoutineStepReconciliation", () => {
  it("inserts every step fresh for a commitment with no existing rows", () => {
    const template = [
      templateStep({ title: "Pack towel", durationMinutes: 10, presetStepId: "preset-a" }),
      templateStep({ title: "Hang towel", durationMinutes: 5, phase: "after", presetStepId: "preset-b" })
    ];
    const plan = planRoutineStepReconciliation([], template, idSequence("id-0", "id-1"));
    expect(plan.changed).toBe(true);
    expect(plan.ops).toEqual([
      { kind: "insert", id: "id-0", templateIndex: 0, sequence: 0, step: template[0], dependsOnIds: [] },
      { kind: "insert", id: "id-1", templateIndex: 1, sequence: 1, step: template[1], dependsOnIds: [] }
    ]);
    expect(plan.finalSteps).toEqual([
      { id: "id-0", phase: "before", durationMinutes: 10, status: "pending", contexts: [] },
      { id: "id-1", phase: "after", durationMinutes: 5, status: "pending", contexts: [] }
    ]);
  });

  it("keeps a non-pending row exactly, and updates a pending sibling to an edited preset", () => {
    const existing = [
      existingStep({
        id: "done-1",
        status: "completed",
        sequence: 0,
        presetStepId: "preset-a",
        title: "Pack towel",
        durationMinutes: 10
      }),
      existingStep({
        id: "pend-1",
        sequence: 1,
        presetStepId: "preset-b",
        title: "Fill water bottle",
        durationMinutes: 5,
        dependsOnIds: ["done-1"]
      })
    ];
    const template = [
      templateStep({ title: "Pack towel", durationMinutes: 10, presetStepId: "preset-a", dependsOn: [] }),
      // The preset edit under test: the pending sibling's duration grows from 5 to 12.
      templateStep({ title: "Fill water bottle", durationMinutes: 12, presetStepId: "preset-b", dependsOn: [0] })
    ];
    const plan = planRoutineStepReconciliation(existing, template);
    expect(plan.changed).toBe(true);
    expect(plan.ops).toEqual([
      { kind: "keep", id: "done-1" },
      { kind: "update", id: "pend-1", templateIndex: 1, sequence: 1, step: template[1], dependsOnIds: ["done-1"] }
    ]);
    // The done row's own fields never appear in an op — only its id, confirming it is never rewritten.
    expect(plan.finalSteps).toEqual([
      { id: "done-1", phase: "before", durationMinutes: 10, status: "completed", contexts: [] },
      { id: "pend-1", phase: "before", durationMinutes: 12, status: "pending", contexts: [] }
    ]);
  });

  it("does no writes when every row already matches the template, even with a locked sibling", () => {
    const existing = [
      existingStep({
        id: "done-1",
        status: "completed",
        sequence: 0,
        presetStepId: "preset-a",
        title: "Pack towel",
        durationMinutes: 10
      }),
      existingStep({
        id: "pend-1",
        sequence: 1,
        presetStepId: "preset-b",
        title: "Fill water bottle",
        durationMinutes: 5,
        dependsOnIds: ["done-1"]
      })
    ];
    const template = [
      templateStep({ title: "Pack towel", durationMinutes: 10, presetStepId: "preset-a", dependsOn: [] }),
      templateStep({ title: "Fill water bottle", durationMinutes: 5, presetStepId: "preset-b", dependsOn: [0] })
    ];
    const plan = planRoutineStepReconciliation(existing, template);
    expect(plan.changed).toBe(false);
    expect(plan.ops).toEqual([
      { kind: "keep", id: "done-1" },
      { kind: "keep", id: "pend-1" }
    ]);
  });

  it("treats a changed cadenceActionId as a real difference, not a silent keep", () => {
    // A pending row's hand-edited cadence link — or one gated back in after being gated out — must be
    // picked up as an update, the same way any other content field is.
    const existing = [existingStep({ id: "row-a", sequence: 0, presetStepId: "preset-a", cadenceActionId: null })];
    const template = [templateStep({ presetStepId: "preset-a", cadenceActionId: "action-1" })];
    const plan = planRoutineStepReconciliation(existing, template);
    expect(plan.changed).toBe(true);
    expect(plan.ops).toEqual([
      { kind: "update", id: "row-a", templateIndex: 0, sequence: 0, step: template[0], dependsOnIds: [] }
    ]);
  });

  it("is a no-op when the cadenceActionId already matches", () => {
    const existing = [
      existingStep({ id: "row-a", sequence: 0, presetStepId: "preset-a", cadenceActionId: "action-1" })
    ];
    const template = [templateStep({ presetStepId: "preset-a", cadenceActionId: "action-1" })];
    const plan = planRoutineStepReconciliation(existing, template);
    expect(plan.changed).toBe(false);
    expect(plan.ops).toEqual([{ kind: "keep", id: "row-a" }]);
  });

  it("matches purely by id regardless of either list's order", () => {
    // The preset was reordered (B now before A) but neither step's own content changed. Position
    // matching alone would misread this as two swapped rewrites; id matching sees no change at all.
    const existing = [
      existingStep({ id: "row-a", sequence: 1, presetStepId: "preset-a", title: "A" }),
      existingStep({ id: "row-b", sequence: 0, presetStepId: "preset-b", title: "B" })
    ];
    const template = [
      templateStep({ title: "B", presetStepId: "preset-b" }),
      templateStep({ title: "A", presetStepId: "preset-a" })
    ];
    const plan = planRoutineStepReconciliation(existing, template);
    expect(plan.changed).toBe(false);
    expect(plan.ops).toEqual([
      { kind: "keep", id: "row-b" },
      { kind: "keep", id: "row-a" }
    ]);
  });

  it("falls back to position for a null-id row, and mixes that with an id-matched sibling", () => {
    // row-a predates the preset_step_id column (null); row-b was written after it landed.
    const existing = [
      existingStep({ id: "row-a", sequence: 0, presetStepId: null, title: "A" }),
      existingStep({ id: "row-b", sequence: 1, presetStepId: "preset-b", title: "B" })
    ];
    const template = [
      templateStep({ title: "A", presetStepId: "preset-a" }),
      templateStep({ title: "B", presetStepId: "preset-b" })
    ];
    const plan = planRoutineStepReconciliation(existing, template);
    // row-a matches template[0] by the position fallback (both otherwise unclaimed), but its
    // preset_step_id is still null while the template step's is "preset-a" — a real difference, so
    // this is the one-time backfill write, not a no-op.
    expect(plan.changed).toBe(true);
    expect(plan.ops).toEqual([
      { kind: "update", id: "row-a", templateIndex: 0, sequence: 0, step: template[0], dependsOnIds: [] },
      { kind: "keep", id: "row-b" }
    ]);
  });

  it("backfills a fallback-matched row's preset_step_id once, then treats it as a real id match", () => {
    const existing = [existingStep({ id: "row-a", sequence: 0, presetStepId: null, title: "A" })];
    const template = [templateStep({ title: "A", presetStepId: "preset-a" })];
    const first = planRoutineStepReconciliation(existing, template);
    expect(first.changed).toBe(true);
    expect(first.ops).toEqual([
      { kind: "update", id: "row-a", templateIndex: 0, sequence: 0, step: template[0], dependsOnIds: [] }
    ]);
    // Apply the backfill by hand (this is what applyRoutineStepPlan would persist) and reconcile again:
    // now it is a genuine id match with nothing left to change.
    const backfilled = [existingStep({ id: "row-a", sequence: 0, presetStepId: "preset-a", title: "A" })];
    const second = planRoutineStepReconciliation(backfilled, template);
    expect(second.changed).toBe(false);
    expect(second.ops).toEqual([{ kind: "keep", id: "row-a" }]);
  });

  it("treats a reordered-but-identical dependsOn set as unchanged (order-independent)", () => {
    const existing = [
      existingStep({ id: "a", sequence: 0, presetStepId: "preset-a", title: "A" }),
      existingStep({ id: "b", sequence: 1, presetStepId: "preset-b", title: "B" }),
      existingStep({
        id: "c",
        sequence: 2,
        presetStepId: "preset-c",
        title: "C",
        dependsOnIds: ["b", "a"]
      })
    ];
    const template = [
      templateStep({ title: "A", presetStepId: "preset-a" }),
      templateStep({ title: "B", presetStepId: "preset-b" }),
      // Same dependency set as stored (a and b), just listed in the other order.
      templateStep({ title: "C", presetStepId: "preset-c", dependsOn: [0, 1] })
    ];
    const plan = planRoutineStepReconciliation(existing, template);
    expect(plan.changed).toBe(false);
  });

  it("treats a reordered contexts array as a real change (order-sensitive)", () => {
    const existing = [
      existingStep({ id: "a", sequence: 0, presetStepId: "preset-a", title: "A", contexts: ["phone", "keys"] })
    ];
    const template = [templateStep({ title: "A", presetStepId: "preset-a", contexts: ["keys", "phone"] })];
    const plan = planRoutineStepReconciliation(existing, template);
    expect(plan.changed).toBe(true);
    expect(plan.ops).toEqual([
      { kind: "update", id: "a", templateIndex: 0, sequence: 0, step: template[0], dependsOnIds: [] }
    ]);
  });

  it("deletes a trailing pending row the preset dropped, leaving a done row untouched", () => {
    const existing = [
      existingStep({
        id: "done-1",
        status: "completed",
        sequence: 0,
        presetStepId: "preset-a",
        title: "Pack towel",
        durationMinutes: 10
      }),
      existingStep({
        id: "pend-extra",
        sequence: 1,
        presetStepId: "preset-b",
        title: "Fill water bottle",
        durationMinutes: 5,
        dependsOnIds: ["done-1"]
      })
    ];
    // The preset now has only the one step the done row already occupies.
    const template = [
      templateStep({ title: "Pack towel", durationMinutes: 10, presetStepId: "preset-a", dependsOn: [] })
    ];
    const plan = planRoutineStepReconciliation(existing, template);
    expect(plan.changed).toBe(true);
    expect(plan.ops).toEqual([
      { kind: "keep", id: "done-1" },
      { kind: "delete", id: "pend-extra" }
    ]);
    expect(plan.finalSteps).toEqual([
      { id: "done-1", phase: "before", durationMinutes: 10, status: "completed", contexts: [] }
    ]);
  });

  it("deletes exactly the removed middle preset step, leaving its id-linked siblings alone", () => {
    // A(preset-a) - B(preset-b) - C(preset-c), all pending and already id-matched. The preset drops
    // B from the middle; A and C keep their own identity and content untouched (no repurposing).
    const existing = [
      existingStep({ id: "row-a", sequence: 0, presetStepId: "preset-a", title: "A" }),
      existingStep({ id: "row-b", sequence: 1, presetStepId: "preset-b", title: "B" }),
      existingStep({ id: "row-c", sequence: 2, presetStepId: "preset-c", title: "C", dependsOnIds: ["row-a"] })
    ];
    const template = [
      templateStep({ title: "A", presetStepId: "preset-a" }),
      // B is gone; C now sits at template index 1 and still depends on A (template position 0).
      templateStep({ title: "C", presetStepId: "preset-c", dependsOn: [0] })
    ];
    const plan = planRoutineStepReconciliation(existing, template);
    expect(plan.changed).toBe(true);
    // row-c is id-matched to template index 1 (not position-matched to whatever used to be there), so
    // it is a "keep" once its now-differing sequence is accounted for — here it must move, since it
    // used to sit at template index 2.
    expect(plan.ops).toEqual([
      { kind: "keep", id: "row-a" },
      {
        kind: "update",
        id: "row-c",
        templateIndex: 1,
        sequence: 1,
        step: template[1],
        dependsOnIds: ["row-a"]
      },
      { kind: "delete", id: "row-b" }
    ]);
    expect(plan.finalSteps.map((step) => step.id)).toEqual(["row-a", "row-c"]);
  });

  it("inserts a new preset step mid-list rather than repurposing an id-linked later step", () => {
    // A(preset-a, pending) - B(preset-b, pending), both already id-matched from a prior sync. The
    // preset inserts a new step X between them. Position matching would have repurposed B's row
    // content into X; id matching must insert X fresh and leave B's own row (and its content) alone.
    const existing = [
      existingStep({ id: "row-a", sequence: 0, presetStepId: "preset-a", title: "A" }),
      existingStep({ id: "row-b", sequence: 1, presetStepId: "preset-b", title: "B", dependsOnIds: ["row-a"] })
    ];
    const template = [
      templateStep({ title: "A", presetStepId: "preset-a" }),
      templateStep({ title: "X", presetStepId: "preset-x", dependsOn: [0] }),
      templateStep({ title: "B", presetStepId: "preset-b", dependsOn: [1] })
    ];
    const plan = planRoutineStepReconciliation(existing, template, idSequence("row-x"));
    expect(plan.changed).toBe(true);
    expect(plan.ops).toEqual([
      { kind: "keep", id: "row-a" },
      {
        kind: "insert",
        id: "row-x",
        templateIndex: 1,
        sequence: 1,
        step: template[1],
        dependsOnIds: ["row-a"]
      },
      // row-b keeps its own id and content, just moves to its new template position and now depends
      // on the freshly inserted X instead of A directly.
      {
        kind: "update",
        id: "row-b",
        templateIndex: 2,
        sequence: 2,
        step: template[2],
        dependsOnIds: ["row-x"]
      }
    ]);
    expect(plan.finalSteps.map((step) => step.id)).toEqual(["row-a", "row-x", "row-b"]);
  });

  it("inserts a new preset step appended after a done step, at the end of the chain", () => {
    const existing = [
      existingStep({
        id: "done-1",
        status: "completed",
        sequence: 0,
        presetStepId: "preset-a",
        title: "Pack towel",
        durationMinutes: 10
      })
    ];
    const template = [
      templateStep({ title: "Pack towel", durationMinutes: 10, presetStepId: "preset-a", dependsOn: [] }),
      templateStep({ title: "Grab goggles", durationMinutes: 7, presetStepId: "preset-b", dependsOn: [0] })
    ];
    const plan = planRoutineStepReconciliation(existing, template, idSequence("new-1"));
    expect(plan.changed).toBe(true);
    expect(plan.ops).toEqual([
      { kind: "keep", id: "done-1" },
      {
        kind: "insert",
        id: "new-1",
        templateIndex: 1,
        sequence: 1,
        step: template[1],
        dependsOnIds: ["done-1"]
      }
    ]);
    expect(plan.finalSteps).toEqual([
      { id: "done-1", phase: "before", durationMinutes: 10, status: "completed", contexts: [] },
      { id: "new-1", phase: "before", durationMinutes: 7, status: "pending", contexts: [] }
    ]);
  });

  it("deletes every pending row and keeps every locked row when reconciled against an empty template", () => {
    // syncInheritedRoutineSteps never calls this with an empty template in practice (it skips
    // unresolved presets before reconciling), but the pure function itself must still behave
    // correctly at this boundary.
    const existing = [existingStep({ id: "done-1", status: "completed" }), existingStep({ id: "pend-1" })];
    const plan = planRoutineStepReconciliation(existing, []);
    // With no template steps at all, the main (template-driven) pass never runs; both rows are
    // resolved entirely by the fallback pass. done-1 is an unclaimed locked row anchored at "before
    // everything" (no template step to trail), so it is emitted — already at sequence 0, so a "keep" —
    // ahead of the trailing delete for the unclaimed pending row.
    expect(plan.ops).toEqual([
      { kind: "keep", id: "done-1" },
      { kind: "delete", id: "pend-1" }
    ]);
  });

  it("keeps a locked row that matches no template step in its true relative position, reindexing every row into a contiguous template-order run", () => {
    // A(preset-a) is followed by a hand-cancelled step whose own preset step was since deleted (no
    // presetStepId match, and the position fallback has nothing left to offer it either since both
    // template slots are already id-claimed), then B(preset-b). Their *stored* sequences reflect the
    // old offset-based scheme this fix replaces: the locked row's small sequence (5, its old untouched
    // position) already sorted ahead of both pending rows' large ones (100000+) — the exact
    // display-order bug being fixed.
    const existing = [
      existingStep({ id: "row-a", status: "pending", sequence: 100_000, presetStepId: "preset-a", title: "A" }),
      existingStep({
        id: "cancelled-x",
        status: "cancelled",
        sequence: 5,
        presetStepId: null,
        title: "Emergency call"
      }),
      existingStep({ id: "row-b", status: "pending", sequence: 100_001, presetStepId: "preset-b", title: "B" })
    ];
    const template = [
      templateStep({ title: "A", presetStepId: "preset-a" }),
      templateStep({ title: "B", presetStepId: "preset-b" })
    ];
    const plan = planRoutineStepReconciliation(existing, template);
    expect(plan.changed).toBe(true);
    // row-a is pending and its stored sequence (100000) doesn't match its new target (0), so it is
    // rewritten via "update" even though its content is otherwise unchanged — the existing behaviour
    // for a pending row whose position moved. cancelled-x is locked, so only its sequence moves
    // ("reseq"), landing right where it always sat: between A and B. row-b is likewise a pending
    // "update" onto its new position.
    expect(plan.ops).toEqual([
      { kind: "update", id: "row-a", templateIndex: 0, sequence: 0, step: template[0], dependsOnIds: [] },
      { kind: "reseq", id: "cancelled-x", sequence: 1 },
      { kind: "update", id: "row-b", templateIndex: 1, sequence: 2, step: template[1], dependsOnIds: [] }
    ]);
    // The reconciled order is template order with the locked row back in its true middle position —
    // contiguous 0..n-1, not the locked-rows-float-to-the-top bug the old offset scheme produced.
    expect(plan.finalSteps).toEqual([
      { id: "row-a", phase: "before", durationMinutes: 10, status: "pending", contexts: [] },
      { id: "cancelled-x", phase: "before", durationMinutes: 10, status: "cancelled", contexts: [] },
      { id: "row-b", phase: "before", durationMinutes: 10, status: "pending", contexts: [] }
    ]);
  });

  it("produces no operations at all for a commitment whose locked row already sits at its correct reconciled position", () => {
    // Same shape as above, but every stored sequence already reflects the fix's own contiguous
    // template-order scheme — a fully-synced commitment, locked row included, must still be a true
    // no-op.
    const existing = [
      existingStep({ id: "row-a", status: "pending", sequence: 0, presetStepId: "preset-a", title: "A" }),
      existingStep({
        id: "cancelled-x",
        status: "cancelled",
        sequence: 1,
        presetStepId: null,
        title: "Emergency call"
      }),
      existingStep({ id: "row-b", status: "pending", sequence: 2, presetStepId: "preset-b", title: "B" })
    ];
    const template = [
      templateStep({ title: "A", presetStepId: "preset-a" }),
      templateStep({ title: "B", presetStepId: "preset-b" })
    ];
    const plan = planRoutineStepReconciliation(existing, template);
    expect(plan.changed).toBe(false);
    expect(plan.ops).toEqual([
      { kind: "keep", id: "row-a" },
      { kind: "keep", id: "cancelled-x" },
      { kind: "keep", id: "row-b" }
    ]);
  });

  it("throws when a template step depends on its own position", () => {
    const template = [templateStep({ title: "A", dependsOn: [0] })];
    expect(() => planRoutineStepReconciliation([], template)).toThrow("A routine connection is invalid.");
  });

  it("throws when a template step depends on a position beyond the template", () => {
    const template = [templateStep({ title: "A", dependsOn: [5] })];
    expect(() => planRoutineStepReconciliation([], template)).toThrow("A routine connection is invalid.");
  });

  it("treats a changed wait as a real difference on a pending row (0→30)", () => {
    const existing = [existingStep({ id: "row-a", sequence: 0, presetStepId: "preset-a", waitAfterMinutes: 0 })];
    const template = [templateStep({ presetStepId: "preset-a", waitAfterMinutes: 30 })];
    const plan = planRoutineStepReconciliation(existing, template);
    expect(plan.changed).toBe(true);
    expect(plan.ops).toEqual([
      { kind: "update", id: "row-a", templateIndex: 0, sequence: 0, step: template[0], dependsOnIds: [] }
    ]);
  });

  it("treats absent wait/mustStartBy/preferredBands as equal to explicit defaults", () => {
    const existing = [
      existingStep({
        id: "row-a",
        sequence: 0,
        presetStepId: "preset-a",
        waitAfterMinutes: 0,
        mustStartByMinutes: null,
        preferredBands: []
      })
    ];
    // Template has all three absent (undefined)
    const template = [
      templateStep({
        presetStepId: "preset-a"
        // waitAfterMinutes, mustStartByMinutes, preferredBands all absent
      })
    ];
    const plan = planRoutineStepReconciliation(existing, template);
    expect(plan.changed).toBe(false);
    expect(plan.ops).toEqual([{ kind: "keep", id: "row-a" }]);
  });

  it("keeps a locked row untouched even when its wait changes", () => {
    const existing = [
      existingStep({
        id: "done-1",
        status: "completed",
        sequence: 0,
        presetStepId: "preset-a",
        waitAfterMinutes: 0
      })
    ];
    const template = [templateStep({ presetStepId: "preset-a", waitAfterMinutes: 30 })];
    const plan = planRoutineStepReconciliation(existing, template);
    expect(plan.changed).toBe(false);
    expect(plan.ops).toEqual([{ kind: "keep", id: "done-1" }]);
  });
});
