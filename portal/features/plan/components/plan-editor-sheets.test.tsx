// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@/test/render";
import { createSeedState, type PortalState } from "@/state/portal-state";
import { usePlanEditors } from "@/features/plan/use-plan-editors";
import { PlanEditorSheets } from "./plan-editor-sheets";

const saveProjectCommand = vi.fn().mockResolvedValue(undefined);
const saveActionCommand = vi.fn().mockResolvedValue(undefined);
const saveEntityCommand = vi.fn().mockResolvedValue(undefined);
const endRecurrenceGoalCommand = vi.fn().mockResolvedValue(undefined);
const recordCadenceCompletionCommand = vi.fn().mockResolvedValue(undefined);
let state: PortalState;

vi.mock("@/state/portal-provider", () => ({
  usePortal: () => ({
    state,
    saveProjectCommand,
    saveActionCommand,
    saveEntityCommand,
    endRecurrenceGoalCommand,
    recordCadenceCompletionCommand
  })
}));

beforeEach(() => {
  state = createSeedState(new Date("2026-08-18T09:00:00.000Z"));
  saveProjectCommand.mockClear();
  saveActionCommand.mockClear();
  saveEntityCommand.mockClear();
});

/** Stands in for `/plan` or `/plan/[areaId]`: owns the hook and offers a button per editor kind. */
function Harness() {
  const editors = usePlanEditors();
  return (
    <div>
      <button onClick={() => editors.openEdit("area", state.areas[0]!)}>Open area edit</button>
      <button onClick={() => editors.openCreate("area")}>Open area create</button>
      <button onClick={() => editors.openEdit("outcome", state.outcomes[0]!)}>Open outcome edit</button>
      <button onClick={() => editors.openEdit("project", state.projects[0]!)}>Open project edit</button>
      <button onClick={() => editors.openCreate("deliverable", { projectId: state.projects[1]!.id })}>
        Open deliverable create
      </button>
      <button onClick={() => editors.openEdit("action", state.actions[0]!)}>Open action edit</button>
      <PlanEditorSheets
        editors={editors}
        areas={state.areas}
        outcomes={state.outcomes}
        projects={state.projects}
        actions={state.actions}
        deliverables={state.deliverables}
        conditionDefinitions={state.conditionDefinitions}
        timezone={state.settings.timezone}
      />
    </div>
  );
}

describe("PlanEditorSheets", () => {
  it("opens the area editor, pre-filled, when an area's Edit is pressed", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open area edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit area" });
    expect((within(dialog).getByLabelText("Name") as HTMLInputElement).value).toBe(state.areas[0]!.name);
  });

  it("opens the outcome editor for the outcome that was pressed", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open outcome edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit outcome" });
    expect((within(dialog).getByLabelText("Outcome") as HTMLInputElement).value).toBe(state.outcomes[0]!.title);
  });

  it("opens the deliverable form with the preset project already chosen", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open deliverable create" }));
    const dialog = screen.getByRole("dialog", { name: "Register or edit deliverables" });
    expect((within(dialog).getByLabelText("Project") as HTMLSelectElement).value).toBe(state.projects[1]!.id);
  });

  it("closes once a project save succeeds", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open project edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit project" });
    // The sheet now animates out rather than vanishing the moment `open` goes false, so this has to
    // wait for the save's own promise to settle (`act`, not a real-time `waitFor` poll — the sheet's
    // exit transition takes real time on its own, but the save resolving does not need to) before the
    // "closing" phase shows up, then finish that transition itself rather than the real fallback timer.
    await act(async () => {
      fireEvent.submit(document.querySelector("form")!);
    });
    expect(dialog.getAttribute("data-phase")).toBe("closing");
    fireEvent.transitionEnd(dialog);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(saveProjectCommand).toHaveBeenCalledTimes(1);
  });

  it("closes once an action save succeeds", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open action edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit action" });
    await act(async () => {
      fireEvent.submit(document.querySelector("form")!);
    });
    expect(dialog.getAttribute("data-phase")).toBe("closing");
    fireEvent.transitionEnd(dialog);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(saveActionCommand).toHaveBeenCalledTimes(1);
  });

  it("registers a new deliverable and closes", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open deliverable create" }));
    const dialog = screen.getByRole("dialog", { name: "Register or edit deliverables" });
    fireEvent.change(screen.getByLabelText("Deliverable title"), { target: { value: "Portfolio" } });
    await act(async () => {
      fireEvent.submit(document.querySelector("form")!);
    });
    expect(dialog.getAttribute("data-phase")).toBe("closing");
    fireEvent.transitionEnd(dialog);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(saveEntityCommand).toHaveBeenCalledTimes(1);
    expect(saveEntityCommand.mock.calls[0]![0].entityType).toBe("deliverable");
  });

  it("stays open and shows the reason when a save is rejected as invalid", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open area create" }));
    fireEvent.submit(document.querySelector("form")!);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Area name is required.");
    expect(screen.getByRole("dialog", { name: "Add an area" })).toBeTruthy();
    expect(saveEntityCommand).not.toHaveBeenCalled();
  });
});
