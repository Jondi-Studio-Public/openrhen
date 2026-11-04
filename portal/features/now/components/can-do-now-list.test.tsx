// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { CanDoNowItem } from "@openrhen/contracts";
import { createSeedState, type StoredRoutineStep } from "@/state/portal-state";
import { fireEvent, render, screen } from "@/test/render";
import { CanDoNowList } from "./can-do-now-list";

const now = new Date("2026-08-18T10:00:00.000Z");
const timezone = "Australia/Sydney";

const step: StoredRoutineStep = {
  id: "step-uniform",
  version: 4,
  commitmentId: "dinner",
  anchorType: "commitment",
  title: "Prepare uniform",
  durationMinutes: 10,
  sequence: 1,
  timingRule: "flexible",
  energy: "low",
  contexts: [],
  dependencyIds: [],
  phase: "before",
  status: "pending"
};

const state = { ...createSeedState(now), routineSteps: [step] };

const item: CanDoNowItem = {
  stepId: "step-uniform",
  commitmentId: "dinner",
  title: "Prepare uniform",
  durationMinutes: 10,
  placedStartAt: "2026-08-18T09:50:00.000Z",
  startBy: "2026-08-18T10:30:00.000Z" // 20:30 local
};

describe("CanDoNowList", () => {
  it("renders nothing when there are no offerable steps", () => {
    const { container } = render(
      <CanDoNowList items={[]} state={state} timezone={timezone} saving={false} runActivityCommand={vi.fn()} />
    );
    expect(container.innerHTML).toBe("");
  });

  it("shows the title, hands-on minutes and start-by, and starts it with the existing start_activity command", () => {
    const runActivityCommand = vi.fn().mockResolvedValue(undefined);
    render(
      <CanDoNowList
        items={[item]}
        state={state}
        timezone={timezone}
        saving={false}
        runActivityCommand={runActivityCommand}
      />
    );
    expect(screen.getByText("Can do now")).toBeTruthy();
    expect(screen.getByText("Prepare uniform")).toBeTruthy();
    expect(screen.getByText("10 min")).toBeTruthy();
    expect(screen.getByText(/start by 8:30 pm/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(runActivityCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "start_activity",
        targetType: "routine_step",
        targetId: "step-uniform",
        plannedMinutes: 10,
        expectedVersion: 4
      })
    );
  });

  it("omits the start-by span when the item has none", () => {
    const { queryByText } = render(
      <CanDoNowList
        items={[{ ...item, startBy: undefined }]}
        state={state}
        timezone={timezone}
        saving={false}
        runActivityCommand={vi.fn()}
      />
    );
    expect(queryByText(/start by/)).toBeNull();
  });
});
