// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { Need } from "@openrhen/contracts";
import { createSeedState, type ActiveSession, type PortalState } from "@/state/portal-state";
import { fireEvent, render, screen, waitFor, within } from "@/test/render";
import { buildNowModel } from "@/features/now/now-model";
import { FactNeeds, latestPreferredWake } from "./fact-needs";

// 20:00 on Tuesday 18 August in the seed zone (UTC+10), the seed state's planning zone.
const now = new Date("2026-08-18T10:00:00.000Z");
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();

const home = {
  id: "ctx-home",
  kind: "location",
  name: "Home",
  status: "active",
  portability: "fixed",
  pathways: []
} as unknown as PortalState["conditionDefinitions"][number];

const state: PortalState = {
  ...createSeedState(now),
  conditionDefinitions: [home],
  assertedConditions: ["laptop"],
  settings: { ...createSeedState(now).settings, version: 7 }
};

const answer = {
  tool: "rhen_save",
  action: "settings",
  fields: [],
  cli: "rhen save",
  call: { tool: "rhen_save", arguments: { entityType: "settings" } },
  instructions: "Call rhen_save."
};
const need = (overrides: Partial<Need> & Pick<Need, "fact">): Need => ({
  title: "",
  question: "",
  blocksDirective: false,
  answer,
  ...overrides
});

const session = (overrides: Partial<ActiveSession> = {}): ActiveSession => ({
  id: "session-1",
  actionId: state.actions[0]!.id,
  status: "running",
  version: 4,
  startedAt: "2026-08-17T03:00:00.000Z",
  plannedEndAt: "2026-08-17T03:45:00.000Z",
  plannedMinutes: 45,
  remainingBeforeMinutes: 90,
  activeElapsedSeconds: 2700,
  ...overrides
});

function mount(
  needs: Need[],
  props: Partial<Parameters<typeof FactNeeds>[0]> = {}
): {
  saveEntityCommand: ReturnType<typeof vi.fn>;
  finishSession: ReturnType<typeof vi.fn>;
  runActivityCommand: ReturnType<typeof vi.fn>;
} {
  const spies = {
    saveEntityCommand: vi.fn().mockResolvedValue(undefined),
    finishSession: vi.fn().mockResolvedValue(undefined),
    runActivityCommand: vi.fn().mockResolvedValue(undefined)
  };
  render(
    <FactNeeds
      needs={needs}
      label="Also check"
      heading="Also check"
      state={state}
      session={null}
      now={now}
      timezone="Australia/Sydney"
      saving={false}
      {...spies}
      {...props}
    />
  );
  return spies;
}

describe("FactNeeds", () => {
  it("renders nothing when there is nothing to ask", () => {
    mount([]);
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.queryByText("Also check")).toBeNull();
  });

  it("names the group and counts it under 'Also check', and leaves the blocking stack unheaded", () => {
    mount([need({ fact: "energy", question: "How is your energy now?" })]);
    const group = screen.getByRole("region", { name: "Also check" });
    expect(within(group).getByRole("heading", { name: "Also check" })).toBeTruthy();
    expect(within(group).getByText("1")).toBeTruthy();
  });

  it("shows a blocking stack with no heading, one line per need", () => {
    mount(
      [
        need({
          fact: "location",
          subjectId: "ctx-home",
          title: "Home",
          question: "Still at Home?",
          blocksDirective: true
        }),
        need({ fact: "energy", question: "How is your energy now?", blocksDirective: true })
      ],
      { heading: undefined, label: "Needs an answer first" }
    );
    const group = screen.getByRole("region", { name: "Needs an answer first" });
    expect(within(group).queryByRole("heading")).toBeNull();
    expect(within(group).getAllByRole("listitem")).toHaveLength(2);
  });

  describe("location", () => {
    it("re-asserts the place in one tap, with the ordinary situation command", () => {
      const { saveEntityCommand } = mount([
        need({ fact: "location", subjectId: "ctx-home", title: "Home", question: "Still at Home?" })
      ]);
      expect(screen.getByText("Still at Home?")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Still at Home" }));
      expect(saveEntityCommand).toHaveBeenCalledTimes(1);
      expect(saveEntityCommand.mock.calls[0]![0]).toMatchObject({
        type: "save_entity",
        entityType: "current_availability",
        expectedVersion: 7,
        entity: {
          currentEnergy: state.currentEnergy,
          assertedConditions: ["laptop"],
          currentSituation: { locationId: "ctx-home" }
        }
      });
    });
  });

  describe("energy", () => {
    it("offers the four choices, each saving the energy as asserted", () => {
      const { saveEntityCommand } = mount([
        need({ fact: "energy", title: "Energy", question: "How is your energy now?" })
      ]);
      const choices = within(screen.getByRole("group", { name: "Energy now" })).getAllByRole("button");
      expect(choices.map((button) => button.textContent)).toEqual([
        "High focus",
        "Medium focus",
        "Low focus",
        "Recovery"
      ]);
      fireEvent.click(screen.getByRole("button", { name: "Low focus" }));
      expect(saveEntityCommand).toHaveBeenCalledTimes(1);
      expect(saveEntityCommand.mock.calls[0]![0]).toMatchObject({
        type: "save_entity",
        entityType: "current_availability",
        expectedVersion: 7,
        // Said again even when it is the stored value: that is what dates it.
        entity: { currentEnergy: "low", assertedConditions: ["laptop"], energyAsserted: true }
      });
    });

    it("asserts the stored value too, when that is the one chosen", () => {
      const { saveEntityCommand } = mount([need({ fact: "energy", question: "How is your energy now?" })]);
      fireEvent.click(screen.getByRole("button", { name: "Medium focus" }));
      expect(saveEntityCommand.mock.calls[0]![0].entity).toEqual({
        currentEnergy: "medium",
        assertedConditions: ["laptop"],
        energyAsserted: true
      });
    });
  });

  describe("wake", () => {
    const wake = need({ fact: "wake", title: "Last wake", question: "Last woke 21 days ago. When did you wake up?" });

    it("keeps the one-tap wake time pressable while another command saves, and sends a double tap once", () => {
      const { saveEntityCommand } = mount([wake], { saving: true });
      const button = screen.getByRole("button", { name: "Woke at 6:00 am" }) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      fireEvent.click(button);
      fireEvent.click(button);
      expect(saveEntityCommand).toHaveBeenCalledTimes(1);
    });

    it("saves the preferred wake time as settings.lastWokeAt in one tap", () => {
      const { saveEntityCommand } = mount([wake]);
      expect(screen.getByText("Last woke 21 days ago. When did you wake up?")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Woke at 6:00 am" }));
      expect(saveEntityCommand).toHaveBeenCalledTimes(1);
      expect(saveEntityCommand.mock.calls[0]![0]).toMatchObject({
        type: "save_entity",
        entityType: "settings",
        expectedVersion: 7,
        // 06:00 on the 18th in the seed zone.
        entity: { lastWokeAt: "2026-08-17T20:00:00.000Z" }
      });
    });

    it("saves a time typed in the planning zone, and not before one is typed", () => {
      const { saveEntityCommand } = mount([wake]);
      const save = screen.getByRole("button", { name: "Woke then" }) as HTMLButtonElement;
      expect(save.disabled).toBe(true);
      fireEvent.change(screen.getByLabelText("When you woke"), { target: { value: "2026-08-18T07:45" } });
      expect(save.disabled).toBe(false);
      fireEvent.click(save);
      expect(saveEntityCommand.mock.calls[0]![0]).toMatchObject({
        entityType: "settings",
        entity: { lastWokeAt: "2026-08-17T21:45:00.000Z" }
      });
    });

    it("cannot be told a wake later than now", () => {
      mount([wake]);
      expect(screen.getByLabelText("When you woke").getAttribute("max")).toBe("2026-08-18T20:00");
    });

    it("says yesterday while today's preferred wake time has not come yet", () => {
      const early = new Date("2026-08-17T18:00:00.000Z");
      expect(latestPreferredWake("06:00", "Australia/Sydney", early)).toEqual({
        at: "2026-08-16T20:00:00.000Z",
        yesterday: true
      });
      expect(latestPreferredWake("06:00", "Australia/Sydney", now)).toEqual({
        at: "2026-08-17T20:00:00.000Z",
        yesterday: false
      });
      mount([wake], { now: early });
      expect(screen.getByRole("button", { name: "Woke at 6:00 am yesterday" })).toBeTruthy();
    });

    it("takes yesterday as the calendar day before, across the 23-hour day daylight saving starts", () => {
      // seed-zone skips 02:00 to 03:00 on Sunday 4 October 2026. At 00:15 on the 5th (AEDT, UTC+11) a 00:30 wake has
      // not come yet, so the latest is 00:30 on the 4th (AEST, UTC+10), not the 3rd that 24 hours back lands on.
      expect(latestPreferredWake("00:30", "Australia/Sydney", new Date("2026-10-04T13:15:00.000Z"))).toEqual({
        at: "2026-10-03T14:30:00.000Z",
        yesterday: true
      });
      // Once it has struck, today's is the one.
      expect(latestPreferredWake("00:30", "Australia/Sydney", new Date("2026-10-04T13:30:00.000Z"))).toEqual({
        at: "2026-10-04T13:30:00.000Z",
        yesterday: false
      });
    });

    it("offers no preferred time when the setting is not a clock time, only the field", () => {
      expect(latestPreferredWake("", "Australia/Sydney", now)).toBeUndefined();
      mount([wake], { state: { ...state, settings: { ...state.settings, preferredWakeTime: "" } } });
      expect(screen.queryByRole("button", { name: /^Woke at/ })).toBeNull();
      expect(screen.getByLabelText("When you woke")).toBeTruthy();
    });

    it("does not offer a preferred time that would move the wake back", () => {
      mount([wake], {
        state: { ...state, settings: { ...state.settings, lastWokeAt: "2026-08-17T22:00:00.000Z" } }
      });
      expect(screen.queryByRole("button", { name: /^Woke at/ })).toBeNull();
      expect(screen.getByRole("button", { name: "Woke then" })).toBeTruthy();
    });

    it("says why a refused save was refused", async () => {
      const refused = vi.fn().mockRejectedValue(new Error("When you last woke cannot be in the future."));
      mount([wake], { saveEntityCommand: refused });
      fireEvent.click(screen.getByRole("button", { name: "Woke at 6:00 am" }));
      expect((await screen.findByRole("alert")).textContent).toBe("When you last woke cannot be in the future.");
    });
  });

  describe("session end", () => {
    const stopped = need({
      fact: "session_end",
      subjectId: "session-1",
      title: "Lab 7: VLAN trunking notes",
      question: "Running 19 h, planned 45 min. When did it stop?",
      asOf: "2026-08-17T03:45:00.000Z",
      blocksDirective: true,
      answer: {
        tool: "rhen_session",
        action: "finish",
        fields: ["endedAt"],
        cli: "rhen session finish --ended-at <time>",
        call: { tool: "rhen_session", arguments: { subcommand: "finish", "ended-at": "<time>" } },
        instructions: "Call rhen_session."
      }
    });
    const chooseOutcome = (value: "finished" | "progress" | "unsure") =>
      fireEvent.change(screen.getByLabelText("How it went"), { target: { value } });

    it("names the session and asks when it stopped", () => {
      mount([stopped], { session: session() });
      expect(screen.getByText("Lab 7: VLAN trunking notes")).toBeTruthy();
      expect(screen.getByText("Running 19 h, planned 45 min. When did it stop?")).toBeTruthy();
    });

    it("finishes an action session at the planned end once the person says it is done", () => {
      const { finishSession } = mount([stopped], { session: session() });
      // The planned end, 13:45 on the 17th in the seed zone, is already in the field.
      expect((screen.getByLabelText("It stopped at") as HTMLInputElement).value).toBe("2026-08-17T13:45");
      chooseOutcome("finished");
      fireEvent.click(screen.getByRole("button", { name: "It stopped then" }));
      expect(finishSession).toHaveBeenCalledWith("finished", 0, { endedAt: "2026-08-17T03:45:00.000Z" });
    });

    it("finishes it at the time that was typed instead", () => {
      const { finishSession } = mount([stopped], { session: session() });
      fireEvent.change(screen.getByLabelText("It stopped at"), { target: { value: "2026-08-17T14:10" } });
      chooseOutcome("finished");
      fireEvent.click(screen.getByRole("button", { name: "It stopped then" }));
      expect(finishSession).toHaveBeenCalledWith("finished", 0, { endedAt: "2026-08-17T04:10:00.000Z" });
    });

    it("bounds the time between the session's start and now", () => {
      mount([stopped], { session: session() });
      const field = screen.getByLabelText("It stopped at");
      expect(field.getAttribute("min")).toBe("2026-08-17T13:00");
      expect(field.getAttribute("max")).toBe("2026-08-18T20:00");
    });

    it("finishes a paused session with no time to give, saying how it went", () => {
      const paused = need({
        fact: "session_end",
        subjectId: "session-1",
        title: "Lab 7: VLAN trunking notes",
        question: "Paused 5 h ago. Finish it?",
        asOf: "2026-08-17T03:45:00.000Z",
        blocksDirective: true,
        answer: {
          tool: "rhen_session",
          action: "finish",
          fields: [],
          cli: "rhen session finish",
          call: { tool: "rhen_session", arguments: { subcommand: "finish" } },
          instructions: "Call rhen_session."
        }
      });
      const { finishSession } = mount([paused], { session: session({ status: "paused" }) });
      expect(screen.getByText("Paused 5 h ago. Finish it?")).toBeTruthy();
      expect(screen.queryByLabelText("It stopped at")).toBeNull();
      // Paused and left is not the same as done: the person still says how it went.
      fireEvent.change(screen.getByLabelText("How it went"), { target: { value: "unsure" } });
      fireEvent.click(screen.getByRole("button", { name: "Finish" }));
      expect(finishSession).toHaveBeenCalledWith("unsure", undefined, undefined);
    });

    it("sends no time for a paused session even when its need still names one", () => {
      const { finishSession } = mount([stopped], { session: session({ status: "paused" }) });
      expect(screen.queryByLabelText("It stopped at")).toBeNull();
      chooseOutcome("finished");
      fireEvent.click(screen.getByRole("button", { name: "Finish" }));
      expect(finishSession).toHaveBeenCalledWith("finished", 0, undefined);
    });

    it("chooses no outcome for an action until the person says how it went", () => {
      const { finishSession } = mount([stopped], { session: session() });
      const outcome = screen.getByLabelText("How it went") as HTMLSelectElement;
      // One tap must not mark a stale action done: as on the checkpoint sheet, nothing is chosen yet.
      expect(outcome.value).toBe("");
      expect([...outcome.options].map((option) => option.textContent)).toEqual([
        "How did it go?",
        "Finished it",
        "Made progress",
        "Not sure"
      ]);
      expect(screen.queryByLabelText("Minutes left")).toBeNull();
      const save = screen.getByRole("button", { name: "It stopped then" }) as HTMLButtonElement;
      expect(save.disabled).toBe(true);
      fireEvent.click(save);
      expect(finishSession).not.toHaveBeenCalled();
      chooseOutcome("finished");
      expect(save.disabled).toBe(false);
    });

    it("records progress with the minutes left, at the time given", () => {
      const { finishSession } = mount([stopped], { session: session() });
      fireEvent.change(screen.getByLabelText("How it went"), { target: { value: "progress" } });
      // Starts from what was left before the session.
      expect((screen.getByLabelText("Minutes left") as HTMLInputElement).value).toBe("90");
      fireEvent.change(screen.getByLabelText("Minutes left"), { target: { value: "40" } });
      fireEvent.click(screen.getByRole("button", { name: "It stopped then" }));
      expect(finishSession).toHaveBeenCalledWith("progress", 40, { endedAt: "2026-08-17T03:45:00.000Z" });
    });

    it("will not record progress without a whole number of minutes left", () => {
      mount([stopped], { session: session() });
      fireEvent.change(screen.getByLabelText("How it went"), { target: { value: "progress" } });
      const save = screen.getByRole("button", { name: "It stopped then" }) as HTMLButtonElement;
      for (const bad of ["", "0", "2.5"]) {
        fireEvent.change(screen.getByLabelText("Minutes left"), { target: { value: bad } });
        expect(save.disabled).toBe(true);
      }
      fireEvent.change(screen.getByLabelText("Minutes left"), { target: { value: "15" } });
      expect(save.disabled).toBe(false);
    });

    it("records that it stopped without saying how it went", () => {
      const { finishSession } = mount([stopped], { session: session() });
      fireEvent.change(screen.getByLabelText("How it went"), { target: { value: "unsure" } });
      expect(screen.queryByLabelText("Minutes left")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "It stopped then" }));
      expect(finishSession).toHaveBeenCalledWith("unsure", undefined, { endedAt: "2026-08-17T03:45:00.000Z" });
    });

    it("gives a routine or a deliverable no outcome to pick", () => {
      mount([stopped], { session: session({ targetType: "routine_step" }) });
      expect(screen.queryByLabelText("How it went")).toBeNull();
    });

    it("finishes a routine or commitment through the activity command, as done", () => {
      const { runActivityCommand, finishSession } = mount([stopped], {
        session: session({ targetType: "routine_step" })
      });
      fireEvent.click(screen.getByRole("button", { name: "It stopped then" }));
      expect(finishSession).not.toHaveBeenCalled();
      expect(runActivityCommand).toHaveBeenCalledWith({
        commandId: expect.any(String),
        expectedVersion: 4,
        type: "finish_activity",
        sessionId: "session-1",
        outcome: "completed",
        endedAt: "2026-08-17T03:45:00.000Z"
      });
    });

    it("stops a deliverable's session rather than completing it", () => {
      const { runActivityCommand } = mount([stopped], { session: session({ targetType: "deliverable" }) });
      fireEvent.click(screen.getByRole("button", { name: "It stopped then" }));
      expect(runActivityCommand).toHaveBeenCalledWith(
        expect.objectContaining({ type: "finish_activity", outcome: "stopped", endedAt: "2026-08-17T03:45:00.000Z" })
      );
    });

    it("says why a refused end time was refused", async () => {
      const finishSession = vi.fn().mockRejectedValue(new Error("The end time must be after 1:00 pm."));
      mount([stopped], { session: session(), finishSession });
      chooseOutcome("finished");
      fireEvent.click(screen.getByRole("button", { name: "It stopped then" }));
      await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("The end time must be after 1:00 pm."));
    });

    it("offers nothing for a session that is not the open one", () => {
      mount([stopped], { session: null });
      expect(screen.queryByRole("button", { name: "It stopped then" })).toBeNull();
    });

    it("is disabled while a save is in flight", () => {
      mount([stopped], { session: session(), saving: true });
      expect((screen.getByRole("button", { name: "It stopped then" }) as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it("lists the needs the model builds, in its words, with each answer next to its line", () => {
    const stale: PortalState = {
      ...state,
      activeSession: session({ plannedEndAt: hoursAgo(18), startedAt: hoursAgo(19), plannedMinutes: 45 }),
      settings: { ...state.settings, lastWokeAt: hoursAgo(40) }
    };
    const model = buildNowModel({
      state: stale,
      recommendation: {
        primary: null,
        alternatives: [],
        candidates: [],
        headline: "Nothing fits",
        explanation: "",
        evidence: []
      },
      forecasts: [],
      currentDirective: null,
      now,
      manualBedtime: false
    });
    expect(model.needs.map((item) => item.fact)).toEqual(["session_end", "wake", "energy"]);
    mount(model.needs, { state: stale, session: stale.activeSession });
    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0]!).getByRole("button", { name: "It stopped then" })).toBeTruthy();
    expect(within(rows[1]!).getByRole("button", { name: "Woke then" })).toBeTruthy();
    expect(within(rows[2]!).getByRole("button", { name: "Recovery" })).toBeTruthy();
  });
});
