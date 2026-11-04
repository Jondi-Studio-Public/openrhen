// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { RecoverySection } from "@/features/settings/components/recovery-section";
import { defaultPlanningSettings } from "@/state/portal-state";

describe("RecoverySection", () => {
  it("is off by default and offers a default window when switched on", () => {
    const onChange = vi.fn();
    render(<RecoverySection draft={defaultPlanningSettings()} onChange={onChange} />);
    expect((screen.getByLabelText("Protect recovery time") as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByLabelText("Recovery starts")).toBeNull();
    fireEvent.click(screen.getByLabelText("Protect recovery time"));
    expect(onChange).toHaveBeenCalledWith({ recoveryStartTime: "18:00", recoveryEndTime: "19:00" });
  });

  it("clears both times when switched off", () => {
    const onChange = vi.fn();
    const draft = { ...defaultPlanningSettings(), recoveryStartTime: "18:00", recoveryEndTime: "19:00" };
    render(<RecoverySection draft={draft} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("Protect recovery time"));
    expect(onChange).toHaveBeenCalledWith({ recoveryStartTime: null, recoveryEndTime: null });
  });

  it("edits start and end on quarter-hour steps", () => {
    const onChange = vi.fn();
    const draft = { ...defaultPlanningSettings(), recoveryStartTime: "18:00", recoveryEndTime: "19:00" };
    render(<RecoverySection draft={draft} onChange={onChange} />);
    const start = screen.getByLabelText("Recovery starts") as HTMLInputElement;
    expect(start.step).toBe("900");
    fireEvent.change(start, { target: { value: "17:45" } });
    expect(onChange).toHaveBeenCalledWith({ recoveryStartTime: "17:45" });
    fireEvent.change(screen.getByLabelText("Recovery ends"), { target: { value: "19:30" } });
    expect(onChange).toHaveBeenLastCalledWith({ recoveryEndTime: "19:30" });
  });

  it("toggles weekdays but keeps at least one", () => {
    const onChange = vi.fn();
    const draft = { ...defaultPlanningSettings(), recoveryStartTime: "18:00", recoveryEndTime: "19:00" };
    const { rerender } = render(<RecoverySection draft={draft} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("Sat"));
    expect(onChange).toHaveBeenCalledWith({ recoveryWeekdays: [0, 1, 2, 3, 4, 5] });
    onChange.mockClear();
    rerender(<RecoverySection draft={{ ...draft, recoveryWeekdays: [2] }} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("Tue"));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Wed"));
    expect(onChange).toHaveBeenCalledWith({ recoveryWeekdays: [2, 3] });
  });

  it("explains precedence", () => {
    render(<RecoverySection draft={defaultPlanningSettings()} onChange={vi.fn()} />);
    expect(
      screen.getByText(
        "Work is never planned inside this time. Commitments and sleep take precedence, and you can skip it for one day from Now."
      )
    ).toBeTruthy();
  });
});
