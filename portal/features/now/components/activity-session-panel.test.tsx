// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createSeedState, type ActiveSession, type PortalState } from "@/state/portal-state";
import { fireEvent, render, screen } from "@/test/render";
import { ActivitySessionPanel } from "./activity-session-panel";

const now = new Date("2026-08-18T10:00:00.000Z");
const iso = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();

const session = (overrides: Partial<ActiveSession> = {}): ActiveSession => ({
  id: "session-1",
  actionId: "networking-section-one",
  status: "running",
  startedAt: iso(-10),
  plannedEndAt: iso(20),
  plannedMinutes: 30,
  remainingBeforeMinutes: 90,
  activeElapsedSeconds: 600,
  ...overrides
});

describe("ActivitySessionPanel", () => {
  it("offers sleep only the endings sleep has", () => {
    render(
      <ActivitySessionPanel
        session={session({ targetType: "sleep", targetId: "sleep-tonight", targetTitle: "Sleep" })}
        state={createSeedState(now)}
        now={now}
        timezone="Australia/Sydney"
        saving={false}
        secondsRemaining={-65}
        activeSleepPlan={undefined}
        runActivityCommand={vi.fn()}
        saveEntityCommand={vi.fn().mockResolvedValue(undefined)}
      />
    );
    expect(screen.getByText("Sleeping")).toBeTruthy();
    expect(screen.getByText("+1:05")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.getByRole("button", { name: "I’m awake" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Did not sleep" })).toBeTruthy();
  });

  it("leads with Done, keeps Pause secondary and folds the rare exits under Something else", () => {
    render(
      <ActivitySessionPanel
        session={session({ targetType: "routine_step", targetId: "step-1", targetTitle: "Glass of water and meds" })}
        state={createSeedState(now)}
        now={now}
        timezone="Australia/Sydney"
        saving={false}
        secondsRemaining={1200}
        activeSleepPlan={undefined}
        runActivityCommand={vi.fn()}
        saveEntityCommand={vi.fn().mockResolvedValue(undefined)}
      />
    );
    const [done, pause] = screen.getAllByRole("button");
    expect(done!.textContent).toBe("Done");
    expect(done!.className).toBe("");
    expect(pause!.textContent).toBe("Pause");
    expect(pause!.className).toBe("quiet");
    const more = screen.getByText("Something else").closest("details")!;
    for (const name of ["Blocked", "Skip", "Did not start"])
      expect(more.contains(screen.getByRole("button", { name }))).toBe(true);
    expect(screen.getByRole("progressbar", { name: "Time used" }).getAttribute("aria-valuenow")).toBe("33");
  });

  it("closes the Something else menu on a tap outside it or on Escape, but not on a tap inside it", () => {
    render(
      <ActivitySessionPanel
        session={session({ targetType: "routine_step", targetId: "step-1", targetTitle: "Glass of water and meds" })}
        state={createSeedState(now)}
        now={now}
        timezone="Australia/Sydney"
        saving={false}
        secondsRemaining={1200}
        activeSleepPlan={undefined}
        runActivityCommand={vi.fn()}
        saveEntityCommand={vi.fn().mockResolvedValue(undefined)}
      />
    );
    const summary = screen.getByText("Something else");
    const more = summary.closest("details")!;
    more.open = true;
    fireEvent.pointerDown(screen.getByRole("button", { name: "Blocked" }));
    expect(more.open).toBe(true);
    fireEvent.pointerDown(document.body);
    expect(more.open).toBe(false);
    more.open = true;
    fireEvent.keyDown(document, { key: "Enter" });
    expect(more.open).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(more.open).toBe(false);
    expect(document.activeElement).toBe(summary);
  });

  it("ends an engaged anchor by saying you are free, and an ordinary commitment by confirming", () => {
    const anchorState = (presence: "blocking" | "anchor"): PortalState => {
      const base = createSeedState(now);
      return { ...base, commitments: base.commitments.map((item) => ({ ...item, presence })) };
    };
    const panel = (presence: "blocking" | "anchor") => (
      <ActivitySessionPanel
        session={session({
          targetType: "fixed_commitment",
          targetId: anchorState(presence).commitments[0]!.id,
          targetTitle: "Swimming carnival"
        })}
        state={anchorState(presence)}
        now={now}
        timezone="Australia/Sydney"
        saving={false}
        secondsRemaining={600}
        activeSleepPlan={undefined}
        runActivityCommand={vi.fn()}
        saveEntityCommand={vi.fn().mockResolvedValue(undefined)}
      />
    );
    const anchored = render(panel("anchor"));
    expect(screen.getByRole("button", { name: "I’m free" })).toBeTruthy();
    expect(screen.getByText(/suggestions come back/)).toBeTruthy();
    anchored.unmount();
    render(panel("blocking"));
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
  });

  it("surfaces the disruption's guessed end while its timer is running, and 'Still out' extends it", () => {
    const base = createSeedState(now);
    const disruptionState: PortalState = {
      ...base,
      commitments: [
        {
          ...base.commitments[0]!,
          id: "disruption-1",
          origin: "disruption",
          disruptionOpenEnded: true,
          startsAt: iso(-30),
          endsAt: iso(60)
        },
        ...base.commitments.slice(1)
      ]
    };
    const saveEntityCommand = vi.fn().mockResolvedValue(undefined);
    render(
      <ActivitySessionPanel
        session={session({ targetType: "fixed_commitment", targetId: "disruption-1", targetTitle: "Oops" })}
        state={disruptionState}
        now={now}
        timezone="Australia/Sydney"
        saving={false}
        secondsRemaining={600}
        activeSleepPlan={undefined}
        runActivityCommand={vi.fn()}
        saveEntityCommand={saveEntityCommand}
      />
    );
    expect(screen.getByText(/held open on a guess, not a fact/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Still out — another hour" }));
    expect(saveEntityCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "save_entity",
        entityType: "commitment",
        entity: expect.objectContaining({ id: "disruption-1", disruptionOpenEnded: true })
      })
    );
  });

  it("offers no 'Still out' affordance for an ordinary commitment session", () => {
    const base = createSeedState(now);
    render(
      <ActivitySessionPanel
        session={session({
          targetType: "fixed_commitment",
          targetId: base.commitments[0]!.id,
          targetTitle: "Swimming carnival"
        })}
        state={base}
        now={now}
        timezone="Australia/Sydney"
        saving={false}
        secondsRemaining={600}
        activeSleepPlan={undefined}
        runActivityCommand={vi.fn()}
        saveEntityCommand={vi.fn().mockResolvedValue(undefined)}
      />
    );
    expect(screen.queryByRole("button", { name: "Still out — another hour" })).toBeNull();
  });

  it("offers a one-tap arrival button only while the tracked commitment's place disagrees with the situation", () => {
    const base = createSeedState(now);
    const locatedState: PortalState = {
      ...base,
      commitments: [{ ...base.commitments[0]!, locationId: "loc-college" }, ...base.commitments.slice(1)],
      conditionDefinitions: [
        {
          id: "loc-college",
          name: "College",
          kind: "location",
          status: "active",
          pathways: [],
          portability: "fixed",
          grants: [],
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0,
          channels: []
        }
      ]
    };
    const saveEntityCommand = vi.fn().mockResolvedValue(undefined);
    render(
      <ActivitySessionPanel
        session={session({
          targetType: "fixed_commitment",
          targetId: locatedState.commitments[0]!.id,
          targetTitle: "Preparing for College Class"
        })}
        state={locatedState}
        now={now}
        timezone="Australia/Sydney"
        saving={false}
        secondsRemaining={600}
        activeSleepPlan={undefined}
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

  it("offers no arrival button once the situation already agrees with the commitment's place", () => {
    const base = createSeedState(now);
    const settledState: PortalState = {
      ...base,
      commitments: [{ ...base.commitments[0]!, locationId: "loc-college" }, ...base.commitments.slice(1)],
      conditionDefinitions: [
        {
          id: "loc-college",
          name: "College",
          kind: "location",
          status: "active",
          pathways: [],
          portability: "fixed",
          grants: [],
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0,
          channels: []
        }
      ],
      currentSituation: { ...base.currentSituation, locationId: "loc-college" }
    };
    render(
      <ActivitySessionPanel
        session={session({
          targetType: "fixed_commitment",
          targetId: settledState.commitments[0]!.id,
          targetTitle: "Preparing for College Class"
        })}
        state={settledState}
        now={now}
        timezone="Australia/Sydney"
        saving={false}
        secondsRemaining={600}
        activeSleepPlan={undefined}
        runActivityCommand={vi.fn()}
        saveEntityCommand={vi.fn().mockResolvedValue(undefined)}
      />
    );
    expect(screen.queryByRole("button", { name: "I’m at College" })).toBeNull();
  });

  it("offers Skip only for a routine-step session, and fires the skipped outcome", () => {
    const runActivityCommand = vi.fn().mockResolvedValue(undefined);
    render(
      <ActivitySessionPanel
        session={session({ targetType: "routine_step", targetId: "step-uniform", targetTitle: "Pack bag" })}
        state={createSeedState(now)}
        now={now}
        timezone="Australia/Sydney"
        saving={false}
        secondsRemaining={600}
        activeSleepPlan={undefined}
        runActivityCommand={runActivityCommand}
        saveEntityCommand={vi.fn().mockResolvedValue(undefined)}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(runActivityCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: "finish_activity", sessionId: "session-1", outcome: "skipped" })
    );
  });

  describe("waking", () => {
    const sleeping = (extra: Partial<ActiveSession> = {}) =>
      session({
        targetType: "sleep",
        targetId: "sleep-tonight",
        targetTitle: "Sleep",
        startedAt: iso(-8 * 60),
        ...extra
      });
    const setup = (state: PortalState = createSeedState(now)) => {
      const runActivityCommand = vi.fn().mockResolvedValue(undefined);
      const saveEntityCommand = vi.fn().mockResolvedValue(undefined);
      render(
        <ActivitySessionPanel
          session={sleeping()}
          state={state}
          now={now}
          timezone="Australia/Sydney"
          saving={false}
          secondsRemaining={0}
          activeSleepPlan={undefined}
          runActivityCommand={runActivityCommand}
          saveEntityCommand={saveEntityCommand}
        />
      );
      return { runActivityCommand, saveEntityCommand };
    };

    it("sends the time you woke when a Woke earlier chip is tapped", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      try {
        const { runActivityCommand } = setup();
        fireEvent.click(screen.getByRole("button", { name: "30 min ago" }));
        await vi.waitFor(() => expect(runActivityCommand).toHaveBeenCalledTimes(1));
        expect(runActivityCommand).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "finish_activity",
            sessionId: "session-1",
            outcome: "completed",
            endedAt: iso(-30)
          })
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("disables a chip that would put the wake before the sleep began", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      try {
        const runActivityCommand = vi.fn().mockResolvedValue(undefined);
        render(
          <ActivitySessionPanel
            session={sleeping({ startedAt: iso(-20) })}
            state={createSeedState(now)}
            now={now}
            timezone="Australia/Sydney"
            saving={false}
            secondsRemaining={0}
            activeSleepPlan={undefined}
            runActivityCommand={runActivityCommand}
            saveEntityCommand={vi.fn().mockResolvedValue(undefined)}
          />
        );
        expect((screen.getByRole("button", { name: "15 min ago" }) as HTMLButtonElement).disabled).toBe(false);
        expect((screen.getByRole("button", { name: "30 min ago" }) as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByRole("button", { name: "1 h ago" }) as HTMLButtonElement).disabled).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("picks a time and sends it in the planning timezone", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      try {
        const { runActivityCommand } = setup();
        fireEvent.click(screen.getByRole("button", { name: "Pick a time" }));
        const save = screen.getByRole("button", { name: "Save wake time" }) as HTMLButtonElement;
        expect(save.disabled).toBe(true);
        // 10:00Z is 20:00 in the seed zone (AEST, UTC+10); 19:15 local is 09:15Z.
        fireEvent.change(screen.getByLabelText("I woke at"), { target: { value: "2026-08-18T19:15" } });
        expect(save.disabled).toBe(false);
        fireEvent.click(save);
        await vi.waitFor(() => expect(runActivityCommand).toHaveBeenCalledTimes(1));
        expect(runActivityCommand).toHaveBeenCalledWith(
          expect.objectContaining({ type: "finish_activity", endedAt: "2026-08-18T09:15:00.000Z" })
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("refuses a picked time in the future", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      try {
        setup();
        fireEvent.click(screen.getByRole("button", { name: "Pick a time" }));
        fireEvent.change(screen.getByLabelText("I woke at"), { target: { value: "2026-08-18T21:00" } });
        expect((screen.getByRole("button", { name: "Save wake time" }) as HTMLButtonElement).disabled).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("makes and checks Woke earlier times on the server clock, not the browser's", async () => {
      // The browser reads 30 minutes behind the server.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(now.getTime() - 30 * 60_000));
      try {
        const runActivityCommand = vi.fn().mockResolvedValue(undefined);
        render(
          <ActivitySessionPanel
            session={sleeping()}
            state={createSeedState(now)}
            now={now}
            timezone="Australia/Sydney"
            saving={false}
            secondsRemaining={0}
            activeSleepPlan={undefined}
            serverClock={() => now}
            runActivityCommand={runActivityCommand}
            saveEntityCommand={vi.fn().mockResolvedValue(undefined)}
          />
        );
        fireEvent.click(screen.getByRole("button", { name: "15 min ago" }));
        await vi.waitFor(() => expect(runActivityCommand).toHaveBeenCalledTimes(1));
        expect(runActivityCommand.mock.calls[0]![0].endedAt).toBe(iso(-15));
      } finally {
        vi.useRealTimers();
      }
    });

    it("closes the sleep now, with no endedAt, from I’m awake", async () => {
      const { runActivityCommand } = setup();
      fireEvent.click(screen.getByRole("button", { name: "I’m awake" }));
      await vi.waitFor(() => expect(runActivityCommand).toHaveBeenCalledTimes(1));
      expect(runActivityCommand.mock.calls[0]![0]).not.toHaveProperty("endedAt");
    });

    it("offers Woke earlier on sleep only", () => {
      render(
        <ActivitySessionPanel
          session={session({ targetType: "routine_step", targetId: "step-1", targetTitle: "Water" })}
          state={createSeedState(now)}
          now={now}
          timezone="Australia/Sydney"
          saving={false}
          secondsRemaining={600}
          activeSleepPlan={undefined}
          runActivityCommand={vi.fn()}
          saveEntityCommand={vi.fn().mockResolvedValue(undefined)}
        />
      );
      expect(screen.queryByRole("group", { name: "Woke earlier" })).toBeNull();
    });
  });

  it("offers no Skip button for a tracked commitment session", () => {
    const base = createSeedState(now);
    render(
      <ActivitySessionPanel
        session={session({
          targetType: "fixed_commitment",
          targetId: base.commitments[0]!.id,
          targetTitle: "Swimming carnival"
        })}
        state={base}
        now={now}
        timezone="Australia/Sydney"
        saving={false}
        secondsRemaining={600}
        activeSleepPlan={undefined}
        runActivityCommand={vi.fn()}
        saveEntityCommand={vi.fn().mockResolvedValue(undefined)}
      />
    );
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
  });
});
