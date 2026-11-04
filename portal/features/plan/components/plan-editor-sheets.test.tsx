// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@/test/render";
import { closeEntityCommandSchema } from "@openrhen/contracts";
import { resultFor } from "@/test/close-fixtures";
import { createSeedState, type PortalState } from "@/state/portal-state";
import { usePlanEditors } from "@/features/plan/use-plan-editors";
import { PlanEditorSheets } from "./plan-editor-sheets";

const saveProjectCommand = vi.fn().mockResolvedValue(undefined);
const saveActionCommand = vi.fn().mockResolvedValue(undefined);
const saveEntityCommand = vi.fn().mockResolvedValue(undefined);
const endRecurrenceGoalCommand = vi.fn().mockResolvedValue(undefined);
const recordCadenceCompletionCommand = vi.fn().mockResolvedValue(undefined);
// Stands in for the server: a body the close route would refuse fails the test, and the reply is built by the real helper.
const closeEntityCommand = vi.fn(async (command: unknown) =>
  resultFor(closeEntityCommandSchema.parse(command), { version: 3 })
);
let state: PortalState;

vi.mock("@/state/portal-provider", () => ({
  usePortal: () => ({
    state,
    saveProjectCommand,
    saveActionCommand,
    saveEntityCommand,
    endRecurrenceGoalCommand,
    recordCadenceCompletionCommand,
    closeEntityCommand
  })
}));

beforeEach(() => {
  state = createSeedState(new Date("2026-08-18T09:00:00.000Z"));
  saveProjectCommand.mockClear();
  saveActionCommand.mockClear();
  saveEntityCommand.mockClear();
  closeEntityCommand.mockClear();
  state.areas = state.areas.map((item) => ({ ...item, version: 3 }));
  state.outcomes = state.outcomes.map((item) => ({ ...item, version: 3 }));
  state.projects = state.projects.map((item) => ({ ...item, version: 3 }));
  state.actions = state.actions.map((item) => ({ ...item, version: 3 }));
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

  describe("the close control", () => {
    it.each([
      ["area", "Open area edit", "Edit area", /^Archive area/],
      ["project", "Open project edit", "Edit project", /^(Close project|Archive project)/],
      ["outcome", "Open outcome edit", "Edit outcome", /^(Close outcome|Archive outcome)/],
      ["action", "Open action edit", "Edit action", /^(Cancel action|Archive action)/]
    ] as const)("an existing %s carries one, and a new one does not", (kind, open, title, label) => {
      render(<Harness />);
      fireEvent.click(screen.getByRole("button", { name: open }));
      expect(within(screen.getByRole("dialog", { name: title })).getByRole("button", { name: label })).toBeTruthy();
      if (kind === "area") {
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        fireEvent.click(screen.getByRole("button", { name: "Open area create" }));
        expect(within(screen.getByRole("dialog", { name: "Add an area" })).queryByRole("button", { name: /^Archive area/ })).toBeNull();
      }
    });

    it("archives the area through the close route, not a status save, and closes the editor", async () => {
      render(<Harness />);
      fireEvent.click(screen.getByRole("button", { name: "Open area edit" }));
      await act(async () => {
        fireEvent.click(within(screen.getByRole("dialog", { name: "Edit area" })).getByRole("button", { name: /^Archive area/ }));
      });
      expect(closeEntityCommand).toHaveBeenCalledOnce();
      expect(closeEntityCommandSchema.parse(closeEntityCommand.mock.calls[0]![0])).toMatchObject({
        type: "area",
        id: state.areas[0]!.id,
        verb: "archive",
        do: "close",
        expectedVersion: 3
      });
      expect(saveEntityCommand).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog", { name: "Edit area" })).toBeNull();
    });

    it("is disabled while the form holds unsaved edits", () => {
      render(<Harness />);
      fireEvent.click(screen.getByRole("button", { name: "Open area edit" }));
      const dialog = screen.getByRole("dialog", { name: "Edit area" });
      const button = within(dialog).getByRole("button", { name: /^Archive area/ }) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Renamed" } });
      expect((within(dialog).getByRole("button", { name: /^Archive area/ }) as HTMLButtonElement).disabled).toBe(true);
      expect(within(dialog).getByText("Save or discard your changes first.")).toBeTruthy();
    });
  });
});
