import { describe, expect, it } from "vitest";
import type { CadenceGateRule } from "./cadence-step-gate.js";
import { isPresetStepEligibleToday } from "./routine-inheritance.js";

// planRoutineStepReconciliation tests moved to @openrhen/contracts/src/planning/routine-reconciliation.test.ts
// computeRoutineStepSchedule tests moved to engine/core/test/scheduling/routine-placement.test.ts — the
// engine is the only placer now.

/**
 * a preset step's cadence link the gate cannot evaluate — the linked action gone, or no
 * longer `schedulingMode: 'cadence'` — used to fail open (included every day, recording nothing on
 * completion). It now fails closed: not due, so left out of today's template, exactly like any other
 * day the cadence isn't due. The engine's `deriveCommitmentRoutineSteps` builds `cadenceGateByActionId`
 * only from actions actually in cadence mode with a rule, so a missing map entry is exactly this case.
 */
describe("isPresetStepEligibleToday", () => {
  const now = new Date("2026-09-05T01:00:00.000Z");
  const gate: CadenceGateRule = { intervalDays: 1, timezone: "Australia/Sydney", startDate: "2026-01-01" };

  it("offers a step with no cadence link at all, unconditionally", () => {
    expect(isPresetStepEligibleToday(null, new Map(), now)).toBe(true);
  });

  it("offers a linked step when the gate can evaluate it and the cadence is due", () => {
    const byAction = new Map([["action-1", gate]]);
    expect(isPresetStepEligibleToday("action-1", byAction, now)).toBe(true);
  });

  it("withholds a linked step when the gate can evaluate it and the cadence is not yet due", () => {
    const notDue: CadenceGateRule = { ...gate, lastCompletedLocalDate: "2026-09-05" };
    const byAction = new Map([["action-1", notDue]]);
    expect(isPresetStepEligibleToday("action-1", byAction, now)).toBe(false);
  });

  it("withholds — never includes — a step whose linked action the gate cannot evaluate", () => {
    // No entry in the map at all: the action no longer exists, or is no longer schedulingMode 'cadence'.
    expect(isPresetStepEligibleToday("gone-or-not-cadence", new Map(), now)).toBe(false);
  });
});
