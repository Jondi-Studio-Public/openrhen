import { describe, expect, it } from "vitest";
import { PLAN_FORECAST_CONTRACT_VERSION, planForecastRequestSchema, portalStateSchema } from "@openrhen/contracts";
import { calculatePlanAndForecast } from "../../src/index.js";

const now = new Date("2026-08-17T02:00:00.000Z");
const later = (hours: number) => new Date(now.getTime() + hours * 60 * 60_000).toISOString();

function baseState(overrides: Record<string, unknown> = {}) {
  return portalStateSchema.parse({
    settings: {
      timezone: "Australia/Sydney",
      planningHorizonEnd: "22:00",
      defaultUsableFraction: 1,
      defaultSetupBufferMinutes: 0,
      defaultTransitionBufferMinutes: 0,
      submissionBufferMinutes: 0,
      submissionBufferPercent: 0,
      energyMeanings: { high: "high", medium: "medium", low: "low", recovery: "recovery" },
      estimateBucketsMinutes: [15, 30, 60],
      conditionCatalog: ["home"],
      preferredBedtime: "23:00",
      preferredWakeTime: "07:00",
      desiredSleepMinutes: 480,
      minimumSleepMinutes: 420,
      maxAwakeHours: 16
    },
    areas: [{ id: "area-study", name: "College and study", status: "active", sortOrder: 0 }],
    outcomes: [
      {
        id: "unit",
        areaId: "area-study",
        title: "Networking unit",
        definitionOfDone: "Unit complete",
        value: 5,
        status: "active"
      }
    ],
    projects: [
      {
        id: "networking",
        title: "Networking unit",
        area: "College and study",
        outcomeId: "unit",
        status: "active",
        uncertainty: "some",
        value: 5,
        consequence: 5,
        externalDeadlineAt: later(72)
      }
    ],
    actions: [],
    commitments: [],
    routineSteps: [],
    routinePresets: [],
    occurrences: [],
    sleepPlans: [],
    captures: [],
    completedToday: [],
    assertedConditions: ["home"],
    currentEnergy: "high",
    horizonEnd: later(96),
    activeSession: null,
    ...overrides
  });
}

const option = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Option ${id}`,
  optimisticMinutes: 30,
  expectedMinutes: 45,
  pessimisticMinutes: 60,
  remainingMinutes: 45,
  energy: "high",
  minimumSessionMinutes: 20,
  maximumSessionMinutes: 60,
  ...extra
});

const projection = (extra: Record<string, unknown> = {}) => ({
  id: "assessment-2",
  projectId: "networking",
  title: "Assessment 2",
  status: "in_progress",
  approved: true,
  remainingMinutes: 310,
  minimumUsefulSessionMinutes: 20,
  uncertainty: "some",
  importance: 5,
  consequence: 5,
  externalDeadlineAt: later(72),
  executionOptions: [option("build-diagram", { title: "Build the network diagram" })],
  ...extra
});

function run(
  deliverables: Record<string, unknown>[],
  stateOverrides: Record<string, unknown> = {},
  continuation?: { actionId: string; requestedMinutes?: number }
) {
  return calculatePlanAndForecast(
    planForecastRequestSchema.parse({
      contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
      requestId: "00000000-0000-4000-8000-0000000000d1",
      inputVersion: "deliverable-fixture",
      calculatedAt: now.toISOString(),
      horizonEnd: later(96),
      state: baseState(stateOverrides),
      deliverables,
      ...(continuation ? { continuation } : {})
    })
  );
}

const otherAction = {
  id: "unrelated-action",
  projectId: "networking",
  title: "Unrelated action",
  status: "active",
  optimisticMinutes: 20,
  expectedMinutes: 30,
  remainingMinutes: 30,
  pessimisticMinutes: 45,
  energy: "high",
  minimumSessionMinutes: 15,
  maximumSessionMinutes: 60,
  importance: 3,
  consequence: 3,
  contexts: [],
  dependencyIds: [],
  splittable: true,
  setupMinutes: 0,
  schedulingMode: "one_off"
};

const session = (extra: Record<string, unknown>) => ({
  id: "session-1",
  status: "running",
  startedAt: later(-0.5),
  plannedEndAt: later(0.5),
  plannedMinutes: 60,
  remainingBeforeMinutes: 310,
  activeElapsedSeconds: 900,
  ...extra
});

type Candidates = {
  candidates: {
    action: { id: string; deliverableId?: string };
    eligible: boolean;
    exclusionReasons: string[];
    scoreComponents: { momentum: number };
  }[];
};
const candidateFor = (result: ReturnType<typeof run>, id: string) =>
  (result.recommendation as unknown as Candidates).candidates.find((candidate) => candidate.action.id === id)!;

type Continuation = { safe: boolean; recommendedMinutes: number; reason: string };
const continuationOf = (result: ReturnType<typeof run>) => result.continuation as unknown as Continuation;

const ACTIVE_SESSION_EXCLUSION = "Another work session is already active.";
/** How `deliverableForecastUnits`/`deliverableCandidateUnits` key a deliverable inside the engine. */
const unitId = "deliverable:assessment-2";

describe("a running deliverable session", () => {
  const deliverableSession = session({ targetType: "deliverable", targetId: "assessment-2", actionId: "assessment-2" });

  it("excludes every other candidate, the way an action session does", () => {
    const result = run([projection()], { actions: [otherAction], activeSession: deliverableSession });
    const other = candidateFor(result, "unrelated-action");
    expect(other.eligible).toBe(false);
    expect(other.exclusionReasons).toContain(ACTIVE_SESSION_EXCLUSION);
    expect(candidateFor(result, unitId).eligible).toBe(true);
    expect(result.currentDirective.kind).toBe("deliverable");
  });

  it("gives the deliverable being worked on its momentum", () => {
    const withSession = run([projection()], { actions: [otherAction], activeSession: deliverableSession });
    const without = run([projection()], { actions: [otherAction] });
    expect(candidateFor(withSession, unitId).scoreComponents.momentum).toBeGreaterThan(
      candidateFor(without, unitId).scoreComponents.momentum
    );
    expect(candidateFor(without, unitId).scoreComponents.momentum).toBe(0);
  });

  it("leaves the ranking alone when the session belongs to an ordinary action", () => {
    const result = run([projection()], {
      actions: [otherAction],
      activeSession: session({ targetType: "action", actionId: "unrelated-action", targetId: "unrelated-action" })
    });
    expect(candidateFor(result, "unrelated-action").eligible).toBe(true);
    expect(candidateFor(result, "unrelated-action").scoreComponents.momentum).toBeGreaterThan(0);
    expect(candidateFor(result, unitId).exclusionReasons).toContain(ACTIVE_SESSION_EXCLUSION);
  });

  it("does not claim a candidate when the session is a routine or sleep directive", () => {
    const result = run([projection()], {
      actions: [otherAction],
      activeSession: session({ targetType: "sleep", actionId: "some-sleep-plan", targetId: "some-sleep-plan" })
    });
    expect(candidateFor(result, "unrelated-action").exclusionReasons).not.toContain(ACTIVE_SESSION_EXCLUSION);
    expect(candidateFor(result, unitId).exclusionReasons).not.toContain(ACTIVE_SESSION_EXCLUSION);
  });

  it("resolves continuation against the deliverable's own forecast unit", () => {
    const result = run(
      [projection()],
      { activeSession: deliverableSession },
      {
        actionId: "assessment-2",
        requestedMinutes: 30
      }
    );
    const continuation = continuationOf(result);
    expect(continuation.safe).toBe(true);
    expect(continuation.recommendedMinutes).toBe(30);
    // The internal unit key is an engine detail; nothing about it should reach the explanation.
    expect(continuation.reason).not.toContain(unitId);
  });

  it("refuses a continuation shorter than the deliverable's minimum useful session", () => {
    const continuation = continuationOf(
      run([projection()], { activeSession: deliverableSession }, { actionId: "assessment-2", requestedMinutes: 15 })
    );
    expect(continuation.safe).toBe(false);
    expect(continuation.recommendedMinutes).toBe(0);
    // The request was the short thing, not the day: hours of compatible time remain either way.
    expect(continuation.reason).toContain("this work needs at least 20");
    expect(continuation.reason).not.toContain("free before");
  });

  it("refuses by name when no measured effort backs the deliverable", () => {
    const continuation = continuationOf(
      run(
        [projection({ approved: false, remainingMinutes: null, minimumUsefulSessionMinutes: null })],
        { activeSession: deliverableSession },
        { actionId: "assessment-2", requestedMinutes: 30 }
      )
    );
    expect(continuation.safe).toBe(false);
    expect(continuation.reason).toContain("Assessment 2");
    expect(continuation.reason).not.toContain("no longer exists");
  });

  it("still refuses an unknown target without inventing a deliverable", () => {
    const continuation = continuationOf(
      run([projection()], {}, { actionId: "nothing-like-this", requestedMinutes: 30 })
    );
    expect(continuation.safe).toBe(false);
    expect(continuation.reason).toContain("no longer exists");
  });
});

describe("deliverables as engine targets", () => {
  it("recommends the enduring deliverable without choosing internal work", () => {
    const directive = run([projection()]).currentDirective;
    expect(directive.kind).toBe("deliverable");
    if (directive.kind !== "deliverable") throw new Error("expected a deliverable directive");
    expect(directive.targetId).toBe("assessment-2");
    expect(directive.title).toBe("Assessment 2");
    expect(directive).toEqual(expect.not.objectContaining({ executionOptionId: expect.anything() }));
    expect(directive.recommendedMinutes).toBeGreaterThan(0);
  });

  it("reproduces the same result for identical input and calculation time", () => {
    const first = run([projection()]);
    const second = run([projection()]);
    expect(second.currentDirective).toEqual(first.currentDirective);
    expect(JSON.stringify(second.recommendation)).toBe(JSON.stringify(first.recommendation));
  });

  it("excludes a deliverable whose prerequisite is incomplete, naming the prerequisite", () => {
    const result = run([
      projection({
        dependenciesSatisfied: false,
        incompletePrerequisites: [{ id: "assessment-1", title: "Assessment 1" }]
      })
    ]);
    expect(result.currentDirective.kind).not.toBe("deliverable");
    const reasons = JSON.stringify(result.recommendation);
    expect(reasons).toContain("Assessment 2 cannot start because Assessment 1 is incomplete.");
  });

  it("stays eligible when at least one internal way of making progress fits", () => {
    const laptopOnly = option("build-diagram", {
      title: "Build the network diagram",
      requirementPathways: [{ id: "p0", contextIds: ["laptop"] }]
    });
    const anywhere = option("review-brief", {
      title: "Review the brief",
      energy: "low",
      expectedMinutes: 20,
      optimisticMinutes: 15,
      pessimisticMinutes: 25,
      remainingMinutes: 20,
      minimumSessionMinutes: 15
    });
    const directive = run([projection({ executionOptions: [laptopOnly, anywhere] })]).currentDirective;
    expect(directive.kind).toBe("deliverable");
    if (directive.kind !== "deliverable") throw new Error("expected a deliverable directive");
    expect(directive.targetId).toBe("assessment-2");
    expect(directive).toEqual(expect.not.objectContaining({ executionOptionId: expect.anything() }));
  });

  it("recommends the deliverable itself before breakdown while keeping forecast effort unknown", () => {
    const result = run([
      projection({ approved: false, remainingMinutes: null, minimumUsefulSessionMinutes: null, executionOptions: [] })
    ]);
    expect(result.currentDirective.kind).toBe("deliverable");
    if (result.currentDirective.kind !== "deliverable") throw new Error("expected a deliverable directive");
    expect(result.currentDirective.targetId).toBe("assessment-2");
    expect(result.currentDirective.recommendedMinutes).toBeGreaterThanOrEqual(5);
    // The project cannot be forecast responsibly while an unknown amount of work sits inside it.
    const forecast = (
      result.schedule as { forecasts: { projectId: string; health: string; reasons: string[] }[] }
    ).forecasts.find((item) => item.projectId === "networking");
    expect(forecast?.health).toBe("unknown");
    expect(forecast?.reasons.join(" ")).toContain("has not been broken down");
  });

  // An AI writing through the CLI drafted a presence-gated step ("Assessment 1 –
  // written assessment", can only be worked on at College or in the live College Zoom class) and the
  // engine still recommended it while at home. The contract had never been approved, so the
  // deliverable fell into the "Breakdown is the work" provisional path, which ignores what the
  // drafted step actually requires. A drafted step's own gate must hold from the moment it exists,
  // not only once a human clicks approve.
  it("does not recommend an unapproved deliverable whose only drafted step needs a place you are not at", () => {
    // `executionOptions` is already the *filtered* set — a step gated on a context you don't hold
    // (assertedConditions is ["home"] here; the drafted step needed "college") never makes it in, which is
    // exactly what buildDeliverableProjections produces for a realistic "Assessment 1" step.
    const result = run([
      projection({
        approved: false,
        remainingMinutes: null,
        minimumUsefulSessionMinutes: null,
        executionOptions: [],
        hasSteps: true
      })
    ]);
    expect(result.currentDirective.kind).not.toBe("deliverable");
    expect(JSON.stringify(result.recommendation)).toContain("no step that can be worked on in the current situation");
  });

  it("never lets one deliverable occupy several places in the ranking", () => {
    const result = run([projection({ executionOptions: [option("a"), option("b"), option("c")] })]);
    const recommendation = result.recommendation as {
      primary: { action: { deliverableId?: string } } | null;
      alternatives: { action: { deliverableId?: string } }[];
    };
    const named = [recommendation.primary, ...recommendation.alternatives]
      .filter(Boolean)
      .map((candidate) => candidate!.action.deliverableId);
    expect(named.filter((id) => id === "assessment-2")).toHaveLength(1);
  });

  it("stops competing for time once it is awaiting an external result", () => {
    const result = run([projection({ status: "awaiting_result" })]);
    expect(result.currentDirective.kind).not.toBe("deliverable");
  });

  it("counts remaining effort once, not once per execution option", () => {
    const single = run([projection({ executionOptions: [option("a")] })]);
    const many = run([projection({ executionOptions: [option("a"), option("b"), option("c")] })]);
    const effort = (result: typeof single) =>
      (
        result.schedule as { forecasts: { projectId: string; protectedRemainingMinutes: number | null }[] }
      ).forecasts.find((item) => item.projectId === "networking")?.protectedRemainingMinutes;
    expect(effort(many)).toBe(effort(single));
  });
});

describe("deliverables with nothing doable", () => {
  const blocked = {
    approved: true,
    remainingMinutes: 300,
    minimumUsefulSessionMinutes: null,
    executionOptions: [],
    hasOpenBlockers: true,
    hasSteps: true
  };

  it("is excluded, naming the blockers rather than going quiet", () => {
    const result = run([projection(blocked)]);
    expect(result.currentDirective.kind).not.toBe("deliverable");
    expect(JSON.stringify(result.recommendation)).toContain(
      "no step that can be worked on until its open blockers are resolved"
    );
  });

  it("says the situation is the obstacle when no blocker is recorded", () => {
    const result = run([projection({ ...blocked, hasOpenBlockers: false })]);
    expect(JSON.stringify(result.recommendation)).toContain("no step that can be worked on in the current situation");
  });

  it("still recommends an unbroken-down deliverable, because Breakdown is the work", () => {
    const result = run([
      projection({
        approved: false,
        remainingMinutes: null,
        minimumUsefulSessionMinutes: null,
        executionOptions: [],
        hasOpenBlockers: true
      })
    ]);
    expect(result.currentDirective.kind).toBe("deliverable");
  });

  it("still recommends a deliverable in Review, where reading the evidence is the work", () => {
    const result = run([projection({ ...blocked, status: "under_review" })]);
    expect(result.currentDirective.kind).toBe("deliverable");
  });

  it("keeps a deliverable available while one step remains executable", () => {
    const result = run([projection({ hasOpenBlockers: true, partiallyBlocked: true })]);
    expect(result.currentDirective.kind).toBe("deliverable");
  });
});
