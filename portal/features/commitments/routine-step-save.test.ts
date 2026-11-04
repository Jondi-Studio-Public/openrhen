import { describe, expect, it } from "vitest";
import type { StoredRoutineStep } from "@/state/portal-state";
import { routineStepEntity } from "./routine-step-save";

const step = (overrides: Partial<StoredRoutineStep> = {}): StoredRoutineStep =>
  ({
    id: "drive",
    version: 4,
    commitmentId: "class",
    title: "Drive to College",
    durationMinutes: 30,
    sequence: 2,
    timingRule: "contiguous",
    energy: "low",
    contexts: ["car"],
    dependencyIds: ["pack-bag"],
    phase: "before",
    status: "pending",
    ...overrides
  }) as unknown as StoredRoutineStep;

describe("routineStepEntity", () => {
  /*
   * The entity command is a whole-row write. A status-only save that quietly dropped the sequence,
   * the dependencies or the linked occurrence would clear the step's place in its routine, which is
   * why marking done restates every column rather than sending the one that changed.
   */
  it("restates every column when only the status changes", () => {
    const original = step({ actionWindowId: "morning-window" });
    expect(routineStepEntity(original, { status: "completed" })).toEqual({
      id: "drive",
      commitmentId: "class",
      title: "Drive to College",
      durationMinutes: 30,
      sequence: 2,
      timingRule: "contiguous",
      energy: "low",
      contexts: ["car"],
      dependencyIds: ["pack-bag"],
      phase: "before",
      actionWindowId: "morning-window",
      status: "completed"
    });
  });

  it("hands the step straight back when nothing is changed", () => {
    expect(routineStepEntity(step())).toMatchObject({ status: "pending", title: "Drive to College", sequence: 2 });
  });

  it("carries the lead window only while the step is flexible", () => {
    expect(routineStepEntity(step({ timingRule: "flexible", maxLeadMinutes: 120 }))).toMatchObject({
      timingRule: "flexible",
      maxLeadMinutes: 120
    });
    // Switching to contiguous drops the window rather than leaving one that outlives the switch.
    expect(
      routineStepEntity(step({ timingRule: "flexible", maxLeadMinutes: 120 }), { timingRule: "contiguous" })
    ).not.toHaveProperty("maxLeadMinutes");
    // And switching the other way carries the new window rather than the absent stored one.
    expect(routineStepEntity(step(), { timingRule: "flexible", maxLeadMinutes: 45 })).toMatchObject({
      timingRule: "flexible",
      maxLeadMinutes: 45
    });
  });

  it("omits the linked occurrence when the step has none", () => {
    expect(routineStepEntity(step())).not.toHaveProperty("actionWindowId");
  });

  it("applies a full edit while keeping what the form does not own", () => {
    const entity = routineStepEntity(step(), {
      title: "Walk to College",
      durationMinutes: 45,
      energy: "medium",
      phase: "after"
    });
    expect(entity).toMatchObject({ title: "Walk to College", durationMinutes: 45, energy: "medium", phase: "after" });
    // The form has no field for these, so they come back from the stored step untouched.
    expect(entity).toMatchObject({ sequence: 2, contexts: ["car"], dependencyIds: ["pack-bag"], status: "pending" });
  });
});
