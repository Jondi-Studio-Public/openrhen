// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { RoutineToolbar } from "@/features/routines/components/routine-toolbar";

function renderToolbar(overrides: Partial<Parameters<typeof RoutineToolbar>[0]> = {}) {
  const props = {
    name: "Campus morning",
    status: "active" as const,
    saving: false,
    dirty: true,
    onNameChange: vi.fn(),
    onAddStep: vi.fn(),
    ...overrides
  };
  render(<RoutineToolbar {...props} />);
  return props;
}

describe("RoutineToolbar", () => {
  it("reports a renamed routine", () => {
    const props = renderToolbar();
    fireEvent.change(screen.getByLabelText(/^Routine name/), { target: { value: "Campus evening" } });
    expect(props.onNameChange).toHaveBeenCalledWith("Campus evening");
  });

  it("has no status select: archiving is its own button, and the status is shown as text", () => {
    const { rerender } = render(
      <RoutineToolbar name="Campus morning" status="active" saving={false} dirty onNameChange={() => {}} onAddStep={() => {}} />
    );
    expect(screen.queryByRole("combobox", { name: "Status" })).toBeNull();
    expect(screen.getByText("Active")).toBeTruthy();
    rerender(
      <RoutineToolbar name="Campus morning" status="archived" saving={false} dirty onNameChange={() => {}} onAddStep={() => {}} />
    );
    expect(screen.getByText("Archived")).toBeTruthy();
  });

  it("carries the close control it is given", () => {
    renderToolbar({ closeControl: <button type="button">Archive routine</button> });
    expect(screen.getByRole("button", { name: "Archive routine" })).toBeTruthy();
  });

  it("adds tiles on either side of the commitment", () => {
    const props = renderToolbar();
    fireEvent.click(screen.getByRole("button", { name: "Add tile" }));
    expect(props.onAddStep).toHaveBeenCalledWith("before");
    fireEvent.click(screen.getByRole("button", { name: "Add step after" }));
    expect(props.onAddStep).toHaveBeenLastCalledWith("after");
  });

  it("refuses to submit while nothing has changed", () => {
    renderToolbar({ dirty: false });
    expect((screen.getByRole("button", { name: "Save routine" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says what it is doing and stays disabled while a save is in flight", () => {
    renderToolbar({ saving: true });
    const save = screen.getByRole("button", { name: "Saving…" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.type).toBe("submit");
  });
});
