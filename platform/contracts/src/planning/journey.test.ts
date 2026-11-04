import { describe, expect, it } from "vitest";
import {
  EMPTY_JOURNEY_INDEX,
  buildJourneyIndex,
  journeyBand,
  resolveJourney,
  resolveMode,
  type JourneyCell,
  type JourneyIndex,
  type JourneyLatest,
  type LocationRef
} from "./journey.js";

const stats = (count: number, median: number, p80: number, p95: number) => ({ count, median, p80, p95 });
const emptyStats = stats(0, 0, 0, 0);

function cell(overrides: Partial<JourneyCell> & Pick<JourneyCell, "dayType" | "band">): JourneyCell {
  return {
    fromLocationId: "home",
    toLocationId: "work",
    mode: "car",
    pooled: emptyStats,
    own: emptyStats,
    ...overrides
  };
}

function indexOf(cells: JourneyCell[], latest: JourneyLatest[] = []): JourneyIndex {
  return buildJourneyIndex({ cells, latest });
}

const from: LocationRef = { id: "home" };
const to: LocationRef = { id: "work" };

describe("journeyBand", () => {
  it("splits a day into 30-minute weekday bands", () => {
    // 2026-09-28 is a Monday.
    expect(journeyBand(new Date("2026-09-28T08:00:00Z"), "UTC")).toEqual({ dayType: "weekday", band: 16 });
    expect(journeyBand(new Date("2026-09-28T08:29:00Z"), "UTC")).toEqual({ dayType: "weekday", band: 16 });
    expect(journeyBand(new Date("2026-09-28T08:30:00Z"), "UTC")).toEqual({ dayType: "weekday", band: 17 });
  });

  it("treats Saturday and Sunday as weekend", () => {
    // 2026-10-03 is a Saturday, 2026-10-04 a Sunday.
    expect(journeyBand(new Date("2026-10-03T12:00:00Z"), "UTC").dayType).toBe("weekend");
    expect(journeyBand(new Date("2026-10-04T12:00:00Z"), "UTC").dayType).toBe("weekend");
    expect(journeyBand(new Date("2026-10-05T12:00:00Z"), "UTC").dayType).toBe("weekday");
  });

  it("derives the band from the departure time in the given timezone, not UTC", () => {
    // 08:00 local (UTC+10 in September, before DST) is 22:00 UTC the day before.
    const band = journeyBand(new Date("2026-09-27T22:00:00Z"), "Australia/Sydney");
    expect(band).toEqual({ dayType: "weekday", band: 16 });
  });

  it("agrees with itself across a DST transition", () => {
    // US DST began 2026-03-08. 09:00 local before and after the change should each report band 18,
    // and the wall-clock band must not shift just because the UTC offset did.
    const before = journeyBand(new Date("2026-03-07T09:00:00-08:00"), "America/Los_Angeles");
    const after = journeyBand(new Date("2026-03-09T09:00:00-07:00"), "America/Los_Angeles");
    expect(before.band).toBe(18);
    expect(after.band).toBe(18);
  });
});

describe("resolveJourney tiers", () => {
  const now = new Date("2026-09-28T08:00:00Z"); // Monday, band 16
  const departAt = now;

  it("tier 1: uses a live sample under 30 minutes old", () => {
    const latest: JourneyLatest = {
      fromLocationId: "home",
      toLocationId: "work",
      mode: "car",
      minutes: 20,
      departedAt: now.toISOString(),
      observedAt: new Date(now.getTime() - 10 * 60_000).toISOString()
    };
    const journeys = indexOf([], [latest]);
    const journey = resolveJourney({
      journeys,
      from,
      to,
      mode: "car",
      departAt,
      now,
      timeZone: "UTC",
      caution: "normal"
    });
    expect(journey?.source).toBe("live");
    expect(journey?.typicalMinutes).toBe(20);
    expect(journey!.minutes).toBeGreaterThanOrEqual(20);
  });

  it("a live sample 30 minutes old or older is not live", () => {
    const latest: JourneyLatest = {
      fromLocationId: "home",
      toLocationId: "work",
      mode: "car",
      minutes: 20,
      departedAt: now.toISOString(),
      observedAt: new Date(now.getTime() - 30 * 60_000).toISOString()
    };
    const journeys = indexOf([], [latest]);
    const journey = resolveJourney({
      journeys,
      from,
      to,
      mode: "car",
      departAt,
      now,
      timeZone: "UTC",
      caution: "normal"
    });
    expect(journey?.source).not.toBe("live");
  });

  it("live plus spread: adds the same pair's percentile-minus-median as spread", () => {
    const latest: JourneyLatest = {
      fromLocationId: "home",
      toLocationId: "work",
      mode: "car",
      minutes: 20,
      departedAt: now.toISOString(),
      observedAt: new Date(now.getTime() - 5 * 60_000).toISOString()
    };
    const bandCell = cell({ dayType: "weekday", band: 16, pooled: stats(5, 22, 26, 30) });
    const journeys = indexOf([bandCell], [latest]);
    const journey = resolveJourney({
      journeys,
      from,
      to,
      mode: "car",
      departAt,
      now,
      timeZone: "UTC",
      caution: "normal"
    });
    // spread = p80(26) - median(22) = 4; live(20) + 4 = 24.
    expect(journey?.minutes).toBe(24);
    expect(journey?.typicalMinutes).toBe(20);
  });

  it("live plus spread falls back to padding when the cell's spread is smaller", () => {
    const latest: JourneyLatest = {
      fromLocationId: "home",
      toLocationId: "work",
      mode: "car",
      minutes: 20,
      departedAt: now.toISOString(),
      observedAt: new Date(now.getTime() - 5 * 60_000).toISOString()
    };
    // p80 - median = 1, smaller than the padding floor of 3.
    const bandCell = cell({ dayType: "weekday", band: 16, pooled: stats(5, 22, 23, 24) });
    const journeys = indexOf([bandCell], [latest]);
    const journey = resolveJourney({
      journeys,
      from,
      to,
      mode: "car",
      departAt,
      now,
      timeZone: "UTC",
      caution: "normal"
    });
    // spread = max(p80(23) - median(22) = 1, padding(20, n=5) = 1.5) = 1.5; live(20) + 1.5 = 21.5.
    expect(journey?.minutes).toBe(22);
  });

  it("tier 2: same pair, band and day type wins once it has 3 or more samples", () => {
    const bandCell = cell({ dayType: "weekday", band: 16, pooled: stats(3, 25, 30, 34) });
    const anyCell = cell({ dayType: null, band: null, pooled: stats(20, 15, 18, 20) });
    const journeys = indexOf([bandCell, anyCell]);
    const journey = resolveJourney({
      journeys,
      from,
      to,
      mode: "car",
      departAt,
      now,
      timeZone: "UTC",
      caution: "normal"
    });
    expect(journey?.typicalMinutes).toBe(25);
    expect(journey?.source).toBe("typical");
    expect(journey?.sampleCount).toBe(3);
  });

  it("tier 2 is skipped below the threshold of 3 samples, falling through to tier 3", () => {
    const bandCell = cell({ dayType: "weekday", band: 16, pooled: stats(2, 25, 30, 34) });
    const anyCell = cell({ dayType: null, band: null, pooled: stats(5, 15, 18, 20) });
    const journeys = indexOf([bandCell, anyCell]);
    const journey = resolveJourney({
      journeys,
      from,
      to,
      mode: "car",
      departAt,
      now,
      timeZone: "UTC",
      caution: "normal"
    });
    expect(journey?.typicalMinutes).toBe(15);
  });

  it("tier 3: same pair at any time, with at least 1 sample", () => {
    const anyCell = cell({ dayType: null, band: null, pooled: stats(1, 18, 20, 22) });
    const journeys = indexOf([anyCell]);
    const journey = resolveJourney({
      journeys,
      from,
      to,
      mode: "car",
      departAt,
      now,
      timeZone: "UTC",
      caution: "normal"
    });
    expect(journey?.typicalMinutes).toBe(18);
    expect(journey?.sampleCount).toBe(1);
  });

  it("own versus pooled: own wins once it reaches 3 samples, otherwise pooled is used", () => {
    const withFewOwn = cell({
      dayType: "weekday",
      band: 16,
      pooled: stats(10, 20, 24, 28),
      own: stats(2, 40, 44, 48)
    });
    const journeyPooled = resolveJourney({
      journeys: indexOf([withFewOwn]),
      from,
      to,
      mode: "car",
      departAt,
      now,
      timeZone: "UTC",
      caution: "normal"
    });
    expect(journeyPooled?.typicalMinutes).toBe(20);
    expect(journeyPooled?.source).toBe("typical");

    const withEnoughOwn = cell({
      dayType: "weekday",
      band: 16,
      pooled: stats(10, 20, 24, 28),
      own: stats(3, 40, 44, 48)
    });
    const journeyOwn = resolveJourney({
      journeys: indexOf([withEnoughOwn]),
      from,
      to,
      mode: "car",
      departAt,
      now,
      timeZone: "UTC",
      caution: "normal"
    });
    expect(journeyOwn?.typicalMinutes).toBe(40);
    expect(journeyOwn?.source).toBe("own");
  });

  it("chooses p80 or p95 by caution", () => {
    const bandCell = cell({ dayType: "weekday", band: 16, pooled: stats(10, 20, 24, 30) });
    const journeys = indexOf([bandCell]);
    const normal = resolveJourney({
      journeys,
      from,
      to,
      mode: "car",
      departAt,
      now,
      timeZone: "UTC",
      caution: "normal"
    });
    const high = resolveJourney({ journeys, from, to, mode: "car", departAt, now, timeZone: "UTC", caution: "high" });
    expect(normal?.minutes).toBe(24);
    expect(high?.minutes).toBe(30);
  });

  it("padding shrinks from n=0 to n=10 and vanishes at 10 or more samples", () => {
    const at0 = allowingAtCount(0);
    const at5 = allowingAtCount(5);
    const at10 = allowingAtCount(10);
    // typical 20, padding floor max(3, 0.15*20=3)=3. n=0 -> full 3; n=5 -> half, 1.5; n=10 -> 0.
    expect(at0).toBe(20 + 3);
    expect(at5).toBe(20 + 2); // ceil(20 + 1.5)
    expect(at10).toBe(20);

    function allowingAtCount(count: number): number {
      // Percentile equal to the median so padding alone decides the result.
      const bandCell = cell({ dayType: "weekday", band: 16, pooled: stats(count, 20, 20, 20) });
      const journeys = indexOf([bandCell]);
      // count=0 never reaches tier 2/3 in resolveJourney (needs >=1), so exercise the tier helper via
      // the any-time cell path directly for n=0, and the band cell for n>=1.
      if (count === 0) {
        const journey = resolveJourney({
          journeys: indexOf([]),
          from,
          to: { id: "work", storedMinutes: 20 },
          mode: "car",
          departAt,
          now,
          timeZone: "UTC",
          caution: "normal"
        });
        return journey!.minutes;
      }
      const journey = resolveJourney({
        journeys,
        from,
        to,
        mode: "car",
        departAt,
        now,
        timeZone: "UTC",
        caution: "normal"
      });
      return journey!.minutes;
    }
  });

  it("tier 4: falls back to the destination's stored minutes with no samples at all", () => {
    const journey = resolveJourney({
      journeys: EMPTY_JOURNEY_INDEX,
      from,
      to: { id: "work", storedMinutes: 30 },
      mode: "car",
      departAt,
      now,
      timeZone: "UTC",
      caution: "normal"
    });
    expect(journey?.source).toBe("fallback");
    expect(journey?.typicalMinutes).toBe(30);
  });

  it("tier 4b: the way there stands in for the way home", () => {
    const journey = resolveJourney({
      journeys: EMPTY_JOURNEY_INDEX,
      from: { id: "work", storedMinutes: 25 },
      to: { id: "home" },
      mode: "car",
      departAt,
      now,
      timeZone: "UTC",
      caution: "normal",
      homeLocationId: "home"
    });
    expect(journey?.source).toBe("assumed");
    expect(journey?.typicalMinutes).toBe(25);
  });

  it("tier 5: straight-line estimate when nothing else is known", () => {
    const journey = resolveJourney({
      journeys: EMPTY_JOURNEY_INDEX,
      from: { id: "home", latitude: 0, longitude: 0 },
      to: { id: "work", latitude: 0.1, longitude: 0 },
      mode: "car",
      departAt,
      now,
      timeZone: "UTC",
      caution: "normal"
    });
    expect(journey?.source).toBe("estimated");
    expect(journey?.typicalMinutes).toBeGreaterThan(0);
  });

  it("with no journeys argument at all (an empty index), only the stored-minutes fallback is reached", () => {
    const journey = resolveJourney({
      journeys: EMPTY_JOURNEY_INDEX,
      from,
      to: { id: "work" },
      mode: "car",
      departAt,
      now,
      timeZone: "UTC",
      caution: "normal"
    });
    expect(journey).toBeUndefined();
  });
});

describe("resolveMode", () => {
  const journeys = EMPTY_JOURNEY_INDEX;

  it("prefers the commitment's own mode when it is available", () => {
    const mode = resolveMode({
      commitmentMode: "bike",
      placeUsualMode: "car",
      userDefaultMode: "walk",
      transportModes: ["car", "bike", "walk"],
      journeys,
      from,
      to
    });
    expect(mode).toBe("bike");
  });

  it("skips a mode not currently available and falls to the place's usual mode", () => {
    const mode = resolveMode({
      commitmentMode: "bike",
      placeUsualMode: "walk",
      transportModes: ["car", "walk"],
      journeys,
      from,
      to
    });
    expect(mode).toBe("walk");
  });

  it("falls to the user's default when neither commitment nor place names one", () => {
    const mode = resolveMode({
      userDefaultMode: "walk",
      transportModes: ["car", "walk"],
      journeys,
      from,
      to
    });
    expect(mode).toBe("walk");
  });

  it("falls to the fastest available mode by typical minutes when nothing else names one", () => {
    const bandCell = cell({ dayType: null, band: null, mode: "walk", pooled: stats(3, 40, 44, 48) });
    const carCell = cell({ dayType: null, band: null, mode: "car", pooled: stats(3, 10, 12, 14) });
    const mode = resolveMode({
      transportModes: ["walk", "car"],
      journeys: indexOf([bandCell, carCell]),
      from,
      to
    });
    expect(mode).toBe("car");
  });

  it("skips every named mode absent from transportModes even at the fastest-available step", () => {
    const mode = resolveMode({
      commitmentMode: "car",
      transportModes: ["walk"],
      journeys,
      from: { id: "home", latitude: 0, longitude: 0 },
      to: { id: "work", latitude: 0, longitude: 0.05 }
    });
    expect(mode).toBe("walk");
  });
});
