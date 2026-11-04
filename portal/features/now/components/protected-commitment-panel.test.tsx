// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { fireEvent, render, screen } from "@/test/render";
import type { NowProtectedCommitment } from "@/features/now/now-model";
import { ProtectedCommitmentPanel } from "./protected-commitment-panel";

const now = new Date("2026-08-18T10:00:00.000Z");
const state = createSeedState(now);
const protectedCommitment: NowProtectedCommitment = {
  id: "dinner",
  title: "Dinner and reset",
  phase: "active",
  startsAt: new Date(now.getTime() + 10 * 60_000),
  endsAt: new Date(now.getTime() + 70 * 60_000),
  protectedStartAt: new Date(now.getTime() + 10 * 60_000),
  protectedEndAt: new Date(now.getTime() + 80 * 60_000),
  phaseStartsAt: new Date(now.getTime() + 10 * 60_000),
  phaseEndsAt: new Date(now.getTime() + 70 * 60_000)
};

describe("ProtectedCommitmentPanel", () => {
  it("tracks the commitment through to the end of its protection", () => {
    const runActivityCommand = vi.fn().mockResolvedValue(undefined);
    render(
      <ProtectedCommitmentPanel
        protectedCommitment={protectedCommitment}
        storedProtectedCommitment={state.commitments[0]!}
        state={state}
        now={now}
        timezone="Australia/Sydney"
        saving={false}
        explanation="Dinner holds this time."
        evidence={["Dinner is confirmed"]}
        runActivityCommand={runActivityCommand}
        saveEntityCommand={vi.fn().mockResolvedValue(undefined)}
      />
    );
    expect(screen.getByText("Dinner holds this time.")).toBeTruthy();
    expect(screen.getByText("Why work is paused")).toBeTruthy();
    // The commitment's own page, for "what was I supposed to have done before this?".
    expect(screen.getByRole("link", { name: "Open this commitment" }).getAttribute("href")).toBe("/commitments/dinner");
    // "in progress" (the schedule protecting this block) and "Start tracking time" (an
    // optional, separate session) read as a contradiction without this line spelling out the difference.
    // The same confusion recurred with that disambiguation buried below the button, so
    // it now opens with a direct answer, right next to the "commitment in progress" wording above it.
    expect(
      screen.getByText(
        "Not tracking time. The schedule already protects this block whether or not tracking is on — start tracking below only if you also want the actual time logged."
      )
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start tracking time" }));
    expect(runActivityCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "start_activity",
        targetType: "fixed_commitment",
        targetId: "dinner",
        phase: "active",
        plannedMinutes: 80
      })
    );
  });

  it("tracks only the setup phase's own window, not the whole protected block", () => {
    // The button used to send `protectedEndAt` (80 minutes out) regardless of
    // phase, so pressing it during setup opened a session spanning the entire protected block.
    const runActivityCommand = vi.fn().mockResolvedValue(undefined);
    render(
      <ProtectedCommitmentPanel
        protectedCommitment={{
          ...protectedCommitment,
          phase: "setup",
          phaseStartsAt: now,
          phaseEndsAt: new Date(now.getTime() + 5 * 60_000)
        }}
        storedProtectedCommitment={state.commitments[0]!}
        state={state}
        now={now}
        timezone="Australia/Sydney"
        saving={false}
        explanation="Setting up."
        evidence={[]}
        runActivityCommand={runActivityCommand}
        saveEntityCommand={vi.fn().mockResolvedValue(undefined)}
      />
    );
    // The "tracking is separate from the protected block" clarification is specific to the active
    // phase — during setup there is no "in progress" wording to contradict in the first place.
    expect(screen.queryByText(/Not tracking time/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start tracking preparation" }));
    expect(runActivityCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "start_activity",
        targetType: "fixed_commitment",
        targetId: "dinner",
        phase: "setup",
        plannedMinutes: 5
      })
    );
  });

  it("tracks only the travel phase's own window", () => {
    const runActivityCommand = vi.fn().mockResolvedValue(undefined);
    render(
      <ProtectedCommitmentPanel
        protectedCommitment={{
          ...protectedCommitment,
          phase: "travel",
          phaseStartsAt: now,
          phaseEndsAt: new Date(now.getTime() + 20 * 60_000)
        }}
        storedProtectedCommitment={state.commitments[0]!}
        state={state}
        now={now}
        timezone="Australia/Sydney"
        saving={false}
        explanation="On the way."
        evidence={[]}
        runActivityCommand={runActivityCommand}
        saveEntityCommand={vi.fn().mockResolvedValue(undefined)}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Start tracking the drive" }));
    expect(runActivityCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "start_activity",
        targetType: "fixed_commitment",
        targetId: "dinner",
        phase: "travel",
        plannedMinutes: 20
      })
    );
  });

  it("names the phase the commitment is currently in", () => {
    render(
      <ProtectedCommitmentPanel
        protectedCommitment={{ ...protectedCommitment, phase: "setup" }}
        storedProtectedCommitment={undefined}
        state={state}
        now={now}
        timezone="Australia/Sydney"
        saving={false}
        explanation="Setting up."
        evidence={[]}
        runActivityCommand={vi.fn()}
        saveEntityCommand={vi.fn().mockResolvedValue(undefined)}
      />
    );
    expect(screen.getByText(/setup buffer/)).toBeTruthy();
  });

  it("offers no lifecycle buttons for an ordinary, non-disruption commitment", () => {
    render(
      <ProtectedCommitmentPanel
        protectedCommitment={protectedCommitment}
        storedProtectedCommitment={state.commitments[0]!}
        state={state}
        now={now}
        timezone="Australia/Sydney"
        saving={false}
        explanation="Dinner holds this time."
        evidence={[]}
        runActivityCommand={vi.fn()}
        saveEntityCommand={vi.fn().mockResolvedValue(undefined)}
      />
    );
    expect(screen.queryByRole("button", { name: "Done, heading home" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Still out — another hour" })).toBeNull();
  });

  it("offers 'Done, heading home' and 'Still out' for an open-ended disruption, and saves on click", () => {
    const openEnded = {
      ...state.commitments[0]!,
      id: "dinner",
      origin: "disruption",
      disruptionOpenEnded: true,
      startsAt: new Date(now.getTime() - 30 * 60_000).toISOString(),
      endsAt: new Date(now.getTime() + 60 * 60_000).toISOString()
    } as (typeof state.commitments)[number];
    const saveEntityCommand = vi.fn().mockResolvedValue(undefined);
    render(
      <ProtectedCommitmentPanel
        protectedCommitment={protectedCommitment}
        storedProtectedCommitment={openEnded}
        state={state}
        now={now}
        timezone="Australia/Sydney"
        saving={false}
        explanation="Dinner holds this time."
        evidence={[]}
        runActivityCommand={vi.fn()}
        saveEntityCommand={saveEntityCommand}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Done, heading home" }));
    expect(saveEntityCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "save_entity",
        entityType: "commitment",
        entity: expect.objectContaining({ id: "dinner", endsAt: now.toISOString(), disruptionOpenEnded: false })
      })
    );
  });

  it("offers a one-tap arrival button for a located commitment while the situation disagrees", () => {
    const locatedCommitment = { ...state.commitments[0]!, locationId: "loc-college" };
    const locatedState = {
      ...state,
      conditionDefinitions: [
        {
          id: "loc-college",
          name: "College",
          kind: "location" as const,
          status: "active" as const,
          pathways: [],
          portability: "fixed" as const,
          grants: [],
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0,
          channels: []
        }
      ]
    };
    const saveEntityCommand = vi.fn().mockResolvedValue(undefined);
    render(
      <ProtectedCommitmentPanel
        protectedCommitment={{ ...protectedCommitment, phase: "setup" }}
        storedProtectedCommitment={locatedCommitment}
        state={locatedState}
        now={now}
        timezone="Australia/Sydney"
        saving={false}
        explanation="Setting up."
        evidence={[]}
        runActivityCommand={vi.fn()}
        saveEntityCommand={saveEntityCommand}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "I’m at College" }));
    expect(saveEntityCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "save_entity",
        entityType: "current_availability",
        entity: expect.objectContaining({ currentSituation: { locationId: "loc-college" } })
      })
    );
  });

  it("offers no arrival button for a located commitment once the situation already agrees", () => {
    const locatedCommitment = { ...state.commitments[0]!, locationId: "loc-college" };
    const locatedState = {
      ...state,
      conditionDefinitions: [
        {
          id: "loc-college",
          name: "College",
          kind: "location" as const,
          status: "active" as const,
          pathways: [],
          portability: "fixed" as const,
          grants: [],
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0,
          channels: []
        }
      ],
      currentSituation: { ...state.currentSituation, locationId: "loc-college" }
    };
    render(
      <ProtectedCommitmentPanel
        protectedCommitment={{ ...protectedCommitment, phase: "setup" }}
        storedProtectedCommitment={locatedCommitment}
        state={locatedState}
        now={now}
        timezone="Australia/Sydney"
        saving={false}
        explanation="Setting up."
        evidence={[]}
        runActivityCommand={vi.fn()}
        saveEntityCommand={vi.fn().mockResolvedValue(undefined)}
      />
    );
    expect(screen.queryByRole("button", { name: "I’m at College" })).toBeNull();
  });
});
