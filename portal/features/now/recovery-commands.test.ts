import { describe, expect, it } from "vitest";
import type { PortalState } from "@/state/portal-state";
import { recoverySkippedCommand } from "@/features/now/recovery-commands";

const plan: NonNullable<PortalState["dailyPlan"]> = {
  id: "daily-plan-2026-08-18",
  version: 3,
  localDate: "2026-08-18",
  desiredActionIds: ["a1", "a2"],
  recoverySkipped: false,
  deferredItems: [
    { actionId: "a3", reason: "Blocked by a meeting" },
    { actionId: "a4", reason: "No time left" }
  ]
};

describe("recoverySkippedCommand", () => {
  it("carries the day's wins and deferrals through unchanged while it sets the skip flag", () => {
    const command = recoverySkippedCommand(plan, "2026-08-18", true);
    expect(command.expectedVersion).toBe(3);
    expect(command.entityType).toBe("daily_plan");
    expect(command.entity).toEqual({
      localDate: "2026-08-18",
      desiredActionIds: ["a1", "a2"],
      deferredItems: plan.deferredItems,
      recoverySkipped: true
    });
  });

  it("does not take another day's deferrals into this day's row", () => {
    const command = recoverySkippedCommand(plan, "2026-08-19", true);
    expect(command.expectedVersion).toBeNull();
    expect(command.entity.deferredItems).toEqual([]);
  });

  it("sends only the flag for an overnight start day, leaving both lists to the server", () => {
    const command = recoverySkippedCommand(plan, "2026-08-18", true, true);
    expect(command.entity).toEqual({ localDate: "2026-08-18", recoverySkippedOnly: true, recoverySkipped: true });
  });
});
