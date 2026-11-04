// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { ActiveSession, StoredRoutineStep } from "@/state/portal-state";
import { fireEvent, render, screen, waitFor } from "@/test/render";
import { WakeRoutinePanel } from "./wake-routine-panel";

const step: StoredRoutineStep = {
  id: "wake-step-0",
  version: 1,
  anchorType: "sleep_plan",
  anchorId: "sleep-last-night",
  purpose: "wake",
  title: "Stretch",
  durationMinutes: 10,
  sequence: 0,
  timingRule: "contiguous",
  energy: "low",
  contexts: [],
  dependencyIds: [],
  phase: "after",
  status: "pending"
};

describe("WakeRoutinePanel", () => {
  it("renders nothing when there is no unfinished wake step", () => {
    const { container } = render(
      <WakeRoutinePanel
        currentWakeStep={undefined}
        stepSession={undefined}
        secondsRemaining={0}
        saving={false}
        runActivityCommand={vi.fn()}
      />
    );
    expect(container.textContent).toBe("");
  });

  it("offers the next unfinished step labelled 'after waking', starting it against its own routine_steps row", () => {
    const runActivityCommand = vi.fn().mockResolvedValue(undefined);
    render(
      <WakeRoutinePanel
        currentWakeStep={step}
        stepSession={undefined}
        secondsRemaining={0}
        saving={false}
        runActivityCommand={runActivityCommand}
      />
    );
    expect(screen.getByText("10 min · after waking")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(runActivityCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "start_activity",
        targetType: "routine_step",
        targetId: "wake-step-0"
      })
    );
  });

  it("shows the running-step countdown card instead of the start card while its own session is open", () => {
    const stepSession: ActiveSession = {
      id: "session-1",
      actionId: "",
      status: "running",
      targetType: "routine_step",
      targetId: "wake-step-0",
      targetTitle: "Stretch",
      startedAt: "2026-08-18T20:00:00.000Z",
      plannedEndAt: "2026-08-18T20:10:00.000Z",
      plannedMinutes: 10,
      remainingBeforeMinutes: 10,
      activeElapsedSeconds: 0
    };
    render(
      <WakeRoutinePanel
        currentWakeStep={step}
        stepSession={stepSession}
        secondsRemaining={300}
        saving={false}
        runActivityCommand={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: "Mark step done" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
  });

  it("ignores a step session that belongs to a different routine step (e.g. tonight's bedtime)", () => {
    const otherSession: ActiveSession = {
      id: "session-2",
      actionId: "",
      status: "running",
      targetType: "routine_step",
      targetId: "before-step",
      targetTitle: "Drink water",
      startedAt: "2026-08-18T10:00:00.000Z",
      plannedEndAt: "2026-08-18T10:10:00.000Z",
      plannedMinutes: 10,
      remainingBeforeMinutes: 10,
      activeElapsedSeconds: 0
    };
    render(
      <WakeRoutinePanel
        currentWakeStep={step}
        stepSession={otherSession}
        secondsRemaining={300}
        saving={false}
        runActivityCommand={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
  });

  describe("the morning in fewer taps", () => {
    const second: StoredRoutineStep = { ...step, id: "wake-step-1", title: "Water", sequence: 1, version: 4 };
    const third: StoredRoutineStep = { ...step, id: "wake-step-2", title: "Meds", sequence: 2, version: 7 };
    const done: StoredRoutineStep = { ...step, id: "wake-step-x", sequence: -1, status: "completed" };
    const cancelled: StoredRoutineStep = { ...step, id: "wake-step-c", sequence: 9, status: "cancelled" };
    const other: StoredRoutineStep = { ...step, id: "other", anchorId: "sleep-older", sequence: 3 };
    const all = [third, other, done, second, cancelled, step];

    it("says which step this is, and what comes after the routine", () => {
      render(
        <WakeRoutinePanel
          currentWakeStep={second}
          routineSteps={all}
          nextTask="Write the report"
          stepSession={undefined}
          secondsRemaining={0}
          saving={false}
          runActivityCommand={vi.fn()}
        />
      );
      // The completed step before it counts; the cancelled one and the other night's do not.
      expect(screen.getByText("Step 3 of 4 · 10 min · after waking")).toBeTruthy();
      expect(screen.getByText("Next task: Write the report")).toBeTruthy();
    });

    it("starts and finishes the step in one tap", async () => {
      const runActivityCommand = vi.fn().mockResolvedValue(undefined);
      render(
        <WakeRoutinePanel
          currentWakeStep={step}
          routineSteps={[step, second]}
          stepSession={undefined}
          secondsRemaining={0}
          saving={false}
          runActivityCommand={runActivityCommand}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      await waitFor(() => expect(runActivityCommand).toHaveBeenCalledTimes(2));
      const [start, finish] = runActivityCommand.mock.calls.map((call) => call[0]);
      expect(start).toMatchObject({ type: "start_activity", targetType: "routine_step", targetId: "wake-step-0" });
      expect(finish).toMatchObject({
        type: "finish_activity",
        outcome: "completed",
        sessionId: start.commandId,
        expectedVersion: 1
      });
    });

    it("does not finish a step whose start was refused", async () => {
      const runActivityCommand = vi.fn().mockRejectedValue(new Error("Plan changed"));
      render(
        <WakeRoutinePanel
          currentWakeStep={step}
          routineSteps={[step]}
          stepSession={undefined}
          secondsRemaining={0}
          saving={false}
          runActivityCommand={runActivityCommand}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      await waitFor(() =>
        expect((screen.getByRole("button", { name: "Done" }) as HTMLButtonElement).disabled).toBe(false)
      );
      expect(runActivityCommand).toHaveBeenCalledTimes(1);
    });

    it("skips this step and every one after it, in order", async () => {
      const runActivityCommand = vi.fn().mockResolvedValue(undefined);
      render(
        <WakeRoutinePanel
          currentWakeStep={second}
          routineSteps={all}
          stepSession={undefined}
          secondsRemaining={0}
          saving={false}
          runActivityCommand={runActivityCommand}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: "Skip the rest of the routine" }));
      expect(runActivityCommand).not.toHaveBeenCalled();
      expect(screen.getByRole("status").textContent).toBe("Skip 2 steps?");
      fireEvent.click(screen.getByRole("button", { name: "Yes, skip them" }));
      await waitFor(() => expect(runActivityCommand).toHaveBeenCalledTimes(2));
      expect(runActivityCommand.mock.calls.map((call) => call[0])).toEqual([
        expect.objectContaining({ type: "skip_routine_step", stepId: "wake-step-1", expectedVersion: 4 }),
        expect.objectContaining({ type: "skip_routine_step", stepId: "wake-step-2", expectedVersion: 7 })
      ]);
    });

    it("lets the person back out of skipping the rest", () => {
      const runActivityCommand = vi.fn().mockResolvedValue(undefined);
      render(
        <WakeRoutinePanel
          currentWakeStep={second}
          routineSteps={all}
          stepSession={undefined}
          secondsRemaining={0}
          saving={false}
          runActivityCommand={runActivityCommand}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: "Skip the rest of the routine" }));
      fireEvent.click(screen.getByRole("button", { name: "Keep them" }));
      expect(screen.getByRole("button", { name: "Skip the rest of the routine" })).toBeTruthy();
      expect(runActivityCommand).not.toHaveBeenCalled();
    });

    it("stops at the first skip the server refuses and leaves the later steps open", async () => {
      const runActivityCommand = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("refused"));
      const four: StoredRoutineStep = { ...step, id: "wake-step-3", sequence: 3, version: 9 };
      render(
        <WakeRoutinePanel
          currentWakeStep={second}
          routineSteps={[...all, four]}
          stepSession={undefined}
          secondsRemaining={0}
          saving={false}
          runActivityCommand={runActivityCommand}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: "Skip the rest of the routine" }));
      fireEvent.click(screen.getByRole("button", { name: "Yes, skip them" }));
      await waitFor(() => expect(runActivityCommand).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(
          (screen.getByRole("button", { name: "Skip the rest of the routine" }) as HTMLButtonElement).disabled
        ).toBe(false)
      );
      expect(runActivityCommand).toHaveBeenCalledTimes(2);
      expect(runActivityCommand.mock.calls.map((call) => call[0].stepId)).toEqual(["wake-step-1", "wake-step-2"]);
    });

    it("judges Done's backfilled start on the clock it is given, not the browser's", async () => {
      const runActivityCommand = vi.fn().mockResolvedValue(undefined);
      const serverNow = new Date("2026-08-18T22:00:00.000Z");
      render(
        <WakeRoutinePanel
          currentWakeStep={step}
          routineSteps={[step]}
          recordedUpTo="2026-08-18T21:55:00.000Z"
          clock={() => serverNow}
          stepSession={undefined}
          secondsRemaining={0}
          saving={false}
          runActivityCommand={runActivityCommand}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      await waitFor(() => expect(runActivityCommand).toHaveBeenCalledTimes(2));
      // Planned start 21:50 is inside recorded time, so the start is the 21:55 boundary.
      expect(runActivityCommand.mock.calls[0]![0].startedAt).toBe("2026-08-18T21:55:00.000Z");
    });

    it("offers no skip-the-rest on the last step", () => {
      render(
        <WakeRoutinePanel
          currentWakeStep={third}
          routineSteps={all}
          stepSession={undefined}
          secondsRemaining={0}
          saving={false}
          runActivityCommand={vi.fn()}
        />
      );
      expect(screen.queryByRole("button", { name: "Skip the rest of the routine" })).toBeNull();
    });
  });
});
