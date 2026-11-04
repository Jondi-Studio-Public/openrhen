import { describe, expect, it } from "vitest";
import { createSeedState, type StoredAction, type StoredRecurrenceRule } from "@/state/portal-state";
import {
  bandLabel,
  cadenceDoneToday,
  dateInput,
  dateOnly,
  dateValue,
  formatMinutes,
  healthChipClass,
  healthChipText,
  localiseReason,
  recurrenceSummary
} from "@/features/plan/plan-formatting";

const seedAction = () => createSeedState(new Date("2026-08-18T09:00:00.000Z")).actions[0]!;
const recurrence = (overrides: Partial<StoredRecurrenceRule>): StoredRecurrenceRule => ({
  id: "rule",
  actionId: "action",
  timezone: "Australia/Sydney",
  startDate: "2026-08-01",
  intervalDays: 1,
  completionMode: "end_date",
  accumulatedMinutes: 0,
  windows: [{ id: "morning", name: "Morning", anchor: "wake" }],
  ...overrides
});
const recurring = (rule: StoredRecurrenceRule): StoredAction => ({
  ...seedAction(),
  schedulingMode: "recurring",
  recurrence: rule
});

const SEED_ZONE = "Australia/Sydney";

describe("plan formatting", () => {
  it("round-trips a datetime-local value through the stored instant, in the planning zone", () => {
    const stored = dateValue("2026-08-18T10:30", SEED_ZONE);
    expect(stored).toBeDefined();
    expect(dateInput(stored, SEED_ZONE)).toBe("2026-08-18T10:30");
  });

  it("treats an absent date as an empty input rather than an invalid one", () => {
    expect(dateInput(undefined, SEED_ZONE)).toBe("");
    expect(dateValue("", SEED_ZONE)).toBeUndefined();
  });

  it("reduces an instant to the calendar day a recurrence starts on, in the planning zone (finding 30)", () => {
    // 2026-08-18T23:59:00Z is already 2026-08-19, 09:59am in the seed zone (AEST, +10).
    expect(dateOnly(new Date("2026-08-18T23:59:00.000Z"), SEED_ZONE)).toBe("2026-08-19");
    expect(dateOnly(new Date("2026-08-18T23:59:00.000Z"), "UTC")).toBe("2026-08-18");
  });

  it("names the known forecast bands and passes an unknown one through unchanged", () => {
    expect(bandLabel("detailed")).toBe("Days 0–7 · exact times");
    expect(bandLabel("weekly")).toBe("Days 15–30 · by week");
    expect(bandLabel("annual")).toBe("annual");
  });

  it("switches from minutes to hours at two hours and drops the decimal past a hundred", () => {
    expect(formatMinutes(119)).toBe("119 min");
    expect(formatMinutes(150)).toBe("2.5 hr");
    expect(formatMinutes(6000)).toBe("100 hr");
  });

  it("says nothing about recurrence for a one-off action", () => {
    expect(recurrenceSummary(seedAction())).toBe("");
  });

  it("reports a met goal ahead of the rule that would otherwise describe it", () => {
    const rule = recurrence({
      completionMode: "total_minutes",
      targetTotalMinutes: 600,
      accumulatedMinutes: 600,
      completedAt: "2026-08-18T09:00:00.000Z"
    });
    expect(recurrenceSummary(recurring(rule))).toBe(" · goal complete");
  });

  it("counts a total-time goal in whole hours", () => {
    const rule = recurrence({ completionMode: "total_minutes", targetTotalMinutes: 600, accumulatedMinutes: 90 });
    expect(recurrenceSummary(recurring(rule))).toBe(" · recurring until 2h of 10h");
  });

  it("summarises cadence by interval, last completion, and how overdue it is", () => {
    // 18 August, mid-morning in the seed zone.
    const now = new Date("2026-08-17T23:00:00.000Z");
    const practice = (overrides: Partial<StoredRecurrenceRule>): StoredAction => ({
      ...seedAction(),
      schedulingMode: "cadence",
      recurrence: recurrence({ completionMode: "manual", windows: [], ...overrides })
    });
    expect(recurrenceSummary(practice({ intervalDays: 1, lastCompletedLocalDate: "2026-08-17" }), now)).toBe(
      " · every day · last done 17 Aug · due today"
    );
    expect(recurrenceSummary(practice({ intervalDays: 3, lastCompletedLocalDate: "2026-08-13" }), now)).toBe(
      " · every 3 days · last done 13 Aug · 2 days overdue"
    );
    expect(recurrenceSummary(practice({ intervalDays: 3, lastCompletedLocalDate: "2026-08-17" }), now)).toBe(
      " · every 3 days · last done 17 Aug · due 20 Aug"
    );
    expect(recurrenceSummary(practice({ intervalDays: 1, lastCompletedLocalDate: "2026-08-18" }), now)).toBe(
      " · every day · done today"
    );
    expect(recurrenceSummary(practice({ intervalDays: 2, startDate: "2026-08-18" }), now)).toBe(
      " · every 2 days · never done · due today"
    );
    expect(
      recurrenceSummary(
        practice({ intervalDays: 1, completionMode: "total_minutes", targetTotalMinutes: 600, accumulatedMinutes: 90 }),
        now
      )
    ).toBe(" · every day · never done · 17 days overdue · 2h of 10h");
  });

  it("summarises a period rule by target and last completion, not the plain-interval sentence", () => {
    const now = new Date("2026-08-17T23:00:00.000Z");
    const practice = (overrides: Partial<StoredRecurrenceRule>): StoredAction => ({
      ...seedAction(),
      schedulingMode: "cadence",
      recurrence: recurrence({ completionMode: "manual", windows: [], ...overrides })
    });
    expect(
      recurrenceSummary(
        practice({ period: { unit: "days", length: 7 }, targetOccurrences: 2, lastCompletedLocalDate: "2026-08-13" }),
        now
      )
    ).toBe(" · 2 times within each 7-day block · last done 13 Aug");
    expect(recurrenceSummary(practice({ period: { unit: "month" }, targetOccurrences: 1 }), now)).toBe(
      " · once within a calendar month · never done"
    );
  });

  it("distinguishes a manual series from one with an end date", () => {
    expect(recurrenceSummary(recurring(recurrence({ completionMode: "manual" })))).toBe(
      " · recurring until marked complete"
    );
    expect(recurrenceSummary(recurring(recurrence({ endDate: "2026-10-01" })))).toBe(" · recurring through 2026-10-01");
  });

  it("shows a forecast reason's ISO instants as the planning timezone's date and time", () => {
    expect(
      localiseReason("683 gross compatible minutes are projected before 2026-10-29T06:00:00.000Z.", "Australia/Sydney")
    ).toBe("683 gross compatible minutes are projected before 29 Oct 2026, 5:00 pm.");
    expect(localiseReason("Required pace is 908 minutes per week.", "Australia/Sydney")).toBe(
      "Required pace is 908 minutes per week."
    );
  });

  it("labels the health chip plainly when nothing is overdue", () => {
    expect(healthChipText({ health: "at_risk" })).toBe("at risk");
    expect(healthChipText(undefined)).toBe("not forecast");
    expect(healthChipClass({ health: "at_risk" })).toBe("health at_risk");
    expect(healthChipClass(undefined)).toBe("health unknown");
  });

  it("reads a truthfully unknown-and-overdue forecast as overdue outright", () => {
    expect(healthChipText({ health: "unknown", overdue: true })).toBe("overdue");
    expect(healthChipClass({ health: "unknown", overdue: true })).toBe("health unknown overdue");
  });

  it("reads a lapsed self-set date as stale, not overdue, but an external one stays overdue", () => {
    const internal = { health: "behind", overdue: true, proposal: { deadlineOwner: "internal" } };
    expect(healthChipText(internal)).toBe("behind · date lapsed");
    expect(healthChipClass(internal)).toBe("health behind");
    const external = { health: "behind", overdue: true, proposal: { deadlineOwner: "external" } };
    expect(healthChipText(external)).toBe("behind · overdue");
    expect(healthChipClass(external)).toBe("health behind overdue");
  });

  it("appends overdue to a health that already had one", () => {
    expect(healthChipText({ health: "behind", overdue: true })).toBe("behind · overdue");
    expect(healthChipClass({ health: "behind", overdue: true })).toBe("health behind overdue");
  });

  it("shows a maintenance project's real adherence health, not the engine's own unknown", () => {
    const maintenance = { health: "unknown", healthBasis: "adherence", adherence: { health: "at_risk" } };
    expect(healthChipText(maintenance)).toBe("at risk");
    expect(healthChipClass(maintenance)).toBe("health at_risk");
  });

  it("still reads the ordinary health when healthBasis is feasibility, even with an adherence field present", () => {
    const feasibility = { health: "on_track", healthBasis: "feasibility", adherence: { health: "behind" } };
    expect(healthChipText(feasibility)).toBe("on track");
  });

  it("says a cadence is done today only once its local day has been ticked", () => {
    const now = new Date("2026-08-18T09:00:00.000Z");
    const practice = (lastCompletedLocalDate?: string): StoredAction => ({
      ...seedAction(),
      schedulingMode: "cadence",
      recurrence: recurrence({
        completionMode: "manual",
        windows: [],
        ...(lastCompletedLocalDate ? { lastCompletedLocalDate } : {})
      })
    });
    expect(cadenceDoneToday(practice(), now)).toBe(false);
    expect(cadenceDoneToday(practice("2026-08-17"), now)).toBe(false);
    expect(cadenceDoneToday(practice("2026-08-18"), now)).toBe(true);
  });
});
