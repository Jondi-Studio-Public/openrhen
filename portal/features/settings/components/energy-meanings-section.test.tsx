// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { EnergyMeaningsSection } from "@/features/settings/components/energy-meanings-section";
import { defaultPlanningSettings } from "@/state/portal-state";

describe("EnergyMeaningsSection", () => {
  it("shows one field per energy level under its readable label", () => {
    render(<EnergyMeaningsSection meanings={defaultPlanningSettings().energyMeanings} onChange={vi.fn()} />);
    expect((screen.getByLabelText("High focus") as HTMLInputElement).value).toBe("Deep focus");
    expect(screen.getByLabelText("Recovery")).toBeTruthy();
  });

  it("reports the level alongside the new meaning", () => {
    const onChange = vi.fn();
    render(<EnergyMeaningsSection meanings={defaultPlanningSettings().energyMeanings} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Low focus"), { target: { value: "Admin only" } });
    expect(onChange).toHaveBeenCalledWith("low", "Admin only");
  });
});
