import { describe, expect, it } from "vitest";
import { createSeedState, type StoredAction, type PlanningFocus } from "@/state/portal-state";
import {
  actionStatusCommand,
  outcomeReviewCommand,
  projectInternalDeadlineCommand,
  projectStatusCommand,
  updateSeriesCommand,
  saveFocusCommand,
  setSeriesEndCommand,
  overdueSeenCommand,
  restoreReviewStampCommand
} from "@/features/review/review-commands";

const actionFixture = (overrides: Partial<StoredAction> = {}): StoredAction =>
  ({
    id: "action-1",
    version: 2,
    projectId: "project-1",
    title: "Weekly review",
    status: "pending" as const,
    optimisticMinutes: 30,
    expectedMinutes: 45,
    pessimisticMinutes: 60,
    remainingMinutes: 45,
    energy: "low" as const,
    minimumSessionMinutes: 15,
    maximumSessionMinutes: 90,
    splittable: true,
    setupMinutes: 0,
    importance: 3,
    consequence: 2,
    contexts: [],
    dependencyIds: [],
    schedulingMode: "recurring" as const,
    recurrence: {
      id: "rule-1",
      actionId: "action-1",
      timezone: "Australia/Sydney",
      startDate: "2026-08-19",
      endDate: "2026-09-30",
      intervalDays: 7,
      completionMode: "manual" as const,
      accumulatedMinutes: 0,
      windows: []
    },
    ...overrides
  }) as unknown as StoredAction;

const planningFocusFixture = (overrides: Partial<PlanningFocus> = {}): PlanningFocus =>
  ({
    id: "focus-1",
    version: 3,
    kind: "weekly" as const,
    periodStart: "2026-08-18",
    periodEnd: "2026-08-24",
    projectIds: ["project-1", "project-2"],
    ...overrides
  }) as unknown as PlanningFocus;

describe("updateSeriesCommand", () => {
  it("restates the stored action, so its alternative routes survive and its notes are left to the server", () => {
    const action = actionFixture({
      notes: "Bring the rubric.",
      contexts: ["home"],
      requirementPathways: [
        { id: "p1", contextIds: ["home"] },
        { id: "p2", contextIds: ["laptop", "quiet"] }
      ],
      preferences: ["morning"]
    } as Partial<StoredAction>);
    const command = updateSeriesCommand(action, "extend");
    expect(command?.action).not.toHaveProperty("notes");
    expect(command?.action).toMatchObject({
      requirementPathways: action.requirementPathways,
      preferences: ["morning"],
      schedulingMode: "recurring"
    });
  });

  it("completes a series and sets status to done, leaving endDate unchanged", () => {
    const action = actionFixture();
    const command = updateSeriesCommand(action, "complete");
    expect(command).not.toBeNull();
    if (!command) return;
    expect(command.expectedVersion).toBe(2);
    expect(command.action.status).toBe("done");
    expect((command.action.recurrence as Record<string, unknown>).endDate).toBe("2026-09-30");
  });

  it("extends a series by exactly seven days and leaves status unchanged", () => {
    const action = actionFixture();
    const command = updateSeriesCommand(action, "extend");
    expect(command).not.toBeNull();
    if (!command) return;
    expect(command.expectedVersion).toBe(2);
    expect(command.action.status).toBe("pending");
    expect((command.action.recurrence as Record<string, unknown>).endDate).toBe("2026-10-07");
  });

  it("extends from today when the series ended before today, so it ends in the future", () => {
    // Ended 30 Sep; today is 28 Oct. Seven days from the old end would be 7 Oct, still in the past.
    const command = updateSeriesCommand(actionFixture(), "extend", "2026-10-28");
    expect((command!.action.recurrence as Record<string, unknown>).endDate).toBe("2026-11-04");
  });

  it("extends from the old end when that is still ahead of today", () => {
    const command = updateSeriesCommand(actionFixture(), "extend", "2026-09-01");
    expect((command!.action.recurrence as Record<string, unknown>).endDate).toBe("2026-10-07");
  });

  it("sets a series' end date back for Undo, leaving everything else as stored", () => {
    const command = setSeriesEndCommand(actionFixture({ version: 7 }), "2026-09-30");
    expect(command!.expectedVersion).toBe(7);
    expect(command!.action.status).toBe("pending");
    expect((command!.action.recurrence as Record<string, unknown>).endDate).toBe("2026-09-30");
    expect(setSeriesEndCommand(actionFixture({ recurrence: undefined }), "2026-09-30")).toBeNull();
  });

  it("extends a series across a month boundary correctly", () => {
    const action = actionFixture({
      recurrence: {
        id: "rule-1",
        actionId: "action-1",
        timezone: "Australia/Sydney",
        startDate: "2026-08-19",
        endDate: "2026-08-28",
        intervalDays: 7,
        completionMode: "manual" as const,
        accumulatedMinutes: 0,
        windows: []
      }
    });
    const command = updateSeriesCommand(action, "extend");
    expect(command).not.toBeNull();
    if (!command) return;
    expect((command.action.recurrence as Record<string, unknown>).endDate).toBe("2026-09-04");
  });

  it("claims the action's own version and restates every other column unchanged", () => {
    const action = actionFixture({ version: 5 });
    const command = updateSeriesCommand(action, "complete");
    expect(command?.expectedVersion).toBe(5);
    expect(command?.action).toMatchObject({
      id: "action-1",
      projectId: "project-1",
      title: "Weekly review",
      energy: "low",
      importance: 3,
      contexts: [],
      dependencyIds: []
    });
  });

  it("saves against no expected version when the action has never been stored", () => {
    const action = actionFixture({ version: undefined });
    const command = updateSeriesCommand(action, "complete");
    expect(command?.expectedVersion).toBeNull();
  });

  it("returns null when the action has no recurrence", () => {
    const action = actionFixture({ recurrence: undefined });
    expect(updateSeriesCommand(action, "complete")).toBeNull();
  });

  it("spreads non-touched recurrence fields through unchanged", () => {
    const action = actionFixture({
      recurrence: {
        id: "rule-1",
        actionId: "action-1",
        timezone: "Australia/Sydney",
        startDate: "2026-08-19",
        endDate: "2026-09-30",
        intervalDays: 14,
        completionMode: "manual" as const,
        accumulatedMinutes: 0,
        windows: []
      }
    });
    const command = updateSeriesCommand(action, "extend");
    expect(command).not.toBeNull();
    expect(command!.action.recurrence).toMatchObject({
      id: "rule-1",
      actionId: "action-1",
      timezone: "Australia/Sydney",
      startDate: "2026-08-19",
      intervalDays: 14,
      completionMode: "manual",
      accumulatedMinutes: 0,
      windows: [],
      endDate: "2026-10-07"
    });
  });
});

describe("saveFocusCommand", () => {
  it("sends planning_focus with the record's version and id when a record exists", () => {
    const record = planningFocusFixture();
    const period = { start: "2026-08-18", end: "2026-08-24" };
    const command = saveFocusCommand("weekly", period, record, ["p1", "p2"]);
    expect(command.expectedVersion).toBe(3);
    expect(command.entityType).toBe("planning_focus");
    expect(command.entity).toMatchObject({
      id: "focus-1",
      kind: "weekly",
      periodStart: "2026-08-18",
      periodEnd: "2026-08-24",
      projectIds: ["p1", "p2"]
    });
  });

  it("saves against no expected version and generates a fresh id when no record exists", () => {
    const period = { start: "2026-08-18", end: "2026-08-24" };
    const command = saveFocusCommand("weekly", period, undefined, ["p1"]);
    expect(command.expectedVersion).toBeNull();
    const entity = command.entity as Record<string, unknown>;
    expect(entity.id).toBeTruthy();
    expect(typeof entity.id).toBe("string");
    expect((entity.id as string).length).toBeGreaterThan(0);
  });

  it("handles monthly periods", () => {
    const record = planningFocusFixture({ kind: "monthly", periodStart: "2026-08-01", periodEnd: "2026-08-31" });
    const period = { start: "2026-08-01", end: "2026-08-31" };
    const command = saveFocusCommand("monthly", period, record, ["p1", "p2", "p3"]);
    expect(command.entity.kind).toBe("monthly");
    expect(command.entity.periodStart).toBe("2026-08-01");
    expect(command.entity.periodEnd).toBe("2026-08-31");
  });

  it("saves against no expected version when the record has never been stored", () => {
    const record = planningFocusFixture({ version: undefined });
    const period = { start: "2026-08-18", end: "2026-08-24" };
    const command = saveFocusCommand("weekly", period, record, []);
    expect(command.expectedVersion).toBeNull();
  });
});

describe("projectStatusCommand", () => {
  it("restates the stored project with only its status changed, deadlines as stored", () => {
    const project = {
      ...createSeedState(new Date("2026-08-18T09:00:00.000Z")).projects[0]!,
      version: 4,
      internalDeadlineAt: "2026-09-01T07:30:00.000Z"
    };
    const command = projectStatusCommand(project, "paused");
    expect(command.expectedVersion).toBe(4);
    expect(command.project).toMatchObject({
      id: project.id,
      outcomeId: project.outcomeId,
      title: project.title,
      status: "paused",
      internalDeadlineAt: "2026-09-01T07:30:00.000Z"
    });
    expect("prerequisites" in command.project).toBe(false);
    expect(projectStatusCommand(project, "cancelled").project.status).toBe("cancelled");
  });
});

describe("review stamp commands", () => {
  const stored = { id: "p1", version: 4 } as unknown as Parameters<typeof overdueSeenCommand>[0];

  it("marks a Seen as the overdue stamp at the project's version", () => {
    expect(overdueSeenCommand(stored)).toMatchObject({ projectId: "p1", expectedVersion: 4, kind: "overdue_seen" });
    expect(overdueSeenCommand({ id: "p1" } as unknown as typeof stored)).toBeNull();
  });

  it("restores the earlier Keep stamp, or none, at the current version", () => {
    expect(restoreReviewStampCommand(stored, "2026-10-01T00:00:00.000Z")).toMatchObject({
      projectId: "p1",
      expectedVersion: 4,
      reviewedAt: "2026-10-01T00:00:00.000Z"
    });
    const cleared = restoreReviewStampCommand(stored, null)!;
    expect(cleared.reviewedAt).toBeNull();
    expect(cleared).not.toHaveProperty("kind");
  });

  it("restores the Seen stamp under its own kind", () => {
    expect(restoreReviewStampCommand(stored, "2026-10-26T00:00:00.000Z", "overdue_seen")).toMatchObject({
      kind: "overdue_seen",
      reviewedAt: "2026-10-26T00:00:00.000Z"
    });
  });
});

describe("in-place review commands", () => {
  const seed = createSeedState(new Date("2026-08-18T09:00:00.000Z"));

  it("moves only the internal deadline, and clears it with null", () => {
    const project = { ...seed.projects[0]!, version: 4, internalDeadlineAt: "2026-08-17T08:00:00.000Z" };
    const moved = projectInternalDeadlineCommand(project, "2026-09-03T04:00:00.000Z");
    expect(moved.expectedVersion).toBe(4);
    expect(moved.project).toMatchObject({
      id: project.id,
      status: project.status,
      internalDeadlineAt: "2026-09-03T04:00:00.000Z"
    });
    expect("internalDeadlineAt" in projectInternalDeadlineCommand(project, null).project).toBe(false);
  });

  it("restates an action with only its status changed", () => {
    const command = actionStatusCommand(actionFixture({ version: 7, status: "waiting" }), "planned");
    expect(command.expectedVersion).toBe(7);
    expect(command.action).toMatchObject({ id: "action-1", status: "planned", title: "Weekly review" });
  });

  it("restates an outcome with a new status or review date, and keeps the rest", () => {
    const outcome = {
      ...seed.outcomes[0]!,
      version: 5,
      reviewOn: "2026-08-01",
      deadlineAt: "2026-08-10T00:00:00.000Z"
    };
    const kept = outcomeReviewCommand(outcome, { reviewOn: "2026-09-15" });
    expect(kept).toMatchObject({
      expectedVersion: 5,
      entityType: "outcome",
      entity: { id: outcome.id, status: outcome.status, deadlineAt: "2026-08-10T00:00:00.000Z", reviewOn: "2026-09-15" }
    });
    const closed = outcomeReviewCommand(outcome, { status: "done" });
    expect(closed.entity).toMatchObject({ status: "done", reviewOn: "2026-08-01" });
    expect("reviewOn" in outcomeReviewCommand(outcome, { reviewOn: null }).entity).toBe(false);
  });

  it("sends the reviewed-on date with a focus save only when given", () => {
    const period = { start: "2026-08-18", end: "2026-08-24" };
    expect(saveFocusCommand("weekly", period, undefined, [], "2026-08-20").entity).toMatchObject({
      reviewedOn: "2026-08-20"
    });
    expect("reviewedOn" in saveFocusCommand("weekly", period, undefined, []).entity).toBe(false);
  });
});
