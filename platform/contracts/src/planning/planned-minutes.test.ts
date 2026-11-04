import { describe, expect, it } from "vitest";
import { activityCommandSchema, MAX_PLANNED_SESSION_MINUTES, sessionCommandSchema } from "./commands";

const base = { commandId: crypto.randomUUID(), expectedVersion: 1 };

describe("planned session minutes", () => {
  it("accepts up to a day and refuses more", () => {
    for (const plannedMinutes of [1, MAX_PLANNED_SESSION_MINUTES]) {
      expect(sessionCommandSchema.safeParse({ ...base, type: "start", actionId: "a", plannedMinutes }).success).toBe(
        true
      );
    }
    for (const plannedMinutes of [MAX_PLANNED_SESSION_MINUTES + 1, 99999, 0]) {
      expect(sessionCommandSchema.safeParse({ ...base, type: "start", actionId: "a", plannedMinutes }).success).toBe(
        false
      );
      expect(
        sessionCommandSchema.safeParse({
          ...base,
          type: "select_alternative",
          actionId: "a",
          plannedMinutes,
          reason: "lower_energy"
        }).success
      ).toBe(false);
      expect(
        activityCommandSchema.safeParse({
          ...base,
          type: "start_activity",
          targetType: "routine_step",
          targetId: "t",
          plannedMinutes
        }).success
      ).toBe(false);
    }
  });
});
