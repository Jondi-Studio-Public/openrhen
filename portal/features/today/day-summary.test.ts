import { describe, expect, it } from "vitest";
import type { DayPlan, DayPlanItem } from "./day-plan";
import { dayAnswer, durationLabel, fixedThings, shortTitle, wakingRange } from "./day-summary";
import { zonedDayBounds } from "./local-datetime";

const TZ = "Australia/Sydney";
// Wednesday 19 August 2026 in the seed zone runs 2026-08-18T14:00Z to 2026-08-19T14:00Z, so 9:00 am local
// is 23:00Z on the 18th.
const bounds = zonedDayBounds("2026-08-19", TZ);
const MIDNIGHT = bounds.startsAt.getTime();
/** A moment on the day, as hours and minutes after its local midnight. */
const at = (hours: number, minutes = 0) => new Date(MIDNIGHT + (hours * 60 + minutes) * 60_000);

/** An item placed by clock time rather than minutes: `(9, 10)` is 9:00 to 10:00 am. */
const hours = (id: string, from: number, to: number, extra: Partial<DayPlanItem> = {}): DayPlanItem => ({
  id,
  kind: "commitment",
  source: "fixed",
  title: id,
  entityId: id,
  startsAt: at(from),
  endsAt: at(to),
  clippedStart: false,
  clippedEnd: false,
  ...extra
});

const planOf = (items: DayPlanItem[], extra: Partial<DayPlan> = {}): DayPlan => ({
  bounds,
  nowAt: null,
  items,
  reserved: [],
  backgrounds: [],
  lines: [],
  locations: [],
  waits: [],
  untimed: [],
  displaced: [],
  calculatedAt: null,
  ...extra
});

describe("durationLabel", () => {
  it("states minutes alone under an hour, hours alone on the hour, and both otherwise", () => {
    expect(durationLabel(0)).toBe("0 m");
    expect(durationLabel(45)).toBe("45 m");
    expect(durationLabel(180)).toBe("3 h");
    expect(durationLabel(468)).toBe("7 h 48 m");
  });

  it("rounds to the minute and never goes below zero", () => {
    expect(durationLabel(59.6)).toBe("1 h");
    expect(durationLabel(44.4)).toBe("44 m");
    expect(durationLabel(-5)).toBe("0 m");
  });
});

describe("shortTitle", () => {
  it("keeps the part before a colon and drops a trailing bracket", () => {
    expect(shortTitle("Dentist: check-up and clean")).toBe("Dentist");
    expect(shortTitle("Physio (Dr Lee)")).toBe("Physio");
    expect(shortTitle("Lecture (week 3): Ethics")).toBe("Lecture");
  });

  it("leaves a plain title, and a bracket that is not trailing, alone", () => {
    expect(shortTitle("Dentist")).toBe("Dentist");
    expect(shortTitle("Call (Mum) back")).toBe("Call (Mum) back");
  });

  it("falls back to the whole title when nothing would be left", () => {
    expect(shortTitle(": mystery")).toBe(": mystery");
  });
});

describe("fixedThings", () => {
  it("keeps stated commitments, in the order the plan holds them", () => {
    const plan = planOf([hours("a", 9, 10), hours("b", 11, 12)]);
    expect(fixedThings(plan).map((thing) => thing.id)).toEqual(["a", "b"]);
  });

  it("leaves out tentative commitments, which are not yet facts", () => {
    expect(fixedThings(planOf([hours("a", 9, 10, { tentative: true }), hours("b", 11, 12)])).map((i) => i.id)).toEqual([
      "b"
    ]);
  });

  it("counts a blocking commitment but not an anchor, which costs the place rather than the hour", () => {
    const plan = planOf([
      hours("blocking", 9, 10, { presence: "blocking" }),
      hours("anchor", 11, 12, { presence: "anchor" })
    ]);
    expect(fixedThings(plan).map((thing) => thing.id)).toEqual(["blocking"]);
  });

  it("leaves out windows and markers", () => {
    const plan = planOf([hours("window", 9, 10, { window: true }), hours("marker", 11, 11, { marker: true })]);
    expect(fixedThings(plan)).toEqual([]);
  });

  it("leaves out everything that is not a commitment, and commitments that are not fixed", () => {
    const plan = planOf([
      hours("work", 9, 10, { kind: "planned", source: "engine" }),
      hours("night", 0, 6, { kind: "sleep" }),
      hours("step", 8, 9, { kind: "routine_step" }),
      hours("recorded", 10, 11, { source: "recorded" })
    ]);
    expect(fixedThings(plan)).toEqual([]);
  });
});

describe("dayAnswer", () => {
  it("says Nothing fixed when the day has no fixed things, after the free time when it is known", () => {
    expect(dayAnswer(planOf([]), 468, TZ)).toBe("7 h 48 m free. Nothing fixed.");
    expect(dayAnswer(planOf([]), null, TZ)).toBe("Nothing fixed.");
  });

  it("names a single fixed thing by its short title and start", () => {
    const plan = planOf([hours("dentist", 14, 15, { title: "Dentist: check-up and clean" })]);
    expect(dayAnswer(plan, 90, TZ)).toBe("1 h 30 m free. One fixed thing: Dentist at 2:00 pm.");
  });

  it("names three fixed things in a sentence", () => {
    const plan = planOf([
      hours("a", 9, 10, { title: "Standup" }),
      hours("b", 11, 12, { title: "Lecture (week 3)" }),
      hours("c", 13, 14, { title: "Gym" })
    ]);
    expect(dayAnswer(plan, 120, TZ)).toBe(
      "2 h free. Three fixed things: Standup at 9:00 am, Lecture at 11:00 am and Gym at 1:00 pm."
    );
  });

  it("names the first three and counts the rest when there are more", () => {
    const plan = planOf([
      hours("a", 8, 9, { title: "A" }),
      hours("b", 9, 10, { title: "B" }),
      hours("c", 10, 11, { title: "C" }),
      hours("d", 11, 12, { title: "D" }),
      hours("e", 12, 13, { title: "E" })
    ]);
    expect(dayAnswer(plan, null, TZ)).toBe("Five fixed things: A at 8:00 am, B at 9:00 am, C at 10:00 am and 2 more.");
  });

  it("does not count tentative commitments in the sentence", () => {
    const plan = planOf([
      hours("a", 9, 10, { title: "Real" }),
      hours("b", 11, 12, { title: "Maybe", tentative: true })
    ]);
    expect(dayAnswer(plan, null, TZ)).toBe("One fixed thing: Real at 9:00 am.");
  });
});

describe("wakingRange", () => {
  const sleep = (id: string, from: number, to: number, extra: Partial<DayPlanItem> = {}) =>
    hours(id, from, to, { kind: "sleep", ...extra });

  it("runs 7 am to 10 pm when there is no sleep on the day", () => {
    expect(wakingRange(planOf([]))).toEqual({ start: 7 * 60, end: 22 * 60 });
  });

  it("opens at the hour of waking and closes at the hour of bed, from the day's sleep blocks", () => {
    // Slept until 6:30 am; bed at 11:30 pm. Both round outward to the hour.
    const plan = planOf([sleep("last-night", 0, 6.5), sleep("tonight", 23.5, 24)]);
    expect(wakingRange(plan)).toEqual({ start: 6 * 60, end: 24 * 60 });
  });

  it("takes only the night that ends before noon as the wake, and the one starting after it as bed", () => {
    expect(wakingRange(planOf([sleep("last-night", 0, 8)]))).toEqual({ start: 8 * 60, end: 22 * 60 });
    expect(wakingRange(planOf([sleep("tonight", 21, 24)]))).toEqual({ start: 7 * 60, end: 21 * 60 });
  });

  it("ignores a sleep window or marker when finding the night", () => {
    const plan = planOf([sleep("w", 0, 4, { window: true }), sleep("m", 23, 23, { marker: true })]);
    expect(wakingRange(plan)).toEqual({ start: 7 * 60, end: 22 * 60 });
  });

  it("widens, on the hour, to take in anything else the day holds outside those hours", () => {
    const plan = planOf([hours("early", 5.25, 6), hours("late", 22.33, 23.17)]);
    expect(wakingRange(plan)).toEqual({ start: 5 * 60, end: 24 * 60 });
  });

  it("is not widened by a recurring window, which is context rather than something awake", () => {
    expect(wakingRange(planOf([hours("w", 3, 4, { kind: "occurrence", window: true })]))).toEqual({
      start: 7 * 60,
      end: 22 * 60
    });
  });

  it("is widened by a wait", () => {
    const wait = {
      id: "wait",
      title: "Resting",
      anchorTitle: "Resting",
      running: false,
      startsAt: at(5, 30),
      endsAt: at(6)
    } as unknown as DayPlan["waits"][number];
    expect(wakingRange(planOf([], { waits: [wait] }))).toEqual({ start: 5 * 60, end: 22 * 60 });
  });

  it("is widened by the now-line, with half an hour either side", () => {
    expect(wakingRange(planOf([], { nowAt: at(6, 10) }))).toEqual({ start: 5 * 60, end: 22 * 60 });
    expect(wakingRange(planOf([], { nowAt: at(22, 10) }))).toEqual({ start: 7 * 60, end: 23 * 60 });
    expect(wakingRange(planOf([], { nowAt: at(12) }))).toEqual({ start: 7 * 60, end: 22 * 60 });
  });

  it("is widened by extra moments the caller names", () => {
    expect(wakingRange(planOf([]), [at(4)])).toEqual({ start: 3 * 60, end: 22 * 60 });
  });

  it("is widened by spans the caller names, such as reserved blocks when they are shown", () => {
    expect(wakingRange(planOf([]), [], [{ startsAt: at(4, 15), endsAt: at(5) }])).toEqual({
      start: 4 * 60,
      end: 22 * 60
    });
  });

  it("never reaches past the day's own edges", () => {
    const plan = planOf([], { nowAt: at(23, 50) });
    expect(wakingRange(plan)).toEqual({ start: 7 * 60, end: 24 * 60 });
    expect(wakingRange(planOf([], { nowAt: at(0, 5) }))).toEqual({ start: 0, end: 22 * 60 });
  });
});
