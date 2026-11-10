import { describe, expect, it } from "vitest";
import { activityCommandSchema, checkInCommandSchema, sessionCommandSchema } from "../index.js";

const id = () => crypto.randomUUID();
const T1 = "2026-11-09T09:00:00+10:00";
const T1_UTC = "2026-11-08T23:00:00Z";
const T2 = "2026-11-09T09:30:00+10:00";

describe("occurredAt on owner-device commands", () => {
  it("is accepted on every session and activity command that changes state", () => {
    const sessionId = id();
    const base = { commandId: id(), expectedVersion: 1, occurredAt: T1 };
    const session = [
      { type: "start", actionId: "a", plannedMinutes: 30 },
      { type: "select_alternative", actionId: "a", plannedMinutes: 30, reason: "better_fit" },
      { type: "correct_start", sessionId, startedAt: T1 },
      { type: "pause", sessionId },
      { type: "resume", sessionId },
      { type: "request_feedback", sessionId },
      { type: "continue", sessionId, requestedMinutes: 15 },
      { type: "finish", sessionId, outcome: "completed" },
      { type: "block", sessionId, reason: "waiting_on_someone", actionStatus: "waiting" },
      { type: "did_not_start", sessionId }
    ];
    for (const command of session) {
      const parsed = sessionCommandSchema.safeParse({ ...base, ...command });
      expect(parsed.success || JSON.stringify(parsed.error?.issues)).toBe(true);
    }
    const activity = [
      { type: "start_activity", targetType: "routine_step", targetId: "s", plannedMinutes: 10 },
      { type: "switch_deliverable_step", sessionId, stepId: "x" },
      { type: "pause_activity", sessionId },
      { type: "resume_activity", sessionId },
      { type: "finish_activity", sessionId, outcome: "completed" },
      { type: "skip_routine_step", stepId: "s" },
      { type: "reopen_routine_step", stepId: "s" }
    ];
    for (const command of activity) {
      const parsed = activityCommandSchema.safeParse({ ...base, ...command });
      expect(parsed.success || JSON.stringify(parsed.error?.issues)).toBe(true);
    }
  });

  it("needs an offset, like every other instant on the wire", () => {
    const parsed = sessionCommandSchema.safeParse({
      commandId: id(),
      expectedVersion: 1,
      type: "pause",
      sessionId: id(),
      occurredAt: "2026-11-09T09:00:00"
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses startedAt and endedAt that name a different moment, and accepts the same moment", () => {
    const start = { commandId: id(), expectedVersion: 1, type: "start", actionId: "a", plannedMinutes: 30 };
    const clash = sessionCommandSchema.safeParse({ ...start, occurredAt: T1, startedAt: T2 });
    expect(clash.success).toBe(false);
    expect(JSON.stringify(clash.error?.issues)).toContain("name different moments");
    expect(sessionCommandSchema.safeParse({ ...start, occurredAt: T1, startedAt: T1_UTC }).success).toBe(true);
    const finish = {
      commandId: id(),
      expectedVersion: 1,
      type: "finish_activity",
      sessionId: id(),
      outcome: "completed"
    };
    expect(activityCommandSchema.safeParse({ ...finish, occurredAt: T1, endedAt: T2 }).success).toBe(false);
    expect(activityCommandSchema.safeParse({ ...finish, occurredAt: T1, endedAt: T1 }).success).toBe(true);
    const sessionFinish = { ...finish, type: "finish" };
    expect(sessionCommandSchema.safeParse({ ...sessionFinish, occurredAt: T1, endedAt: T2 }).success).toBe(false);
  });

  it("still takes startedAt and endedAt alone, as the agent contract has them", () => {
    expect(
      sessionCommandSchema.safeParse({
        commandId: id(),
        expectedVersion: 1,
        type: "start",
        actionId: "a",
        plannedMinutes: 30,
        startedAt: T1
      }).success
    ).toBe(true);
  });

  it("is on a single check-in answer only, not on the batch answer or a voluntary check-in", () => {
    const answer = {
      commandId: id(),
      expectedVersion: null,
      type: "answer_check_in",
      checkInId: id(),
      status: "on_track",
      answerSource: "app"
    };
    const parsed = checkInCommandSchema.parse({ ...answer, occurredAt: T1 });
    expect(parsed).toMatchObject({ occurredAt: T1 });
    const voluntary = checkInCommandSchema.parse({
      commandId: id(),
      expectedVersion: null,
      type: "voluntary_check_in",
      status: "on_track",
      answerSource: "app",
      occurredAt: T1
    });
    expect("occurredAt" in voluntary).toBe(false);
  });
});
