// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { RoutinePresetSidebar } from "@/features/routines/components/routine-preset-sidebar";
import type { RoutinePreset } from "@/state/portal-state";

const preset = (id: string, name: string, steps: number): RoutinePreset => ({
  id,
  name,
  activityName: name,
  status: "active",
  replacesWakeRoutine: false,
  steps: Array.from({ length: steps }, (_, index) => ({
    id: `${id}-${index}`,
    title: "Step",
    durationMinutes: 10,
    sequence: index,
    timingRule: "contiguous" as const,
    energy: "low" as const,
    contexts: [],
    dependencyIds: [],
    phase: "before" as const
  }))
});

function renderSidebar(overrides: Partial<Parameters<typeof RoutinePresetSidebar>[0]> = {}) {
  const props = {
    presets: [preset("a", "Campus morning", 3)],
    showArchived: false,
    archivedCount: 2,
    openId: undefined,
    onShowArchivedChange: vi.fn(),
    onOpen: vi.fn(),
    ...overrides
  };
  render(<RoutinePresetSidebar {...props} />);
  return props;
}

describe("RoutinePresetSidebar", () => {
  it("counts the tiles behind each routine", () => {
    renderSidebar();
    expect(screen.getByText("3 tiles")).toBeTruthy();
    renderSidebar({ presets: [preset("b", "Solo", 1)] });
    expect(screen.getByText("1 tile")).toBeTruthy();
  });

  it("names the panel after the view and shows how much is archived", () => {
    renderSidebar();
    expect(screen.getByRole("heading", { name: "Routines" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Archive (2)" })).toBeTruthy();
  });

  it("switches to the archive on request", () => {
    const props = renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "Archive (2)" }));
    expect(props.onShowArchivedChange).toHaveBeenCalledWith(true);
  });

  it("marks each archived entry so it cannot be mistaken for a live one", () => {
    renderSidebar({ showArchived: true, presets: [preset("a", "Old", 1)] });
    expect(screen.getByRole("heading", { name: "Archive" })).toBeTruthy();
    expect(screen.getByText("1 tile · archived")).toBeTruthy();
  });

  it("explains an empty list differently in each view", () => {
    renderSidebar({ presets: [] });
    expect(screen.getByText("No active routines. Create one to begin.")).toBeTruthy();
    renderSidebar({ presets: [], showArchived: true });
    expect(screen.getByText("No archived routines.")).toBeTruthy();
  });

  it("highlights the routine that is open and opens the one that is clicked", () => {
    const props = renderSidebar({ openId: "a" });
    const choice = screen.getByRole("button", { name: /Campus morning/ });
    expect(choice.className).toBe("preset-choice active");
    fireEvent.click(choice);
    expect(props.onOpen).toHaveBeenCalledWith(props.presets[0]);
  });
});
