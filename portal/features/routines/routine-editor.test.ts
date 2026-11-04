import { describe, expect, it } from "vitest";
import {
  newRoutineStep,
  normalizeRoutineLabel,
  patchRoutineStep,
  removeRoutineStep,
  routineGraphLevels,
  routinePresetDraft,
  routinePresetsForView,
  toggleRoutineAccordion,
  topologicalRoutineSteps,
  validateRoutineGraph
} from "./routine-editor";
import type { RoutinePreset } from "@/state/portal-state";

const preset: RoutinePreset = {
  id: "morning",
  name: "Morning preparation",
  activityName: "Leave for campus",
  status: "active",
  replacesWakeRoutine: false,
  version: 3,
  steps: [
    {
      id: "pack",
      title: "Pack bag",
      durationMinutes: 10,
      sequence: 0,
      timingRule: "flexible",
      maxLeadMinutes: 90,
      energy: "low",
      contexts: ["home"],
      dependencyIds: [],
      phase: "before"
    }
  ]
};

describe("routine preset editor state", () => {
  it("opens one accordion at a time and closes the active accordion", () => {
    expect(toggleRoutineAccordion(null, "morning")).toBe("morning");
    expect(toggleRoutineAccordion("morning", "evening")).toBe("evening");
    expect(toggleRoutineAccordion("morning", "morning")).toBeNull();
  });

  it("loads an existing preset into an isolated editable draft", () => {
    const draft = routinePresetDraft(preset);
    expect(draft).toMatchObject({ id: "morning", name: "Morning preparation", status: "active" });
    draft.steps[0]!.contexts.push("phone");
    expect(preset.steps[0]!.contexts).toEqual(["home"]);
  });

  it("creates a blank new-preset draft", () => {
    expect(routinePresetDraft()).toEqual({
      id: "",
      name: "",
      activityName: "",
      status: "active",
      replacesWakeRoutine: false,
      steps: []
    });
  });

  it("keeps normal spaces in user-facing routine names", () => {
    expect(normalizeRoutineLabel("  Morning   gym routine  ")).toBe("Morning gym routine");
  });

  it("keeps archived routines out of the active view", () => {
    const archived = { ...preset, id: "old", status: "archived" as const };
    expect(routinePresetsForView([preset, archived], false).map((item) => item.id)).toEqual(["morning"]);
    expect(routinePresetsForView([preset, archived], true).map((item) => item.id)).toEqual(["old"]);
  });

  it("calculates deterministic dependency levels and topological order", () => {
    const a = { ...newRoutineStep("a", 0), title: "A" };
    const b = { ...newRoutineStep("b", 1), title: "B", dependencyIds: ["a"] };
    const c = { ...newRoutineStep("c", 2), title: "C", dependencyIds: ["a"] };
    const d = { ...newRoutineStep("d", 3), title: "D", dependencyIds: ["b", "c"] };
    expect(routineGraphLevels([d, c, a, b]).before.map((level) => level.map((step) => step.id))).toEqual([
      ["a"],
      ["b", "c"],
      ["d"]
    ]);
    expect(topologicalRoutineSteps([d, c, a, b]).map((step) => step.id)).toEqual(["a", "b", "c", "d"]);
  });
  it("rejects cycles self-links duplicates and missing steps", () => {
    const a = { ...newRoutineStep("a", 0), dependencyIds: ["b"] };
    const b = { ...newRoutineStep("b", 1), dependencyIds: ["a"] };
    expect(validateRoutineGraph([a, b])).toMatch(/cycle/);
    expect(validateRoutineGraph([{ ...a, dependencyIds: ["a"] }])).toMatch(/itself/);
    expect(validateRoutineGraph([{ ...a, dependencyIds: ["b", "b"] }, b])).toMatch(/duplicate/);
    expect(validateRoutineGraph([{ ...a, dependencyIds: ["missing"] }])).toMatch(/no longer exists/);
  });

  it("levels before-steps and after-steps independently around the commitment", () => {
    const a = { ...newRoutineStep("a", 0, "before"), title: "A" };
    const b = { ...newRoutineStep("b", 1, "before"), title: "B", dependencyIds: ["a"] };
    const x = { ...newRoutineStep("x", 2, "after"), title: "X" };
    const y = { ...newRoutineStep("y", 3, "after"), title: "Y", dependencyIds: ["x"] };
    const levels = routineGraphLevels([b, y, a, x]);
    expect(levels.before.map((level) => level.map((step) => step.id))).toEqual([["a"], ["b"]]);
    expect(levels.after.map((level) => level.map((step) => step.id))).toEqual([["x"], ["y"]]);
    expect(topologicalRoutineSteps([b, y, a, x]).map((step) => step.id)).toEqual(["a", "b", "x", "y"]);
  });
  it("rejects a connection that crosses before/after the commitment", () => {
    const before = { ...newRoutineStep("before", 0, "before") };
    const after = { ...newRoutineStep("after", 1, "after"), dependencyIds: ["before"] };
    expect(validateRoutineGraph([before, after])).toMatch(/before\/after/);
  });
  it("defaults new steps to the before phase and accepts an explicit phase", () => {
    expect(newRoutineStep("one", 0).phase).toBe("before");
    expect(newRoutineStep("two", 1, "after").phase).toBe("after");
  });

  it("adds, patches, and removes steps without mutating earlier state", () => {
    const original = [newRoutineStep("one", 0)];
    const withFlexibleTiming = patchRoutineStep(original, 0, { timingRule: "flexible", maxLeadMinutes: 60 });
    expect(withFlexibleTiming[0]).toMatchObject({ timingRule: "flexible", maxLeadMinutes: 60 });
    expect(original[0]).toMatchObject({ timingRule: "contiguous" });
    expect(removeRoutineStep(withFlexibleTiming, 0)).toEqual([]);
  });
});
