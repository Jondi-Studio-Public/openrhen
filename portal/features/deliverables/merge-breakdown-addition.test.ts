import { describe, expect, it } from "vitest";
import { criterion, deliverable, step } from "@/features/deliverables/test-fixtures";
import { mergeBreakdownAddition } from "./merge-breakdown-addition";

describe("mergeBreakdownAddition", () => {
  it("adds agreed criteria and steps and links them by title", () => {
    let id = 0;
    const result = mergeBreakdownAddition(
      deliverable({ criteria: [], steps: [] }),
      {
        criteria: [{ title: "Three models completed", required: true }],
        steps: [
          {
            title: "Create three part models",
            expectedMinutes: 90,
            criteriaServed: ["Three models completed"],
            dependsOnStepTitles: []
          }
        ]
      },
      () => `new-${++id}`
    );
    expect(result).toMatchObject({ changed: true, addedCriteria: 1, addedSteps: 1, addedLinks: 1 });
    expect(result.deliverable.criteria[0]).toMatchObject({ title: "Three models completed", stepIds: ["new-3"] });
    expect(result.deliverable.steps[0]).toMatchObject({ id: "new-3", expectedMinutes: 90, remainingMinutes: 90 });
  });

  it("is idempotent after a tool-call retry", () => {
    const existingStep = step("make-models", { title: "Create three part models", expectedMinutes: 90 });
    const existingCriterion = criterion("models", {
      title: "Three models completed",
      stepIds: [existingStep.id]
    });
    const original = deliverable({ criteria: [existingCriterion], steps: [existingStep] });
    const result = mergeBreakdownAddition(original, {
      criteria: [{ title: " three MODELS completed ", required: true }],
      steps: [
        {
          title: "CREATE THREE PART MODELS",
          expectedMinutes: 90,
          criteriaServed: ["Three models completed"],
          dependsOnStepTitles: []
        }
      ]
    });
    expect(result).toMatchObject({ changed: false, addedCriteria: 0, addedSteps: 0, addedLinks: 0 });
    expect(result.deliverable).toBe(original);
  });

  it("carries the source provenance a requirement was talked out of", () => {
    const result = mergeBreakdownAddition(
      deliverable({ criteria: [], steps: [] }),
      {
        criteria: [
          {
            title: "Three models completed",
            required: true,
            interpretation: "Each model is a separate part file, not three views of one.",
            sourceDocument: "Assessment brief",
            sourceLocation: "Task 2, page 4",
            expectedEvidence: "Three saved .prt files",
            verificationMethod: "llm_inspection"
          }
        ],
        steps: []
      },
      () => "criterion-id"
    );
    expect(result.deliverable.criteria[0]).toMatchObject({
      interpretation: "Each model is a separate part file, not three views of one.",
      sourceDocument: "Assessment brief",
      sourceLocation: "Task 2, page 4",
      expectedEvidence: "Three saved .prt files",
      verificationMethod: "llm_inspection"
    });
  });

  it("leaves the provenance fields off entirely when the conversation did not establish them", () => {
    const result = mergeBreakdownAddition(
      deliverable({ criteria: [], steps: [] }),
      { criteria: [{ title: "PDFs are readable", required: true }], steps: [] },
      () => "criterion-id"
    );
    expect(result.deliverable.criteria[0]).not.toHaveProperty("sourceDocument");
    expect(result.deliverable.criteria[0]).not.toHaveProperty("verificationMethod");
  });

  it("can link an existing step to a newly added criterion without duplicating the step", () => {
    const existingStep = step("export", { title: "Export PDFs" });
    const result = mergeBreakdownAddition(
      deliverable({ criteria: [], steps: [existingStep] }),
      {
        criteria: [{ title: "PDFs are readable", required: true }],
        steps: [
          { title: "Export PDFs", expectedMinutes: 15, criteriaServed: ["PDFs are readable"], dependsOnStepTitles: [] }
        ]
      },
      () => "criterion-id"
    );
    expect(result).toMatchObject({ changed: true, addedCriteria: 1, addedSteps: 0, addedLinks: 1 });
    expect(result.deliverable.steps).toHaveLength(1);
    expect(result.deliverable.criteria[0]?.stepIds).toEqual(["export"]);
  });

  it("chains a new step onto an existing one by title", () => {
    const existingStep = step("draft", { title: "Draft the report" });
    let id = 0;
    const result = mergeBreakdownAddition(
      deliverable({ criteria: [], steps: [existingStep] }),
      {
        criteria: [],
        steps: [
          {
            title: "Submit the report",
            expectedMinutes: 10,
            criteriaServed: [],
            dependsOnStepTitles: ["Draft the report"]
          }
        ]
      },
      () => `new-${++id}`
    );
    expect(result.deliverable.steps.find((item) => item.title === "Submit the report")).toMatchObject({
      dependencyIds: ["draft"]
    });
    expect(result.unresolvedDependencyTitles).toEqual([]);
  });

  it("resolves a chain within the same addition batch, in order", () => {
    let id = 0;
    const result = mergeBreakdownAddition(
      deliverable({ criteria: [], steps: [] }),
      {
        criteria: [],
        steps: [
          { title: "Draft the report", expectedMinutes: 60, criteriaServed: [], dependsOnStepTitles: [] },
          {
            title: "Submit the report",
            expectedMinutes: 10,
            criteriaServed: [],
            dependsOnStepTitles: ["Draft the report"]
          }
        ]
      },
      () => `new-${++id}`
    );
    const draft = result.deliverable.steps.find((item) => item.title === "Draft the report")!;
    const submit = result.deliverable.steps.find((item) => item.title === "Submit the report")!;
    expect(submit.dependencyIds).toEqual([draft.id]);
    expect(result.unresolvedDependencyTitles).toEqual([]);
  });

  it("cannot chain onto a step later in the same batch — only earlier ones resolve", () => {
    let id = 0;
    const result = mergeBreakdownAddition(
      deliverable({ criteria: [], steps: [] }),
      {
        criteria: [],
        steps: [
          {
            title: "Draft the report",
            expectedMinutes: 60,
            criteriaServed: [],
            dependsOnStepTitles: ["Submit the report"]
          },
          { title: "Submit the report", expectedMinutes: 10, criteriaServed: [], dependsOnStepTitles: [] }
        ]
      },
      () => `new-${++id}`
    );
    const draft = result.deliverable.steps.find((item) => item.title === "Draft the report")!;
    expect(draft.dependencyIds).toEqual([]);
    expect(result.unresolvedDependencyTitles).toEqual(["Submit the report"]);
  });

  it("reports an unresolvable dependency title instead of silently dropping it", () => {
    let id = 0;
    const result = mergeBreakdownAddition(
      deliverable({ criteria: [], steps: [] }),
      {
        criteria: [],
        steps: [
          {
            title: "Submit the report",
            expectedMinutes: 10,
            criteriaServed: [],
            dependsOnStepTitles: ["A step that was never proposed"]
          }
        ]
      },
      () => `new-${++id}`
    );
    expect(result.deliverable.steps[0]?.dependencyIds).toEqual([]);
    expect(result.unresolvedDependencyTitles).toEqual(["A step that was never proposed"]);
  });

  it("retrofits an additional prerequisite onto an existing step without recreating it", () => {
    const revision = step("revise", { title: "Redraw the callouts" });
    const handoff = step("handoff", { title: "Resubmit and get approval", dependencyIds: [] });
    const result = mergeBreakdownAddition(deliverable({ criteria: [], steps: [revision, handoff] }), {
      criteria: [],
      steps: [
        {
          title: "Resubmit and get approval",
          expectedMinutes: 10,
          criteriaServed: [],
          dependsOnStepTitles: ["Redraw the callouts"]
        }
      ]
    });
    expect(result).toMatchObject({ changed: true, addedSteps: 0, addedDependencies: 1 });
    expect(result.deliverable.steps).toHaveLength(2);
    expect(result.deliverable.steps.find((item) => item.id === "handoff")).toMatchObject({
      dependencyIds: ["revise"]
    });
    // The untouched step in the original deliverable is not mutated in place.
    expect(handoff.dependencyIds).toEqual([]);
  });

  it("keeps an existing prerequisite when the retrofit repeats it, and reports no change", () => {
    const revision = step("revise", { title: "Redraw the callouts" });
    const handoff = step("handoff", { title: "Resubmit and get approval", dependencyIds: ["revise"] });
    const original = deliverable({ criteria: [], steps: [revision, handoff] });
    const result = mergeBreakdownAddition(original, {
      criteria: [],
      steps: [
        {
          title: "Resubmit and get approval",
          expectedMinutes: 10,
          criteriaServed: [],
          dependsOnStepTitles: ["Redraw the callouts"]
        }
      ]
    });
    expect(result).toMatchObject({ changed: false, addedDependencies: 0 });
    expect(result.deliverable).toBe(original);
  });

  it("reports an unresolved retrofit dependency instead of silently dropping it", () => {
    const handoff = step("handoff", { title: "Resubmit and get approval" });
    const result = mergeBreakdownAddition(deliverable({ criteria: [], steps: [handoff] }), {
      criteria: [],
      steps: [
        {
          title: "Resubmit and get approval",
          expectedMinutes: 10,
          criteriaServed: [],
          dependsOnStepTitles: ["A revision step that was never proposed"]
        }
      ]
    });
    expect(result.deliverable.steps[0]?.dependencyIds).toEqual([]);
    expect(result.unresolvedDependencyTitles).toEqual(["A revision step that was never proposed"]);
  });

  it("carries details and reblockOnComplete onto a newly created step only", () => {
    let id = 0;
    const result = mergeBreakdownAddition(
      deliverable({ criteria: [], steps: [] }),
      {
        criteria: [],
        steps: [
          {
            title: "Resubmit the drawing package",
            expectedMinutes: 20,
            criteriaServed: [],
            dependsOnStepTitles: [],
            details: "From teacher feedback: resubmit after the five corrections.",
            reblockOnComplete: {
              description: "Waiting for the teacher's email response on the resubmission.",
              category: "waiting_on_someone"
            }
          }
        ]
      },
      () => `new-${++id}`
    );
    expect(result.deliverable.steps[0]).toMatchObject({
      details: "From teacher feedback: resubmit after the five corrections.",
      reblockOnComplete: {
        description: "Waiting for the teacher's email response on the resubmission.",
        category: "waiting_on_someone"
      }
    });
  });

  it("ignores details and reblockOnComplete when the title matches an existing step", () => {
    const handoff = step("handoff", { title: "Resubmit and get approval" });
    const result = mergeBreakdownAddition(deliverable({ criteria: [], steps: [handoff] }), {
      criteria: [],
      steps: [
        {
          title: "Resubmit and get approval",
          expectedMinutes: 10,
          criteriaServed: [],
          dependsOnStepTitles: [],
          details: "Should not land on the existing step.",
          reblockOnComplete: { description: "Should not land either.", category: "other" }
        }
      ]
    });
    expect(result.deliverable.steps[0]).not.toHaveProperty("details");
    expect(result.deliverable.steps[0]).not.toHaveProperty("reblockOnComplete");
  });

  it("reports a step naming itself as its own prerequisite instead of storing a self-reference", () => {
    let id = 0;
    const result = mergeBreakdownAddition(
      deliverable({ criteria: [], steps: [] }),
      {
        criteria: [],
        steps: [
          {
            title: "Submit the report",
            expectedMinutes: 10,
            criteriaServed: [],
            dependsOnStepTitles: ["Submit the report"]
          }
        ]
      },
      () => `new-${++id}`
    );
    expect(result.deliverable.steps[0]?.dependencyIds).toEqual([]);
    expect(result.unresolvedDependencyTitles).toEqual(["Submit the report"]);
  });

  describe("dependency cycles", () => {
    it("reports a direct two-step cycle and does not persist the retrofit", () => {
      // Existing chain: "Redraw the callouts" already depends on "Resubmit and get approval".
      const approval = step("approval", { title: "Resubmit and get approval" });
      const redraw = step("redraw", { title: "Redraw the callouts", dependencyIds: [approval.id] });
      const original = deliverable({ criteria: [], steps: [approval, redraw] });
      // Retrofitting "Resubmit and get approval" to also wait on "Redraw the callouts" closes the loop.
      const result = mergeBreakdownAddition(original, {
        criteria: [],
        steps: [
          {
            title: "Resubmit and get approval",
            expectedMinutes: 10,
            criteriaServed: [],
            dependsOnStepTitles: ["Redraw the callouts"]
          }
        ]
      });
      expect(result.cyclePath).toEqual([
        "Resubmit and get approval",
        "Redraw the callouts",
        "Resubmit and get approval"
      ]);
      // The deliverable returned still carries the offending edge — the caller rejects the whole call
      // before ever saving it — but nothing about the merge itself should be mistaken for success.
      expect(result.changed).toBe(true);
    });

    it("reports an indirect three-step cycle", () => {
      const a = step("a", { title: "A" });
      const b = step("b", { title: "B", dependencyIds: [a.id] });
      const c = step("c", { title: "C", dependencyIds: [b.id] });
      const original = deliverable({ criteria: [], steps: [a, b, c] });
      // Retrofit "A" to also depend on "C", closing A -> C -> B -> A.
      const result = mergeBreakdownAddition(original, {
        criteria: [],
        steps: [{ title: "A", expectedMinutes: 10, criteriaServed: [], dependsOnStepTitles: ["C"] }]
      });
      expect(result.cyclePath).toEqual(["A", "C", "B", "A"]);
    });

    it("accepts a legitimate diamond where two steps share a common dependency", () => {
      let id = 0;
      const foundation = step("foundation", { title: "Lay the foundation" });
      const original = deliverable({ criteria: [], steps: [foundation] });
      const result = mergeBreakdownAddition(
        original,
        {
          criteria: [],
          steps: [
            {
              title: "Frame the walls",
              expectedMinutes: 60,
              criteriaServed: [],
              dependsOnStepTitles: ["Lay the foundation"]
            },
            {
              title: "Run the wiring",
              expectedMinutes: 60,
              criteriaServed: [],
              dependsOnStepTitles: ["Lay the foundation"]
            },
            {
              title: "Final inspection",
              expectedMinutes: 30,
              criteriaServed: [],
              dependsOnStepTitles: ["Frame the walls", "Run the wiring"]
            }
          ]
        },
        () => `new-${++id}`
      );
      expect(result.cyclePath).toBeNull();
      expect(result.changed).toBe(true);
      const inspection = result.deliverable.steps.find((item) => item.title === "Final inspection")!;
      expect(inspection.dependencyIds).toHaveLength(2);
    });

    it("does not run cycle detection, and reports no cycle, when nothing added a dependency edge", () => {
      const existing = step("existing", { title: "Existing step" });
      const original = deliverable({ criteria: [criterion("c", { title: "Done" })], steps: [existing] });
      const result = mergeBreakdownAddition(original, {
        criteria: [],
        steps: [{ title: "Existing step", expectedMinutes: 30, criteriaServed: ["Done"], dependsOnStepTitles: [] }]
      });
      expect(result.cyclePath).toBeNull();
    });
  });
});
