import { describe, expect, it } from "vitest";
import { planningEntityCommandSchema, sessionCommandSchema } from "@openrhen/contracts";

const base = {
  commandId: "11111111-1111-4111-8111-111111111111",
  expectedVersion: 1,
  sessionId: "22222222-2222-4222-8222-222222222222"
};

describe("durable session command contract", () => {
  it("requires a remaining estimate when progress is reported", () => {
    expect(sessionCommandSchema.safeParse({ ...base, type: "finish", outcome: "progress" }).success).toBe(false);
    expect(
      sessionCommandSchema.safeParse({ ...base, type: "finish", outcome: "progress", remainingMinutes: 30 }).success
    ).toBe(true);
  });
  it("preserves unsure as a distinct outcome", () => {
    const parsed = sessionCommandSchema.parse({ ...base, type: "finish", outcome: "unsure" });
    expect(parsed).toMatchObject({ type: "finish", outcome: "unsure" });
    expect("remainingMinutes" in parsed).toBe(false);
  });
  it("requires blocking and alternative reason categories", () => {
    expect(sessionCommandSchema.safeParse({ ...base, type: "block", actionStatus: "blocked" }).success).toBe(false);
    expect(
      sessionCommandSchema.safeParse({ ...base, type: "block", actionStatus: "blocked", reason: "dependency" }).success
    ).toBe(true);
    expect(
      sessionCommandSchema.safeParse({
        commandId: base.commandId,
        expectedVersion: 1,
        type: "select_alternative",
        actionId: "action",
        plannedMinutes: 30,
        reason: "personal_priority"
      }).success
    ).toBe(true);
  });
});

describe("current availability command", () => {
  it("accepts reported energy and contexts as one versioned change", () => {
    expect(
      planningEntityCommandSchema.safeParse({
        commandId: base.commandId,
        expectedVersion: 1,
        type: "save_entity",
        entityType: "current_availability",
        entity: { currentEnergy: "low", assertedConditions: ["home", "phone"] }
      }).success
    ).toBe(true);
  });
});
