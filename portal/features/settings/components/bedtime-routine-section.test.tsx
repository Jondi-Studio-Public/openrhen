// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { BedtimeRoutineSection } from "@/features/settings/components/bedtime-routine-section";
import type { RoutinePreset } from "@/state/portal-state";

const preset = (id: string, name: string, status: RoutinePreset["status"]): RoutinePreset => ({
  id,
  name,
  activityName: name,
  status,
  replacesWakeRoutine: false,
  steps: []
});

describe("BedtimeRoutineSection", () => {
  it("offers active routines but hides archived ones", () => {
    render(
      <BedtimeRoutineSection
        presetId={undefined}
        routinePresets={[preset("a", "Wind down", "active"), preset("b", "Old", "archived")]}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByRole("option", { name: "Wind down" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Old" })).toBeNull();
  });

  it("keeps an archived routine listed while it is the one selected, so it cannot vanish silently", () => {
    render(<BedtimeRoutineSection presetId="b" routinePresets={[preset("b", "Old", "archived")]} onChange={vi.fn()} />);
    expect(screen.getByRole("option", { name: "Old" })).toBeTruthy();
  });

  it("reports clearing the routine as undefined rather than an empty id", () => {
    const onChange = vi.fn();
    render(
      <BedtimeRoutineSection presetId="a" routinePresets={[preset("a", "Wind down", "active")]} onChange={onChange} />
    );
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "" } });
    expect(onChange).toHaveBeenCalledWith(undefined);
  });
});
