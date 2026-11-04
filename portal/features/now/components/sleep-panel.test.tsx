// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createSeedState, type StoredRoutineStep, type StoredSleepPlan } from "@/state/portal-state";
import { fireEvent, render, screen } from "@/test/render";
import { SleepPanel } from "./sleep-panel";

const now = new Date("2026-08-18T10:00:00.000Z");
const state = createSeedState(now);
const sleepDue: StoredSleepPlan = {
  id: "sleep-tonight",
  version: 2,
  plannedStartAt: now.toISOString(),
  plannedWakeAt: new Date(now.getTime() + 480 * 60_000).toISOString(),
  desiredMinutes: 480,
  allowedMinutes: 480,
  sleepDeficitMinutes: 0,
  anchorDeviationMinutes: 0,
  hardErrors: [],
  explanation: "Sleep is due now.",
  status: "planned"
};

const props = {
  sleepDue,
  state,
  timezone: "Australia/Sydney",
  now,
  saving: false,
  manualBedtime: false,
  sleepPanelDue: true,
  sleepEarlyStart: false,
  sleepMinutesUntilPlannedStart: 0,
  sleepEarlyStartWakeAt: undefined,
  sleepConstrainedMinutes: undefined,
  sleepNapTopUpMinutes: undefined,
  onCancelManualBedtime: vi.fn(),
  tentativeSleepConflict: undefined,
  wakeToCommitmentMinutes: undefined,
  commitmentAfterWake: undefined,
  wakeShiftMinutes: 0,
  stepSession: undefined,
  secondsRemaining: 0,
  currentBedtimeStep: undefined,
  primary: null,
  sleepSuggestion: undefined,
  stayUpOffer: undefined,
  runActivityCommand: vi.fn().mockResolvedValue(undefined),
  saveEntityCommand: vi.fn().mockResolvedValue(undefined)
};

// Bedtime started by hand at 12:42 pm local against a plan of 8:45 pm – 4:33 am,
// with last night 72 minutes short of the 480 the settings ask for.
const earlyNow = new Date("2026-08-29T02:42:00.000Z");
const earlyPlan: StoredSleepPlan = {
  ...sleepDue,
  plannedStartAt: "2026-08-29T10:45:00.000Z", // 8:45 pm local
  plannedWakeAt: "2026-08-29T18:33:00.000Z", // 4:33 am local
  desiredMinutes: 468,
  allowedMinutes: 468
};
const earlyProps = {
  ...props,
  sleepDue: earlyPlan,
  now: earlyNow,
  manualBedtime: true,
  sleepPanelDue: false,
  sleepEarlyStart: true,
  sleepMinutesUntilPlannedStart: 483,
  sleepEarlyStartWakeAt: "2026-08-29T10:30:00.000Z", // 12:42 pm + 468 minutes = 8:30 pm
  // No wakeConstraint on earlyPlan, so the constrained offer is just the desired amount (480).
  sleepConstrainedMinutes: 480 as number | undefined,
  sleepNapTopUpMinutes: 72 as number | undefined
};

const bedtimeStep: StoredRoutineStep = {
  id: "step-teeth",
  version: 1,
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

describe("SleepPanel", () => {
  it("starts the protected sleep for the minutes the plan allows", () => {
    const runActivityCommand = vi.fn().mockResolvedValue(undefined);
    render(<SleepPanel {...props} runActivityCommand={runActivityCommand} />);
    expect(screen.getByText("Sleep is due now.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start sleep" }));
    expect(runActivityCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "start_activity",
        targetType: "sleep",
        targetId: "sleep-tonight",
        plannedMinutes: 480,
        expectedVersion: 2
      })
    );
    // Sleep that is genuinely due is one decision, not a menu: the plan already says how long.
    expect(screen.queryByRole("button", { name: /^Full sleep/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Nap/ })).toBeNull();
  });

  it("works through the bedtime routine before offering to start sleep", () => {
    render(<SleepPanel {...props} currentBedtimeStep={bedtimeStep} />);
    expect(screen.getByText("Brush teeth")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start sleep" })).toBeNull();
  });

  it("offers the catch-up as a change to the plan, never as a silent one", () => {
    const saveEntityCommand = vi.fn().mockResolvedValue(undefined);
    render(
      <SleepPanel
        {...props}
        saveEntityCommand={saveEntityCommand}
        sleepSuggestion={{ kind: "catchup", minutes: 540, addedMinutes: 60, wakeAtIso: "2026-08-18T19:00:00.000Z" }}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Extend by 60 min to catch up on last night's shortfall" }));
    expect(saveEntityCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "save_entity",
        entityType: "sleep_plan",
        entity: {
          id: "sleep-tonight",
          plannedStartAt: sleepDue.plannedStartAt,
          plannedWakeAt: "2026-08-18T19:00:00.000Z"
        }
      })
    );
  });

  it("says an early start was a choice, and offers to take it back", () => {
    const onCancelManualBedtime = vi.fn();
    render(<SleepPanel {...props} manualBedtime sleepPanelDue={false} onCancelManualBedtime={onCancelManualBedtime} />);
    fireEvent.click(screen.getByRole("button", { name: "Not ready yet" }));
    expect(onCancelManualBedtime).toHaveBeenCalledTimes(1);
  });

  it("warns when a tentative commitment sits inside protected sleep", () => {
    render(<SleepPanel {...props} tentativeSleepConflict={{ ...state.commitments[0]!, status: "tentative" }} />);
    expect(screen.getByText(/conflicts with protected sleep/)).toBeTruthy();
  });

  it("labels the plan's own times during an early start instead of describing sleeping now", () => {
    const runActivityCommand = vi.fn().mockResolvedValue(undefined);
    const { container } = render(<SleepPanel {...earlyProps} runActivityCommand={runActivityCommand} />);
    const header = container.querySelector("p.time")!.textContent!;
    expect(header).not.toContain("For 468 minutes");
    expect(header).toMatch(/Planned sleep 8:45\spm – 4:33\sam \(468 minutes\) · bedtime in 8 h 3 m/);
    // The honest end time for the planned duration, so the planned wake above cannot be read as
    // "until" — and the reason the panel asks which sleep is meant rather than just starting one.
    const microcopy = screen.getByText(/would end around/).textContent!;
    expect(microcopy).toMatch(
      /planned 468 minutes, begun now, would end around 8:30\spm, not the planned 4:33\sam wake/
    );
    // Neither option is "the plan's 468 minutes", so the bare Start is gone with it.
    expect(screen.queryByRole("button", { name: "Start sleep" })).toBeNull();
    expect(runActivityCommand).not.toHaveBeenCalled();
  });

  it("offers a full night from settings or a nap that tops last night back up, when started early", () => {
    const runActivityCommand = vi.fn().mockResolvedValue(undefined);
    render(<SleepPanel {...earlyProps} runActivityCommand={runActivityCommand} />);
    // The full night is the desired sleep the settings carry (480), never the plan's own 468.
    expect(state.settings.desiredSleepMinutes).toBe(480);
    // No wakeConstraint on this plan, so nothing to name — the option is a plain full sleep.
    expect(screen.queryByText(/cuts this short/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Full sleep — 480 minutes, until 8:42\spm$/ }));
    expect(runActivityCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "start_activity",
        targetType: "sleep",
        targetId: "sleep-tonight",
        plannedMinutes: 480,
        expectedVersion: 2
      })
    );
    // The nap defaults to the top-up the model measured against that same desired amount.
    fireEvent.click(screen.getByRole("button", { name: /^Nap — 72 minutes, until 1:54\spm$/ }));
    expect(runActivityCommand).toHaveBeenLastCalledWith(expect.objectContaining({ plannedMinutes: 72 }));
  });

  it("offers the constrained-sleep duration and names the constraint, when it binds", () => {
    const runActivityCommand = vi.fn().mockResolvedValue(undefined);
    const bindingPlan: StoredSleepPlan = {
      ...earlyPlan,
      wakeConstraint: {
        commitmentId: "c-breakfast",
        title: "Eat Breakfast",
        protectedStartAt: new Date(earlyNow.getTime() + 300 * 60_000).toISOString()
      }
    };
    render(
      <SleepPanel
        {...earlyProps}
        sleepDue={bindingPlan}
        sleepConstrainedMinutes={300}
        runActivityCommand={runActivityCommand}
      />
    );
    const button = screen.getByRole("button", { name: /^Sleep until .* — 300 minutes$/ });
    expect(screen.getByText(/wake for Eat Breakfast/).textContent).toContain("cuts this short of the full 480 minutes");
    // Never the old flat label once the constraint has actually shortened the offer.
    expect(screen.queryByRole("button", { name: /^Full sleep/ })).toBeNull();
    fireEvent.click(button);
    expect(runActivityCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "start_activity",
        targetType: "sleep",
        targetId: "sleep-tonight",
        plannedMinutes: 300
      })
    );
  });

  it("offers the full desired sleep, un-shortened, when a wake constraint exists but sits far enough off", () => {
    const runActivityCommand = vi.fn().mockResolvedValue(undefined);
    // Matches The constraint is 951 minutes away, but the min() against the 480
    // desired keeps the offer at 480 — never the raw 951.
    const farPlan: StoredSleepPlan = {
      ...earlyPlan,
      wakeConstraint: {
        commitmentId: "c-uniform",
        title: "Prepare uniform",
        protectedStartAt: new Date(earlyNow.getTime() + 951 * 60_000).toISOString()
      }
    };
    render(
      <SleepPanel
        {...earlyProps}
        sleepDue={farPlan}
        sleepConstrainedMinutes={480}
        runActivityCommand={runActivityCommand}
      />
    );
    const button = screen.getByRole("button", { name: /^Full sleep — 480 minutes, until 8:42\spm$/ });
    expect(button.textContent).not.toContain("951");
    expect(screen.queryByText(/cuts this short/)).toBeNull();
    fireEvent.click(button);
    expect(runActivityCommand).toHaveBeenCalledWith(expect.objectContaining({ plannedMinutes: 480 }));
  });

  it("lets a typed nap length override the top-up it offered", () => {
    const runActivityCommand = vi.fn().mockResolvedValue(undefined);
    render(<SleepPanel {...earlyProps} runActivityCommand={runActivityCommand} />);
    fireEvent.change(screen.getByLabelText("Nap minutes"), { target: { value: "45" } });
    fireEvent.click(screen.getByRole("button", { name: /^Nap — 45 minutes, until 1:27\spm$/ }));
    expect(runActivityCommand).toHaveBeenCalledWith(expect.objectContaining({ plannedMinutes: 45 }));
  });

  it("asks for a nap length instead of guessing one when nothing is owed", () => {
    const runActivityCommand = vi.fn().mockResolvedValue(undefined);
    render(<SleepPanel {...earlyProps} sleepNapTopUpMinutes={undefined} runActivityCommand={runActivityCommand} />);
    const nap = screen.getByRole("button", { name: "Nap — set the minutes" });
    expect((nap as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByLabelText("Nap minutes").getAttribute("placeholder")).toBe("30");
    fireEvent.change(screen.getByLabelText("Nap minutes"), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: /^Nap — 20 minutes, until 1:02\spm$/ }));
    expect(runActivityCommand).toHaveBeenCalledWith(expect.objectContaining({ plannedMinutes: 20 }));
  });

  it("blames the wake constraint for a shifted wake, and a missed start only without one", () => {
    const constrained: StoredSleepPlan = {
      ...sleepDue,
      wakeConstraint: {
        commitmentId: "work",
        title: "Prepare uniform",
        protectedStartAt: sleepDue.plannedWakeAt
      }
    };
    const { unmount } = render(<SleepPanel {...props} sleepDue={constrained} wakeShiftMinutes={-87} />);
    const constrainedCopy = screen.getByText(/Your preferred wake/).textContent!;
    expect(constrainedCopy).toContain("Prepare uniform requires you to be available by");
    expect(constrainedCopy).not.toContain("missed start");
    unmount();
    render(<SleepPanel {...props} wakeShiftMinutes={30} />);
    expect(screen.getByText(/Your preferred wake/).textContent).toContain(
      "protected sleep duration takes priority after a missed start"
    );
  });

  it("warns about a night placed early and lets the user keep the near night instead", () => {
    const saveEntityCommand = vi.fn().mockResolvedValue(undefined);
    const earlyDeviationPlan: StoredSleepPlan = {
      ...sleepDue,
      wakeConstraint: {
        commitmentId: "c-shift",
        title: "Shift",
        protectedStartAt: "2026-08-19T21:00:00.000Z" // 7:00 am local
      },
      deviationOptions: {
        early: {
          startsAt: "2026-08-18T05:00:00.000Z", // 3:00 pm local
          wakesAt: "2026-08-19T21:00:00.000Z",
          minutes: 480
        },
        near: {
          startsAt: "2026-08-19T15:00:00.000Z", // 1:00 am local
          wakesAt: "2026-08-19T21:00:00.000Z",
          minutes: 360
        },
        warn: true
      }
    };
    render(<SleepPanel {...props} sleepDue={earlyDeviationPlan} saveEntityCommand={saveEntityCommand} />);
    expect(screen.getByText(/This night starts well before your usual bedtime/)).toBeTruthy();
    const warningText = screen.getByText(/To get 8 h before/).textContent!;
    expect(warningText).toContain("To get 8 h before Shift at 7:00 am, bed is at 3:00 pm.");
    expect(warningText).toContain("Or sleep 1:00 am–7:00 am for 6 h.");
    fireEvent.click(screen.getByRole("button", { name: "Keep this night" }));
    expect(saveEntityCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "save_entity",
        entityType: "sleep_plan",
        entity: { id: "sleep-tonight", placementChoice: "near" }
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "Go to bed early" }));
    expect(saveEntityCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({ entity: { id: "sleep-tonight", placementChoice: "early" } })
    );
  });

  it("does not show the deviation warning once the choice can no longer change anything", () => {
    render(
      <SleepPanel
        {...props}
        sleepDue={{
          ...sleepDue,
          deviationOptions: {
            early: { startsAt: sleepDue.plannedStartAt, wakesAt: sleepDue.plannedWakeAt, minutes: 480 },
            near: { startsAt: sleepDue.plannedStartAt, wakesAt: sleepDue.plannedWakeAt, minutes: 480 },
            warn: false
          }
        }}
      />
    );
    expect(screen.queryByText(/This night starts well before your usual bedtime/)).toBeNull();
  });

  it("shows the stay-up offer and accepts it as an override to tonight's plan", () => {
    const saveEntityCommand = vi.fn().mockResolvedValue(undefined);
    render(
      <SleepPanel
        {...props}
        saveEntityCommand={saveEntityCommand}
        stayUpOffer={{
          nightId: "sleep-tonight",
          projectId: "project-report",
          projectTitle: "Report",
          actionId: "action-draft",
          actionTitle: "Draft section 3",
          minutesBehind: 90,
          opensAt: sleepDue.plannedStartAt,
          closesAt: sleepDue.plannedWakeAt,
          choices: [
            {
              minutes: 30,
              bedtimeAt: "2026-08-18T10:30:00.000Z",
              wakeAt: sleepDue.plannedWakeAt,
              sleepMinutes: 450
            }
          ]
        }}
      />
    );
    expect(screen.getByText(/Report is behind\. Stay up to work on Draft section 3\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^30 min/ }));
    expect(saveEntityCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "save_entity",
        entityType: "sleep_plan",
        entity: {
          id: "sleep-tonight",
          plannedStartAt: "2026-08-18T10:30:00.000Z",
          plannedWakeAt: sleepDue.plannedWakeAt,
          stayUpAnswerMinutes: 30
        }
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "Not tonight" }));
    expect(saveEntityCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({ entity: { id: "sleep-tonight", stayUpAnswerMinutes: 0 } })
    );
  });
});
