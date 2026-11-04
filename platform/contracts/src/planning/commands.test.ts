import { describe, expect, it } from "vitest";
import {
  activityCommandSchema,
  confirmProjectWantedCommandSchema,
  saveActionCommandSchema,
  saveCommitmentRecurrenceRuleCommandSchema,
  saveProjectCommandSchema,
  sessionCommandSchema,
  wakeCommandSchema
} from "./commands.js";

const baseRule = {
  id: "rule-1",
  title: "Weekday school run",
  timezone: "Australia/Sydney",
  startDate: "2026-09-09",
  repeat: { unit: "days" as const, intervalDays: 1 },
  localStartTime: "15:00",
  localEndTime: "16:00",
  setupBeforeMinutes: 0,
  transitionAfterMinutes: 0
};

describe("saveCommitmentRecurrenceRuleCommandSchema", () => {
  it("parses a rule without shareToCalendar", () => {
    const parsed = saveCommitmentRecurrenceRuleCommandSchema.parse({
      expectedVersion: null,
      rule: baseRule
    });
    expect(parsed.rule.shareToCalendar).toBeUndefined();
  });

  it("round-trips shareToCalendar when present", () => {
    const parsed = saveCommitmentRecurrenceRuleCommandSchema.parse({
      expectedVersion: null,
      rule: { ...baseRule, shareToCalendar: true }
    });
    expect(parsed.rule.shareToCalendar).toBe(true);
  });

  // `transportMode` is nullable, unlike every other mode field on the wire: the series editor's own way of clearing a previously chosen
  // mode back to "usual", which a bare enum could not express.
  it("accepts an explicit null transportMode, and a real mode, alongside absent (no opinion)", () => {
    expect(
      saveCommitmentRecurrenceRuleCommandSchema.parse({ expectedVersion: null, rule: baseRule }).rule.transportMode
    ).toBeUndefined();
    expect(
      saveCommitmentRecurrenceRuleCommandSchema.parse({
        expectedVersion: null,
        rule: { ...baseRule, transportMode: null }
      }).rule.transportMode
    ).toBeNull();
    expect(
      saveCommitmentRecurrenceRuleCommandSchema.parse({
        expectedVersion: null,
        rule: { ...baseRule, transportMode: "bike" }
      }).rule.transportMode
    ).toBe("bike");
  });
});

describe("backfilled start commands", () => {
  const base = { commandId: "11111111-1111-4111-8111-111111111111", expectedVersion: 1 };
  const startedAt = "2026-09-03T09:00:00+10:00";
  const activity = {
    ...base,
    type: "start_activity" as const,
    targetType: "deliverable" as const,
    targetId: "d1",
    plannedMinutes: 30
  };

  it("accepts startedAt on start_activity and leaves it absent otherwise", () => {
    expect(activityCommandSchema.parse({ ...activity, startedAt })).toMatchObject({ startedAt });
    expect(activityCommandSchema.parse(activity)).not.toHaveProperty("startedAt");
  });

  it("refuses a startedAt that is not an ISO datetime with an offset", () => {
    expect(activityCommandSchema.safeParse({ ...activity, startedAt: "yesterday" }).success).toBe(false);
    expect(activityCommandSchema.safeParse({ ...activity, startedAt: "2026-09-03T09:00:00" }).success).toBe(false);
  });

  it("refuses a sleep target with startedAt but accepts one without", () => {
    const sleep = { ...activity, targetType: "sleep" as const };
    const refused = activityCommandSchema.safeParse({ ...sleep, startedAt });
    expect(refused.success).toBe(false);
    expect(JSON.stringify(refused.error?.issues)).toContain("save sleep-log-entry");
    expect(activityCommandSchema.safeParse(sleep).success).toBe(true);
  });

  it("accepts startedAt on the action start and select_alternative", () => {
    const start = { ...base, type: "start" as const, actionId: "a1", plannedMinutes: 20 };
    expect(sessionCommandSchema.parse({ ...start, startedAt })).toMatchObject({ startedAt });
    expect(sessionCommandSchema.parse(start)).not.toHaveProperty("startedAt");
    const alternative = {
      ...start,
      type: "select_alternative" as const,
      reason: "lower_energy" as const
    };
    expect(sessionCommandSchema.parse({ ...alternative, startedAt })).toMatchObject({ startedAt });
    expect(sessionCommandSchema.safeParse({ ...alternative, startedAt: "soon" }).success).toBe(false);
  });

  it("accepts correct_start with a session and an offset datetime, and nothing looser", () => {
    const correct = { ...base, type: "correct_start" as const, sessionId: "22222222-2222-4222-8222-222222222222" };
    expect(sessionCommandSchema.parse({ ...correct, startedAt })).toMatchObject({ startedAt });
    expect(sessionCommandSchema.safeParse(correct).success).toBe(false);
    expect(sessionCommandSchema.safeParse({ ...correct, startedAt: "soon" }).success).toBe(false);
  });
});

describe("prerequisites on save commands", () => {
  const project = { id: "p1", outcomeId: "o1", title: "P", status: "active", uncertainty: "some", consequence: 3 };
  const action = {
    id: "a1",
    projectId: "p1",
    title: "A",
    status: "active",
    optimisticMinutes: 10,
    expectedMinutes: 20,
    pessimisticMinutes: 30,
    remainingMinutes: 20,
    energy: "medium",
    minimumSessionMinutes: 10,
    maximumSessionMinutes: 30,
    splittable: true,
    setupMinutes: 0,
    importance: 3,
    consequence: 3,
    contexts: [],
    dependencyIds: []
  };

  it("leaves prerequisites absent, accepts a mixed list and an explicit empty list on a project", () => {
    expect(saveProjectCommandSchema.parse({ expectedVersion: null, project }).project.prerequisites).toBeUndefined();
    const refs = [
      { kind: "project", id: "p2" },
      { kind: "deliverable", id: "d1" },
      { kind: "action", id: "a9" }
    ];
    expect(
      saveProjectCommandSchema.parse({ expectedVersion: null, project: { ...project, prerequisites: refs } }).project
        .prerequisites
    ).toEqual(refs);
    expect(
      saveProjectCommandSchema.parse({ expectedVersion: null, project: { ...project, prerequisites: [] } }).project
        .prerequisites
    ).toEqual([]);
    expect(() =>
      saveProjectCommandSchema.parse({
        expectedVersion: null,
        project: { ...project, prerequisites: [{ kind: "goal", id: "x" }] }
      })
    ).toThrow();
  });

  it("lets an action wait on a project or deliverable but not on another action", () => {
    const ok = saveActionCommandSchema.safeParse({
      expectedVersion: null,
      action: {
        ...action,
        prerequisites: [
          { kind: "project", id: "p2" },
          { kind: "deliverable", id: "d1" }
        ]
      }
    });
    expect(ok.success).toBe(true);
    const bad = saveActionCommandSchema.safeParse({
      expectedVersion: null,
      action: { ...action, prerequisites: [{ kind: "action", id: "a2" }] }
    });
    expect(bad.success).toBe(false);
  });
});

describe("confirmProjectWantedCommandSchema", () => {
  it("accepts the keep and overdue_seen kinds and nothing else", () => {
    for (const kind of ["keep", "overdue_seen"])
      expect(confirmProjectWantedCommandSchema.parse({ projectId: "p1", expectedVersion: 1, kind }).kind).toBe(kind);
    expect(
      confirmProjectWantedCommandSchema.safeParse({ projectId: "p1", expectedVersion: 1, kind: "x" }).success
    ).toBe(false);
  });

  it("takes a project id and a version, and nothing that edits the project", () => {
    expect(confirmProjectWantedCommandSchema.parse({ projectId: "p1", expectedVersion: 3 })).toEqual({
      projectId: "p1",
      expectedVersion: 3
    });
    const withExtras = confirmProjectWantedCommandSchema.parse({
      projectId: "p1",
      expectedVersion: 3,
      title: "Renamed",
      status: "cancelled"
    });
    expect(withExtras).toEqual({ projectId: "p1", expectedVersion: 3 });
  });

  it("needs a real version and project, and accepts a dated or cleared reviewedAt for undo", () => {
    expect(confirmProjectWantedCommandSchema.safeParse({ projectId: "p1", expectedVersion: null }).success).toBe(false);
    expect(confirmProjectWantedCommandSchema.safeParse({ projectId: "", expectedVersion: 1 }).success).toBe(false);
    expect(
      confirmProjectWantedCommandSchema.safeParse({ projectId: "p", expectedVersion: 1, reviewedAt: null }).success
    ).toBe(true);
    expect(
      confirmProjectWantedCommandSchema.safeParse({
        projectId: "p",
        expectedVersion: 1,
        reviewedAt: "2026-10-01T00:00:00Z"
      }).success
    ).toBe(true);
    expect(
      confirmProjectWantedCommandSchema.safeParse({ projectId: "p", expectedVersion: 1, reviewedAt: "yesterday" })
        .success
    ).toBe(false);
  });

  it("is not a field a project save accepts", () => {
    const saved = saveProjectCommandSchema.parse({
      expectedVersion: 1,
      project: {
        id: "p",
        outcomeId: "o",
        title: "P",
        status: "active",
        uncertainty: "some",
        consequence: 3,
        lastReviewedAt: "2026-10-01T00:00:00Z"
      }
    });
    expect(saved.project).not.toHaveProperty("lastReviewedAt");
  });
});

describe("wake command", () => {
  const commandId = "11111111-1111-4111-8111-111111111111";

  it("takes no time at all, one time, or both, as ISO datetimes with an offset", () => {
    expect(wakeCommandSchema.parse({ commandId, type: "wake" })).toEqual({ commandId, type: "wake" });
    expect(wakeCommandSchema.parse({ commandId, type: "wake", at: "2026-09-03T07:00:00+10:00" })).toMatchObject({
      at: "2026-09-03T07:00:00+10:00"
    });
    expect(
      wakeCommandSchema.parse({
        commandId,
        type: "wake",
        at: "2026-09-03T07:00:00+10:00",
        sleptAt: "2026-09-02T23:15:00+10:00"
      })
    ).toMatchObject({ sleptAt: "2026-09-02T23:15:00+10:00" });
  });

  it("refuses a time that is not an ISO datetime with an offset, or a sleep that is not before the wake", () => {
    expect(wakeCommandSchema.safeParse({ commandId, type: "wake", at: "this morning" }).success).toBe(false);
    expect(wakeCommandSchema.safeParse({ commandId, type: "wake", sleptAt: "2026-09-02T23:15:00" }).success).toBe(
      false
    );
    const equal = wakeCommandSchema.safeParse({
      commandId,
      type: "wake",
      at: "2026-09-03T07:00:00+10:00",
      sleptAt: "2026-09-03T07:00:00+10:00"
    });
    expect(equal.success).toBe(false);
    expect(JSON.stringify(equal.error?.issues)).toContain("after the time slept");
    expect(wakeCommandSchema.safeParse({ type: "wake" }).success).toBe(false);
  });
});
