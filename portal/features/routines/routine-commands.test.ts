import { describe, expect, it } from "vitest";
import { createSeedState, type PortalState, type RoutinePreset } from "@/state/portal-state";
import type { RoutinePresetDraft } from "@/features/routines/routine-editor";
import { routinePresetCommand } from "@/features/routines/routine-commands";

const seed = () => createSeedState(new Date("2026-08-19T00:00:00.000Z"));

const routinePresetFixture = (overrides: Partial<RoutinePreset> = {}): RoutinePreset =>
  ({
    id: "preset-1",
    version: 2,
    name: "Morning routine",
    activityName: "Get ready",
    status: "active" as const,
    replacesWakeRoutine: false,
    steps: [
      {
        id: "step-1",
        commitmentId: "c1",
        title: "Shower",
        durationMinutes: 15,
        sequence: 0,
        timingRule: "flexible" as const,
        maxLeadMinutes: 60,
        energy: "medium" as const,
        contexts: ["home"],
        phase: "before" as const,
        dependencyIds: []
      }
    ],
    ...overrides
  }) as unknown as RoutinePreset;

const draftFixture = (overrides: Partial<RoutinePresetDraft> = {}): RoutinePresetDraft =>
  ({
    id: "preset-1",
    name: "Morning routine",
    activityName: "Get ready",
    status: "active" as const,
    replacesWakeRoutine: false,
    steps: [
      {
        id: "step-1",
        commitmentId: "c1",
        title: "Shower",
        durationMinutes: 15,
        sequence: 0,
        timingRule: "flexible" as const,
        maxLeadMinutes: 60,
        energy: "medium" as const,
        contexts: ["home"],
        phase: "before" as const,
        dependencyIds: []
      }
    ],
    ...overrides
  }) as unknown as RoutinePresetDraft;

describe("routinePresetCommand", () => {
  it("claims the preset's version from state and assembles the entity from the draft", () => {
    const state: PortalState = { ...seed(), routinePresets: [routinePresetFixture({ version: 3 })] };
    const draft = draftFixture();
    const command = routinePresetCommand(draft, state);
    expect(command.expectedVersion).toBe(3);
    expect(command.entityType).toBe("routine_preset");
    expect(command.entity).toMatchObject({
      id: "preset-1",
      name: "Morning routine",
      activityName: "Get ready",
      status: "active",
      replacesWakeRoutine: false
    });
    expect(command.entity.steps).toEqual(draft.steps);
  });

  it("saves against no expected version when the preset is not in state (insert case)", () => {
    const state: PortalState = seed();
    const draft = draftFixture();
    const command = routinePresetCommand(draft, state);
    expect(command.expectedVersion).toBeNull();
  });

  it("saves against no expected version when the stored preset has never been persisted", () => {
    const state: PortalState = { ...seed(), routinePresets: [routinePresetFixture({ version: undefined })] };
    const draft = draftFixture();
    const command = routinePresetCommand(draft, state);
    expect(command.expectedVersion).toBeNull();
  });

  it("spreads all draft fields into the entity, including status and replacesWakeRoutine", () => {
    const state: PortalState = { ...seed(), routinePresets: [routinePresetFixture()] };
    const draft = draftFixture({ status: "archived", replacesWakeRoutine: true });
    const command = routinePresetCommand(draft, state);
    expect(command.entity.status).toBe("archived");
    expect(command.entity.replacesWakeRoutine).toBe(true);
  });

  it("preserves the topologically-ordered steps the page composed", () => {
    const orderedSteps = [
      {
        id: "step-2",
        commitmentId: "c2",
        title: "Breakfast",
        durationMinutes: 20,
        sequence: 0,
        timingRule: "flexible" as const,
        maxLeadMinutes: 60,
        energy: "low" as const,
        contexts: ["home"],
        phase: "before" as const,
        dependencyIds: []
      },
      {
        id: "step-1",
        commitmentId: "c1",
        title: "Shower",
        durationMinutes: 15,
        sequence: 1,
        timingRule: "flexible" as const,
        maxLeadMinutes: 60,
        energy: "medium" as const,
        contexts: ["home"],
        phase: "before" as const,
        dependencyIds: ["step-2"]
      }
    ];
    const state: PortalState = { ...seed(), routinePresets: [routinePresetFixture()] };
    const draft = draftFixture({ steps: orderedSteps });
    const command = routinePresetCommand(draft, state);
    const entity = command.entity as Record<string, unknown>;
    const steps = entity.steps as unknown[];
    expect(steps).toEqual(orderedSteps);
    expect(steps.length).toBe(2);
    if (Array.isArray(steps)) {
      expect((steps[0] as Record<string, unknown>).sequence).toBe(0);
      expect((steps[1] as Record<string, unknown>).sequence).toBe(1);
    }
  });
});
