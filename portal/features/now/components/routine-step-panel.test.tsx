// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createSeedState, type StoredRoutineStep } from "@/state/portal-state";
import { fireEvent, render, screen } from "@/test/render";
import { RoutineStepPanel } from "./routine-step-panel";

const now = new Date("2026-08-18T10:00:00.000Z");
const state = createSeedState(now);
const routineDue: StoredRoutineStep = {
  id: "step-uniform",
  version: 4,
  commitmentId: "dinner",
  anchorType: "commitment",
  title: "Prepare uniform",
  durationMinutes: 10,
  sequence: 1,
  timingRule: "flexible",
  energy: "low",
  contexts: [],
  dependencyIds: [],
  phase: "before",
  status: "pending"
};

describe("RoutineStepPanel", () => {
  it("says which commitment the preparation is for and starts it", () => {
    const runActivityCommand = vi.fn().mockResolvedValue(undefined);
    render(
      <RoutineStepPanel
        routineDue={routineDue}
        state={state}
        now={now}
        timezone="Australia/Sydney"
        saving={false}
        runActivityCommand={runActivityCommand}
        saveEntityCommand={vi.fn().mockResolvedValue(undefined)}
      />
    );
    expect(screen.getByText("10 minutes")).toBeTruthy();
    expect(screen.getByText(/Required for/)).toBeTruthy();
    // The commitment names itself and is the way into its own page, where the rest of its
    // preparation — and where that preparation came from — is written down.
    expect(screen.getByRole("link", { name: "Dinner and reset" }).getAttribute("href")).toBe("/commitments/dinner");
    fireEvent.click(screen.getByRole("button", { name: "Start preparation" }));
    expect(runActivityCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "start_activity",
        targetType: "routine_step",
        targetId: "step-uniform",
        plannedMinutes: 10,
        expectedVersion: 4
      })
    );
  });

  it("falls back to a plain description when the commitment has gone", () => {
    render(
      <RoutineStepPanel
        routineDue={{ ...routineDue, commitmentId: "missing" }}
        state={state}
        now={now}
        timezone="Australia/Sydney"
        saving={false}
        runActivityCommand={vi.fn()}
        saveEntityCommand={vi.fn().mockResolvedValue(undefined)}
      />
    );
    expect(screen.getByText(/an upcoming commitment/)).toBeTruthy();
  });

  it("skips the step directly, without opening a session", () => {
    const saveEntityCommand = vi.fn().mockResolvedValue(undefined);
    render(
      <RoutineStepPanel
        routineDue={routineDue}
        state={state}
        now={now}
        timezone="Australia/Sydney"
        saving={false}
        runActivityCommand={vi.fn()}
        saveEntityCommand={saveEntityCommand}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(saveEntityCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "save_entity",
        entityType: "routine_step",
        expectedVersion: 4,
        entity: expect.objectContaining({ id: "step-uniform", status: "skipped" })
      })
    );
  });
});
