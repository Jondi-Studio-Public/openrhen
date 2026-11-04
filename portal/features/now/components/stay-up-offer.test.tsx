// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { StoredSleepPlan } from "@/state/portal-state";
import { fireEvent, render, screen } from "@/test/render";
import { StayUpOffer } from "./stay-up-offer";

const sleepDue: StoredSleepPlan = {
  id: "sleep-tonight",
  version: 2,
  plannedStartAt: "2026-08-18T10:00:00.000Z",
  plannedWakeAt: "2026-08-18T18:00:00.000Z",
  desiredMinutes: 480,
  allowedMinutes: 480,
  sleepDeficitMinutes: 0,
  anchorDeviationMinutes: 0,
  hardErrors: [],
  explanation: "Sleep is due now.",
  status: "planned"
};

const offer = {
  nightId: "sleep-tonight",
  projectId: "project-report",
  projectTitle: "Report",
  actionId: "action-draft",
  actionTitle: "Draft section 3",
  minutesBehind: 90,
  opensAt: sleepDue.plannedStartAt,
  closesAt: sleepDue.plannedWakeAt,
  choices: [
    { minutes: 30, bedtimeAt: "2026-08-18T10:30:00.000Z", wakeAt: sleepDue.plannedWakeAt, sleepMinutes: 450 },
    { minutes: 60, bedtimeAt: "2026-08-18T11:00:00.000Z", wakeAt: sleepDue.plannedWakeAt, sleepMinutes: 420 }
  ]
};

describe("StayUpOffer", () => {
  it("names the behind project and its top action, once per choice", () => {
    render(
      <StayUpOffer
        offer={offer}
        sleepDue={sleepDue}
        timezone="Australia/Sydney"
        saving={false}
        saveEntityCommand={vi.fn().mockResolvedValue(undefined)}
      />
    );
    expect(screen.getByText("Report is behind. Stay up to work on Draft section 3?")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^30 min/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^60 min/ })).toBeTruthy();
  });

  it("accepts a choice as an override of tonight's bedtime and wake, never the wake", () => {
    const saveEntityCommand = vi.fn().mockResolvedValue(undefined);
    render(
      <StayUpOffer
        offer={offer}
        sleepDue={sleepDue}
        timezone="Australia/Sydney"
        saving={false}
        saveEntityCommand={saveEntityCommand}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /^60 min/ }));
    expect(saveEntityCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "save_entity",
        entityType: "sleep_plan",
        expectedVersion: 2,
        entity: {
          id: "sleep-tonight",
          plannedStartAt: "2026-08-18T11:00:00.000Z",
          plannedWakeAt: sleepDue.plannedWakeAt,
          stayUpAnswerMinutes: 60
        }
      })
    );
  });

  it("records a decline as zero minutes, leaving tonight's plan untouched", () => {
    const saveEntityCommand = vi.fn().mockResolvedValue(undefined);
    render(
      <StayUpOffer
        offer={offer}
        sleepDue={sleepDue}
        timezone="Australia/Sydney"
        saving={false}
        saveEntityCommand={saveEntityCommand}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Not tonight" }));
    expect(saveEntityCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "save_entity",
        entityType: "sleep_plan",
        entity: { id: "sleep-tonight", stayUpAnswerMinutes: 0 }
      })
    );
  });

  it("disables every button while a save is in flight", () => {
    render(
      <StayUpOffer
        offer={offer}
        sleepDue={sleepDue}
        timezone="Australia/Sydney"
        saving
        saveEntityCommand={vi.fn().mockResolvedValue(undefined)}
      />
    );
    for (const button of screen.getAllByRole("button")) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
