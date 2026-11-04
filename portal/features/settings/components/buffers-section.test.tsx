// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { BuffersSection } from "@/features/settings/components/buffers-section";
import { defaultPlanningSettings } from "@/state/portal-state";

describe("BuffersSection", () => {
  it("edits each buffer independently", () => {
    const onChange = vi.fn();
    render(<BuffersSection draft={defaultPlanningSettings()} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Default setup before (minutes)"), { target: { value: "15" } });
    expect(onChange).toHaveBeenCalledWith({ defaultSetupBufferMinutes: 15 });
    fireEvent.change(screen.getByLabelText("Minimum submission buffer (minutes)"), { target: { value: "90" } });
    expect(onChange).toHaveBeenLastCalledWith({ submissionBufferMinutes: 90 });
  });

  it("keeps the submission percentage as a fraction behind a percent control", () => {
    const onChange = vi.fn();
    render(<BuffersSection draft={defaultPlanningSettings()} onChange={onChange} />);
    // The percent control puts its "%" suffix inside the label, so the label text is not just its name.
    const percent = screen.getByLabelText(/^Submission buffer percentage/) as HTMLInputElement;
    expect(percent.value).toBe("10");
    fireEvent.change(percent, { target: { value: "25" } });
    expect(onChange).toHaveBeenCalledWith({ submissionBufferPercent: 0.25 });
  });

  it("edits the start-by warning lead, defaulting to the settings default", () => {
    const onChange = vi.fn();
    const draft = defaultPlanningSettings();
    render(<BuffersSection draft={draft} onChange={onChange} />);
    const input = screen.getByLabelText(/^Start-by warning lead/) as HTMLInputElement;
    expect(input.value).toBe(String(draft.startByWarningMinutes));
    fireEvent.change(input, { target: { value: "45" } });
    expect(onChange).toHaveBeenCalledWith({ startByWarningMinutes: 45 });
  });

  it("edits the session break, defaulting to the settings default", () => {
    const onChange = vi.fn();
    const draft = defaultPlanningSettings();
    render(<BuffersSection draft={draft} onChange={onChange} />);
    const input = screen.getByLabelText(/^Break after a maximum session/) as HTMLInputElement;
    expect(input.value).toBe(String(draft.sessionBreakMinutes));
    fireEvent.change(input, { target: { value: "20" } });
    expect(onChange).toHaveBeenCalledWith({ sessionBreakMinutes: 20 });
  });

  it("defaults the default mode to no opinion, and reports a choice or a clear back to it", () => {
    const onChange = vi.fn();
    render(<BuffersSection draft={defaultPlanningSettings()} onChange={onChange} />);
    const field = screen.getByLabelText(/^Default mode/) as HTMLSelectElement;
    expect(field.value).toBe("");
    fireEvent.change(field, { target: { value: "walk" } });
    expect(onChange).toHaveBeenCalledWith({ defaultTransportMode: "walk" });
    fireEvent.change(field, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith({ defaultTransportMode: undefined });
  });
});
