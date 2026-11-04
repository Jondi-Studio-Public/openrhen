// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import type { PortalState } from "@/state/portal-state";
import { step } from "@/features/deliverables/test-fixtures";
import { StepRequirementsSheet } from "./step-requirements-sheet";

type ConditionDefinition = PortalState["conditionDefinitions"][number];
const context = (id: string, name: string): ConditionDefinition => ({
  id,
  name,
  kind: "location",
  status: "active",
  pathways: [],
  portability: "fixed",
  grants: [],
  setupBeforeMinutes: 0,
  transitionAfterMinutes: 0,
  channels: []
});
const definitions = [context("home", "At home"), context("laptop", "Laptop")];

describe("StepRequirementsSheet", () => {
  it("starts from the step's saved pathways and saves the edited draft", async () => {
    const onSave = vi.fn(() => true);
    const onClose = vi.fn();
    render(
      <StepRequirementsSheet
        open
        step={step("s1", { requirementPathways: [{ id: "p1", contextIds: ["home"] }] })}
        conditionDefinitions={definitions}
        saving={false}
        onSave={onSave}
        onClose={onClose}
      />
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Laptop" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith([{ id: "p1", contextIds: ["home", "laptop"] }]);
  });

  it("closes once the save resolves true, and does not close on a false result", async () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <StepRequirementsSheet
        open
        step={step("s1")}
        conditionDefinitions={definitions}
        saving={false}
        onSave={() => false}
        onClose={onClose}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await Promise.resolve();
    expect(onClose).not.toHaveBeenCalled();

    rerender(
      <StepRequirementsSheet
        open
        step={step("s1")}
        conditionDefinitions={definitions}
        saving={false}
        onSave={() => true}
        onClose={onClose}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await Promise.resolve();
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on Cancel without calling onSave", () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    render(
      <StepRequirementsSheet
        open
        step={step("s1")}
        conditionDefinitions={definitions}
        saving={false}
        onSave={onSave}
        onClose={onClose}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("disables Save and labels it Saving… while a save is in flight", () => {
    render(
      <StepRequirementsSheet
        open
        step={step("s1")}
        conditionDefinitions={definitions}
        saving
        onSave={() => true}
        onClose={() => {}}
      />
    );
    const button = screen.getByRole("button", { name: "Saving…" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("resets the draft to the step's saved pathways each time it reopens", () => {
    const onSave = vi.fn(() => true);
    const targetStep = step("s1", { requirementPathways: [{ id: "p1", contextIds: ["home"] }] });
    const { rerender } = render(
      <StepRequirementsSheet
        open
        step={targetStep}
        conditionDefinitions={definitions}
        saving={false}
        onSave={onSave}
        onClose={() => {}}
      />
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Laptop" }));
    // Closing, then reopening on the same (unsaved) step must discard the abandoned tick.
    rerender(
      <StepRequirementsSheet
        open={false}
        step={targetStep}
        conditionDefinitions={definitions}
        saving={false}
        onSave={onSave}
        onClose={() => {}}
      />
    );
    rerender(
      <StepRequirementsSheet
        open
        step={targetStep}
        conditionDefinitions={definitions}
        saving={false}
        onSave={onSave}
        onClose={() => {}}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenLastCalledWith([{ id: "p1", contextIds: ["home"] }]);
  });
});
