import { commitmentOccurrenceId } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";
import {
  occurrenceId,
  resolveCommitmentRecurrenceRepeats,
  resolveRecurrenceOccurrences,
  type ActionRecurrenceRule,
  type CommitmentRecurrenceRule
} from "../../src/index.js";

const rule: ActionRecurrenceRule = {
  id: "dental",
  actionId: "dental-action",
  timezone: "Australia/Sydney",
  startDate: "2026-08-10",
  endDate: "2026-10-04",
  intervalDays: 1,
  windows: [
    {
      id: "morning",
      name: "Morning",
      anchor: "wake",
      startOffsetMinutes: 0,
      endOffsetMinutes: 180,
      fallback: { startTime: "05:00", endTime: "08:00" }
    },
    {
      id: "bedtime",
      name: "Bedtime",
      anchor: "sleep_start",
      startOffsetMinutes: -180,
      endOffsetMinutes: 0,
      fallback: { startTime: "20:00", endTime: "21:00" }
    }
  ]
};

describe("recurring action windows", () => {
  it("creates two stable daily occurrences", () => {
    const result = resolveRecurrenceOccurrences({
      rule,
      from: new Date("2026-08-09T14:00:00Z"),
      through: new Date("2026-08-11T14:00:00Z"),
      preferredWakeTime: "06:00"
    });
    expect(result).toHaveLength(4);
    expect(result.map((item) => item.id)).toContain(occurrenceId("dental", "2026-08-10", "morning"));
  });

  it("keeps a window that started on the previous local date and is still open (F1-02)", () => {
    const nightRule: ActionRecurrenceRule = {
      id: "night",
      actionId: "night-action",
      timezone: "Australia/Sydney",
      startDate: "2026-08-10",
      intervalDays: 1,
      windows: [{ id: "late", name: "Late", anchor: "local_time", localStartTime: "22:00", localEndTime: "01:00" }]
    };
    // 00:30 local (UTC+10) on 2026-08-12 is 14:30Z on 2026-08-11.
    const result = resolveRecurrenceOccurrences({
      rule: nightRule,
      from: new Date("2026-08-11T14:30:00Z"),
      through: new Date("2026-08-12T14:30:00Z")
    });
    const open = result.find((item) => item.localDate === "2026-08-11");
    expect(open?.id).toBe(occurrenceId("night", "2026-08-11", "late"));
    expect(open?.windowEndsAt.toISOString()).toBe("2026-08-11T15:00:00.000Z");
    // The previous day's window has ended and the look-back never goes before the rule's startDate.
    expect(result.map((item) => item.localDate)).toEqual(["2026-08-11", "2026-08-12"]);
    const first = resolveRecurrenceOccurrences({
      rule: nightRule,
      from: new Date("2026-08-09T14:30:00Z"),
      through: new Date("2026-08-10T14:30:00Z")
    });
    expect(first.every((item) => item.localDate >= "2026-08-10")).toBe(true);
  });

  it("prefers actual wake over planned wake and only changes pending resolution", () => {
    const input = {
      rule,
      from: new Date("2026-08-10T00:00:00Z"),
      through: new Date("2026-08-11T00:00:00Z"),
      preferredWakeTime: "06:00",
      anchors: [
        {
          localDate: "2026-08-10",
          plannedWakeAt: new Date("2026-08-09T20:00:00Z"),
          actualWakeAt: new Date("2026-08-09T21:30:00Z")
        }
      ]
    };
    const morning = resolveRecurrenceOccurrences(input).find((item) => item.windowId === "morning")!;
    expect(morning.anchorSource).toBe("actual_wake");
    expect(morning.windowStartsAt.toISOString()).toBe("2026-08-09T21:30:00.000Z");
  });

  it("prefers an actual wake when multiple sleep rows share the same local day", () => {
    const anchors = [
      { localDate: "2026-08-10", wakeLocalDate: "2026-08-10", plannedWakeAt: new Date("2026-08-09T20:00:00Z") },
      {
        localDate: "2026-08-10",
        wakeLocalDate: "2026-08-10",
        plannedWakeAt: new Date("2026-08-09T22:00:00Z"),
        actualWakeAt: new Date("2026-08-09T21:15:00Z")
      }
    ];
    const morning = resolveRecurrenceOccurrences({
      rule,
      from: new Date("2026-08-09T14:00:00Z"),
      through: new Date("2026-08-10T14:00:00Z"),
      anchors,
      preferredWakeTime: "06:00"
    }).find((item) => item.windowId === "morning")!;
    expect(morning.anchorSource).toBe("actual_wake");
    expect(morning.windowStartsAt.toISOString()).toBe("2026-08-09T21:15:00.000Z");
  });

  it("assigns bedtime to the local sleep-start day rather than the next wake day", () => {
    const anchors = [
      {
        localDate: "2026-08-11",
        wakeLocalDate: "2026-08-11",
        sleepLocalDate: "2026-08-10",
        plannedWakeAt: new Date("2026-08-10T21:00:00Z"),
        plannedSleepStartAt: new Date("2026-08-10T12:00:00Z")
      }
    ];
    const result = resolveRecurrenceOccurrences({
      rule,
      from: new Date("2026-08-09T14:00:00Z"),
      through: new Date("2026-08-11T14:00:00Z"),
      anchors,
      preferredWakeTime: "06:00"
    });
    const bedtime = result.find((item) => item.windowId === "bedtime" && item.anchorSource === "planned_sleep")!;
    expect(bedtime.localDate).toBe("2026-08-10");
    expect(bedtime.windowEndsAt.toISOString()).toBe("2026-08-10T12:00:00.000Z");
  });

  // seed-zone is UTC+10 in August. Last night's sleep began at 00:45 today and ended at 08:00 today,
  // so its sleep-start date is *today* — the same date tonight's bedtime window belongs to.
  const sleptAfterMidnight = {
    localDate: "2026-08-10",
    wakeLocalDate: "2026-08-10",
    sleepLocalDate: "2026-08-10",
    actualWakeAt: new Date("2026-08-09T22:00:00Z"),
    plannedWakeAt: new Date("2026-08-09T21:00:00Z"),
    plannedSleepStartAt: new Date("2026-08-09T14:45:00Z")
  };
  const tonight = {
    localDate: "2026-08-11",
    wakeLocalDate: "2026-08-11",
    sleepLocalDate: "2026-08-10",
    plannedWakeAt: new Date("2026-08-10T20:00:00Z"),
    plannedSleepStartAt: new Date("2026-08-10T12:13:00Z")
  };

  it("anchors tonight's bedtime to tonight's plan, not to a sleep that began after midnight", () => {
    const result = resolveRecurrenceOccurrences({
      rule,
      from: new Date("2026-08-09T22:30:00Z"),
      through: new Date("2026-08-11T14:00:00Z"),
      anchors: [sleptAfterMidnight, tonight],
      preferredWakeTime: "06:00"
    });
    const bedtime = result.find((item) => item.windowId === "bedtime" && item.localDate === "2026-08-10")!;
    expect(bedtime.anchorSource).toBe("planned_sleep");
    expect(bedtime.windowEndsAt.toISOString()).toBe("2026-08-10T12:13:00.000Z");
    expect(bedtime.windowStartsAt.toISOString()).toBe("2026-08-10T09:13:00.000Z");
  });

  it("still lets the observed wake decide the wake window on the same day", () => {
    const result = resolveRecurrenceOccurrences({
      rule,
      from: new Date("2026-08-09T22:30:00Z"),
      through: new Date("2026-08-11T14:00:00Z"),
      anchors: [sleptAfterMidnight, tonight],
      preferredWakeTime: "06:00"
    });
    const morning = result.find((item) => item.windowId === "morning" && item.localDate === "2026-08-10")!;
    expect(morning.anchorSource).toBe("actual_wake");
    expect(morning.windowStartsAt.toISOString()).toBe("2026-08-09T22:00:00.000Z");
  });

  it("falls back to the clock when the only sleep on the date is one already slept through", () => {
    const bedtime = resolveRecurrenceOccurrences({
      rule,
      from: new Date("2026-08-09T22:30:00Z"),
      through: new Date("2026-08-11T00:00:00Z"),
      anchors: [sleptAfterMidnight],
      preferredWakeTime: "06:00"
    }).find((item) => item.windowId === "bedtime" && item.localDate === "2026-08-10")!;
    expect(bedtime.anchorSource).toBe("fallback");
    expect(bedtime.windowStartsAt.toISOString()).toBe("2026-08-10T10:00:00.000Z");
  });

  it("ignores a sleep row that knows no wake time when another on the day does", () => {
    const morning = resolveRecurrenceOccurrences({
      rule,
      from: new Date("2026-08-09T14:00:00Z"),
      through: new Date("2026-08-10T14:00:00Z"),
      anchors: [
        {
          localDate: "2026-08-10",
          sleepLocalDate: "2026-08-10",
          plannedSleepStartAt: new Date("2026-08-10T12:13:00Z")
        },
        { localDate: "2026-08-10", wakeLocalDate: "2026-08-10", plannedWakeAt: new Date("2026-08-09T20:30:00Z") }
      ],
      preferredWakeTime: "06:00"
    }).find((item) => item.windowId === "morning")!;
    expect(morning.anchorSource).toBe("planned_wake");
    expect(morning.windowStartsAt.toISOString()).toBe("2026-08-09T20:30:00.000Z");
  });

  it("uses clock fallbacks and respects the end date", () => {
    const fallback = resolveRecurrenceOccurrences({
      rule: { ...rule, endDate: "2026-08-10" },
      from: new Date("2026-08-10T00:00:00Z"),
      through: new Date("2026-08-12T00:00:00Z")
    });
    expect(fallback.filter((item) => item.windowId === "bedtime")).toHaveLength(1);
    expect(fallback.find((item) => item.windowId === "bedtime")?.anchorSource).toBe("fallback");
  });

  it("keeps local clock windows stable across the seed-zone DST transition", () => {
    const dstRule = {
      ...rule,
      startDate: "2026-10-03",
      endDate: "2026-10-05",
      windows: [
        { id: "clock", name: "Clock", anchor: "local_time" as const, localStartTime: "08:00", localEndTime: "09:00" }
      ]
    };
    const result = resolveRecurrenceOccurrences({
      rule: dstRule,
      from: new Date("2026-10-02T00:00:00Z"),
      through: new Date("2026-10-06T00:00:00Z")
    });
    expect(result).toHaveLength(3);
    expect(result.every((item) => item.windowEndsAt.getTime() - item.windowStartsAt.getTime() === 3_600_000)).toBe(
      true
    );
  });

  it("bounds occurrences by `through` when no endDate is set (total_minutes / manual completion)", () => {
    const { endDate: _endDate, ...ruleWithoutEndDate } = rule;
    const openEnded: ActionRecurrenceRule = ruleWithoutEndDate;
    const result = resolveRecurrenceOccurrences({
      rule: openEnded,
      from: new Date("2026-08-09T14:00:00Z"),
      through: new Date("2026-08-11T14:00:00Z"),
      preferredWakeTime: "06:00"
    });
    expect(result).toHaveLength(4);
  });

  it("stops generating occurrences once completedAt is set", () => {
    const completed: ActionRecurrenceRule = { ...rule, completedAt: new Date("2026-08-09T00:00:00Z") };
    const result = resolveRecurrenceOccurrences({
      rule: completed,
      from: new Date("2026-08-09T14:00:00Z"),
      through: new Date("2026-08-11T14:00:00Z"),
      preferredWakeTime: "06:00"
    });
    expect(result).toHaveLength(0);
  });
});

describe("recurring commitment repeats", () => {
  const piano: CommitmentRecurrenceRule = {
    id: "piano",
    title: "Piano lesson",
    timezone: "Australia/Sydney",
    startDate: "2026-08-14",
    repeat: { unit: "days", intervalDays: 14 },
    localStartTime: "14:00",
    localEndTime: "15:00",
    setupBeforeMinutes: 10,
    transitionAfterMinutes: 15,
    status: "active"
  };

  it("lands every two weeks on Friday and skips the weeks in between", () => {
    const result = resolveCommitmentRecurrenceRepeats({
      rule: piano,
      from: new Date("2026-08-01T00:00:00Z"),
      through: new Date("2026-09-12T00:00:00Z")
    });
    expect(result.map((item) => item.localDate)).toEqual(["2026-08-14", "2026-08-28", "2026-09-11"]);
    expect(
      result.every((item) => new Date(item.startsAt).getUTCDay() === new Date("2026-08-14T00:00:00Z").getUTCDay())
    ).toBe(true);
    expect(result[0]!.id).toBe(commitmentOccurrenceId("piano", "2026-08-14"));
    // Pins the contracts function to the engine's derived output: the portal builds exception-row ids
    // with it, and any drift from this shape wedges the replan's unique (rule, local date) index.
    expect(result.map((item) => item.id)).toEqual(["piano:2026-08-14", "piano:2026-08-28", "piano:2026-09-11"]);
    expect(result.every((item) => item.id === commitmentOccurrenceId("piano", item.localDate!))).toBe(true);
    expect(
      result.every(
        (item) => item.title === "Piano lesson" && item.setupBeforeMinutes === 10 && item.transitionAfterMinutes === 15
      )
    ).toBe(true);
  });

  it("carries the rule's place link onto every occurrence", () => {
    const result = resolveCommitmentRecurrenceRepeats({
      rule: { ...piano, location: "Studio 3", locationId: "campus" },
      from: new Date("2026-08-01T00:00:00Z"),
      through: new Date("2026-09-12T00:00:00Z")
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((item) => item.location === "Studio 3" && item.locationId === "campus")).toBe(true);
  });

  it("carries the rule's presence onto every occurrence, and says nothing when the rule does not", () => {
    const anchored = resolveCommitmentRecurrenceRepeats({
      rule: { ...piano, presence: "anchor" },
      from: new Date("2026-08-01T00:00:00Z"),
      through: new Date("2026-09-12T00:00:00Z")
    });
    expect(anchored.length).toBeGreaterThan(0);
    expect(anchored.every((item) => item.presence === "anchor")).toBe(true);
    const plain = resolveCommitmentRecurrenceRepeats({
      rule: piano,
      from: new Date("2026-08-01T00:00:00Z"),
      through: new Date("2026-09-12T00:00:00Z")
    });
    expect(plain.every((item) => item.presence === undefined)).toBe(true);
  });

  it("stops generating once the rule is ended", () => {
    const result = resolveCommitmentRecurrenceRepeats({
      rule: { ...piano, status: "ended" },
      from: new Date("2026-08-01T00:00:00Z"),
      through: new Date("2026-09-12T00:00:00Z")
    });
    expect(result).toHaveLength(0);
  });

  it("respects an explicit end date", () => {
    const result = resolveCommitmentRecurrenceRepeats({
      rule: { ...piano, endDate: "2026-08-20" },
      from: new Date("2026-08-01T00:00:00Z"),
      through: new Date("2026-09-12T00:00:00Z")
    });
    expect(result.map((item) => item.localDate)).toEqual(["2026-08-14"]);
  });
});

describe("recurring commitment repeats — months", () => {
  const base = {
    id: "monthly",
    title: "Monthly appointment",
    timezone: "Australia/Sydney",
    localStartTime: "14:00",
    localEndTime: "15:00",
    setupBeforeMinutes: 0,
    transitionAfterMinutes: 0,
    status: "active" as const
  };

  it("day_of_month: produces no February occurrence for a 31st-anchored rule", () => {
    const rule: CommitmentRecurrenceRule = {
      ...base,
      startDate: "2026-01-31",
      repeat: { unit: "months", intervalMonths: 1, anchor: "day_of_month" }
    };
    const result = resolveCommitmentRecurrenceRepeats({
      rule,
      from: new Date("2026-01-01T00:00:00Z"),
      through: new Date("2026-04-01T00:00:00Z")
    });
    expect(result.map((item) => item.localDate)).toEqual(["2026-01-31", "2026-03-31"]);
  });

  it("last_day: produces the 28th in February", () => {
    const rule: CommitmentRecurrenceRule = {
      ...base,
      startDate: "2026-01-31",
      repeat: { unit: "months", intervalMonths: 1, anchor: "last_day" }
    };
    const result = resolveCommitmentRecurrenceRepeats({
      rule,
      from: new Date("2026-01-01T00:00:00Z"),
      through: new Date("2026-04-01T00:00:00Z")
    });
    expect(result.map((item) => item.localDate)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
  });

  it("nth_weekday and last_weekday agree in February and diverge in March", () => {
    const nthRule: CommitmentRecurrenceRule = {
      ...base,
      startDate: "2026-02-22",
      repeat: { unit: "months", intervalMonths: 1, anchor: "nth_weekday" }
    };
    const lastRule: CommitmentRecurrenceRule = {
      ...nthRule,
      repeat: { unit: "months", intervalMonths: 1, anchor: "last_weekday" }
    };
    const window = { from: new Date("2026-02-01T00:00:00Z"), through: new Date("2026-04-01T00:00:00Z") };
    const nth = resolveCommitmentRecurrenceRepeats({ rule: nthRule, ...window });
    const last = resolveCommitmentRecurrenceRepeats({ rule: lastRule, ...window });
    expect(nth.map((item) => item.localDate)).toEqual(["2026-02-22", "2026-03-22"]);
    expect(last.map((item) => item.localDate)).toEqual(["2026-02-22", "2026-03-29"]);
  });

  it("respects intervalMonths = 3", () => {
    const rule: CommitmentRecurrenceRule = {
      ...base,
      startDate: "2026-01-15",
      repeat: { unit: "months", intervalMonths: 3, anchor: "day_of_month" }
    };
    const result = resolveCommitmentRecurrenceRepeats({
      rule,
      from: new Date("2026-01-01T00:00:00Z"),
      through: new Date("2026-08-01T00:00:00Z")
    });
    expect(result.map((item) => item.localDate)).toEqual(["2026-01-15", "2026-04-15", "2026-07-15"]);
  });
});

describe("recurring commitment repeats — weeks", () => {
  it("expands a Tuesday and Thursday rule, starting on its own start date", () => {
    const rule: CommitmentRecurrenceRule = {
      id: "tue-thu",
      title: "Class",
      timezone: "Australia/Sydney",
      localStartTime: "09:00",
      localEndTime: "10:00",
      setupBeforeMinutes: 0,
      transitionAfterMinutes: 0,
      status: "active",
      // 2026-09-03 is a Thursday: the Tuesday before it does not fall.
      startDate: "2026-09-03",
      repeat: { unit: "weeks", intervalWeeks: 1, weekdays: [2, 4] }
    };
    const result = resolveCommitmentRecurrenceRepeats({
      rule,
      from: new Date("2026-09-01T00:00:00Z"),
      through: new Date("2026-09-16T00:00:00Z")
    });
    expect(result.map((item) => item.localDate)).toEqual(["2026-09-03", "2026-09-08", "2026-09-10", "2026-09-15"]);
  });
});
