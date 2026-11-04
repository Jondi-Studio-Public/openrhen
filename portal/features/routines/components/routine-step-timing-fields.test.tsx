// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { RoutineStepTimingFields } from "@/features/routines/components/routine-step-timing-fields";
import type { RoutinePresetStep } from "@/state/portal-state";

const step = (overrides: Partial<RoutinePresetStep> = {}): RoutinePresetStep => ({
  id: "one",
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

function renderFields(overrides: Partial<Parameters<typeof RoutineStepTimingFields>[0]> = {}) {
  const patch = vi.fn();
  render(<RoutineStepTimingFields step={step()} patch={patch} timeBands={[]} {...overrides} />);
  return { patch };
}

describe("RoutineStepTimingFields", () => {
  it("edits hands-on minutes and defaults the wait to 0", () => {
    const { patch } = renderFields();
    fireEvent.change(screen.getByLabelText("Hands-on"), { target: { value: "25" } });
    expect(patch).toHaveBeenLastCalledWith({ durationMinutes: 25 });
    expect((screen.getByLabelText("Then wait") as HTMLInputElement).value).toBe("0");
    fireEvent.change(screen.getByLabelText("Then wait"), { target: { value: "15" } });
    expect(patch).toHaveBeenLastCalledWith({ waitAfterMinutes: 15 });
  });

  it("words the must-start-by field by phase and treats empty or zero as none", () => {
    renderFields({ step: step({ phase: "before" }) });
    expect(screen.getByLabelText(/at least N min before it starts/)).toBeTruthy();
    const { patch } = renderFields({ step: step({ phase: "after", mustStartByMinutes: 20 }) });
    const input = screen.getByLabelText(/within N min of it ending/) as HTMLInputElement;
    expect(input.value).toBe("20");
    fireEvent.change(input, { target: { value: "" } });
    expect(patch).toHaveBeenLastCalledWith({ mustStartByMinutes: undefined });
    fireEvent.change(input, { target: { value: "0" } });
    expect(patch).toHaveBeenLastCalledWith({ mustStartByMinutes: undefined });
  });

  it("asks for the earliest lead time only when the timing is flexible", () => {
    renderFields();
    expect(screen.queryByLabelText("Earliest")).toBeNull();
    const { patch } = renderFields({ step: step({ timingRule: "flexible" }) });
    expect((screen.getByLabelText("Earliest") as HTMLInputElement).value).toBe("60");
    fireEvent.change(screen.getByLabelText("Earliest"), { target: { value: "30" } });
    expect(patch).toHaveBeenLastCalledWith({ maxLeadMinutes: 30 });
  });

  it("shows preferred time bands only for a flexible before-step", () => {
    renderFields({ timeBands: bands });
    expect(screen.queryByText("Preferred time bands")).toBeNull();
    const { patch } = renderFields({
      timeBands: bands,
      step: step({ timingRule: "flexible", preferredBands: ["morning"] })
    });
    expect(screen.getByText("Preferred time bands")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Evening" }));
    expect(patch).toHaveBeenCalledWith({ preferredBands: ["morning", "evening"] });
    renderFields({
      timeBands: bands,
      step: step({ timingRule: "flexible", phase: "after" })
    });
    expect(screen.getAllByText("Preferred time bands")).toHaveLength(1);
  });

  it("says when no time bands are defined yet", () => {
    renderFields({ step: step({ timingRule: "flexible" }), timeBands: [] });
    expect(screen.getByText("No time bands defined yet.")).toBeTruthy();
  });
});
