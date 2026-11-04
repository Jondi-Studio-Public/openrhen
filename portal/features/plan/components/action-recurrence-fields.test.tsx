// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { emptyAction } from "@/features/plan/plan-drafts";
import { ActionRecurrenceFields } from "@/features/plan/components/action-recurrence-fields";

const recurring = () => ({ ...emptyAction("Australia/Sydney"), schedulingMode: "recurring" as const });

describe("ActionRecurrenceFields", () => {
  it("asks for an end date only while the series ends on one", () => {
    const { rerender } = render(<ActionRecurrenceFields draft={recurring()} onChange={() => {}} />);
    expect(screen.getByLabelText("Series ends")).toBeTruthy();
    rerender(
      <ActionRecurrenceFields draft={{ ...recurring(), completionMode: "total_minutes" }} onChange={() => {}} />
    );
    expect(screen.queryByLabelText("Series ends")).toBeNull();
    expect(screen.getByLabelText("Target total minutes")).toBeTruthy();
  });

  it("explains a manual series instead of asking for a date it will never have", () => {
    render(<ActionRecurrenceFields draft={{ ...recurring(), completionMode: "manual" }} onChange={() => {}} />);
    expect(screen.queryByLabelText("Series ends")).toBeNull();
    expect(screen.queryByLabelText("Target total minutes")).toBeNull();
    expect(screen.getByText("Keeps recurring until marked complete from the action list.")).toBeTruthy();
  });

  it("labels each half of a fallback window so both times can be reached separately", () => {
    const onChange = vi.fn();
    render(<ActionRecurrenceFields draft={recurring()} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Bedtime fallback start"), { target: { value: "19:30" } });
    expect(onChange).toHaveBeenCalledWith({ ...recurring(), bedtimeFallbackStart: "19:30" });
  });

  it("asks cadence only how often, never for the windows it does not have", () => {
    const onChange = vi.fn();
    const practice = { ...recurring(), schedulingMode: "cadence" as const, completionMode: "manual" as const };
    render(<ActionRecurrenceFields draft={practice} onChange={onChange} mode="cadence" />);
    expect(screen.queryByLabelText("Bedtime fallback start")).toBeNull();
    expect(screen.queryByLabelText("Morning fallback start")).toBeNull();
    expect(screen.getByLabelText("Series starts")).toBeTruthy();
    expect(screen.getByLabelText("Ends when")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Days between suggestions"), { target: { value: "3" } });
    expect(onChange).toHaveBeenCalledWith({ ...practice, intervalDays: "3" });
  });

  it("switches cadence to a period target and back, showing only the relevant fields", () => {
    const onChange = vi.fn();
    const practice = { ...recurring(), schedulingMode: "cadence" as const, completionMode: "manual" as const };
    render(<ActionRecurrenceFields draft={practice} onChange={onChange} mode="cadence" />);
    expect(screen.queryByLabelText("Times per period")).toBeNull();
    fireEvent.change(screen.getByLabelText("Suggest"), { target: { value: "days" } });
    expect(onChange).toHaveBeenCalledWith({ ...practice, periodUnit: "days" });
  });

  it("asks for a period length, target, spacing, and weekdays once a days period is chosen", () => {
    const onChange = vi.fn();
    const practice = {
      ...recurring(),
      schedulingMode: "cadence" as const,
      completionMode: "manual" as const,
      periodUnit: "days" as const
    };
    render(<ActionRecurrenceFields draft={practice} onChange={onChange} mode="cadence" />);
    expect(screen.queryByLabelText("Days between suggestions")).toBeNull();
    expect(screen.getByLabelText("Period length in days")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Target occurrences per period"), { target: { value: "2" } });
    expect(onChange).toHaveBeenCalledWith({ ...practice, targetOccurrences: "2" });
    fireEvent.change(screen.getByLabelText("Minimum days between completions"), { target: { value: "3" } });
    expect(onChange).toHaveBeenCalledWith({ ...practice, minSpacingDays: "3" });
    fireEvent.click(screen.getByText("Mon"));
    expect(onChange).toHaveBeenCalledWith({ ...practice, eligibleWeekdays: [1] });
  });

  it("asks only for a target, not a period length, once a calendar-month period is chosen", () => {
    const practice = {
      ...recurring(),
      schedulingMode: "cadence" as const,
      completionMode: "manual" as const,
      periodUnit: "month" as const
    };
    render(<ActionRecurrenceFields draft={practice} onChange={() => {}} mode="cadence" />);
    expect(screen.queryByLabelText("Period length in days")).toBeNull();
    expect(screen.getByLabelText("Target occurrences per period")).toBeTruthy();
  });

  it("changes what ends the series without disturbing the rest of the draft", () => {
    const onChange = vi.fn();
    render(<ActionRecurrenceFields draft={recurring()} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Ends when"), { target: { value: "manual" } });
    expect(onChange).toHaveBeenCalledWith({ ...recurring(), completionMode: "manual" });
  });
});
