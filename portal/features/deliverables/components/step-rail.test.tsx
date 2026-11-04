// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { StoredDeliverable } from "@/state/portal-state";
import { fireEvent, render, screen, within } from "@/test/render";
import { StepRail } from "./step-rail";
import { assess, blocker, deliverable, step } from "@/features/deliverables/test-fixtures";

const plan = deliverable({
  steps: [
    step("draft", { title: "Draft", sortOrder: 0 }),
    step("revise", { title: "Revise", sortOrder: 1, dependencyIds: ["draft"] }),
    step("submit", { title: "Submit", sortOrder: 2, estimateNeedsReview: true })
  ],
  blockers: [blocker("portal", { description: "Portal closed", stepIds: ["submit"] })]
});

function renderRail(overrides: Partial<Parameters<typeof StepRail>[0]> = {}) {
  const onEdit = vi.fn();
  const onSwitchStep = vi.fn();
  render(
    <StepRail
      deliverable={plan}
      readiness={assess(plan)}
      conditionDefinitions={[]}
      editable
      currentStepId="draft"
      stepSeconds={{ draft: 125 }}
      canSwitch
      onSwitchStep={onSwitchStep}
      onEdit={onEdit}
      timezone="Australia/Sydney"
      {...overrides}
    />
  );
  return { onEdit, onSwitchStep };
}

/** Applies every functional edit the rail queued to the plan, the way the page's draft would. */
const applied = (onEdit: ReturnType<typeof vi.fn>, from: StoredDeliverable = plan) =>
  onEdit.mock.calls.reduce<StoredDeliverable>((current, [change]) => change(current), from);

describe("StepRail", () => {
  it("marks the current step, its time this session, and why the others are or are not workable", () => {
    renderRail();
    expect(screen.getByText("Now:")).toBeTruthy();
    expect(screen.getByText(/2:05 this session/)).toBeTruthy();
    expect(screen.getByText("Waiting on Draft")).toBeTruthy();
    expect(screen.getByText("Blocked by Portal closed")).toBeTruthy();
    expect(screen.getByText(/overran its estimate/)).toBeTruthy();
  });

  it("offers Work on this action in the heading of every other executable step, not the current one", () => {
    const { onSwitchStep } = renderRail({
      currentStepId: "revise",
      deliverable: {
        ...plan,
        steps: plan.steps.map((item) => (item.id === "draft" ? { ...item, status: "done" } : item))
      },
      readiness: assess({
        ...plan,
        steps: plan.steps.map((item) => (item.id === "draft" ? { ...item, status: "done" } : item))
      })
    });
    // Draft is done, Revise is current, Submit is blocked: nothing else is executable.
    expect(screen.queryByRole("button", { name: "Work on this action" })).toBeNull();
    onSwitchStep.mockClear();
  });

  it("switches to another executable step with one click", () => {
    const { onSwitchStep } = renderRail({ currentStepId: undefined });
    fireEvent.click(screen.getByRole("button", { name: "Work on this action" }));
    expect(onSwitchStep).toHaveBeenCalledWith("draft");
  });

  it("hides the switch outside a running Carry-out session", () => {
    renderRail({ canSwitch: false, currentStepId: undefined });
    expect(screen.queryByRole("button", { name: "Work on this action" })).toBeNull();
  });

  it("authors every projection field the engine reads", () => {
    const { onEdit } = renderRail();
    fireEvent.change(screen.getAllByLabelText("Energy")[0]!, { target: { value: "high" } });
    const minimum = screen.getAllByLabelText("Minimum session minutes")[0]!;
    fireEvent.change(minimum, { target: { value: "25" } });
    fireEvent.click(screen.getAllByRole("checkbox", { name: "Required to complete the deliverable" })[0]!);
    fireEvent.change(screen.getAllByLabelText("Pessimistic minutes")[0]!, { target: { value: "90" } });
    // Edits are patches merged into the draft as it stands, so all four survive without a re-render.
    expect(applied(onEdit).steps[0]).toMatchObject({
      energy: "high",
      minimumSessionMinutes: 25,
      required: false,
      pessimisticMinutes: 90
    });
  });

  it("edits a step's prerequisites through the depends-on multi-select, offering every other step but not itself", () => {
    const { onEdit } = renderRail();
    // Submit (index 2) has no prerequisite yet. Its select must offer Draft and Revise, but not
    // itself, and setting Draft as selected must save it as the step's sole dependency.
    const select = screen.getAllByLabelText("Depends on")[2]! as HTMLSelectElement;
    const options = within(select)
      .getAllByRole("option")
      .map((option) => (option as HTMLOptionElement).text);
    expect(options).toEqual(["Draft", "Revise"]);
    (within(select).getByText("Draft") as HTMLOptionElement).selected = true;
    fireEvent.change(select);
    expect(applied(onEdit).steps[2]?.dependencyIds).toEqual(["draft"]);
  });

  it("clears the overrun flag when remaining effort is re-estimated", () => {
    const { onEdit } = renderRail();
    fireEvent.change(screen.getAllByLabelText("Remaining minutes")[2]!, { target: { value: "40" } });
    const submit = applied(onEdit).steps[2]!;
    expect(submit.remainingMinutes).toBe(40);
    expect(submit.estimateNeedsReview).toBe(false);
  });

  it("removes a step along with every reference to it", () => {
    const { onEdit } = renderRail();
    fireEvent.click(screen.getAllByRole("button", { name: "Remove action" })[0]!);
    const next = applied(onEdit);
    expect(next.steps.map((item) => item.id)).toEqual(["revise", "submit"]);
    expect(next.steps[0]?.dependencyIds).toEqual([]);
  });

  it("renders values as text with no controls when not editable", () => {
    renderRail({ editable: false, canSwitch: false });
    expect(screen.queryByRole("button", { name: "Add action" })).toBeNull();
    expect(screen.queryByLabelText("Energy")).toBeNull();
    expect(screen.getAllByText(/medium energy · sessions 15–60 min/)).toHaveLength(3);
    for (const box of screen.getAllByRole("checkbox")) expect((box as HTMLInputElement).disabled).toBe(true);
  });

  it("omits Edit requirements when no onSaveStepRequirementPathways is supplied", () => {
    renderRail({ editable: false, canSwitch: false });
    expect(screen.queryByRole("button", { name: "Edit requirements" })).toBeNull();
  });

  describe("Edit requirements popup", () => {
    it("offers it only outside session editability, opens it, and saves against the right step", async () => {
      const onSaveStepRequirementPathways = vi.fn(async () => true);
      renderRail({
        editable: false,
        canSwitch: false,
        onSaveStepRequirementPathways,
        conditionDefinitions: [
          {
            id: "home",
            name: "Home",
            kind: "location",
            status: "active",
            pathways: [],
            portability: "fixed",
            grants: [],
            setupBeforeMinutes: 0,
            transitionAfterMinutes: 0,
            channels: []
          }
        ]
      });
      // Three steps, none editable inline, so the affordance appears once per step.
      const buttons = screen.getAllByRole("button", { name: "Edit requirements" });
      expect(buttons).toHaveLength(3);
      fireEvent.click(buttons[2]!); // Submit
      const popup = await screen.findByRole("dialog");
      fireEvent.click(within(popup).getByRole("button", { name: "Add a requirement" }));
      fireEvent.click(within(popup).getByRole("button", { name: "Save" }));
      expect(onSaveStepRequirementPathways).toHaveBeenCalledWith("submit", [
        expect.objectContaining({ contextIds: [] })
      ]);
    });

    it("is absent inside a running session, where the inline editor already covers pathways", () => {
      const onSaveStepRequirementPathways = vi.fn();
      renderRail({ onSaveStepRequirementPathways });
      expect(screen.queryByRole("button", { name: "Edit requirements" })).toBeNull();
      // The inline editable pathway editor is still there instead.
      expect(screen.getAllByText("Where can this action be done?")).toHaveLength(3);
    });
  });

  describe("compact", () => {
    it("shows the current step and up to three others, with neither the editor disclosure nor Energy", () => {
      renderRail({ compact: true });
      expect(screen.getByText("Now:")).toBeTruthy();
      expect(screen.queryByText("Edit action")).toBeNull();
      expect(screen.queryByText("Details")).toBeNull();
      expect(screen.queryByLabelText("Energy")).toBeNull();
      // Draft (current), Revise, Submit — the whole three-step plan fits under the cap.
      expect(screen.getAllByRole("checkbox")).toHaveLength(3);
    });

    it("shows a done-count instead of the total in the heading", () => {
      renderRail({
        compact: true,
        deliverable: {
          ...plan,
          steps: plan.steps.map((item) => (item.id === "draft" ? { ...item, status: "done" } : item))
        }
      });
      expect(screen.getByText("1 of 3 done")).toBeTruthy();
    });

    it("still offers Work on this action under the same conditions as the full rail", () => {
      const { onSwitchStep } = renderRail({ compact: true, currentStepId: undefined });
      fireEvent.click(screen.getByRole("button", { name: "Work on this action" }));
      expect(onSwitchStep).toHaveBeenCalledWith("draft");
    });

    it("calls onShowAll from the footer button, naming the total step count", () => {
      const onShowAll = vi.fn();
      renderRail({ compact: true, onShowAll });
      fireEvent.click(screen.getByRole("button", { name: "All 3 actions" }));
      expect(onShowAll).toHaveBeenCalled();
    });

    it("omits the footer button when onShowAll is not supplied", () => {
      renderRail({ compact: true });
      expect(screen.queryByRole("button", { name: /All \d+ actions/ })).toBeNull();
    });
  });
});
