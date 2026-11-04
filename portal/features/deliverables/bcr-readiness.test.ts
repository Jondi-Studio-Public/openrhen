import { describe, expect, it } from "vitest";
import { assessDeliverable, cyclicSteps } from "@openrhen/contracts";
import type { StoredDeliverable, StoredDeliverableStep } from "@/state/portal-state";

const now = new Date("2026-08-17T09:00:00.000Z");

const step = (id: string, extra: Partial<StoredDeliverableStep> = {}): StoredDeliverableStep => ({
  id,
  title: `Step ${id}`,
  status: "planned",
  optimisticMinutes: 20,
  expectedMinutes: 30,
  pessimisticMinutes: 45,
  remainingMinutes: 30,
  energy: "high",
  minimumSessionMinutes: 15,
  maximumSessionMinutes: 60,
  splittable: true,
  setupMinutes: 0,
  required: true,
  sortOrder: 0,
  dependencyIds: [],
  requirementPathways: [],
  ...extra
});

const deliverable = (extra: Partial<StoredDeliverable> = {}): StoredDeliverable => ({
  id: "assessment-2",
  projectId: "networking",
  title: "Assessment 2",
  status: "in_progress",
  uncertainty: "some",
  importance: 5,
  consequence: 5,
  contractVersion: 1,
  planVersion: 1,
  contractApprovedAt: "2026-08-18T00:00:00.000Z",
  planApprovedAt: "2026-08-18T00:00:00.000Z",
  sortOrder: 0,
  dependencyIds: [],
  sourceIds: [],
  sourceFiles: [],
  steps: [],
  criteria: [],
  blockers: [],
  contractProposals: [],
  ...extra
});

const assess = (value: StoredDeliverable) =>
  assessDeliverable({
    deliverable: value,
    situation: { locationId: null, overrides: {}, carrying: {}, transportModes: ["car"], travel: {}, travelOff: false },
    conditionDefinitions: [],
    now
  });

describe("BCR readiness", () => {
  it("keeps the deliverable available while one blocked step leaves another executable", () => {
    const result = assess(
      deliverable({
        steps: [step("diagram"), step("evidence")],
        blockers: [
          {
            id: "unclear",
            description: "Evidence requirements are unclear",
            category: "missing_information",
            state: "open",
            stepIds: ["evidence"]
          }
        ]
      })
    );
    expect(result.executableStepIds).toEqual(["diagram"]);
    expect(result.stalled).toBe(false);
    expect(result.steps.find((item) => item.stepId === "evidence")?.reason).toBe("blocked");
  });

  it("stalls only when no required step is executable", () => {
    const result = assess(
      deliverable({
        steps: [step("evidence")],
        blockers: [
          {
            id: "unclear",
            description: "Unclear",
            category: "missing_information",
            state: "open",
            stepIds: ["evidence"]
          }
        ]
      })
    );
    expect(result.stalled).toBe(true);
  });

  it("treats an awaiting-response blocker as still open and a resolved one as cleared", () => {
    const waiting = assess(
      deliverable({
        steps: [step("evidence")],
        blockers: [
          {
            id: "asked",
            description: "Asked the teacher",
            category: "waiting_on_someone",
            state: "awaiting_response",
            stepIds: ["evidence"]
          }
        ]
      })
    );
    expect(waiting.executableStepIds).toEqual([]);
    const answered = assess(
      deliverable({
        steps: [step("evidence")],
        blockers: [
          {
            id: "asked",
            description: "Asked the teacher",
            category: "waiting_on_someone",
            state: "resolved",
            stepIds: ["evidence"]
          }
        ]
      })
    );
    expect(answered.executableStepIds).toEqual(["evidence"]);
  });

  it("unlocks a successor only once its prerequisite is done", () => {
    const pending = assess(
      deliverable({ steps: [step("diagram"), step("configure", { dependencyIds: ["diagram"] })] })
    );
    expect(pending.executableStepIds).toEqual(["diagram"]);
    expect(pending.steps.find((item) => item.stepId === "configure")?.waitingOn).toEqual(["diagram"]);
    const advanced = assess(
      deliverable({ steps: [step("diagram", { status: "done" }), step("configure", { dependencyIds: ["diagram"] })] })
    );
    expect(advanced.executableStepIds).toEqual(["configure"]);
  });

  it("propagates a block through a whole dependency chain while a parallel chain stays executable", () => {
    // A <- B <- C is one line of work; D is an unrelated, independent line. Blocking A must exclude
    // B and C transitively — neither is individually blocked, each is only waiting on an incomplete
    // prerequisite — while D, which depends on nothing in that chain, stays offered.
    const result = assess(
      deliverable({
        steps: [step("a"), step("b", { dependencyIds: ["a"] }), step("c", { dependencyIds: ["b"] }), step("d")],
        blockers: [
          {
            id: "stuck",
            description: "Waiting on the teacher",
            category: "waiting_on_someone",
            state: "open",
            stepIds: ["a"]
          }
        ]
      })
    );
    expect(result.executableStepIds).toEqual(["d"]);
    expect(result.steps.find((item) => item.stepId === "a")).toMatchObject({ reason: "blocked" });
    expect(result.steps.find((item) => item.stepId === "b")).toMatchObject({
      reason: "prerequisite",
      waitingOn: ["a"]
    });
    expect(result.steps.find((item) => item.stepId === "c")).toMatchObject({
      reason: "prerequisite",
      waitingOn: ["b"]
    });
    const dReadiness = result.steps.find((item) => item.stepId === "d");
    expect(dReadiness?.executable).toBe(true);
    expect(dReadiness?.reason).toBeUndefined();
    // Once the blocker clears and A is actually finished, the whole chain opens up one link at a time
    // rather than all at once — C still needs B done first.
    const aDone = assess(
      deliverable({
        steps: [
          step("a", { status: "done" }),
          step("b", { dependencyIds: ["a"] }),
          step("c", { dependencyIds: ["b"] }),
          step("d")
        ]
      })
    );
    expect(aDone.executableStepIds.sort()).toEqual(["b", "d"]);
  });

  it("excludes a step whose requirements the current situation does not satisfy", () => {
    const result = assess(
      deliverable({ steps: [step("configure", { requirementPathways: [{ id: "p0", contextIds: ["laptop"] }] })] })
    );
    expect(result.executableStepIds).toEqual([]);
    expect(result.steps[0]?.reason).toBe("situation");
  });

  it("reports unknown effort rather than zero until the contract and plan are approved", () => {
    const unapproved = assess(deliverable({ contractVersion: 0, planVersion: 0, steps: [step("diagram")] }));
    expect(unapproved.approved).toBe(false);
    expect(unapproved.remainingMinutes).toBeNull();
    const approved = assess(deliverable({ steps: [step("diagram"), step("configure")] }));
    expect(approved.remainingMinutes).toBe(60);
  });

  it("names an uncovered required criterion and a step contributing to nothing", () => {
    const result = assess(
      deliverable({
        steps: [step("diagram"), step("stray")],
        criteria: [
          {
            id: "connectivity",
            key: "connectivity",
            title: "Demonstrate connectivity",
            required: true,
            state: "unsatisfied",
            sortOrder: 0,
            stepIds: ["diagram"]
          },
          {
            id: "declaration",
            key: "declaration",
            title: "Include the declaration",
            required: true,
            state: "unsatisfied",
            sortOrder: 1,
            stepIds: []
          }
        ]
      })
    );
    expect(result.coverageFailures).toEqual([
      { kind: "uncovered_criterion", criterionId: "declaration", title: "Include the declaration" },
      { kind: "uncontributing_step", stepId: "stray", title: "Step stray" }
    ]);
  });

  it("reports every step on a prerequisite cycle instead of only refusing the plan", () => {
    expect(cyclicSteps([step("a", { dependencyIds: ["b"] }), step("b", { dependencyIds: ["a"] }), step("c")])).toEqual([
      "a",
      "b"
    ]);
    const result = assess(
      deliverable({ steps: [step("a", { dependencyIds: ["b"] }), step("b", { dependencyIds: ["a"] })] })
    );
    expect(result.coverageFailures.filter((failure) => failure.kind === "cyclic_prerequisite")).toHaveLength(2);
    expect(result.executableStepIds).toEqual([]);
  });

  it("holds a missing prerequisite as a constraint rather than dropping it", () => {
    const result = assess(deliverable({ steps: [step("configure", { dependencyIds: ["deleted"] })] }));
    expect(result.steps[0]?.waitingOn).toEqual(["deleted"]);
    expect(result.executableStepIds).toEqual([]);
  });

  it("never calls an empty or unapproved contract satisfied", () => {
    expect(assess(deliverable()).contractSatisfied).toBe(false);
    const unapproved = assess(
      deliverable({
        contractVersion: 0,
        planVersion: 0,
        steps: [step("diagram", { status: "done" })],
        criteria: [
          {
            id: "c",
            key: "c",
            title: "Connectivity",
            required: true,
            state: "satisfied",
            sortOrder: 0,
            stepIds: ["diagram"]
          }
        ]
      })
    );
    expect(unapproved.contractSatisfied).toBe(false);
  });

  it("reports the contract satisfied only when required criteria and required steps are settled", () => {
    const outstanding = assess(
      deliverable({
        steps: [step("diagram")],
        criteria: [
          {
            id: "connectivity",
            key: "connectivity",
            title: "Connectivity",
            required: true,
            state: "satisfied",
            sortOrder: 0,
            stepIds: ["diagram"]
          }
        ]
      })
    );
    expect(outstanding.contractSatisfied).toBe(false);
    const settled = assess(
      deliverable({
        steps: [step("diagram", { status: "done" })],
        criteria: [
          {
            id: "connectivity",
            key: "connectivity",
            title: "Connectivity",
            required: true,
            state: "satisfied",
            sortOrder: 0,
            stepIds: ["diagram"]
          },
          {
            id: "optional",
            key: "optional",
            title: "Optional extra",
            required: false,
            state: "unsatisfied",
            sortOrder: 1,
            stepIds: ["diagram"]
          }
        ]
      })
    );
    expect(settled.contractSatisfied).toBe(true);
  });
});
