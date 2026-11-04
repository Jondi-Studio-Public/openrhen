// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { ActiveSession } from "@/state/portal-state";
import { fireEvent, render, screen } from "@/test/render";
import { BedtimeStepSessionCard } from "./bedtime-step-session-card";

const stepSession = (status: ActiveSession["status"]): ActiveSession => ({
  id: "session-9",
  actionId: "networking-section-one",
  status,
  targetType: "routine_step",
  targetId: "step-teeth",
  targetTitle: "Brush teeth",
  startedAt: "2026-08-18T10:00:00.000Z",
  plannedEndAt: "2026-08-18T10:05:00.000Z",
  plannedMinutes: 5,
  remainingBeforeMinutes: 5,
  activeElapsedSeconds: 60
});

describe("BedtimeStepSessionCard", () => {
  it("completes the running step", () => {
    const runActivityCommand = vi.fn().mockResolvedValue(undefined);
    render(
      <BedtimeStepSessionCard
        stepSession={stepSession("running")}
        secondsRemaining={240}
        saving={false}
        runActivityCommand={runActivityCommand}
      />
    );
    expect(screen.getByText("Brush teeth")).toBeTruthy();
    expect(screen.getByText("4:00")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mark step done" }));
    expect(runActivityCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: "finish_activity", sessionId: "session-9", outcome: "completed" })
    );
  });

  it("offers to resume a paused step", () => {
    const runActivityCommand = vi.fn().mockResolvedValue(undefined);
    render(
      <BedtimeStepSessionCard
        stepSession={stepSession("paused")}
        secondsRemaining={240}
        saving={false}
        runActivityCommand={runActivityCommand}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(runActivityCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: "resume_activity", sessionId: "session-9" })
    );
  });
});
