// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { CommitmentNameInput, RoutineBoard } from "@/features/routines/components/routine-board";
import type { RoutinePresetDraft } from "@/features/routines/routine-editor";
import type { RoutinePresetStep } from "@/state/portal-state";

// The board measures itself after layout, which needs an observer jsdom does not ship.
beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

const step = (overrides: Partial<RoutinePresetStep> & { id: string }): RoutinePresetStep => ({
  title: overrides.id,
  durationMinutes: 10,
  sequence: 0,
  timingRule: "contiguous",
  energy: "low",
  contexts: [],
  dependencyIds: [],
  phase: "before",
  ...overrides
});

const draft = (steps: RoutinePresetStep[]): RoutinePresetDraft => ({
  id: "preset",
  name: "Campus morning",
  activityName: "Class",
  status: "active",
  replacesWakeRoutine: false,
  steps
});

function renderBoard(steps: RoutinePresetStep[], overrides: Partial<Parameters<typeof RoutineBoard>[0]> = {}) {
  const props = {
    draft: draft(steps),
    editingId: null,
    setEditingId: vi.fn(),
    patchStep: vi.fn(),
    deleteStep: vi.fn(),
    connect: vi.fn(),
    dropConnection: vi.fn(),
    reorder: vi.fn(),
    contexts: [],
    recurringWindows: [],
    cadenceActions: [],
    timeBands: [],
    onCommitmentNameChange: vi.fn(),
    onReplacesWakeRoutineChange: vi.fn(),
    ...overrides
  };
  const view = render(<RoutineBoard {...props} />);
  return { ...view, props };
}

describe("RoutineBoard", () => {
  it("puts independent steps in the first column and dependents in the next", () => {
    const { container } = renderBoard([
      step({ id: "wake" }),
      step({ id: "shower", sequence: 1, dependencyIds: ["wake"] })
    ]);
    const labels = [...container.querySelectorAll(".level-label")].map((node) => node.textContent);
    expect(labels).toEqual(["Starts", "Then", "Commitment"]);
  });

  it("places after-phase steps on the far side of the commitment", () => {
    const { container } = renderBoard([step({ id: "wake" }), step({ id: "tidy", sequence: 1, phase: "after" })]);
    const labels = [...container.querySelectorAll(".level-label")].map((node) => node.textContent);
    expect(labels).toEqual(["Starts", "Commitment", "Then"]);
  });

  it("draws one arrow per dependency plus the arrows into the commitment", () => {
    const { container } = renderBoard([
      step({ id: "wake" }),
      step({ id: "shower", sequence: 1, dependencyIds: ["wake"] })
    ]);
    const keys = [...container.querySelectorAll(".routine-connections path[marker-end]")];
    expect(keys).toHaveLength(2);
  });

  it("renders a tile for every step", () => {
    const { container } = renderBoard([step({ id: "wake" }), step({ id: "tidy", sequence: 1, phase: "after" })]);
    expect(container.querySelectorAll(".routine-tile")).toHaveLength(2);
  });

  it("names the commitment from the draft and reports a rename", () => {
    const { props } = renderBoard([step({ id: "wake" })]);
    const input = screen.getByLabelText("Commitment name") as HTMLInputElement;
    expect(input.value).toBe("Class");
    fireEvent.change(input, { target: { value: "Lecture" } });
    expect(props.onCommitmentNameChange).toHaveBeenCalledWith("Lecture");
  });

  it("reports the replaces-wake-routine checkbox from the draft", () => {
    const { container, props } = renderBoard([step({ id: "wake" })]);
    const checkbox = container.querySelector(".replaces-wake-routine input") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);
    expect(props.onReplacesWakeRoutineChange).toHaveBeenCalledWith(true);
  });
});

describe("CommitmentNameInput", () => {
  it("stays reachable by name even while it is empty", () => {
    const onChange = vi.fn();
    render(<CommitmentNameInput value="" onChange={onChange} />);
    const input = screen.getByLabelText("Commitment name") as HTMLInputElement;
    expect(input.placeholder).toBe("Name the commitment");
    fireEvent.change(input, { target: { value: "Class" } });
    expect(onChange).toHaveBeenCalledWith("Class");
  });
});
