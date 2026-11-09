// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import type { WorkLabelView } from "@/features/plan/work-label-client";
import { WorkLabelChip } from "./work-label-chip";

const label = (over: Partial<WorkLabelView> = {}): WorkLabelView => ({
  areaId: "a1",
  value: "unknown",
  origin: null,
  at: null,
  ...over
});
const show = (over: Partial<Parameters<typeof WorkLabelChip>[0]> = {}) => {
  const onChoose = vi.fn();
  render(<WorkLabelChip label={label()} modelConfigured busy={false} error={null} onChoose={onChoose} {...over} />);
  return onChoose;
};

describe("WorkLabelChip", () => {
  it("says not decided yet, and why when no local model is set", () => {
    show();
    expect(screen.getByRole("status").textContent).toBe("Counts as work: Not decided yet");
    document.body.innerHTML = "";
    show({ modelConfigured: false });
    expect(screen.getByRole("status").textContent).toContain("no local model is set");
  });

  it("shows the model's label as inferred, with Yes and No unpressed and no Reset", () => {
    show({ label: label({ value: "work", origin: "inferred" }) });
    expect(screen.getByRole("status").textContent).toBe("Counts as work: Yes (inferred)");
    expect(screen.getByRole("button", { name: "Counts as work: yes" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Counts as work: no" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("button", { name: "Counts as work: reset" })).toBeNull();
  });

  it("shows the owner's answer as theirs, presses its button and offers Reset", () => {
    show({ label: label({ value: "not_work", origin: "corrected" }) });
    expect(screen.getByRole("status").textContent).toBe("Counts as work: No (your answer)");
    expect(screen.getByRole("button", { name: "Counts as work: no" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Counts as work: reset" })).toBeTruthy();
  });

  it("reports one tap: Yes, No and Reset each choose their answer", () => {
    const onChoose = show({ label: label({ value: "work", origin: "corrected" }) });
    fireEvent.click(screen.getByRole("button", { name: "Counts as work: yes" }));
    fireEvent.click(screen.getByRole("button", { name: "Counts as work: no" }));
    fireEvent.click(screen.getByRole("button", { name: "Counts as work: reset" }));
    expect(onChoose.mock.calls).toEqual([["work"], ["not_work"], ["unset"]]);
  });

  it("disables the taps while loading or saving, and shows an error as an alert", () => {
    const onChoose = show({ label: null, busy: false });
    expect(screen.getByRole("status").textContent).toBe("Counts as work: Loading…");
    fireEvent.click(screen.getByRole("button", { name: "Counts as work: yes" }));
    expect(onChoose).not.toHaveBeenCalled();
    document.body.innerHTML = "";
    show({ busy: true, error: "The answer was not saved." });
    expect((screen.getByRole("button", { name: "Counts as work: no" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toBe("The answer was not saved.");
  });
});
