// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { fireEvent, render, screen, within } from "@/test/render";
import { SessionFeedbackPanel } from "./session-feedback-panel";

const now = new Date("2026-08-18T10:00:00.000Z");
const state = createSeedState(now);
const sessionAction = state.actions[0]!;

function renderPanel(overrides: Partial<Parameters<typeof SessionFeedbackPanel>[0]> = {}) {
  const props = {
    sessionAction,
    state,
    now,
    timezone: "Australia/Sydney",
    saving: false,
    plannedStart: now,
    plannedEnd: new Date(now.getTime() + 1_800_000),
    plannedDuration: 30,
    planningDecisionCurrent: true,
    continuation: { safe: true, recommendedMinutes: 25, reason: "Room remains today.", displacedProjectIds: [] },
    remainingChoice: "30",
    onRemainingChoiceChange: vi.fn(),
    customRemaining: 120,
    onCustomRemainingChange: vi.fn(),
    blockReason: "missing_information" as const,
    onBlockReasonChange: vi.fn(),
    note: "",
    onNoteChange: vi.fn(),
    finishSession: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
  const { unmount, rerender } = render(<SessionFeedbackPanel {...props} />);
  return {
    ...props,
    unmount,
    rerender: (next: Partial<typeof props>) => rerender(<SessionFeedbackPanel {...props} {...next} />)
  };
}

const choose = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));
const save = (name: string | RegExp = "Save") => fireEvent.click(screen.getByRole("button", { name }));

describe("SessionFeedbackPanel", () => {
  it("shows the checkpoint on the hero, with the answers sheet open and Add a note beside Save", () => {
    renderPanel();
    expect(screen.getByText(/^Checkpoint · 30 min planned$/)).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: sessionAction.title })).toBeTruthy();
    expect(screen.getByRole("button", { name: "How did it go?" })).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
    for (const name of ["Finished it", "Made progress", "Got stuck", "Didn't start", "Add a note"]) {
      expect(screen.getByRole("button", { name: new RegExp(name) })).toBeTruthy();
    }
    // Nothing is chosen yet, so there is nothing to save.
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("records a finished session with no remaining effort, only once Save is pressed", () => {
    const props = renderPanel();
    choose(/^Finished it/);
    expect(props.finishSession).not.toHaveBeenCalled();
    save();
    expect(props.finishSession).toHaveBeenCalledWith("finished", 0, { note: "" });
  });

  it("calls a finished cadence session done for the day, since the action itself stays open", () => {
    const props = renderPanel({ sessionAction: { ...sessionAction, schedulingMode: "cadence" } });
    expect(screen.queryByRole("button", { name: /^Finished it/ })).toBeNull();
    choose(/^Done for today/);
    save();
    expect(props.finishSession).toHaveBeenCalledWith("finished", 0, { note: "" });
  });

  it("asks for an exact figure only once the custom estimate is chosen", () => {
    const props = renderPanel();
    expect(screen.queryByText("Exact remaining minutes")).toBeNull();
    choose(/^Made progress/);
    expect(screen.queryByText("Exact remaining minutes")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More…" }));
    expect(props.onRemainingChoiceChange).toHaveBeenCalledWith("custom");
    props.unmount();
    renderPanel({ remainingChoice: "custom" });
    choose(/^Made progress/);
    expect(screen.getByText("Exact remaining minutes")).toBeTruthy();
  });

  it("lets the exact figure be typed digit by digit and records values below 120", () => {
    const props = renderPanel({ remainingChoice: "custom" });
    choose(/^Made progress/);
    const input = screen.getByLabelText("Exact remaining minutes") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "9" } });
    expect(input.value).toBe("9");
    fireEvent.change(input, { target: { value: "90" } });
    expect(input.value).toBe("90");
    expect(props.onCustomRemainingChange).toHaveBeenLastCalledWith(90);
    fireEvent.change(input, { target: { value: "" } });
    expect(input.value).toBe("");
    expect(props.onCustomRemainingChange).toHaveBeenCalledTimes(2);
    fireEvent.blur(input);
    expect(input.value).toBe("120");
  });

  it("records 75 typed digit by digit, then restores the parent value on blur", () => {
    const props = renderPanel({ remainingChoice: "custom" });
    choose(/^Made progress/);
    const input = screen.getByLabelText("Exact remaining minutes") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "7" } });
    fireEvent.change(input, { target: { value: "75" } });
    expect(props.onCustomRemainingChange).toHaveBeenLastCalledWith(75);
    fireEvent.blur(input);
    expect(input.value).toBe("120");
  });

  it("offers 15 min, 30 min, 1 h, More… and Not sure for what is left, with the exact figure behind More…", () => {
    renderPanel();
    choose(/^Made progress/);
    for (const name of ["15 min", "30 min", "1 h", "More…", "Not sure"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: "30 min" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("option", { name: "90 minutes" })).toBeNull();
  });

  it("records progress with the chosen remaining minutes, saying so on the Save button", () => {
    const props = renderPanel();
    choose(/^Made progress/);
    expect(props.finishSession).not.toHaveBeenCalled();
    save("Save · 30 min left");
    expect(props.finishSession).toHaveBeenCalledWith("progress", 30, { note: "" });
  });

  it("records an unsure estimate as unsure, with no minutes", () => {
    const props = renderPanel({ remainingChoice: "unsure" });
    choose(/^Made progress/);
    save();
    expect(props.finishSession).toHaveBeenCalledWith("unsure", undefined, { note: "" });
  });

  it("offers to keep going only when it is safe, and says what that sends", () => {
    const props = renderPanel();
    choose(/^Keep going for 25 min/);
    save("Keep going 25 min");
    expect(props.finishSession).toHaveBeenCalledWith("continue");
  });

  it("offers no Keep going while the plan is not current, and says it returns once the plan refreshes", () => {
    renderPanel({ planningDecisionCurrent: false });
    expect(screen.queryByRole("button", { name: /Keep going/ })).toBeNull();
    expect(screen.getByText(/Keeping going comes back once the plan refreshes\./)).toBeTruthy();
  });

  it("says how long the session has run in hours, and that one past a day was left running", () => {
    const first = renderPanel({ plannedStart: new Date(now.getTime() - 82 * 60_000) });
    expect(screen.getByText(/, 1 h 22 m in$/)).toBeTruthy();
    first.unmount();
    renderPanel({ plannedStart: new Date(now.getTime() - 26 * 60 * 60_000) });
    expect(screen.getByText(/ and left running$/)).toBeTruthy();
  });

  it("hands focus to How did it go? when the sheet it opened by itself is closed", () => {
    renderPanel();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "How did it go?" }));
  });

  it("marks the chosen answer as pressed", () => {
    renderPanel();
    choose(/^Finished it/);
    expect(screen.getByRole("button", { name: /^Finished it/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /^Didn't start/ }).getAttribute("aria-pressed")).toBe("false");
  });

  it("says why Keep going is not offered where its row would be", () => {
    renderPanel({
      continuation: { safe: false, recommendedMinutes: 0, reason: "Dinner starts too soon.", displacedProjectIds: [] }
    });
    expect(screen.queryByRole("button", { name: /Keep going/ })).toBeNull();
    expect(screen.getByText(/^Keep going isn.t offered: /)).toBeTruthy();
  });

  it("does not send a Keep going that stopped being safe after it was chosen", () => {
    const props = renderPanel();
    choose(/^Keep going for 25 min/);
    props.rerender({ planningDecisionCurrent: false });
    const saveButton = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
    fireEvent.click(saveButton);
    expect(props.finishSession).not.toHaveBeenCalled();
  });

  it("shows a failed save inside the sheet", async () => {
    renderPanel({ finishSession: vi.fn().mockRejectedValue(new Error("The server did not answer.")) });
    choose(/^Finished it/);
    save();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("The server did not answer.");
    expect(within(screen.getByRole("dialog")).getByRole("alert")).toBe(alert);
  });

  it("sends a block as waiting when the reason is another person", () => {
    const props = renderPanel({ blockReason: "waiting_on_someone", note: "chasing the tutor" });
    choose(/^Got stuck/);
    expect(screen.getByRole("button", { name: "Waiting on someone" }).getAttribute("aria-pressed")).toBe("true");
    expect(props.finishSession).not.toHaveBeenCalled();
    save();
    expect(props.finishSession).toHaveBeenCalledWith("blocked", sessionAction.remainingMinutes, {
      reason: "waiting_on_someone",
      actionStatus: "waiting",
      note: "chasing the tutor"
    });
  });

  it("sends a block as blocked for any other reason", () => {
    const props = renderPanel();
    choose(/^Got stuck/);
    save();
    expect(props.finishSession).toHaveBeenCalledWith("blocked", sessionAction.remainingMinutes, {
      reason: "missing_information",
      actionStatus: "blocked",
      note: ""
    });
  });

  it("puts a session that never started back on the list", () => {
    const props = renderPanel();
    choose(/^Didn't start/);
    save();
    expect(props.finishSession).toHaveBeenCalledWith("did_not_start", sessionAction.remainingMinutes, { note: "" });
  });

  describe("the time the work ended", () => {
    // The session started at 18:30 on the planning wall clock (seed-zone, UTC+10) and now is 20:00.
    const started = new Date(now.getTime() - 90 * 60_000);
    const setEnded = (value: string) => fireEvent.change(screen.getByLabelText("It ended at"), { target: { value } });

    it("starts blank under Finished it, bounded by the session's start and now on the planning wall clock", () => {
      renderPanel({ plannedStart: started });
      expect(screen.queryByLabelText("It ended at")).toBeNull();
      choose(/^Finished it/);
      const picker = screen.getByLabelText("It ended at") as HTMLInputElement;
      expect(picker.value).toBe("");
      expect(picker.min).toBe("2026-08-18T18:30");
      expect(picker.max).toBe("2026-08-18T20:00");
    });

    it("sends the chosen time with Finished it and with Made progress", () => {
      const props = renderPanel({ plannedStart: started });
      choose(/^Finished it/);
      setEnded("2026-08-18T19:15");
      save();
      expect(props.finishSession).toHaveBeenLastCalledWith("finished", 0, {
        note: "",
        endedAt: "2026-08-18T09:15:00.000Z"
      });
      choose(/^Made progress/);
      save("Save · 30 min left");
      expect(props.finishSession).toHaveBeenLastCalledWith("progress", 30, {
        note: "",
        endedAt: "2026-08-18T09:15:00.000Z"
      });
    });

    it("leaves endedAt out when blank, or cleared again", () => {
      const props = renderPanel({ plannedStart: started });
      choose(/^Made progress/);
      save("Save · 30 min left");
      expect(props.finishSession).toHaveBeenLastCalledWith("progress", 30, { note: "" });
      setEnded("2026-08-18T19:15");
      setEnded("");
      choose(/^Finished it/);
      save();
      expect(props.finishSession).toHaveBeenLastCalledWith("finished", 0, { note: "" });
    });

    it("does not send it with Got stuck, Didn't start or Keep going, which take no end time", () => {
      const props = renderPanel({ plannedStart: started });
      choose(/^Finished it/);
      setEnded("2026-08-18T19:15");
      choose(/^Got stuck/);
      save();
      expect(props.finishSession).toHaveBeenLastCalledWith("blocked", sessionAction.remainingMinutes, {
        reason: "missing_information",
        actionStatus: "blocked",
        note: ""
      });
      choose(/^Didn't start/);
      save();
      expect(props.finishSession).toHaveBeenLastCalledWith("did_not_start", sessionAction.remainingMinutes, {
        note: ""
      });
      choose(/^Keep going for 25 min/);
      save("Keep going 25 min");
      expect(props.finishSession).toHaveBeenLastCalledWith("continue");
    });
  });

  describe("Keep the estimate", () => {
    const withMinutes = (remainingMinutes: number) => ({ ...sessionAction, remainingMinutes });

    it("offers the task's own estimate first, pressed, once Made progress is chosen", () => {
      renderPanel({ sessionAction: withMinutes(180), remainingChoice: "keep" });
      choose(/^Made progress/);
      const keep = screen.getByRole("button", { name: "Keep 180 min" });
      expect(keep.getAttribute("aria-pressed")).toBe("true");
      expect(screen.getByRole("button", { name: "30 min" }).getAttribute("aria-pressed")).toBe("false");
    });

    it("saves it as ordinary progress with the estimate, not as Not sure", () => {
      const props = renderPanel({ sessionAction: withMinutes(180), remainingChoice: "keep" });
      choose(/^Made progress/);
      save("Save · 180 min left");
      expect(props.finishSession).toHaveBeenCalledWith("progress", 180, { note: "" });
    });

    it("starts every checkpoint from the estimate, whatever the last one ended on", () => {
      const props = renderPanel({ sessionAction: withMinutes(180), remainingChoice: "60" });
      expect(props.onRemainingChoiceChange).toHaveBeenCalledWith("keep");
    });

    it("does not repeat a preset that equals the estimate", () => {
      renderPanel({ sessionAction: withMinutes(30), remainingChoice: "keep" });
      choose(/^Made progress/);
      expect(screen.getByRole("button", { name: "Keep 30 min" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "30 min" })).toBeNull();
    });

    it("falls back to 30 minutes when the task has nothing left to keep", () => {
      const props = renderPanel({ sessionAction: withMinutes(0), remainingChoice: "keep" });
      choose(/^Made progress/);
      expect(screen.queryByRole("button", { name: /^Keep \d+ min/ })).toBeNull();
      save("Save · 30 min left");
      expect(props.finishSession).toHaveBeenCalledWith("progress", 30, { note: "" });
    });

    it("still sends Not sure as unsure when that is chosen", () => {
      const props = renderPanel({ sessionAction: withMinutes(180), remainingChoice: "unsure" });
      choose(/^Made progress/);
      save();
      expect(props.finishSession).toHaveBeenCalledWith("unsure", undefined, { note: "" });
    });
  });
});
