import { describe, expect, it } from "vitest";
import {
  assumedNightsBeyondPlans,
  normalizePlanningSlots,
  planSchedule,
  recommend,
  resolvePlanningCapacity,
  slotFitsAction,
  type Action,
  type Project
} from "../../src/index.js";
import { holding } from "../model/situation.js";

const now = new Date("2026-08-10T00:00:00.000Z");
const end = new Date("2026-08-10T04:00:00.000Z");
// 00:00Z to 04:00Z is 10:00 to 14:00 in the seed zone, inside a single daily planning window.
const day = { timezone: "Australia/Sydney", dayStartTime: "07:00", dayEndTime: "22:00" };
const project: Project = {
  id: "project",
  status: "active",
  uncertainty: "known",
  externalDeadlineAt: end,
  value: 3,
  consequence: 3
};
const action = (energy: Action["energy"]): Action => ({
  id: `${energy}-action`,
  projectId: project.id,
  title: `${energy} work`,
  status: "active",
  expectedMinutes: 30,
  remainingMinutes: 30,
  pessimisticMinutes: 30,
  energy,
  minimumSessionMinutes: 15,
  maximumSessionMinutes: 30,
  importance: 3,
  consequence: 3,
  contexts: ["home"],
  dependenciesComplete: true
});

describe("capacity", () => {
  it("uses energy-unconfirmed automatic day windows", () => {
    const automatic = resolvePlanningCapacity({
      now,
      horizonEnd: end,
      usableFraction: 0.8,
      ...day
    });
    expect(automatic).toEqual([
      {
        id: "automatic:2026-08-10",
        startsAt: now,
        endsAt: end,
        energy: "unconfirmed",
        contexts: [],
        usableFraction: 0.8
      }
    ]);
  });

  it("discounts automatic free time and removes protected commitments once", () => {
    const capacity = resolvePlanningCapacity({
      now,
      horizonEnd: end,
      usableFraction: 0.8,
      ...day
    });
    const schedule = planSchedule({
      now,
      horizonEnd: end,
      projects: [project],
      actions: [action("high")],
      capacityWindows: capacity,
      commitments: [
        { id: "fixed", startsAt: new Date("2026-08-10T01:00:00.000Z"), endsAt: new Date("2026-08-10T02:00:00.000Z") }
      ]
    });
    expect(schedule.slots.reduce((sum, slot) => sum + slot.capacityMinutes, 0)).toBe(144);
    expect(schedule.forecasts[0]?.reasons).toContain(
      "Time capacity is calculated, but future energy suitability is unconfirmed."
    );
  });

  it("uses reported energy to filter Now without restricting the future time forecast", () => {
    const capacity = resolvePlanningCapacity({
      now,
      horizonEnd: end,
      usableFraction: 0.85,
      ...day
    });
    const high = action("high");
    const low = action("low");
    const result = recommend({
      now,
      horizonEnd: end,
      projects: [project],
      actions: [high, low],
      capacityWindows: capacity,
      commitments: [],
      ...holding("home"),
      currentEnergy: "low"
    });
    expect(result.candidates.find((item) => item.action.id === high.id)?.exclusionReasons).toContain(
      "Current energy is low; this action requires high."
    );
    expect(result.primary?.action.id).toBe(low.id);
  });

  it("treats a planned action as ready for recommendation", () => {
    const capacity = resolvePlanningCapacity({
      now,
      horizonEnd: end,
      usableFraction: 0.85,
      ...day
    });
    const planned = { ...action("low"), status: "planned" as const };
    const result = recommend({
      now,
      horizonEnd: end,
      projects: [project],
      actions: [planned],
      capacityWindows: capacity,
      commitments: [],
      ...holding("home"),
      currentEnergy: "low"
    });
    expect(result.primary?.action.id).toBe(planned.id);
  });

  it("explains the nearest active candidate when nothing fits", () => {
    const capacity = resolvePlanningCapacity({
      now,
      horizonEnd: end,
      usableFraction: 0.85,
      ...day
    });
    const inactive = { ...action("low"), id: "inactive", status: "done" as const };
    const active = { ...action("high"), id: "active", contexts: ["campus"] };
    const result = recommend({
      now,
      horizonEnd: end,
      projects: [project],
      actions: [inactive, active],
      capacityWindows: capacity,
      commitments: [],
      ...holding("home"),
      currentEnergy: "low"
    });
    expect(result.primary).toBeNull();
    expect(result.explanation).toBe("Missing context: campus.");
    expect(result.evidence).toContain("Current energy is low; this action requires high.");
    expect(result.evidence).not.toContain("Action is not ready to work on.");
  });

  // Automatic windows always carry `contexts: []` (asserted above: the literal fixture has
  // `contexts: []`). The scheduling admission matcher (`slots.ts`'s `evaluateAdmission`) treats a
  // window's empty context list as "nothing declared, so unknown", and unknown is permissive there —
  // never a window's own `no`. This ties that guarantee directly to what automatic mode actually
  // produces, rather than only to a hand-built empty window (`matcher-parity.test.ts`), so a future
  // change that makes automatic windows declare something can't silently start excluding context-gated
  // work from the schedule without a test noticing.
  it("never excludes a context-requiring action from an automatic window on account of its (always empty) contexts", () => {
    const automatic = resolvePlanningCapacity({
      now,
      horizonEnd: end,
      usableFraction: 1,
      ...day
    });
    expect(automatic.every((window) => window.contexts?.length === 0)).toBe(true);
    const needsCampus = { ...action("high"), id: "needs-campus", contexts: ["campus"] };
    const slots = normalizePlanningSlots({ from: now, until: end, capacityWindows: automatic, commitments: [] });
    expect(slots.some((slot) => slotFitsAction(slot, needsCampus))).toBe(true);
  });
});

// Capacity is now every hour not spent asleep, so the automatic window spans the whole local day and
// sleep is subtracted as a commitment. That only stays honest if nights past the planned run are
// assumed: sleep is planned a week out while forecasts run for months, and without a stand-in night
// every distant project would be credited twenty-four usable hours a day.
describe("assumed nights beyond the planned sleep run", () => {
  const settings = { timezone: "Australia/Sydney", preferredBedtime: "20:50", preferredWakeTime: "06:00" };
  const state = { settings } as never as Parameters<typeof assumedNightsBeyondPlans>[0];
  const from = new Date("2026-08-17T00:00:00.000Z");

  it("covers every night from the last planned wake to the horizon", () => {
    const horizonEnd = new Date("2026-08-27T00:00:00.000Z");
    const nights = assumedNightsBeyondPlans(state, [], from, horizonEnd);
    expect(nights.length).toBeGreaterThanOrEqual(9);
    for (const night of nights) {
      expect(night.endsAt.getTime() - night.startsAt.getTime()).toBe(9 * 60 * 60_000 + 10 * 60_000); // 20:50 -> 06:00
      expect(night.startsAt.getTime()).toBeGreaterThanOrEqual(from.getTime());
      expect(night.startsAt.getTime()).toBeLessThan(horizonEnd.getTime());
    }
    // One per local night, none doubled up.
    expect(new Set(nights.map((night) => night.id)).size).toBe(nights.length);
  });

  it("does not assume a night the planner has already planned", () => {
    const plannedWake = new Date("2026-08-24T20:00:00.000Z"); // 25 Aug 6:00am local
    const nights = assumedNightsBeyondPlans(
      state,
      [{ plannedStartAt: new Date("2026-08-24T10:50:00.000Z"), plannedWakeAt: plannedWake }] as never,
      from,
      new Date("2026-08-30T00:00:00.000Z")
    );
    expect(nights.every((night) => night.startsAt >= plannedWake)).toBe(true);
  });

  describe("a known commitment past the planned run", () => {
    const sleepSettings = {
      timezone: "Australia/Sydney",
      preferredBedtime: "22:30",
      preferredWakeTime: "06:30",
      desiredSleepMinutes: 480,
      minimumSleepMinutes: 360,
      maxAwakeHours: 18,
      bedtimeDeviationMinutes: 60,
      arrivalMarginMinutes: 0
    };
    const sleepState = { settings: sleepSettings } as never as Parameters<typeof assumedNightsBeyondPlans>[0];
    // seed-zone is UTC+10 in August: the shift is 22:00 on the 21st to 06:00 on the 22nd local.
    const shift = {
      id: "night-shift",
      title: "Night shift",
      startsAt: new Date("2026-08-21T12:00:00.000Z"),
      endsAt: new Date("2026-08-21T20:00:00.000Z")
    };
    const nights = assumedNightsBeyondPlans(sleepState, [], from, new Date("2026-08-27T00:00:00.000Z"), [
      shift
    ] as never);
    const overlapsShift = (night: { startsAt: Date; endsAt: Date }) =>
      night.startsAt < shift.endsAt && night.endsAt > shift.startsAt;

    it("never puts a bed on top of the shift", () => {
      expect(nights.some(overlapsShift)).toBe(false);
    });

    it("sleeps in the daytime after the shift and leaves other nights alone", () => {
      const after = nights.find(
        (night) => night.startsAt >= shift.endsAt && night.startsAt.getTime() < shift.endsAt.getTime() + 4 * 3_600_000
      );
      expect(after).toBeDefined();
      expect(after!.endsAt.getTime() - after!.startsAt.getTime()).toBeGreaterThanOrEqual(360 * 60_000);
      const ordinary = nights.filter((night) => night.id === "assumed-sleep:2026-08-19");
      expect(ordinary[0]!.endsAt.getTime() - ordinary[0]!.startsAt.getTime()).toBe(8 * 3_600_000);
    });
  });

  describe("a night moved before a night shift", () => {
    it("carries the moved wake into the next night so the awake limit holds", () => {
      const settings = {
        timezone: "Australia/Sydney",
        preferredBedtime: "22:30",
        preferredWakeTime: "06:30",
        desiredSleepMinutes: 480,
        minimumSleepMinutes: 360,
        maxAwakeHours: 18,
        bedtimeDeviationMinutes: 60,
        arrivalMarginMinutes: 0
      };
      // 22:00 on the 21st to 07:00 on the 22nd local (UTC+10): the night of the 21st sleeps 14:00-22:00.
      const shift = {
        id: "night-shift",
        title: "Night shift",
        startsAt: new Date("2026-08-21T12:00:00.000Z"),
        endsAt: new Date("2026-08-21T21:00:00.000Z")
      };
      const nights = assumedNightsBeyondPlans(
        { settings } as never as Parameters<typeof assumedNightsBeyondPlans>[0],
        [],
        from,
        new Date("2026-08-27T00:00:00.000Z"),
        [shift] as never
      );
      const before = nights.find(
        (night) => night.endsAt <= shift.startsAt && night.endsAt > new Date("2026-08-21T00:00:00.000Z")
      );
      expect(before).toBeDefined();
      const maxAwakeMs = 18 * 3_600_000;
      for (let index = 1; index < nights.length; index += 1)
        expect(nights[index]!.startsAt.getTime() - nights[index - 1]!.endsAt.getTime()).toBeLessThanOrEqual(maxAwakeMs);
    });
  });

  describe("sleep moved ahead of a night shift", () => {
    it("covers every horizon date with exactly one assumed night and leaves no gap", () => {
      const settings = {
        timezone: "Australia/Sydney",
        preferredBedtime: "22:30",
        preferredWakeTime: "06:30",
        desiredSleepMinutes: 480,
        minimumSleepMinutes: 360,
        maxAwakeHours: 18,
        bedtimeDeviationMinutes: 60,
        arrivalMarginMinutes: 0
      };
      // 22:00 on the 21st to 07:00 on the 22nd local (UTC+10).
      const shift = {
        id: "night-shift",
        title: "Night shift",
        startsAt: new Date("2026-08-21T12:00:00.000Z"),
        endsAt: new Date("2026-08-21T21:00:00.000Z")
      };
      const nights = assumedNightsBeyondPlans(
        { settings } as never as Parameters<typeof assumedNightsBeyondPlans>[0],
        [],
        from,
        new Date("2026-08-27T00:00:00.000Z"),
        [shift] as never
      );
      const ids = nights.map((night) => night.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (let index = 1; index < nights.length; index += 1) {
        expect(nights[index]!.startsAt.getTime()).toBeGreaterThanOrEqual(nights[index - 1]!.endsAt.getTime());
        // No gap in the run: the awake stretch between nights never exceeds the limit.
        expect(nights[index]!.startsAt.getTime() - nights[index - 1]!.endsAt.getTime()).toBeLessThanOrEqual(
          18 * 3_600_000
        );
      }
      // Every local day from the 22nd to the 26th has a night that starts or ends on it.
      const day = (date: Date) => date.toLocaleDateString("en-CA", { timeZone: "Australia/Sydney" });
      for (const date of ["2026-08-22", "2026-08-23", "2026-08-24", "2026-08-25", "2026-08-26"]) {
        const covering = nights.filter((night) => day(night.startsAt) === date || day(night.endsAt) === date);
        expect(covering.length, date).toBeGreaterThanOrEqual(1);
      }
      const startDays = nights.map((night) => day(night.startsAt));
      expect(startDays).toContain("2026-08-26");
    });
  });

  describe("a re-plan forced by the awake limit", () => {
    it("keeps every gap between assumed nights within maxAwakeHours", () => {
      const settings = {
        timezone: "Australia/Sydney",
        preferredBedtime: "22:30",
        preferredWakeTime: "06:30",
        desiredSleepMinutes: 480,
        minimumSleepMinutes: 360,
        maxAwakeHours: 18,
        bedtimeDeviationMinutes: 60,
        arrivalMarginMinutes: 0
      };
      // 01:00-06:00 local on the 21st (UTC+10) lies inside the night of the 20th.
      const early = {
        id: "early-start",
        title: "Early start",
        startsAt: new Date("2026-08-20T15:00:00.000Z"),
        endsAt: new Date("2026-08-20T20:00:00.000Z")
      };
      const nights = assumedNightsBeyondPlans(
        { settings } as never as Parameters<typeof assumedNightsBeyondPlans>[0],
        [],
        from,
        new Date("2026-08-27T00:00:00.000Z"),
        [early] as never
      );
      expect(nights.length).toBeGreaterThan(3);
      for (let index = 1; index < nights.length; index += 1) {
        expect(nights[index]!.startsAt.getTime()).toBeGreaterThanOrEqual(nights[index - 1]!.endsAt.getTime());
        expect(nights[index]!.startsAt.getTime() - nights[index - 1]!.endsAt.getTime()).toBeLessThanOrEqual(
          18 * 3_600_000
        );
      }
    });
  });

  describe("a moved night that starts inside the horizon", () => {
    it("is emitted even when the preferred bedtime falls past the horizon end", () => {
      const settings = {
        timezone: "Australia/Sydney",
        preferredBedtime: "22:30",
        preferredWakeTime: "06:30",
        desiredSleepMinutes: 480,
        minimumSleepMinutes: 360,
        maxAwakeHours: 18,
        bedtimeDeviationMinutes: 60,
        arrivalMarginMinutes: 0
      };
      const shift = {
        id: "night-shift",
        title: "Night shift",
        startsAt: new Date("2026-08-21T12:00:00.000Z"),
        endsAt: new Date("2026-08-21T21:00:00.000Z")
      };
      // Horizon ends 20:00 local on the 21st (10:00Z), before the 22:30 preferred bedtime.
      const horizonEnd = new Date("2026-08-21T10:00:00.000Z");
      const nights = assumedNightsBeyondPlans(
        { settings } as never as Parameters<typeof assumedNightsBeyondPlans>[0],
        [],
        from,
        horizonEnd,
        [shift] as never
      );
      const moved = nights.find((night) => night.startsAt.toISOString() === "2026-08-21T04:00:00.000Z");
      expect(moved).toBeDefined();
      expect(moved!.endsAt.toISOString()).toBe("2026-08-21T12:00:00.000Z");
    });
  });

  describe("back-to-back night shifts past the planned run", () => {
    it("chains each assumed night from the previous one without overlap", () => {
      const settings = {
        timezone: "Australia/Sydney",
        preferredBedtime: "22:30",
        preferredWakeTime: "06:30",
        desiredSleepMinutes: 480,
        minimumSleepMinutes: 360,
        maxAwakeHours: 18,
        bedtimeDeviationMinutes: 60,
        arrivalMarginMinutes: 0
      };
      const shifts = [
        {
          id: "shift-1",
          title: "Night 1",
          startsAt: new Date("2026-08-21T12:00:00.000Z"),
          endsAt: new Date("2026-08-21T20:00:00.000Z")
        },
        {
          id: "shift-2",
          title: "Night 2",
          startsAt: new Date("2026-08-22T11:00:00.000Z"),
          endsAt: new Date("2026-08-22T21:00:00.000Z")
        }
      ];
      const nights = assumedNightsBeyondPlans(
        { settings } as never as Parameters<typeof assumedNightsBeyondPlans>[0],
        [],
        from,
        new Date("2026-08-27T00:00:00.000Z"),
        shifts as never
      );
      for (let index = 1; index < nights.length; index += 1)
        expect(nights[index]!.startsAt.getTime()).toBeGreaterThanOrEqual(nights[index - 1]!.endsAt.getTime());
      for (const night of nights)
        for (const shift of shifts) expect(night.startsAt < shift.endsAt && night.endsAt > shift.startsAt).toBe(false);
    });
  });

  describe("protected recovery window", () => {
    // Friday 14 August in the seed zone is UTC+10; 13:00 local is 03:00Z.
    const fridayStart = new Date("2026-08-13T14:00:00.000Z");
    const saturdayEnd = new Date("2026-08-15T14:00:00.000Z");
    const base = { now: fridayStart, horizonEnd: saturdayEnd, usableFraction: 1, timezone: "Australia/Sydney" };
    const whole = { dayStartTime: "00:00", dayEndTime: "00:00" };
    const recovery = { startTime: "13:00", endTime: "14:00", weekdays: [5] };

    it("partitions a matching weekday and leaves other days whole", () => {
      const windows = resolvePlanningCapacity({ ...base, ...whole, recovery });
      expect(
        windows.map((window) => [window.id, window.energy, window.startsAt.toISOString(), window.endsAt.toISOString()])
      ).toEqual([
        ["automatic:2026-08-14", "unconfirmed", "2026-08-13T14:00:00.000Z", "2026-08-14T03:00:00.000Z"],
        ["recovery:2026-08-14", "recovery", "2026-08-14T03:00:00.000Z", "2026-08-14T04:00:00.000Z"],
        ["automatic:2026-08-14:after", "unconfirmed", "2026-08-14T04:00:00.000Z", "2026-08-14T14:00:00.000Z"],
        ["automatic:2026-08-15", "unconfirmed", "2026-08-14T14:00:00.000Z", "2026-08-15T14:00:00.000Z"]
      ]);
    });

    it("clips the window at now and drops it once past", () => {
      const during = resolvePlanningCapacity({
        ...base,
        ...whole,
        recovery,
        now: new Date("2026-08-14T03:30:00.000Z")
      });
      expect(during[0]).toMatchObject({ id: "recovery:2026-08-14", startsAt: new Date("2026-08-14T03:30:00.000Z") });
      const after = resolvePlanningCapacity({ ...base, ...whole, recovery, now: new Date("2026-08-14T05:00:00.000Z") });
      expect(after.map((window) => window.id)).toEqual(["automatic:2026-08-14:after", "automatic:2026-08-15"]);
    });

    it("keeps a skipped date whole", () => {
      const windows = resolvePlanningCapacity({
        ...base,
        ...whole,
        recovery: { ...recovery, skippedDate: "2026-08-14" }
      });
      expect(windows.map((window) => window.id)).toEqual(["automatic:2026-08-14", "automatic:2026-08-15"]);
    });

    describe("overnight window", () => {
      const overnight = { startTime: "23:00", endTime: "06:00", weekdays: [5] };
      const spans = (windows: ReturnType<typeof resolvePlanningCapacity>) =>
        windows.map((window) => [window.id, window.energy, window.startsAt.toISOString(), window.endsAt.toISOString()]);

      it("runs to the next morning and spills into the next day's window", () => {
        const windows = resolvePlanningCapacity({ ...base, ...whole, recovery: overnight });
        expect(spans(windows)).toEqual([
          ["automatic:2026-08-14", "unconfirmed", "2026-08-13T14:00:00.000Z", "2026-08-14T13:00:00.000Z"],
          ["recovery:2026-08-14", "recovery", "2026-08-14T13:00:00.000Z", "2026-08-14T14:00:00.000Z"],
          ["recovery:2026-08-15:spill", "recovery", "2026-08-14T14:00:00.000Z", "2026-08-14T20:00:00.000Z"],
          ["automatic:2026-08-15:after", "unconfirmed", "2026-08-14T20:00:00.000Z", "2026-08-15T14:00:00.000Z"]
        ]);
      });

      it("drops the spill with the skipped start date", () => {
        const windows = resolvePlanningCapacity({
          ...base,
          ...whole,
          recovery: { ...overnight, skippedDate: "2026-08-14" }
        });
        expect(windows.map((window) => window.id)).toEqual(["automatic:2026-08-14", "automatic:2026-08-15"]);
      });

      it("drops the spill when the start date is among the skipped dates", () => {
        const windows = resolvePlanningCapacity({
          ...base,
          ...whole,
          recovery: { ...overnight, skippedDates: ["2026-08-14"] }
        });
        expect(windows.map((window) => window.id)).toEqual(["automatic:2026-08-14", "automatic:2026-08-15"]);
      });

      it("only spills on the day after a matching weekday", () => {
        // Saturday's window starts a recovery that spills into Sunday, but Friday's spills into Saturday only.
        const saturdayOnly = resolvePlanningCapacity({
          ...base,
          ...whole,
          recovery: { ...overnight, weekdays: [6] },
          horizonEnd: new Date("2026-08-16T14:00:00.000Z")
        });
        expect(saturdayOnly.map((window) => window.id)).toEqual([
          "automatic:2026-08-14",
          "automatic:2026-08-15",
          "recovery:2026-08-15",
          "recovery:2026-08-16:spill",
          "automatic:2026-08-16:after"
        ]);
      });

      it("keeps the real elapsed time across the spring-forward night", () => {
        // seed-zone clocks jump 02:00 to 03:00 on Sunday 4 Oct 2026, so Saturday 23:00 to 06:00 is six hours.
        const windows = resolvePlanningCapacity({
          now: new Date("2026-10-02T14:00:00.000Z"),
          horizonEnd: new Date("2026-10-04T13:00:00.000Z"),
          usableFraction: 1,
          timezone: "Australia/Sydney",
          ...whole,
          recovery: { startTime: "23:00", endTime: "06:00", weekdays: [6] }
        });
        const night = windows.filter((window) => window.energy === "recovery");
        expect(spans(night)).toEqual([
          ["recovery:2026-10-03", "recovery", "2026-10-03T13:00:00.000Z", "2026-10-03T14:00:00.000Z"],
          ["recovery:2026-10-04:spill", "recovery", "2026-10-03T14:00:00.000Z", "2026-10-03T19:00:00.000Z"]
        ]);
        const total = windows.reduce((sum, window) => sum + (window.endsAt.getTime() - window.startsAt.getTime()), 0);
        expect(total).toBe(47 * 3_600_000);
      });

      it("keeps a same-day window that the spring-forward gap swallows from becoming a whole day", () => {
        // 02:00 to 03:00 on Sunday 4 Oct 2026 does not exist in the seed zone, so both ends resolve to one instant.
        const windows = resolvePlanningCapacity({
          now: new Date("2026-10-03T13:00:00.000Z"),
          horizonEnd: new Date("2026-10-05T13:00:00.000Z"),
          usableFraction: 1,
          timezone: "Australia/Sydney",
          ...whole,
          recovery: { startTime: "02:00", endTime: "03:00", weekdays: [0] }
        });
        const recovered = windows
          .filter((window) => window.energy === "recovery")
          .reduce((sum, window) => sum + (window.endsAt.getTime() - window.startsAt.getTime()), 0);
        expect(recovered).toBeLessThanOrEqual(3_600_000);
      });

      it("keeps the real elapsed time across the fall-back night", () => {
        // Clocks return 03:00 to 02:00 on Sunday 5 Apr 2026, so Saturday 23:00 to 06:00 is eight hours.
        const windows = resolvePlanningCapacity({
          now: new Date("2026-04-03T13:00:00.000Z"),
          horizonEnd: new Date("2026-04-05T14:00:00.000Z"),
          usableFraction: 1,
          timezone: "Australia/Sydney",
          ...whole,
          recovery: { startTime: "23:00", endTime: "06:00", weekdays: [6] }
        });
        const recoveryMinutes = windows
          .filter((window) => window.energy === "recovery")
          .reduce((sum, window) => sum + (window.endsAt.getTime() - window.startsAt.getTime()) / 60_000, 0);
        expect(recoveryMinutes).toBe(8 * 60);
      });
    });

    it("never changes the day's total minutes", () => {
      const minutes = (windows: ReturnType<typeof resolvePlanningCapacity>) =>
        windows.reduce((sum, window) => sum + (window.endsAt.getTime() - window.startsAt.getTime()), 0);
      expect(minutes(resolvePlanningCapacity({ ...base, ...whole, recovery }))).toBe(
        minutes(resolvePlanningCapacity({ ...base, ...whole }))
      );
    });
  });
});
