// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createSeedState, type ActiveSession } from "@/state/portal-state";
import { fireEvent, render, screen } from "@/test/render";
import { ActionSessionPanel } from "./action-session-panel";

const now = new Date("2026-08-18T10:00:00.000Z");
const state = createSeedState(now);
const session = (status: ActiveSession["status"]): ActiveSession => ({
  id: "session-1",
  actionId: "networking-section-one",
  status,
  startedAt: new Date(now.getTime() - 600_000).toISOString(),
  plannedEndAt: new Date(now.getTime() + 1_200_000).toISOString(),
  plannedMinutes: 30,
  remainingBeforeMinutes: 90,
  activeElapsedSeconds: 600
});

describe("ActionSessionPanel", () => {
  it("shows the project, the countdown and the two ways out", () => {
    const onPauseOrResume = vi.fn();
    const onRequestFeedback = vi.fn();
    render(
      <ActionSessionPanel
        session={session("running")}
        sessionAction={state.actions[0]!}
        state={state}
        now={now}
        timezone="Australia/Sydney"
        saving={false}
        secondsRemaining={1200}
        plannedStart={now}
        plannedEnd={new Date(now.getTime() + 1_800_000)}
        plannedDuration={30}
        onPauseOrResume={onPauseOrResume}
        onRequestFeedback={onRequestFeedback}
      />
    );
    expect(screen.getByText(/^In progress · started /)).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: state.actions[0]!.title })).toBeTruthy();
    expect(screen.getByText("of 30 min")).toBeTruthy();
    expect(screen.getByText("Submit Networking Assignment 2")).toBeTruthy();
    expect(screen.getByText("20:00")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onPauseOrResume).toHaveBeenCalledTimes(1);
    expect(onRequestFeedback).toHaveBeenCalledTimes(1);
  });

  it("makes Done the one primary, with Pause beside it, and shows how far through the session is", () => {
    render(
      <ActionSessionPanel
        session={session("running")}
        sessionAction={state.actions[0]!}
        state={state}
        now={now}
        timezone="Australia/Sydney"
        saving={false}
        secondsRemaining={1200}
        plannedStart={now}
        plannedEnd={new Date(now.getTime() + 1_800_000)}
        plannedDuration={30}
        onPauseOrResume={vi.fn()}
        onRequestFeedback={vi.fn()}
      />
    );
    const [done, pause] = screen.getAllByRole("button");
    expect(done!.textContent).toBe("Done");
    // Done comes first and Pause beside it; which is the primary is styling, not markup.
    expect(pause!.textContent).toBe("Pause");
    // Ten of thirty minutes gone.
    const bar = screen.getByRole("progressbar", { name: "Time used" });
    expect(bar.getAttribute("aria-valuenow")).toBe("33");
    expect((bar.firstElementChild as HTMLElement).style.transform).toBe("scaleX(0.33333333333333337)");
  });

  it("offers to resume once the session is paused", () => {
    render(
      <ActionSessionPanel
        session={session("paused")}
        sessionAction={state.actions[0]!}
        state={state}
        now={now}
        timezone="Australia/Sydney"
        saving={false}
        secondsRemaining={1200}
        plannedStart={now}
        plannedEnd={new Date(now.getTime() + 1_800_000)}
        plannedDuration={30}
        onPauseOrResume={vi.fn()}
        onRequestFeedback={vi.fn()}
      />
    );
    expect(screen.getByText(/^Paused · started /)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
  });

  const panelProps = {
    sessionAction: state.actions[0]!,
    state,
    now,
    timezone: "Australia/Sydney",
    saving: false,
    secondsRemaining: 1200,
    plannedStart: now,
    plannedEnd: new Date(now.getTime() + 1_800_000),
    plannedDuration: 30,
    onPauseOrResume: vi.fn(),
    onRequestFeedback: vi.fn()
  };
  it("stops the session to switch only once the person confirms, saying what it keeps", () => {
    const onSwitch = vi.fn().mockResolvedValue(undefined);
    render(
      <ActionSessionPanel
        {...panelProps}
        sessionAction={{ ...state.actions[0]!, remainingMinutes: 90 }}
        session={session("running")}
        onSwitch={onSwitch}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Switch to…" }));
    expect(onSwitch).not.toHaveBeenCalled();
    expect(screen.getByText(/stops now and keeps its 1 h 30 m\. Then you pick what to do instead\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop and choose" }));
    expect(onSwitch).toHaveBeenCalledTimes(1);
  });

  it("leaves the session running when the person keeps going", () => {
    const onSwitch = vi.fn().mockResolvedValue(undefined);
    render(<ActionSessionPanel {...panelProps} session={session("running")} onSwitch={onSwitch} />);
    fireEvent.click(screen.getByRole("button", { name: "Switch to…" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep going" }));
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it("takes focus on its heading when it was started by a switch, and says so once", () => {
    const onFocused = vi.fn();
    render(
      <ActionSessionPanel
        session={session("running")}
        sessionAction={state.actions[0]!}
        state={state}
        now={now}
        timezone="Australia/Sydney"
        saving={false}
        secondsRemaining={1200}
        plannedStart={now}
        plannedEnd={new Date(now.getTime() + 1_800_000)}
        plannedDuration={30}
        onPauseOrResume={vi.fn()}
        onRequestFeedback={vi.fn()}
        focusOnMount
        onFocused={onFocused}
      />
    );
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));
    expect(onFocused).toHaveBeenCalledTimes(1);
  });

  it("offers no Switch to without a way to switch", () => {
    render(<ActionSessionPanel {...panelProps} session={session("running")} />);
    expect(screen.queryByRole("button", { name: "Switch to…" })).toBeNull();
  });

  it("refuses a picked time that is not earlier than the start, which would drop the work between", () => {
    const onCorrectStart = vi.fn().mockResolvedValue(undefined);
    // Started at 09:55Z; now is 10:00Z. 19:58 in the seed zone (+10 on this date) is 09:58Z, later than the start.
    render(
      <ActionSessionPanel
        {...panelProps}
        session={session("running")}
        plannedStart={new Date(now.getTime() - 5 * 60_000)}
        onCorrectStart={onCorrectStart}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Started earlier?" }));
    fireEvent.click(screen.getByRole("button", { name: "Pick a time" }));
    fireEvent.change(screen.getByLabelText("It started at"), { target: { value: "2026-08-18T19:58" } });
    expect(screen.getByRole("alert").textContent).toMatch(/not earlier than the start/);
    const move = screen.getByRole("button", { name: "Move the start" }) as HTMLButtonElement;
    expect(move.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("It started at"), { target: { value: "2026-08-18T19:50" } });
    expect(move.disabled).toBe(false);
    fireEvent.click(move);
    expect(onCorrectStart).toHaveBeenCalledWith("2026-08-18T09:50:00.000Z");
  });

  it("turns off a chip that would move the start before the last session ended", () => {
    const withEnd = {
      ...state,
      lastEndedSessions: [
        { targetId: "x", endedAt: new Date(now.getTime() - 20 * 60_000).toISOString(), focusedMinutes: 5 }
      ]
    };
    render(
      <ActionSessionPanel
        {...panelProps}
        state={withEnd}
        session={session("running")}
        plannedStart={new Date(now.getTime() - 5 * 60_000)}
        onCorrectStart={vi.fn().mockResolvedValue(undefined)}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Started earlier?" }));
    expect((screen.getByRole("button", { name: "30 min ago" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "10 min ago" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("moves the start earlier from Started earlier?, only once a time is chosen", async () => {
    const onCorrectStart = vi.fn().mockResolvedValue(undefined);
    render(
      <ActionSessionPanel
        {...panelProps}
        session={session("running")}
        plannedStart={new Date(now.getTime() - 5 * 60_000)}
        onCorrectStart={onCorrectStart}
      />
    );
    expect(screen.queryByRole("button", { name: "Move the start" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Started earlier?" }));
    const move = screen.getByRole("button", { name: "Move the start" }) as HTMLButtonElement;
    expect(move.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "30 min ago" }));
    expect(move.disabled).toBe(false);
    fireEvent.click(move);
    expect(onCorrectStart).toHaveBeenCalledTimes(1);
    expect(onCorrectStart.mock.calls[0]![0]).toBe("2026-08-18T09:30:00.000Z");
  });
});
