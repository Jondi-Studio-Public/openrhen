// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { RoutineOneOffEditor } from "@/features/routines/components/routine-one-off-editor";
import type { RoutinePresetStep } from "@/state/portal-state";

// The board measures itself after layout — see routine-board.test.tsx's own note.
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
  title: "Pack bag",
  durationMinutes: 10,
  sequence: 0,
  timingRule: "contiguous",
  energy: "low",
  contexts: [],
  dependencyIds: [],
  phase: "before",
  ...overrides
});

const bands = [
  { id: "morning", name: "Morning", start: "06:00", end: "12:00" },
  { id: "evening", name: "Evening", start: "17:00", end: "22:00" }
];

function renderEditor(overrides: Partial<Parameters<typeof RoutineOneOffEditor>[0]> = {}) {
  const onSave = vi.fn();
  const onClose = vi.fn();
  const props = {
    title: "Class",
    steps: [step({ id: "one" })],
    contexts: ["home"],
    timeBands: bands,
    onSave,
    onClose,
    ...overrides
  };
  render(<RoutineOneOffEditor {...props} />);
  return { onSave, onClose };
}

function openTile() {
  fireEvent.click(screen.getByRole("button", { name: "Edit Pack bag" }));
}

describe("RoutineOneOffEditor timing fields", () => {
  it("edits hands-on, wait and must-start-by, treating an empty or zero must-start-by as none", () => {
    renderEditor();
    openTile();
    fireEvent.change(screen.getByLabelText("Hands-on"), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("Then wait"), { target: { value: "5" } });
    const mustStartBy = screen.getByLabelText(/at least N min before it starts/) as HTMLInputElement;
    fireEvent.change(mustStartBy, { target: { value: "30" } });
    expect((screen.getByLabelText(/at least N min before it starts/) as HTMLInputElement).value).toBe("30");
    fireEvent.change(screen.getByLabelText(/at least N min before it starts/), { target: { value: "0" } });
    expect((screen.getByLabelText(/at least N min before it starts/) as HTMLInputElement).value).toBe("");
  });

  it("offers earliest lead time and preferred bands only when flexible, and saves them back", () => {
    const { onSave } = renderEditor();
    openTile();
    expect(screen.queryByLabelText("Earliest")).toBeNull();
    expect(screen.queryByText("Preferred time bands")).toBeNull();
    fireEvent.change(screen.getByLabelText("Timing"), { target: { value: "flexible" } });
    expect((screen.getByLabelText("Earliest") as HTMLInputElement).value).toBe("60");
    fireEvent.change(screen.getByLabelText("Earliest"), { target: { value: "45" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Morning" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Use for this event" }));
    expect(onSave).toHaveBeenCalledWith([
      expect.objectContaining({
        timingRule: "flexible",
        maxLeadMinutes: 45,
        preferredBands: ["morning"]
      })
    ]);
  });

  it("hides preferred bands for a flexible after-step even though earliest still applies", () => {
    renderEditor({ steps: [step({ id: "one", phase: "after", timingRule: "flexible" })] });
    openTile();
    expect(screen.getByLabelText("Earliest")).toBeTruthy();
    expect(screen.getByLabelText(/within N min of it ending/)).toBeTruthy();
    expect(screen.queryByText("Preferred time bands")).toBeNull();
  });
});
