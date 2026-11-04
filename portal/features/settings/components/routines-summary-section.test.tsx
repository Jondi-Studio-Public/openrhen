// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@/test/render";
import { RoutinesSummarySection } from "@/features/settings/components/routines-summary-section";
import type { RoutinePreset } from "@/state/portal-state";

const preset = (id: string, name: string): RoutinePreset => ({
  id,
  name,
  activityName: name,
  status: "active",
  replacesWakeRoutine: false,
  steps: []
});

describe("RoutinesSummarySection", () => {
  it("names both the bedtime and wake routine, or says neither is chosen", () => {
    const { container } = render(
      <RoutinesSummarySection
        presetId="bed"
        wakePresetId="wake"
        routinePresets={[preset("bed", "Wind down"), preset("wake", "Morning routine")]}
      />
    );
    expect(screen.getByText(/Bedtime routine:/)).toBeTruthy();
    const named = [...container.querySelectorAll(".routines-summary p strong")].map((node) => node.textContent);
    expect(named).toEqual(["Wind down", "Morning routine"]);
  });

  it("says 'none chosen' for the wake routine when nothing is selected", () => {
    render(<RoutinesSummarySection presetId={undefined} wakePresetId={undefined} routinePresets={[]} />);
    const noneChosen = screen.getAllByText("none chosen");
    expect(noneChosen.length).toBe(2);
  });
});
