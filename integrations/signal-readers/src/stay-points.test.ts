import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectStayPoints, type PositionFix, type StayPoint } from "./stay-points.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 0, 5, 0, 0, 0);
const LAT = 51.5;
const LNG = -0.12;
const M_PER_DEG = 111_320;
const FAR_FUTURE = T0 + 30 * DAY;

/** A point `east` and `north` metres from the test origin. */
function at(east: number, north: number): { lat: number; lng: number } {
  return { lat: LAT + north / M_PER_DEG, lng: LNG + east / (M_PER_DEG * Math.cos((LAT * Math.PI) / 180)) };
}

let counter = 0;
function fix(ts: number, east: number, north: number, extra: Partial<PositionFix> = {}): PositionFix {
  counter += 1;
  return {
    ts,
    ...at(east, north),
    accuracyM: 15,
    routeKey: "route-a",
    mints: true,
    eventKey: `k-${counter}`,
    ingestedAt: ts + 1000,
    ...extra
  };
}

/** Fixes every `step` ms from `start` to `end` inclusive, with a small deterministic wobble. */
function series(
  start: number,
  end: number,
  step: number,
  east: number,
  north: number,
  extra: Partial<PositionFix> = {}
) {
  const out: PositionFix[] = [];
  let i = 0;
  for (let ts = start; ts <= end; ts += step) {
    out.push(fix(ts, east + ((i % 3) - 1) * 4, north + ((i % 2) - 0.5) * 4, extra));
    i += 1;
  }
  return out;
}

function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (state * 1664525 + 1013904223) % 4294967296;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const detect = (fixes: PositionFix[], now = FAR_FUTURE): StayPoint[] => detectStayPoints(fixes, { now });

describe("detectStayPoints basics", () => {
  it("finds one closed stay from a run of fixes in one place", () => {
    const stays = detect(series(T0 + 8 * HOUR, T0 + 9 * HOUR, 10 * MIN, 0, 0));
    expect(stays).toHaveLength(1);
    const stay = stays[0]!;
    expect(stay.from).toBe(T0 + 8 * HOUR);
    expect(stay.to).toBe(T0 + 9 * HOUR);
    expect(stay.approximate).toBe(false);
    expect(stay.routes).toEqual(["route-a"]);
    expect(stay.inputEventKeys).toHaveLength(7);
    expect(stay.centroid.lat).toBeCloseTo(LAT, 4);
    expect(stay.open).toBe(false);
  });

  it("never makes a stay from a single fix", () => {
    expect(detect([fix(T0 + HOUR, 0, 0)])).toEqual([]);
  });

  it("needs at least five minutes", () => {
    expect(detect([fix(T0, 0, 0), fix(T0 + 4 * MIN, 0, 0)])).toEqual([]);
    expect(detect([fix(T0, 0, 0), fix(T0 + 5 * MIN, 0, 0)])).toHaveLength(1);
  });

  it("returns nothing for no input and does not modify its input", () => {
    expect(detect([])).toEqual([]);
    const input = series(T0, T0 + HOUR, 10 * MIN, 0, 0);
    const copy = JSON.stringify(input);
    detect(input);
    expect(JSON.stringify(input)).toBe(copy);
  });

  it("drops fixes with accuracy over 200 m, so a wild fix does not split a stay", () => {
    const fixes = [
      ...series(T0, T0 + 20 * MIN, 5 * MIN, 0, 0),
      fix(T0 + 22 * MIN, 3000, 0, { accuracyM: 250 }),
      ...series(T0 + 25 * MIN, T0 + 45 * MIN, 5 * MIN, 0, 0)
    ];
    const stays = detect(fixes);
    expect(stays).toHaveLength(1);
    expect(stays[0]!.to).toBe(T0 + 45 * MIN);
    expect(stays[0]!.inputEventKeys).toHaveLength(10);
  });

  it("leaves a fix with no accuracy out of the median", () => {
    const fixes = series(T0, T0 + 30 * MIN, 10 * MIN, 0, 0).map(({ accuracyM: _dropped, ...rest }) => rest);
    const stay = detect(fixes)[0]!;
    expect(stay.medianAccuracyM).toBe(0);
    expect(stay.approximate).toBe(false);
  });
});

describe("window and approximate visits", () => {
  it("makes one approximate stay out of an urban canyon with 40-90 m error", () => {
    const accuracies = [40, 60, 80, 90, 85, 90, 80, 70, 90];
    const offsets: Array<[number, number]> = [
      [0, 0],
      [30, -20],
      [-25, 35],
      [40, 10],
      [-35, -30],
      [20, 40],
      [-10, -45],
      [45, -5],
      [0, 20]
    ];
    const fixes = accuracies.map((accuracyM, i) =>
      fix(T0 + 10 * HOUR + i * 4 * MIN, offsets[i]![0], offsets[i]![1], { accuracyM })
    );
    const stays = detect(fixes);
    expect(stays).toHaveLength(1);
    expect(stays[0]!.approximate).toBe(true);
    expect(stays[0]!.medianAccuracyM).toBe(80);
  });

  it("marks the boundary at a median of exactly 75 m as not approximate", () => {
    const stay = detect(series(T0, T0 + 30 * MIN, 10 * MIN, 0, 0, { accuracyM: 75 }))[0]!;
    expect(stay.approximate).toBe(false);
    const worse = detect(series(T0, T0 + 30 * MIN, 10 * MIN, 0, 0, { accuracyM: 76 }))[0]!;
    expect(worse.approximate).toBe(true);
  });

  it("treats two shops 40 m apart visited back to back as one stay", () => {
    const fixes = [
      ...series(T0, T0 + 20 * MIN, 5 * MIN, 0, 0, { accuracyM: 15 }),
      ...series(T0 + 25 * MIN, T0 + 45 * MIN, 5 * MIN, 40, 0, { accuracyM: 15 })
    ];
    expect(detect(fixes)).toHaveLength(1);
  });

  it("keeps two shops 40 m apart visited on different days as two stays", () => {
    const fixes = [
      ...series(T0 + 10 * HOUR, T0 + 10 * HOUR + 30 * MIN, 10 * MIN, 0, 0, { accuracyM: 15 }),
      ...series(T0 + DAY + 15 * HOUR, T0 + DAY + 15 * HOUR + 30 * MIN, 10 * MIN, 40, 0, { accuracyM: 15 })
    ];
    const stays = detect(fixes);
    expect(stays).toHaveLength(2);
    expect(stays[0]!.centroid.lng).not.toBeCloseTo(stays[1]!.centroid.lng, 5);
  });

  it("splits back to back places that are well outside the window", () => {
    const fixes = [
      ...series(T0, T0 + 20 * MIN, 5 * MIN, 0, 0),
      ...series(T0 + 25 * MIN, T0 + 45 * MIN, 5 * MIN, 300, 0)
    ];
    const stays = detect(fixes);
    expect(stays).toHaveLength(2);
    expect(stays[0]!.to).toBe(T0 + 20 * MIN);
    expect(stays[0]!.toBound).toBe(T0 + 25 * MIN);
    expect(stays[0]!.endApprox).toBe(false);
  });

  it("widens the window with poor accuracy", () => {
    const fixes = [
      fix(T0, 0, 0, { accuracyM: 60 }),
      fix(T0 + 5 * MIN, 90, 0, { accuracyM: 60 }),
      fix(T0 + 10 * MIN, -90, 0, { accuracyM: 60 })
    ];
    expect(detect(fixes)).toHaveLength(1);
    const tight = fixes.map((f) => ({ ...f, accuracyM: 10 }));
    expect(detect(tight)).toEqual([]);
  });
});

describe("gaps", () => {
  it("ends a stay at the last home fix and bounds it by the next fix elsewhere", () => {
    const home = series(T0 + 20 * HOUR, T0 + 23 * HOUR, 30 * MIN, 0, 0);
    const office = series(T0 + DAY + 8 * HOUR + 20 * MIN, T0 + DAY + 9 * HOUR, 10 * MIN, 2000, 0);
    const stays = detect([...home, ...office]);
    expect(stays).toHaveLength(2);
    const [first, second] = stays as [StayPoint, StayPoint];
    expect(first.to).toBe(T0 + 23 * HOUR);
    expect(first.toBound).toBe(T0 + DAY + 8 * HOUR + 20 * MIN);
    expect(first.endApprox).toBe(true);
    expect(first.open).toBe(false);
    expect(first.closeTime).toBe(T0 + DAY + 8 * HOUR + 20 * MIN + 1000);
    expect(second.from).toBe(T0 + DAY + 8 * HOUR + 20 * MIN);
  });

  it("bridges a long gap at home with fixes on both sides as one stay", () => {
    const fixes = [
      ...series(T0 + 20 * HOUR, T0 + 21 * HOUR, 30 * MIN, 0, 0),
      ...series(T0 + DAY + 7 * HOUR, T0 + DAY + 7 * HOUR + 30 * MIN, 30 * MIN, 5, 5)
    ];
    const stays = detect(fixes);
    expect(stays).toHaveLength(1);
    expect(stays[0]!.from).toBe(T0 + 20 * HOUR);
    expect(stays[0]!.to).toBe(T0 + DAY + 7 * HOUR + 30 * MIN);
  });

  it("makes one stay out of a long home stay with four sparse fixes", () => {
    const times = [21 * HOUR, 24 * HOUR + 30 * MIN, 28 * HOUR, 31 * HOUR + 30 * MIN];
    const fixes = times.map((t) => fix(T0 + t, 0, 0));
    const stays = detect(fixes, T0 + 32 * HOUR);
    expect(stays).toHaveLength(1);
    expect(stays[0]!.from).toBe(T0 + 21 * HOUR);
    expect(stays[0]!.to).toBe(T0 + 31 * HOUR + 30 * MIN);
    expect(stays[0]!.open).toBe(true);
  });

  it("does not bridge a gap of 12 h or more", () => {
    const fixes = [
      ...series(T0, T0 + 30 * MIN, 10 * MIN, 0, 0),
      ...series(T0 + 13 * HOUR, T0 + 13 * HOUR + 30 * MIN, 10 * MIN, 0, 0)
    ];
    const stays = detect(fixes);
    expect(stays).toHaveLength(2);
    expect(stays[0]!.toBound).toBe(T0 + 30 * MIN + 12 * HOUR);
    expect(stays[0]!.endApprox).toBe(true);
  });

  it("does not bridge a gap with a fix elsewhere inside it", () => {
    const fixes = [
      ...series(T0, T0 + 30 * MIN, 10 * MIN, 0, 0),
      ...series(T0 + 3 * HOUR, T0 + 3 * HOUR + 20 * MIN, 10 * MIN, 1500, 0),
      ...series(T0 + 6 * HOUR, T0 + 6 * HOUR + 30 * MIN, 10 * MIN, 0, 0)
    ];
    const stays = detect(fixes);
    expect(stays).toHaveLength(3);
  });

  it("gives no 3-day stay for a phone that was off for 3 days", () => {
    const fixes = [
      ...series(T0 + 8 * HOUR, T0 + 9 * HOUR, 15 * MIN, 0, 0),
      ...series(T0 + 3 * DAY + 8 * HOUR, T0 + 3 * DAY + 9 * HOUR, 15 * MIN, 0, 0)
    ];
    const stays = detect(fixes);
    expect(stays).toHaveLength(2);
    for (const stay of stays) expect(stay.to - stay.from).toBeLessThanOrEqual(HOUR);
    expect(stays[0]!.toBound).toBe(T0 + 9 * HOUR + 12 * HOUR);
  });

  it("does not bridge a gap when another route has a fix elsewhere inside it", () => {
    const fixes = [
      ...series(T0, T0 + 30 * MIN, 10 * MIN, 0, 0),
      fix(T0 + 3 * HOUR, 5000, 0, { routeKey: "route-b", eventKey: "elsewhere", ingestedAt: T0 + 3 * HOUR + 1000 }),
      ...series(T0 + 6 * HOUR, T0 + 6 * HOUR + 30 * MIN, 10 * MIN, 0, 0)
    ];
    const stays = detect(fixes).filter((stay) => stay.routes.includes("route-a"));
    expect(stays).toHaveLength(2);
    // The first stay was closed by the other route's fix, not by the later fixes of its own route.
    expect(stays[0]!.toBound).toBe(T0 + 3 * HOUR);
  });

  it("still bridges a long gap when another route's fix inside it is at the same place", () => {
    const fixes = [
      ...series(T0, T0 + 30 * MIN, 10 * MIN, 0, 0),
      fix(T0 + 3 * HOUR, 3, 3, { routeKey: "route-b", eventKey: "same-place" }),
      ...series(T0 + 6 * HOUR, T0 + 6 * HOUR + 30 * MIN, 10 * MIN, 0, 0)
    ];
    expect(detect(fixes).filter((stay) => stay.routes.includes("route-a"))).toHaveLength(1);
  });

  it("handles a very large stay quickly and without a stack error", () => {
    const fixes: PositionFix[] = [];
    for (let i = 0; i < 200_000; i += 1) fixes.push(fix(T0 + i * 1000, (i % 3) - 1, (i % 2) - 0.5));
    const started = Date.now();
    const stays = detect(fixes);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(stays).toHaveLength(1);
    expect(stays[0]!.inputEventKeys).toHaveLength(200_000);
  });

  it("splits at a gap over 90 min when the fixes after it are elsewhere", () => {
    const fixes = [
      ...series(T0, T0 + 30 * MIN, 10 * MIN, 0, 0),
      ...series(T0 + 3 * HOUR, T0 + 3 * HOUR + 30 * MIN, 10 * MIN, 400, 0)
    ];
    expect(detect(fixes)).toHaveLength(2);
  });
});

describe("vehicles", () => {
  it("drops a traffic jam inside a vehicle segment", () => {
    const jam = series(T0 + 8 * HOUR, T0 + 8 * HOUR + 20 * MIN, MIN, 0, 0, { motion: "automotive" });
    expect(detect(jam)).toEqual([]);
  });

  it("drops cycling over more than half the stay, keeps it at half or less", () => {
    const base = series(T0, T0 + 40 * MIN, 5 * MIN, 0, 0);
    const mostly = base.map((f, i) => (i < 5 ? { ...f, motion: "cycling" } : f));
    expect(detect(mostly)).toEqual([]);
    const half = base.map((f, i) => (i < 4 ? { ...f, motion: "cycling" } : f));
    expect(detect(half)).toHaveLength(1);
  });

  it("drops a stay whose median speed is above 1.5 m/s", () => {
    const fixes: PositionFix[] = [];
    for (let i = 0; i < 36; i += 1) fixes.push(fix(T0 + i * 10_000, i % 2 === 0 ? -15 : 15, 0));
    expect(detect(fixes)).toEqual([]);
  });

  it("does not let a drive between two places join them", () => {
    const fixes = [
      ...series(T0, T0 + 30 * MIN, 10 * MIN, 0, 0),
      ...series(T0 + 35 * MIN, T0 + 55 * MIN, 5 * MIN, 5000, 0, { motion: "automotive" }),
      ...series(T0 + 60 * MIN, T0 + 90 * MIN, 10 * MIN, 10_000, 0)
    ];
    const stays = detect(fixes);
    expect(stays.map((s) => Math.round(s.centroid.lng * 100))).toEqual([
      Math.round(LNG * 100),
      Math.round(at(10_000, 0).lng * 100)
    ]);
  });
});

describe("open and closed stays", () => {
  const fixes = series(T0 + 8 * HOUR, T0 + 9 * HOUR, 10 * MIN, 0, 0);
  const last = T0 + 9 * HOUR;

  it("is open while the 12 h cap has not passed, with no end bound yet", () => {
    const stay = detect(fixes, last + 2 * HOUR)[0]!;
    expect(stay.open).toBe(true);
    expect(stay.toBound).toBe(stay.to);
    expect(stay.endApprox).toBe(false);
    expect(stay.closeTime).toBe(last + 12 * HOUR);
  });

  it("closes at last fix + 12 h with an approximate end", () => {
    const stay = detect(fixes, last + 12 * HOUR)[0]!;
    expect(stay.open).toBe(false);
    expect(stay.toBound).toBe(last + 12 * HOUR);
    expect(stay.endApprox).toBe(true);
  });

  it("closes at once when a later fix elsewhere has been ingested", () => {
    const closer = fix(last + 5 * MIN, 1000, 0, { ingestedAt: last + 6 * MIN });
    expect(detect([...fixes, closer], last + 5 * MIN)[0]!.open).toBe(true);
    const closed = detect([...fixes, closer], last + 6 * MIN)[0]!;
    expect(closed.open).toBe(false);
    expect(closed.toBound).toBe(last + 5 * MIN);
    expect(closed.closeTime).toBe(last + 6 * MIN);
  });

  it("ignores fixes that were ingested after now", () => {
    const stays = detect(fixes, T0 + 8 * HOUR + 25 * MIN);
    expect(stays).toHaveLength(1);
    expect(stays[0]!.to).toBe(T0 + 8 * HOUR + 20 * MIN);
    expect(stays[0]!.open).toBe(true);
  });

  it("a closer ingested late closes the stay no earlier than its own ingestion, up to the cap", () => {
    const late = fix(last + 5 * HOUR, 1000, 0, { ingestedAt: last + 20 * HOUR });
    const stay = detect([...fixes, late], last + 21 * HOUR)[0]!;
    expect(stay.closeTime).toBe(last + 12 * HOUR);
    expect(stay.toBound).toBe(last + 5 * HOUR);
  });
});

describe("dedupe across routes", () => {
  const a = (extra: Partial<PositionFix> = {}) =>
    series(T0, T0 + 60 * MIN, 10 * MIN, 0, 0, { routeKey: "r-a", accuracyM: 60, ...extra });

  it("merges overlapping stays on two routes and takes bounds from the most accurate one", () => {
    const b = series(T0 + 10 * MIN, T0 + 70 * MIN, 10 * MIN, 20, 0, { routeKey: "r-b", accuracyM: 10 });
    const stays = detect([...a(), ...b]);
    expect(stays).toHaveLength(1);
    const stay = stays[0]!;
    expect(stay.from).toBe(T0 + 10 * MIN);
    expect(stay.to).toBe(T0 + 70 * MIN);
    expect(stay.medianAccuracyM).toBe(10);
    expect(stay.routes).toEqual(["r-a", "r-b"]);
    expect(stay.inputEventKeys).toHaveLength(14);
  });

  it("keeps stays that overlap by less than half", () => {
    const b = series(T0 + 50 * MIN, T0 + 110 * MIN, 10 * MIN, 0, 0, { routeKey: "r-b", accuracyM: 10 });
    expect(detect([...a(), ...b])).toHaveLength(2);
  });

  it("keeps stays whose centroids are further apart than the window", () => {
    const b = series(T0, T0 + 60 * MIN, 10 * MIN, 400, 0, { routeKey: "r-b", accuracyM: 10 });
    expect(detect([...a({ accuracyM: 10 }), ...b])).toHaveLength(2);
  });

  it("never merges two stays of the same route", () => {
    const fixes = [
      ...series(T0, T0 + 30 * MIN, 10 * MIN, 0, 0),
      ...series(T0 + 40 * MIN, T0 + 70 * MIN, 10 * MIN, 400, 0)
    ];
    expect(detect(fixes)).toHaveLength(2);
  });

  it("mints when any contributing fix mints", () => {
    const joinOnly = series(T0, T0 + 30 * MIN, 10 * MIN, 0, 0, { mints: false });
    expect(detect(joinOnly)[0]!.mints).toBe(false);
    const merged = detect([
      ...joinOnly,
      ...series(T0, T0 + 30 * MIN, 10 * MIN, 0, 0, { routeKey: "r-b", accuracyM: 5 })
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.mints).toBe(true);
  });
});

describe("late and unordered input", () => {
  const home = series(T0 + 20 * HOUR, T0 + 23 * HOUR, 20 * MIN, 0, 0);
  const trip = series(T0 + 24 * HOUR, T0 + 25 * HOUR, 10 * MIN, 3000, 0);
  const back = series(T0 + 26 * HOUR, T0 + 27 * HOUR, 10 * MIN, 0, 0);

  it("gives the same stays whatever order the fixes arrive in", () => {
    const all = [...home, ...trip, ...back];
    const expected = detect(all);
    expect(expected).toHaveLength(3);
    for (const seed of [1, 2, 3, 4, 5]) expect(detect(shuffled(all, seed))).toEqual(expected);
  });

  it("gives the same stays when a batch of offline fixes is ingested at once", () => {
    const batchAt = T0 + 30 * HOUR;
    const live = [...home, ...trip, ...back];
    const batch = live.map((f) => (f.ts >= T0 + 24 * HOUR ? { ...f, ingestedAt: batchAt } : f));
    const strip = (stays: StayPoint[]) => stays.map(({ closeTime: _closeTime, ...rest }) => rest);
    expect(strip(detect(shuffled(batch, 9)))).toEqual(strip(detect(live)));
    expect(strip(detect(batch, batchAt - 1))).toHaveLength(1);
  });

  it("has the offline fixes change the answer only once they are ingested", () => {
    const batchAt = T0 + 30 * HOUR;
    const late = trip.map((f) => ({ ...f, ingestedAt: batchAt }));
    const before = detect(
      [...home, ...late, ...back].filter((f) => f.ingestedAt <= batchAt - 1),
      batchAt - 1
    );
    const after = detect([...home, ...late, ...back], batchAt);
    expect(before.some((s) => s.centroid.lng > LNG + 0.01)).toBe(false);
    expect(after.some((s) => s.centroid.lng > LNG + 0.01)).toBe(true);
  });

  it("is deterministic for identical input", () => {
    const all = [...home, ...trip, ...back];
    expect(detect(all)).toEqual(detect([...all]));
  });
});

describe("string literals", () => {
  it("hold none of the words the posture design forbids", () => {
    const forbidden = [
      "sleep",
      "asleep",
      "wake",
      "woke",
      "awake",
      "tired",
      "rest",
      "rested",
      "nap",
      "bedtime",
      "overnight",
      "night",
      "energy",
      "capacity"
    ];
    const source = readFileSync(new URL("./stay-points.ts", import.meta.url), "utf8");
    const literals = [...source.matchAll(/"([^"\\]|\\.)*"|`([^`\\]|\\.)*`/g)].map((m) => m[0].toLowerCase());
    for (const literal of literals)
      for (const word of forbidden)
        expect(new RegExp(`\\b${word}\\b`).test(literal), `${word} in ${literal}`).toBe(false);
  });
});
