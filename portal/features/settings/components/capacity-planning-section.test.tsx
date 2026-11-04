// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { CapacityPlanningSection } from "@/features/settings/components/capacity-planning-section";
import { defaultPlanningSettings } from "@/state/portal-state";

describe("CapacityPlanningSection", () => {
  it("labels the fraction as free time", () => {
    render(<CapacityPlanningSection draft={defaultPlanningSettings()} onChange={vi.fn()} />);
    expect(screen.getByLabelText(/^Usable free time/)).toBeTruthy();
  });

  it("reports a usable-fraction change as a patch", () => {
    const onChange = vi.fn();
    render(<CapacityPlanningSection draft={defaultPlanningSettings()} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText(/^Usable free time/), { target: { value: "70" } });
    expect(onChange).toHaveBeenCalledWith({ defaultUsableFraction: 0.7 });
  });
});
