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

function run(stateOverrides: Record<string, unknown> = {}) {
  return calculatePlanAndForecast(
    planForecastRequestSchema.parse({
      contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
      requestId: "00000000-0000-4000-8000-0000000000e1",
      inputVersion: "prerequisite-fixture",
      calculatedAt: now.toISOString(),
      horizonEnd: later(96),
      state: baseState(stateOverrides),
      deliverables: []
    })
  );
}

const setup = (status: string, extra: Record<string, unknown> = {}) => ({
  id: "setup",
  title: "Lab setup",
  area: "College and study",
  outcomeId: "unit",
  status,
  uncertainty: "some",
  value: 5,
  consequence: 5,
  ...extra
});
const networking = (prerequisites: unknown[]) => ({
  id: "networking",
  title: "Networking unit",
  area: "College and study",
  outcomeId: "unit",
  status: "active",
  uncertainty: "some",
  value: 5,
  consequence: 5,
  externalDeadlineAt: later(72),
  prerequisites
});

describe("prerequisites beyond action-to-action", () => {
  it("holds a project's actions while a project it waits on is unfinished, and names it", () => {
    const result = run({
      projects: [networking([{ kind: "project", id: "setup" }]), setup("active")],
      actions: [otherAction]
    });
    const candidate = candidateFor(result, "unrelated-action");
    expect(candidate.eligible).toBe(false);
    expect(candidate.exclusionReasons.join(" ")).toContain("waiting on project Lab setup");
  });

  it("releases them once that project is done", () => {
    const result = run({
      projects: [networking([{ kind: "project", id: "setup" }]), setup("done")],
      actions: [otherAction]
    });
    expect(candidateFor(result, "unrelated-action").eligible).toBe(true);
  });

  it("holds an action that waits on another project's action", () => {
    const blocked = { ...otherAction, id: "needs-setup-step", prerequisites: [{ kind: "project", id: "setup" }] };
    const result = run({ projects: [networking([]), setup("active")], actions: [otherAction, blocked] });
    expect(candidateFor(result, "needs-setup-step").eligible).toBe(false);
    expect(candidateFor(result, "unrelated-action").eligible).toBe(true);
  });

  it("rejects a prerequisite loop through a project and its own child", () => {
    expect(() =>
      baseState({ projects: [networking([{ kind: "action", id: "unrelated-action" }])], actions: [otherAction] })
    ).toThrow(/prerequisite cycle/);
  });
});
