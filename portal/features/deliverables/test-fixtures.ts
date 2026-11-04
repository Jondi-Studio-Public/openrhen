import { assessDeliverable } from "@openrhen/contracts";
import type {
  ActiveSession,
  StoredDeliverable,
  StoredDeliverableBlocker,
  StoredDeliverableCriterion,
  StoredDeliverableStep
} from "@/state/portal-state";

/** Builders shared by the deliverable component tests. Values are realistic, not minimal. */
export const fixtureNow = new Date("2026-08-18T09:00:00.000Z");

export const step = (id: string, extra: Partial<StoredDeliverableStep> = {}): StoredDeliverableStep => ({
  id,
  title: `Step ${id}`,
  status: "planned",
  optimisticMinutes: 20,
  expectedMinutes: 30,
  pessimisticMinutes: 45,
  remainingMinutes: 30,
  energy: "medium",
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

export const criterion = (id: string, extra: Partial<StoredDeliverableCriterion> = {}): StoredDeliverableCriterion => ({
  id,
  key: id,
  title: `Criterion ${id}`,
  required: true,
  state: "unsatisfied",
  sortOrder: 0,
  stepIds: [],
  ...extra
});

export const blocker = (id: string, extra: Partial<StoredDeliverableBlocker> = {}): StoredDeliverableBlocker => ({
  id,
  description: `Blocker ${id}`,
  category: "missing_information",
  state: "open",
  stepIds: [],
  ...extra
});

export const deliverable = (extra: Partial<StoredDeliverable> = {}): StoredDeliverable => ({
  id: "assessment-2",
  version: 3,
  projectId: "networking",
  title: "Assessment 2",
  status: "in_progress",
  uncertainty: "some",
  importance: 5,
  consequence: 5,
  contractVersion: 1,
  planVersion: 1,
  contractApprovedAt: "2026-08-17T00:00:00.000Z",
  planApprovedAt: "2026-08-17T00:00:00.000Z",
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

export const session = (extra: Partial<ActiveSession> = {}): ActiveSession => ({
  id: "session-1",
  version: 2,
  actionId: "assessment-2",
  status: "running",
  targetType: "deliverable",
  targetId: "assessment-2",
  targetTitle: "Assessment 2",
  startedAt: new Date(fixtureNow.getTime() - 600_000).toISOString(),
  plannedEndAt: new Date(fixtureNow.getTime() + 1_200_000).toISOString(),
  plannedMinutes: 30,
  remainingBeforeMinutes: 0,
  activeElapsedSeconds: 600,
  segmentStartedAt: new Date(fixtureNow.getTime() - 600_000).toISOString(),
  ...extra
});

export const assess = (value: StoredDeliverable) =>
  assessDeliverable({
    deliverable: value,
    situation: { locationId: null, overrides: {}, carrying: {}, transportModes: ["car"], travel: {}, travelOff: false },
    conditionDefinitions: [],
    now: fixtureNow
  });
