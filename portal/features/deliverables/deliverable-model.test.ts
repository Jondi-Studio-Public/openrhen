import { describe, expect, it } from "vitest";
import { assessDeliverable } from "@openrhen/contracts";
import {
  continueButtonState,
  coverageFailureText,
  criteriaProgress,
  formatElapsed,
  nextExecutableStepId,
  phaseLabel,
  phaseOf,
  removeStep,
  sessionTiming,
  sortDeliverables,
  statusText,
  stepProgress,
  stepReadinessText
} from "./deliverable-model";
import { assess, blocker, criterion, deliverable, fixtureNow, session, step } from "./test-fixtures";

describe("deliverable model", () => {
  it("derives the BCR phase from approval and status", () => {
    expect(phaseOf(deliverable({ contractApprovedAt: undefined }))).toBe("Breakdown");
    expect(phaseOf(deliverable())).toBe("Carry out");
    expect(phaseOf(deliverable({ status: "under_review" }))).toBe("Review");
  });

  it("shows the Carry out phase as the doing stage and leaves the others as they are", () => {
    expect(phaseLabel("Carry out")).toBe("Do the work");
    expect(phaseLabel("Breakdown")).toBe("Breakdown");
    expect(phaseLabel("Review")).toBe("Review");
  });

  it('words the stored status by the approvals, so drafted actions never sit under "needs breakdown"', () => {
    const unapproved = { contractApprovedAt: undefined, planApprovedAt: undefined };
    const drafted = [step("a"), step("b"), step("c")];
    expect(statusText(deliverable({ ...unapproved, status: "needs_breakdown", steps: drafted }))).toBe(
      "breakdown awaiting approval"
    );
    expect(statusText(deliverable({ ...unapproved, status: "needs_breakdown" }))).toBe("needs breakdown");
    // "ready" is only stored by approving, so an unapproved one is a mismatch to word as awaiting approval.
    expect(statusText(deliverable({ ...unapproved, status: "ready", steps: drafted }))).toBe(
      "breakdown awaiting approval"
    );
    // Cancelled steps are not actions.
    expect(
      statusText(deliverable({ ...unapproved, status: "ready", steps: [step("a", { status: "cancelled" })] }))
    ).toBe("needs breakdown");
    expect(statusText(deliverable({ status: "ready" }))).toBe("ready");
    expect(statusText(deliverable({ ...unapproved, status: "in_progress" }))).toBe("in progress");
    expect(statusText(deliverable({ ...unapproved, status: "cancelled" }))).toBe("cancelled");
  });

  it("opens a session on the earliest executable step, preferring one already in progress", () => {
    const plan = deliverable({
      steps: [
        step("a", { sortOrder: 0, status: "done" }),
        step("b", { sortOrder: 1, dependencyIds: ["a"] }),
        step("c", { sortOrder: 2, status: "doing" }),
        step("d", { sortOrder: 3, dependencyIds: ["b"] })
      ]
    });
    expect(nextExecutableStepId(plan, assess(plan))).toBe("c");
    const noneDoing = deliverable({
      steps: plan.steps.map((item) => ({ ...item, status: item.id === "a" ? "done" : "planned" }))
    });
    expect(nextExecutableStepId(noneDoing, assess(noneDoing))).toBe("b");
    const nothing = deliverable({ steps: [step("x", { status: "blocked" })] });
    expect(nextExecutableStepId(nothing, assess(nothing))).toBeNull();
  });

  it("never rolls onto a step whose chain is blocked, offering a parallel chain instead", () => {
    // The rollover a running session takes when its step finishes is exactly nextExecutableStepId —
    // this is the pure-function half of that guarantee (the postgres side is exercised for real in
    // state-store.integration.test.ts). draft is done; revise is next in its own chain but blocked;
    // proofread is a parallel, unrelated line of work and should be offered instead.
    const plan = deliverable({
      steps: [
        step("draft", { sortOrder: 0, status: "done" }),
        step("revise", { sortOrder: 1, dependencyIds: ["draft"] }),
        step("finalize", { sortOrder: 2, dependencyIds: ["revise"] }),
        step("proofread", { sortOrder: 3 })
      ],
      blockers: [
        {
          id: "locked",
          description: "Waiting on feedback",
          category: "waiting_on_someone",
          state: "open",
          stepIds: ["revise"]
        }
      ]
    });
    expect(nextExecutableStepId(plan, assess(plan))).toBe("proofread");
  });

  it("sorts the in-session deliverable first, then live work by status and deadline", () => {
    const list = [
      deliverable({ id: "done", title: "Done", status: "completed" }),
      deliverable({ id: "shell", title: "Shell", status: "needs_breakdown", contractApprovedAt: undefined }),
      deliverable({ id: "later", title: "Later", externalDeadlineAt: "2026-09-01T00:00:00.000Z" }),
      deliverable({ id: "soon", title: "Soon", externalDeadlineAt: "2026-08-20T00:00:00.000Z" })
    ];
    expect(sortDeliverables(list, null).map((item) => item.id)).toEqual(["soon", "later", "shell", "done"]);
    expect(sortDeliverables(list, session({ targetId: "shell" })).map((item) => item.id)).toEqual([
      "shell",
      "soon",
      "later",
      "done"
    ]);
  });

  it("counts progress without cancelled steps", () => {
    const plan = deliverable({
      steps: [step("a", { status: "done" }), step("b", { status: "cancelled" }), step("c", { remainingMinutes: 12 })]
    });
    expect(stepProgress(plan)).toEqual({ done: 1, total: 2, remaining: 12 });
  });

  it("leaves an archived step out of progress, neither done nor remaining", () => {
    const plan = deliverable({
      steps: [step("a", { status: "done" }), step("b", { status: "archived" }), step("c", { remainingMinutes: 12 })]
    });
    expect(stepProgress(plan)).toEqual({ done: 1, total: 2, remaining: 12 });
  });

  it("names the offending record in a coverage failure", () => {
    expect(coverageFailureText({ kind: "uncovered_criterion", criterionId: "c", title: "Connectivity" })).toContain(
      "“Connectivity”"
    );
    expect(coverageFailureText({ kind: "uncontributing_step", stepId: "s", title: "" })).toContain("untitled");
    expect(coverageFailureText({ kind: "cyclic_prerequisite", stepId: "s", title: "Draft" })).toContain("cycle");
  });

  it("explains why a step is not workable, naming the step or blocker in the way", () => {
    const plan = deliverable({
      steps: [step("a"), step("b", { dependencyIds: ["a"] }), step("c")],
      blockers: [blocker("k", { description: "Waiting on tutor", stepIds: ["c"] })]
    });
    const readiness = assess(plan);
    const byId = new Map(readiness.steps.map((item) => [item.stepId, item]));
    const tz = "Australia/Sydney";
    expect(stepReadinessText(byId.get("a")!, plan, new Map(), tz)).toBe("Ready to work on");
    expect(stepReadinessText(byId.get("b")!, plan, new Map(), tz)).toBe("Waiting on Step a");
    expect(stepReadinessText(byId.get("c")!, plan, new Map(), tz)).toBe("Blocked by Waiting on tutor");
  });

  it("names when a commitment-gated step's hold clears, once the next occurrence is known", () => {
    const gated = deliverable({
      steps: [step("class-only", { requirementPathways: [{ id: "p0", contextIds: ["college"] }] })]
    });
    const conditionDefinitions = [
      {
        id: "college",
        name: "College class",
        kind: "live" as const,
        status: "active" as const,
        pathways: [],
        portability: "fixed" as const,
        grants: [],
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0,
        channels: [],
        recurrenceRuleId: "college-rule"
      }
    ];
    const readiness = assessDeliverable({
      deliverable: gated,
      situation: {
        locationId: null,
        overrides: {},
        carrying: {},
        transportModes: ["car"],
        travel: {},
        travelOff: false
      },
      conditionDefinitions,
      now: fixtureNow,
      commitments: [
        {
          id: "college-next-week",
          title: "College class",
          startsAt: new Date(fixtureNow.getTime() + 60 * 60_000).toISOString(),
          endsAt: new Date(fixtureNow.getTime() + 120 * 60_000).toISOString(),
          status: "confirmed",
          recurrenceRuleId: "college-rule"
        }
      ]
    });
    const stepReadiness = readiness.steps.find((item) => item.stepId === "class-only")!;
    expect(stepReadinessText(stepReadiness, gated, new Map(), "Australia/Sydney")).toBe(
      "Only during College class. Starts at 8:00 pm."
    );
  });

  it("times a running session with an open segment, counting up total and down remaining", () => {
    const running = session({
      activeElapsedSeconds: 600,
      segmentStartedAt: new Date(fixtureNow.getTime() - 60_000).toISOString()
    });
    const timing = sessionTiming(running, fixtureNow);
    expect(timing).toEqual({ totalSeconds: 660, remainingSeconds: 1200, atCheckpoint: false, hasStep: false });
  });

  it("stops counting the open segment while paused", () => {
    const paused = session({ status: "paused", activeElapsedSeconds: 600, segmentStartedAt: undefined });
    const timing = sessionTiming(paused, fixtureNow);
    expect(timing.totalSeconds).toBe(600);
    expect(timing.atCheckpoint).toBe(false);
  });

  it("reaches the checkpoint once the planned end has passed, even while still running", () => {
    const overrun = session({ plannedEndAt: new Date(fixtureNow.getTime() - 1000).toISOString() });
    expect(sessionTiming(overrun, fixtureNow).atCheckpoint).toBe(true);
  });

  it("is at the checkpoint whenever the session status says feedback", () => {
    const feedback = session({ status: "feedback", stepId: "draft" });
    const timing = sessionTiming(feedback, fixtureNow);
    expect(timing.atCheckpoint).toBe(true);
    expect(timing.hasStep).toBe(true);
  });

  it("labels the Continue button for all four states", () => {
    const notYet = session({ status: "running" });
    expect(continueButtonState(notYet, true, null)).toEqual({ label: "Preparing checkpoint…", disabled: true });
    const feedback = session({ status: "feedback" });
    expect(continueButtonState(feedback, false, null)).toEqual({
      label: "Continue unavailable until planning refreshes",
      disabled: true
    });
    expect(continueButtonState(feedback, true, { safe: true, recommendedMinutes: 25 })).toEqual({
      label: "Continue for 25 min",
      disabled: false
    });
    expect(continueButtonState(feedback, true, { safe: false, recommendedMinutes: 0 })).toEqual({
      label: "Continuing would displace other work",
      disabled: true
    });
  });

  it("counts satisfied, required and total criteria", () => {
    const plan = deliverable({
      criteria: [
        criterion("a", { required: true, state: "satisfied" }),
        criterion("b", { required: true, state: "unsatisfied" }),
        criterion("c", { required: false, state: "satisfied" })
      ]
    });
    expect(criteriaProgress(plan)).toEqual({ satisfied: 1, required: 2, total: 3 });
  });

  it("formats elapsed time as M:SS below an hour and H:MM:SS at or above it", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(545)).toBe("9:05");
    expect(formatElapsed(2700)).toBe("45:00");
    expect(formatElapsed(3599)).toBe("59:59");
    expect(formatElapsed(3600)).toBe("1:00:00");
    expect(formatElapsed(7199)).toBe("1:59:59");
    expect(formatElapsed(7260)).toBe("2:01:00");
  });

  it("removing a step also removes every reference to it", () => {
    const plan = deliverable({
      steps: [step("a"), step("b", { dependencyIds: ["a"] })],
      criteria: [criterion("c", { stepIds: ["a", "b"] })],
      blockers: [blocker("k", { stepIds: ["a"] })]
    });
    const next = removeStep(plan, "a");
    expect(next.steps.map((item) => item.id)).toEqual(["b"]);
    expect(next.steps[0]?.dependencyIds).toEqual([]);
    expect(next.criteria[0]?.stepIds).toEqual(["b"]);
    expect(next.blockers[0]?.stepIds).toEqual([]);
  });
});
