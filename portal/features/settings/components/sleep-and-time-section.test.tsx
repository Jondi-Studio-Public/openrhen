// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { SleepAndTimeSection } from "@/features/settings/components/sleep-and-time-section";
import { defaultPlanningSettings } from "@/state/portal-state";

const settings = () => defaultPlanningSettings();

describe("SleepAndTimeSection", () => {
  it("reports each edited limit as a patch rather than a whole settings object", () => {
    const onChange = vi.fn();
    render(<SleepAndTimeSection draft={settings()} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Preferred bedtime"), { target: { value: "23:30" } });
    expect(onChange).toHaveBeenCalledWith({ preferredBedtime: "23:30" });
    fireEvent.change(screen.getByLabelText(/^Maximum awake hours/), { target: { value: "18" } });
    expect(onChange).toHaveBeenLastCalledWith({ maxAwakeHours: 18 });
  });

  it("edits the bedtime-deviation minutes", () => {
    const onChange = vi.fn();
    render(<SleepAndTimeSection draft={{ ...settings(), bedtimeDeviationMinutes: 90 }} onChange={onChange} />);
    const input = screen.getByLabelText(/^Bedtime deviation/) as HTMLInputElement;
    expect(input.value).toBe("90");
    fireEvent.change(input, { target: { value: "120" } });
    expect(onChange).toHaveBeenCalledWith({ bedtimeDeviationMinutes: 120 });
  });

  it("clears last wake when the field is emptied instead of storing an empty string", () => {
    const onChange = vi.fn();
    render(
      <SleepAndTimeSection draft={{ ...settings(), lastWokeAt: "2026-08-18T20:00:00.000Z" }} onChange={onChange} />
    );
    fireEvent.change(screen.getByLabelText(/^When did you last wake\?/), { target: { value: "" } });
    expect(onChange).toHaveBeenCalledWith({ lastWokeAt: undefined });
  });

  it("shows and reads last wake on the planning wall clock, not the device's", () => {
    const onChange = vi.fn();
    // A planning zone no test machine runs in, so a picker that read the device's zone would fail.
    const draft = { ...settings(), timezone: "Pacific/Auckland", lastWokeAt: "2026-08-18T20:00:00.000Z" };
    render(<SleepAndTimeSection draft={draft} onChange={onChange} />);
    const input = screen.getByLabelText(/^When did you last wake\?/) as HTMLInputElement;
    expect(input.value).toBe("2026-08-19T08:00");
    fireEvent.change(input, { target: { value: "2026-08-19T07:30" } });
    expect(onChange).toHaveBeenCalledWith({ lastWokeAt: "2026-08-18T19:30:00.000Z" });
  });

  it("points at the sleep log to add or correct a past night", () => {
    render(<SleepAndTimeSection draft={settings()} onChange={vi.fn()} />);
    expect(screen.getByRole("link", { name: "Sleep" }).getAttribute("href")).toBe("/sleep");
  });
});
