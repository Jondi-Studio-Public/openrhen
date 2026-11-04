// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createSeedState, type ActiveSession } from "@/state/portal-state";
import { act, fireEvent, render, screen } from "@/test/render";
import { DeliverableSessionPanel } from "./deliverable-session-panel";

const now = new Date("2026-08-18T10:00:00.000Z");
const session: ActiveSession = {
  id: "session-1",
  actionId: "networking-section-one",
  status: "running",
  targetType: "deliverable",
  targetId: "deliverable one",
  targetTitle: "Assignment 2",
  startedAt: new Date(now.getTime() - 600_000).toISOString(),
  plannedEndAt: new Date(now.getTime() + 1_200_000).toISOString(),
  plannedMinutes: 30,
  remainingBeforeMinutes: 90,
  activeElapsedSeconds: 600
};

describe("DeliverableSessionPanel", () => {
  it("points at the workspace with the deliverable id escaped into the link", () => {
    render(
      <DeliverableSessionPanel
        session={session}
        state={createSeedState(now)}
        now={now}
        timezone="Australia/Sydney"
        saving={false}
        secondsRemaining={1200}
        sessionCheckpointReached={false}
        runActivityCommand={vi.fn()}
      />
    );
    expect(screen.getByText("Deliverable in progress")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open workspace" }).getAttribute("href")).toBe(
      "/deliverables?deliverable=deliverable%20one"
    );
  });

  it("says the protected period has ended once the checkpoint is reached, with no pause or stop offered", () => {
    render(
      <DeliverableSessionPanel
        session={session}
        state={createSeedState(now)}
        now={now}
        timezone="Australia/Sydney"
        saving={false}
        secondsRemaining={-30}
        sessionCheckpointReached
        runActivityCommand={vi.fn()}
      />
    );
    expect(screen.getByText("Checkpoint reached")).toBeTruthy();
    expect(screen.getByText("+0:30")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop — work remains" })).toBeNull();
  });

  // Pausing a deliverable session (and stopping it for now, with a note on what
  // came up) needs to work from this panel directly — leaving the phone in a hurry shouldn't
  // require opening the workspace first.
  it("pauses the session without opening the workspace", () => {
    const runActivityCommand = vi.fn();
    render(
      <DeliverableSessionPanel
        session={session}
        state={createSeedState(now)}
        now={now}
        timezone="Australia/Sydney"
        saving={false}
        secondsRemaining={1200}
        sessionCheckpointReached={false}
        runActivityCommand={runActivityCommand}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(runActivityCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "pause_activity",
        sessionId: session.id,
        expectedVersion: session.version ?? null
      })
    );
    expect(runActivityCommand.mock.calls[0]?.[0]).not.toHaveProperty("note");
  });

  it("carries the typed note onto a bare pause", () => {
    const runActivityCommand = vi.fn();
    render(
      <DeliverableSessionPanel
        session={session}
        state={createSeedState(now)}
        now={now}
        timezone="Australia/Sydney"
        saving={false}
        secondsRemaining={1200}
        sessionCheckpointReached={false}
        runActivityCommand={runActivityCommand}
      />
    );
    fireEvent.change(screen.getByLabelText("Optional note — what came up"), {
      target: { value: "Kid needs help with homework" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(runActivityCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "pause_activity",
        sessionId: session.id,
        note: "Kid needs help with homework"
      })
    );
  });

  it("clears the note field after a successful pause", async () => {
    const runActivityCommand = vi.fn().mockResolvedValue(undefined);
    render(
      <DeliverableSessionPanel
        session={session}
        state={createSeedState(now)}
        now={now}
        timezone="Australia/Sydney"
        saving={false}
        secondsRemaining={1200}
        sessionCheckpointReached={false}
        runActivityCommand={runActivityCommand}
      />
    );
    const input = screen.getByLabelText("Optional note — what came up") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Kid needs help with homework" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
      await Promise.resolve();
    });
    expect(input.value).toBe("");
  });

  it("shows the recorded note once paused", () => {
    render(
      <DeliverableSessionPanel
        session={{ ...session, status: "paused", pausedRemainingSeconds: 1200, note: "Kid needs help" }}
        state={createSeedState(now)}
        now={now}
        timezone="Australia/Sydney"
        saving={false}
        secondsRemaining={1200}
        sessionCheckpointReached={false}
        runActivityCommand={vi.fn()}
      />
    );
    expect(screen.getByText("Paused: Kid needs help")).toBeTruthy();
    expect(screen.queryByLabelText("Optional note — what came up")).toBeNull();
  });

  it("offers Resume instead of Pause once paused, and hides the stop-with-note field", () => {
    const runActivityCommand = vi.fn();
    render(
      <DeliverableSessionPanel
        session={{ ...session, status: "paused", pausedRemainingSeconds: 1200 }}
        state={createSeedState(now)}
        now={now}
        timezone="Australia/Sydney"
        saving={false}
        secondsRemaining={1200}
        sessionCheckpointReached={false}
        runActivityCommand={runActivityCommand}
      />
    );
    expect(screen.getByText("Deliverable paused")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop — work remains" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(runActivityCommand).toHaveBeenCalledWith(expect.objectContaining({ type: "resume_activity" }));
  });

  it("stops the session with the typed note, leaving the work open", () => {
    const runActivityCommand = vi.fn();
    render(
      <DeliverableSessionPanel
        session={session}
        state={createSeedState(now)}
        now={now}
        timezone="Australia/Sydney"
        saving={false}
        secondsRemaining={1200}
        sessionCheckpointReached={false}
        runActivityCommand={runActivityCommand}
      />
    );
    fireEvent.change(screen.getByLabelText("Optional note — what came up"), {
      target: { value: "Had to leave for a phone call" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Stop — work remains" }));
    expect(runActivityCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "finish_activity",
        sessionId: session.id,
        outcome: "stopped",
        note: "Had to leave for a phone call"
      })
    );
  });
});
