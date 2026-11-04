// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { RoutineTile } from "@/features/routines/components/routine-tile";
import type { RoutinePresetStep } from "@/state/portal-state";

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

function renderTile(overrides: Partial<Parameters<typeof RoutineTile>[0]> = {}) {
  const first = step({ id: "one" });
  const props = {
    step: first,
    allSteps: [first],
    editing: false,
    setEditingId: vi.fn(),
    patchStep: vi.fn(),
    deleteStep: vi.fn(),
    connect: vi.fn(),
    dropConnection: vi.fn(),
    reorder: vi.fn(),
    contexts: ["home", "campus"],
    recurringWindows: [],
    cadenceActions: [],
    timeBands: [],
    setRef: vi.fn(),
    ...overrides
  };
  render(<RoutineTile {...props} />);
  return props;
}

describe("RoutineTile, collapsed", () => {
  it("summarises the step and names an untitled one so it can still be reached", () => {
    renderTile();
    expect(screen.getByText("10 min · low")).toBeTruthy();
    expect(screen.getByText("No prerequisites")).toBeTruthy();
    renderTile({ step: step({ id: "two", title: "" }) });
    expect(screen.getByRole("button", { name: "Edit untitled tile" })).toBeTruthy();
  });

  it("counts prerequisites, but says so differently once an occurrence is linked", () => {
    renderTile({ step: step({ id: "one", dependencyIds: ["a", "b"] }) });
    expect(screen.getByText("2 prerequisites")).toBeTruthy();
    renderTile({ step: step({ id: "two", dependencyIds: ["a"], actionWindowId: "w" }) });
    expect(screen.getByText("Completes a recurring occurrence")).toBeTruthy();
  });

  it("opens itself from either handle", () => {
    const props = renderTile();
    fireEvent.click(screen.getByRole("button", { name: "Edit Pack bag" }));
    expect(props.setEditingId).toHaveBeenCalledWith("one");
    vi.mocked(props.setEditingId).mockClear();
    fireEvent.click(screen.getByText("Pack bag"));
    expect(props.setEditingId).toHaveBeenCalledWith("one");
    fireEvent.click(screen.getByRole("button", { name: "Connections into Pack bag" }));
    expect(props.setEditingId).toHaveBeenLastCalledWith("one");
  });

  it("runs both drop handlers, so one gesture can connect or reorder", () => {
    const props = renderTile();
    const article = document.querySelector(".routine-tile")!;
    fireEvent.drop(article, { dataTransfer: { getData: () => "" } });
    expect(props.dropConnection).toHaveBeenCalled();
    expect(props.reorder).toHaveBeenCalled();
  });
});

describe("RoutineTile, editing", () => {
  it("edits the name and the estimate", () => {
    const props = renderTile({ editing: true });
    fireEvent.change(screen.getByLabelText("Step name"), { target: { value: "Pack the bag" } });
    expect(props.patchStep).toHaveBeenCalledWith("one", { title: "Pack the bag" });
    fireEvent.change(screen.getByLabelText("Hands-on"), { target: { value: "25" } });
    expect(props.patchStep).toHaveBeenLastCalledWith("one", { durationMinutes: 25 });
  });

  it("edits the wait after the step, defaulting to 0", () => {
    const props = renderTile({ editing: true });
    expect((screen.getByLabelText("Then wait") as HTMLInputElement).value).toBe("0");
    fireEvent.change(screen.getByLabelText("Then wait"), { target: { value: "15" } });
    expect(props.patchStep).toHaveBeenCalledWith("one", { waitAfterMinutes: 15 });
  });

  it("words the must-start-by field by phase and treats an empty value as none", () => {
    renderTile({ editing: true, step: step({ id: "one", phase: "before" }) });
    expect(screen.getByLabelText(/at least N min before it starts/)).toBeTruthy();
    const props = renderTile({
      editing: true,
      step: step({ id: "two", phase: "after", mustStartByMinutes: 20 })
    });
    const input = screen.getAllByLabelText(/within N min of it ending/)[0] as HTMLInputElement;
    expect(input.value).toBe("20");
    fireEvent.change(input, { target: { value: "" } });
    expect(props.patchStep).toHaveBeenCalledWith("two", { mustStartByMinutes: undefined });
  });

  it("shows the preferred-bands checkbox group only for a flexible before-step", () => {
    const bands = [
      { id: "morning", name: "Morning", start: "06:00", end: "12:00" },
      { id: "evening", name: "Evening", start: "17:00", end: "22:00" }
    ];
    renderTile({ editing: true, timeBands: bands });
    expect(screen.queryByText("Preferred time bands")).toBeNull();
    const props = renderTile({
      editing: true,
      timeBands: bands,
      step: step({ id: "two", timingRule: "flexible", preferredBands: ["morning"] })
    });
    expect(screen.getByText("Preferred time bands")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Evening" }));
    expect(props.patchStep).toHaveBeenCalledWith("two", { preferredBands: ["morning", "evening"] });
    renderTile({
      editing: true,
      timeBands: bands,
      step: step({ id: "three", timingRule: "flexible", phase: "after" })
    });
    expect(screen.getAllByText("Preferred time bands")).toHaveLength(1);
  });

  it("takes the estimate from a linked occurrence and stops it being edited by hand", () => {
    const props = renderTile({
      editing: true,
      recurringWindows: [{ id: "w1", label: "Stretch · Morning", minutes: 15 }]
    });
    fireEvent.change(screen.getByLabelText(/^Linked recurring occurrence/), { target: { value: "w1" } });
    expect(props.patchStep).toHaveBeenCalledWith("one", { actionWindowId: "w1", durationMinutes: 15 });
    renderTile({
      editing: true,
      step: step({ id: "two", actionWindowId: "w1" }),
      recurringWindows: [{ id: "w1", label: "Stretch · Morning", minutes: 15 }]
    });
    expect((screen.getAllByLabelText("Hands-on")[1] as HTMLInputElement).disabled).toBe(true);
  });

  it("links a cadence action and disables the recurring-occurrence select while it is set", () => {
    const props = renderTile({
      editing: true,
      cadenceActions: [{ id: "a1", label: "Practice piano", minutes: 20 }]
    });
    fireEvent.change(screen.getByLabelText(/^Linked cadence action/), { target: { value: "a1" } });
    expect(props.patchStep).toHaveBeenCalledWith("one", { cadenceActionId: "a1" });
    renderTile({
      editing: true,
      step: step({ id: "two", cadenceActionId: "a1" }),
      cadenceActions: [{ id: "a1", label: "Practice piano", minutes: 20 }]
    });
    expect((screen.getAllByLabelText(/^Linked recurring occurrence/)[1] as HTMLSelectElement).disabled).toBe(true);
  });

  it("disables the cadence-action select once a recurring occurrence is linked", () => {
    renderTile({
      editing: true,
      step: step({ id: "one", actionWindowId: "w1" }),
      recurringWindows: [{ id: "w1", label: "Stretch · Morning", minutes: 15 }],
      cadenceActions: [{ id: "a1", label: "Practice piano", minutes: 20 }]
    });
    expect((screen.getByLabelText(/^Linked cadence action/) as HTMLSelectElement).disabled).toBe(true);
  });

  it("shows a cadence-linked step's own label when collapsed", () => {
    renderTile({ step: step({ id: "one", cadenceActionId: "a1" }) });
    expect(screen.getByText("Stands in for a cadence action")).toBeTruthy();
  });

  it("asks for a lead window only when the timing is flexible", () => {
    renderTile({ editing: true });
    expect(screen.queryByLabelText("Earliest")).toBeNull();
    renderTile({ editing: true, step: step({ id: "two", timingRule: "flexible" }) });
    expect((screen.getByLabelText("Earliest") as HTMLInputElement).value).toBe("60");
  });

  it("connects a new prerequisite but removes one directly, so a cycle can still be refused", () => {
    const one = step({ id: "one", dependencyIds: [] });
    const two = step({ id: "two", title: "Shower" });
    const props = renderTile({ editing: true, step: one, allSteps: [one, two] });
    fireEvent.click(screen.getByRole("checkbox", { name: "Shower" }));
    expect(props.connect).toHaveBeenCalledWith("two", "one");
  });

  it("drops a prerequisite without going through the connection check", () => {
    const one = step({ id: "one", dependencyIds: ["two"] });
    const two = step({ id: "two", title: "Shower" });
    const props = renderTile({ editing: true, step: one, allSteps: [one, two] });
    fireEvent.click(screen.getByRole("checkbox", { name: "Shower" }));
    expect(props.patchStep).toHaveBeenCalledWith("one", { dependencyIds: [] });
    expect(props.connect).not.toHaveBeenCalled();
  });

  it("only offers prerequisites from the same side of the commitment", () => {
    const one = step({ id: "one" });
    const after = step({ id: "two", title: "Shower", phase: "after" });
    renderTile({ editing: true, step: one, allSteps: [one, after] });
    expect(screen.queryByRole("checkbox", { name: "Shower" })).toBeNull();
    expect(screen.getByText("No prior connection required.")).toBeTruthy();
  });

  it("adds and removes required contexts", () => {
    const props = renderTile({ editing: true, step: step({ id: "one", contexts: ["home"] }) });
    fireEvent.click(screen.getByRole("checkbox", { name: "campus" }));
    expect(props.patchStep).toHaveBeenCalledWith("one", { contexts: ["home", "campus"] });
    fireEvent.click(screen.getByRole("checkbox", { name: "home" }));
    expect(props.patchStep).toHaveBeenLastCalledWith("one", { contexts: [] });
  });

  it("closes and deletes from inside the editor", () => {
    const props = renderTile({ editing: true });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(props.setEditingId).toHaveBeenCalledWith(null);
    fireEvent.click(screen.getByRole("button", { name: "Remove tile" }));
    expect(props.deleteStep).toHaveBeenCalledWith("one");
  });
});
