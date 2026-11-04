// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { WakeRoutineSection } from "@/features/settings/components/wake-routine-section";
import type { RoutinePreset } from "@/state/portal-state";

const preset = (id: string, name: string, status: RoutinePreset["status"]): RoutinePreset => ({
  id,
  name,
  activityName: name,
  status,
  replacesWakeRoutine: false,
  steps: []
});

describe("WakeRoutineSection", () => {
  it("offers active routines but hides archived ones", () => {
    render(
      <WakeRoutineSection
        presetId={undefined}
        routinePresets={[preset("a", "Morning routine", "active"), preset("b", "Old", "archived")]}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByRole("option", { name: "Morning routine" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Old" })).toBeNull();
  });

  it("keeps an archived routine listed while it is the one selected, so it cannot vanish silently", () => {
    render(<WakeRoutineSection presetId="b" routinePresets={[preset("b", "Old", "archived")]} onChange={vi.fn()} />);
    expect(screen.getByRole("option", { name: "Old" })).toBeTruthy();
  });

  it("reports clearing the routine as undefined rather than an empty id", () => {
    const onChange = vi.fn();
    render(
      <WakeRoutineSection
        presetId="a"
        routinePresets={[preset("a", "Morning routine", "active")]}
        onChange={onChange}
      />
    );
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "" } });
    expect(onChange).toHaveBeenCalledWith(undefined);
  });
});
