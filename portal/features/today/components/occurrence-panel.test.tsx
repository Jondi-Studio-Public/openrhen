// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { StoredAction, StoredOccurrence, StoredRoutineStep } from "@/state/portal-state";
import { render, screen } from "@/test/render";
import { OccurrencePanel } from "./occurrence-panel";

const occurrence = (overrides: Partial<StoredOccurrence>): StoredOccurrence =>
  ({
    id: "morning-meds",
    actionId: "meds",
    localDate: "2026-08-18",
    windowId: "window-morning",
    windowName: "Morning",
    windowStartsAt: "2026-08-17T21:00:00.000Z",
    windowEndsAt: "2026-08-17T22:00:00.000Z",
    anchorSource: "planned_wake",
    status: "pending",
    ...overrides
  }) as unknown as StoredOccurrence;

const actions = [{ id: "meds", title: "Take medication" }] as unknown as StoredAction[];

describe("Recurring windows panel", () => {
  it("says so when nothing falls on this day", () => {
    render(<OccurrencePanel occurrences={[]} actions={actions} routineSteps={[]} timezone="Australia/Sydney" />);
    expect(screen.getByText("No recurring windows fall on this day.")).toBeTruthy();
  });

  it("names the action, the window, and the anchor in readable words", () => {
    render(
      <OccurrencePanel occurrences={[occurrence({})]} actions={actions} routineSteps={[]} timezone="Australia/Sydney" />
    );
    expect(screen.getByText("Take medication · Morning")).toBeTruthy();
    expect(screen.getByText(/planned wake/)).toBeTruthy();
  });

  it("credits the routine that already covers an occurrence", () => {
    // `routineCovered` is the engine's own verdict now — the panel only looks up which
    // `routine_steps` row's `actionWindowId` matches, to name it.
    const routineSteps = [
      { id: "morning-step", title: "Morning routine", actionWindowId: "window-morning" }
    ] as unknown as StoredRoutineStep[];
    render(
      <OccurrencePanel
        occurrences={[occurrence({ routineCovered: true })]}
        actions={actions}
        routineSteps={routineSteps}
        timezone="Australia/Sydney"
      />
    );
    expect(screen.getByText(/covered by Morning routine/)).toBeTruthy();
  });

  it("grades a missed window as behind and a completed one as ahead", () => {
    const { container } = render(
      <OccurrencePanel
        occurrences={[
          occurrence({ id: "a", status: "missed" }),
          occurrence({ id: "b", status: "completed" }),
          occurrence({ id: "c", status: "pending" })
        ]}
        actions={actions}
        routineSteps={[]}
        timezone="Australia/Sydney"
      />
    );
    expect([...container.querySelectorAll(".health")].map((node) => node.className)).toEqual([
      "health behind",
      "health ahead",
      "health on_track"
    ]);
  });
});
