// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { StoredRoutineStep } from "@/state/portal-state";
import { fireEvent, render, screen } from "@/test/render";
import { BedtimeStepCard } from "./bedtime-step-card";

const step: StoredRoutineStep = {
  id: "step-teeth",
  version: 3,
  anchorType: "sleep_plan",
  anchorId: "sleep-tonight",
  purpose: "bedtime",
  title: "Brush teeth",
  durationMinutes: 5,
  sequence: 0,
  timingRule: "contiguous",
  energy: "low",
  contexts: [],
  dependencyIds: [],
  phase: "before",
  status: "pending"
};

describe("BedtimeStepCard", () => {
  it("starts the named step against its own routine_steps row", () => {
    const runActivityCommand = vi.fn().mockResolvedValue(undefined);
    render(<BedtimeStepCard step={step} label="before sleep" saving={false} runActivityCommand={runActivityCommand} />);
    expect(screen.getByText("5 min · before sleep")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(runActivityCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "start_activity",
        targetType: "routine_step",
        targetId: "step-teeth",
        plannedMinutes: 5,
        expectedVersion: 3
      })
    );
  });

  it("renders whatever label the caller passes, so the same card serves the wake routine too", () => {
    const runActivityCommand = vi.fn().mockResolvedValue(undefined);
    const wakeStep: StoredRoutineStep = { ...step, id: "step-2", purpose: "wake" };
    render(
      <BedtimeStepCard step={wakeStep} label="after waking" saving={false} runActivityCommand={runActivityCommand} />
    );
    expect(screen.getByText("5 min · after waking")).toBeTruthy();
  });

  it("leaves the title off where the headline already says it", () => {
    render(
      <BedtimeStepCard step={step} label="after waking" saving={false} runActivityCommand={vi.fn()} showTitle={false} />
    );
    expect(screen.queryByText("Brush teeth")).toBeNull();
    expect(screen.getByText("5 min · after waking")).toBeTruthy();
  });

  it("skips the step without starting anything", () => {
    const runActivityCommand = vi.fn().mockResolvedValue(undefined);
    render(<BedtimeStepCard step={step} label="before sleep" saving={false} runActivityCommand={runActivityCommand} />);
    fireEvent.click(screen.getByRole("button", { name: "Skip this step" }));
    expect(runActivityCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: "skip_routine_step", stepId: "step-teeth" })
    );
  });
});
