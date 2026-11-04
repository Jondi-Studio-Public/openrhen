import { describe, expect, it } from "vitest";
import { createSeedState, type PortalState, type StoredRoutineStep, type StoredSleepPlan } from "@/state/portal-state";
import {
  dailyPlanCommand,
  routineStepStatusCommand,
  sleepPlanOverrideCommand,
  sleepPlanPlacementChoiceCommand
} from "@/features/today/today-commands";

const seed = () => createSeedState(new Date("2026-08-19T00:00:00.000Z"));
const SEED_ZONE = "Australia/Sydney";

const prepStep = (overrides: Partial<StoredRoutineStep> = {}): StoredRoutineStep =>
  ({
    id: "bins",
    version: 4,
    commitmentId: "dinner",
    title: "Take the bins out",
    durationMinutes: 15,
    sequence: 0,
    timingRule: "flexible" as const,
    maxLeadMinutes: 120,
    energy: "low" as const,
    contexts: ["home"],
    dependencyIds: [],
    phase: "before" as const,
    status: "pending" as const,
    ...overrides
  }) as unknown as StoredRoutineStep;

const sleepPlan = (overrides: Partial<StoredSleepPlan> = {}): StoredSleepPlan =>
  ({
    id: "night-one",
    plannedStartAt: "2026-08-18T12:00:00.000Z",
    plannedWakeAt: "2026-08-18T20:00:00.000Z",
    allowedMinutes: 480,
    desiredMinutes: 480,
    sleepDeficitMinutes: 0,
    anchorDeviationMinutes: 0,
    hardErrors: [],
    explanation: "Full night available",
    status: "planned" as const,
    ...overrides
  }) as unknown as StoredSleepPlan;

describe("dailyPlanCommand", () => {
  it("saves against no expected version when no daily plan is stored for the day yet", () => {
    const state: PortalState = seed();
    const command = dailyPlanCommand(
      { dayKey: "2026-08-19", desiredActionIds: ["a1"], deferredAction: "", deferredReason: "" },
      state
    );
    expect(command.expectedVersion).toBeNull();
    expect(command.entityType).toBe("daily_plan");
    expect(command.entity).toMatchObject({ localDate: "2026-08-19", desiredActionIds: ["a1"], deferredItems: [] });
  });

  it("claims the version of the stored plan that its merge read", () => {
    const state: PortalState = {
      ...seed(),
      dailyPlan: {
        id: "daily-plan-2026-08-19",
        version: 3,
        localDate: "2026-08-19",
        desiredActionIds: ["a1"],
        recoverySkipped: false,
        deferredItems: [{ actionId: "a2", reason: "Ran out of time" }]
      }
    };
    const command = dailyPlanCommand(
      { dayKey: "2026-08-19", desiredActionIds: ["a1"], deferredAction: "", deferredReason: "" },
      state
    );
    expect(command.expectedVersion).toBe(3);
  });

  it("merges a new deferred item with whatever the stored plan already carried", () => {
    const state: PortalState = {
      ...seed(),
      dailyPlan: {
        id: "daily-plan-2026-08-19",
        version: 3,
        localDate: "2026-08-19",
        desiredActionIds: ["a1"],
        recoverySkipped: false,
        deferredItems: [{ actionId: "a2", reason: "Ran out of time" }]
      }
    };
    const command = dailyPlanCommand(
      { dayKey: "2026-08-19", desiredActionIds: ["a1"], deferredAction: "a3", deferredReason: " Blocked " },
      state
    );
    expect(command.entity.deferredItems).toEqual([
      { actionId: "a2", reason: "Ran out of time" },
      { actionId: "a3", reason: "Blocked" }
    ]);
  });

  it("drops a stored plan from a different day rather than reading its version or its deferred items", () => {
    const state: PortalState = {
      ...seed(),
      dailyPlan: {
        id: "daily-plan-2026-08-18",
        version: 7,
        localDate: "2026-08-18",
        desiredActionIds: ["a1"],
        recoverySkipped: false,
        deferredItems: [{ actionId: "a2", reason: "Yesterday" }]
      }
    };
    const command = dailyPlanCommand(
      { dayKey: "2026-08-19", desiredActionIds: [], deferredAction: "", deferredReason: "" },
      state
    );
    expect(command.expectedVersion).toBeNull();
    expect(command.entity.deferredItems).toEqual([]);
  });

  it("adds no deferred item when the reason is blank", () => {
    const state: PortalState = seed();
    const command = dailyPlanCommand(
      { dayKey: "2026-08-19", desiredActionIds: [], deferredAction: "a3", deferredReason: "   " },
      state
    );
    expect(command.entity.deferredItems).toEqual([]);
  });
});

describe("routineStepStatusCommand", () => {
  it("claims the step's own version and restates every other column unchanged", () => {
    const state: PortalState = { ...seed(), routineSteps: [prepStep()] };
    const command = routineStepStatusCommand("bins", "completed", state);
    expect(command).not.toBeNull();
    expect(command?.expectedVersion).toBe(4);
    expect(command?.entityType).toBe("routine_step");
    expect(command?.entity).toMatchObject({
      id: "bins",
      commitmentId: "dinner",
      title: "Take the bins out",
      durationMinutes: 15,
      sequence: 0,
      timingRule: "flexible",
      status: "completed"
    });
    // Status only: the columns the save did not name travel through unchanged.
    expect(command?.entity.energy).toBe("low");
    expect(command?.entity.contexts).toEqual(["home"]);
  });

  it("saves against no expected version when the step has never been stored", () => {
    const state: PortalState = { ...seed(), routineSteps: [prepStep({ version: undefined })] };
    const command = routineStepStatusCommand("bins", "completed", state);
    expect(command?.expectedVersion).toBeNull();
  });

  it("returns null, rather than throwing, when the step is no longer on the plan", () => {
    const state: PortalState = { ...seed(), routineSteps: [] };
    expect(routineStepStatusCommand("bins", "completed", state)).toBeNull();
  });
});

describe("sleepPlanOverrideCommand", () => {
  it("converts the datetime-local override into the planning timezone's instants", () => {
    const command = sleepPlanOverrideCommand(
      sleepPlan({ version: 2 }),
      "2026-08-18T22:00",
      "2026-08-19T06:00",
      SEED_ZONE
    );
    expect(command.expectedVersion).toBe(2);
    expect(command.entityType).toBe("sleep_plan");
    expect(command.entity).toMatchObject({
      id: "night-one",
      // 22:00 local (AEST, +10) is 12:00 UTC.
      plannedStartAt: "2026-08-18T12:00:00.000Z",
      plannedWakeAt: "2026-08-18T20:00:00.000Z"
    });
  });

  it("saves against no expected version when the engine's own night was never stored", () => {
    const command = sleepPlanOverrideCommand(
      sleepPlan({ version: undefined }),
      "2026-08-18T22:00",
      "2026-08-19T06:00",
      SEED_ZONE
    );
    expect(command.expectedVersion).toBeNull();
  });
});

describe("sleepPlanPlacementChoiceCommand", () => {
  it("records the answer to the bedtime-deviation choice against the plan's version", () => {
    const command = sleepPlanPlacementChoiceCommand(sleepPlan({ version: 3 }), "near");
    expect(command.expectedVersion).toBe(3);
    expect(command.entityType).toBe("sleep_plan");
    expect(command.entity).toEqual({ id: "night-one", placementChoice: "near" });
  });

  it("saves against no expected version when the engine's own night was never stored", () => {
    const command = sleepPlanPlacementChoiceCommand(sleepPlan({ version: undefined }), "early");
    expect(command.expectedVersion).toBeNull();
  });
});
