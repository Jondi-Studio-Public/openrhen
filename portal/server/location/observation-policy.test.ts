import { describe, expect, it } from "vitest";
import type { LocationMatch, NearbyLocation } from "./nearest-location";
import {
  DEVICE_LOCATION_HISTORY_LIMIT,
  appendObservation,
  decideBrowserObservation,
  decidePhonePing,
  emptyDeviceLocationState,
  nextSuggestion,
  observationRecord,
  observationsOfDevice,
  parseDeviceLocationState,
  readingFreshness,
  sustainedLocationId,
  sustainedRun,
  type DeviceObservationRecord
} from "./observation-policy";

const at = (minutes: number) => new Date(Date.UTC(2026, 7, 26, 9, minutes)).toISOString();
const now = new Date(Date.UTC(2026, 7, 26, 10, 0));
const place = (locationId: string, distanceMeters = 20): NearbyLocation => ({
  locationId,
  locationName: locationId,
  distanceMeters
});
const matched = (locationId: string, distanceMeters = 20): LocationMatch => ({
  kind: "matched",
  toleranceMeters: 150,
  location: place(locationId, distanceMeters)
});
const ambiguous: LocationMatch = {
  kind: "ambiguous",
  toleranceMeters: 150,
  candidates: [place("home"), place("shed")]
};
const unmatched: LocationMatch = { kind: "none", toleranceMeters: 150, nearest: place("home", 4000) };

const fix = (locationId: string | null, minutes: number, source: "phone" | "browser" = "phone") =>
  observationRecord({
    match: locationId === null ? unmatched : matched(locationId),
    source,
    accuracyMeters: 12,
    observedAt: at(minutes),
    recordedAt: at(minutes)
  });

describe("parseDeviceLocationState", () => {
  it("reads an absent or unrecognisable column as nothing observed yet", () => {
    expect(parseDeviceLocationState(null)).toEqual(emptyDeviceLocationState());
    expect(parseDeviceLocationState("not json")).toEqual(emptyDeviceLocationState());
  });

  it("keeps a valid lastPhonePingAt and drops a malformed one", () => {
    const at = "2026-10-29T08:00:00.000Z";
    expect(parseDeviceLocationState({ observations: [], suggestion: null, lastPhonePingAt: at }).lastPhonePingAt).toBe(
      at
    );
    expect(parseDeviceLocationState({ lastPhonePingAt: "nope" })).toEqual(emptyDeviceLocationState());
    expect(parseDeviceLocationState({ lastPhonePingAt: 5 })).toEqual(emptyDeviceLocationState());
  });

  it("keeps the readings it understands and drops the ones it does not", () => {
    const state = parseDeviceLocationState({
      observations: [fix("home", 0), { observedAt: at(1) }, null],
      suggestion: { kind: "move", locationId: "shed", locationName: "Shed", observedAt: at(2), suggestedAt: at(2) }
    });
    expect(state.observations).toEqual([fix("home", 0)]);
    // The suggestion above names no source, and a question nobody can attribute is not kept.
    expect(state.suggestion).toBeNull();
  });

  it("round-trips a stored suggestion", () => {
    const suggestion = {
      kind: "move" as const,
      locationId: "shed",
      locationName: "Shed",
      distanceMeters: 31,
      observedAt: at(2),
      suggestedAt: at(2),
      source: "phone" as const
    };
    expect(parseDeviceLocationState({ observations: [], suggestion }).suggestion).toEqual(suggestion);
  });
});

describe("appendObservation", () => {
  it("keeps only the most recent readings", () => {
    let observations: DeviceObservationRecord[] = [];
    for (let minute = 0; minute < DEVICE_LOCATION_HISTORY_LIMIT + 5; minute += 1)
      observations = appendObservation({ observations, suggestion: null }, fix("home", minute));
    expect(observations).toHaveLength(DEVICE_LOCATION_HISTORY_LIMIT);
    expect(observations[0]!.observedAt).toBe(at(5));
  });

  it("orders by the device's clock, so a ping delayed by a blackspot lands in its own run", () => {
    const state = { observations: [fix("home", 0), fix("home", 30)], suggestion: null };
    expect(appendObservation(state, fix("home", 10)).map((entry) => entry.observedAt)).toEqual([at(0), at(10), at(30)]);
  });
});

describe("sustainedLocationId", () => {
  it("needs a run spanning the full period", () => {
    expect(sustainedLocationId([fix("shed", 0), fix("shed", 9)])).toBeNull();
    expect(sustainedLocationId([fix("shed", 0), fix("shed", 10)])).toBe("shed");
  });

  it("restarts at any reading that concluded something else", () => {
    expect(sustainedLocationId([fix("shed", 0), fix("home", 5), fix("shed", 20)])).toBeNull();
    expect(sustainedLocationId([fix("shed", 0), fix(null, 5), fix("shed", 20)])).toBeNull();
  });

  it("ignores a run that does not reach the newest reading", () => {
    expect(sustainedLocationId([fix("shed", 0), fix("shed", 30), fix("home", 40)])).toBeNull();
  });

  it("concludes nothing from a single reading", () => {
    expect(sustainedLocationId([fix("shed", 0)])).toBeNull();
    expect(sustainedLocationId([])).toBeNull();
  });
});

describe("sustainedRun", () => {
  it("names the run's own start — the oldest reading in the trailing agreeing run — not the newest", () => {
    // The own-trip arrival time for a phone-sustained arrival (the travel time model design note,
    // "Own trips (T2)", "Arrival") is this `startedAt`, not the moment the run was recognised.
    expect(sustainedRun([fix("shed", 0), fix("shed", 10)])).toEqual({ locationId: "shed", startedAt: at(0) });
  });

  it("is null under the same conditions sustainedLocationId is", () => {
    expect(sustainedRun([fix("shed", 0), fix("shed", 9)])).toBeNull();
    expect(sustainedRun([fix("shed", 0), fix("home", 5), fix("shed", 20)])).toBeNull();
    expect(sustainedRun([])).toBeNull();
  });

  it("agrees with sustainedLocationId's own locationId whenever both are non-null", () => {
    const run = sustainedRun([fix("shed", 0), fix("shed", 15), fix("shed", 30)]);
    expect(run?.locationId).toBe(sustainedLocationId([fix("shed", 0), fix("shed", 15), fix("shed", 30)]));
  });
});

describe("readingFreshness", () => {
  it("accepts a recent or slightly skewed reading and refuses old or future ones", () => {
    expect(readingFreshness(at(55), now)).toBe("ok"); // 5 min old
    expect(readingFreshness(at(0), now)).toBe("ok"); // 60 min old, on the limit
    expect(readingFreshness(new Date(now.getTime() + 60_000).toISOString(), now)).toBe("ok");
    expect(readingFreshness(new Date(now.getTime() - 61 * 60_000).toISOString(), now)).toBe("stale");
    expect(readingFreshness(new Date(now.getTime() + 3 * 3_600_000).toISOString(), now)).toBe("future");
  });
});

describe("sustained presence is measured on the server's clock", () => {
  // One burst: both readings reach the server at minute 20, but the sender dated them 11 minutes apart.
  const burst = (locationId: string, observedMinutes: number) =>
    observationRecord({
      match: matched(locationId),
      source: "phone",
      accuracyMeters: 12,
      observedAt: at(observedMinutes),
      recordedAt: at(20)
    });

  it("does not count a burst of readings dated minutes apart", () => {
    expect(sustainedRun([burst("shed", 9), burst("shed", 20)])).toBeNull();
    const outcome = decidePhonePing({
      match: matched("shed"),
      observations: [burst("shed", 9), burst("shed", 20)],
      currentLocationId: "home",
      observedAt: at(20),
      now: new Date(at(20)),
      accuracyMeters: 12
    });
    expect(outcome.decision).toBe("suggested");
    expect(outcome.assertLocationId).toBeNull();
  });

  it("counts readings the server received ten minutes apart, whatever their own dates say", () => {
    const received = (minutes: number) =>
      observationRecord({
        match: matched("shed"),
        source: "phone",
        accuracyMeters: 12,
        observedAt: at(20),
        recordedAt: at(minutes)
      });
    expect(sustainedRun([received(0), received(10)])).toEqual({ locationId: "shed", startedAt: at(20) });
  });

  it("breaks a run on a silence between receipts, not between the sender's dates", () => {
    const received = (minutes: number) =>
      observationRecord({
        match: matched("shed"),
        source: "phone",
        accuracyMeters: 12,
        observedAt: at(minutes > 30 ? 0 : minutes),
        recordedAt: at(minutes)
      });
    expect(sustainedRun([received(0), received(50)])).toEqual({ locationId: "shed", startedAt: at(0) });
    expect(sustainedRun([received(0), received(70)])).toBeNull();
  });
});

describe("coarse and gapped evidence", () => {
  const coarse = (locationId: string, minutes: number) =>
    observationRecord({
      match: matched(locationId),
      source: "phone",
      accuracyMeters: 5000,
      observedAt: at(minutes),
      recordedAt: at(minutes)
    });

  it("does not count a coarse fix towards sustained presence", () => {
    expect(sustainedRun([coarse("shed", 0), coarse("shed", 20)])).toBeNull();
    expect(sustainedRun([fix("shed", 0), coarse("shed", 20)])).toBeNull();
    expect(sustainedRun([coarse("shed", 0), fix("shed", 20)])).toBeNull();
  });

  it("breaks a run across a silence longer than the maximum gap", () => {
    expect(sustainedRun([fix("shed", 0), fix("shed", 61)])).toBeNull();
    expect(sustainedRun([fix("shed", 0), fix("shed", 60)])).toEqual({ locationId: "shed", startedAt: at(0) });
  });

  it("does not let a coarse fix refresh the assertion from the phone", () => {
    const outcome = decidePhonePing({
      match: matched("home"),
      observations: [coarse("home", 30)],
      currentLocationId: "home",
      observedAt: at(30),
      now,
      accuracyMeters: 5000
    });
    expect(outcome).toEqual({ decision: "suggested", assertLocationId: null, suggestion: "unchanged" });
  });

  it("does not let a coarse fix refresh the assertion from the browser", () => {
    const outcome = decideBrowserObservation({
      match: matched("home"),
      currentLocationId: "home",
      locationStale: false,
      hasLocations: true,
      observedAt: at(30),
      now,
      accuracyMeters: 5000
    });
    expect(outcome).toMatchObject({ decision: "ignored", assertLocationId: null, suggestion: "unchanged" });
  });
});

describe("decidePhonePing", () => {
  const ping = (match: LocationMatch, observations: DeviceObservationRecord[], currentLocationId: string | null) =>
    decidePhonePing({ match, observations, currentLocationId, observedAt: at(30), now });

  it("refreshes the clock when the reading agrees with the assertion", () => {
    const outcome = ping(matched("home"), [fix("home", 30)], "home");
    expect(outcome.decision).toBe("refreshed");
    expect(outcome.assertLocationId).toBe("home");
    expect(outcome.suggestion).toBe("clear");
  });

  it("moves the assertion once presence at somewhere else is sustained", () => {
    const outcome = ping(matched("shed"), [fix("shed", 15), fix("shed", 30)], "home");
    expect(outcome.decision).toBe("asserted");
    expect(outcome.assertLocationId).toBe("shed");
    expect(outcome.suggestion).toBe("clear");
  });

  it("only suggests a place it has just started seeing, so passing one does not move anything", () => {
    const outcome = ping(matched("shed", 31), [fix("home", 20), fix("shed", 30)], "home");
    expect(outcome.decision).toBe("suggested");
    expect(outcome.assertLocationId).toBeNull();
    expect(outcome.suggestion).toEqual({
      kind: "move",
      locationId: "shed",
      locationName: "shed",
      distanceMeters: 31,
      observedAt: at(30),
      suggestedAt: now.toISOString(),
      source: "phone"
    });
  });

  it("asserts a first-ever location once presence is sustained", () => {
    expect(ping(matched("home"), [fix("home", 15), fix("home", 30)], null).decision).toBe("asserted");
  });

  it("leaves a question rather than a guess when two places are in range", () => {
    const outcome = ping(ambiguous, [], "home");
    expect(outcome.decision).toBe("suggested");
    expect(outcome.assertLocationId).toBeNull();
    expect(outcome.suggestion).toMatchObject({ kind: "ambiguous", candidates: [place("home"), place("shed")] });
  });

  it("records being somewhere unsaved as its own question", () => {
    const outcome = ping(unmatched, [], "home");
    expect(outcome.decision).toBe("suggested");
    expect(outcome.suggestion).toMatchObject({ kind: "unknown", source: "phone" });
  });
});

describe("decideBrowserObservation", () => {
  const observe = (match: LocationMatch, currentLocationId: string | null, locationStale = false) =>
    decideBrowserObservation({
      match,
      currentLocationId,
      locationStale,
      hasLocations: true,
      observedAt: at(30),
      now
    });

  it("refreshes the clock when the tab confirms a fresh assertion", () => {
    const outcome = observe(matched("home", 24), "home");
    expect(outcome.decision).toBe("refreshed");
    expect(outcome.assertLocationId).toBe("home");
    expect(outcome.location).toEqual(place("home", 24));
  });

  it("never moves the assertion from a browser, however sustained the machine's opinion", () => {
    const outcome = observe(matched("shed", 61), "home");
    expect(outcome.decision).toBe("suggest");
    expect(outcome.assertLocationId).toBeNull();
    expect(outcome.location).toEqual(place("shed", 61));
    expect(outcome.suggestion).toMatchObject({ kind: "move", locationId: "shed", source: "browser" });
  });

  it("asks again rather than quietly reinstating an assertion that had gone stale", () => {
    const outcome = observe(matched("home"), "home", true);
    expect(outcome.decision).toBe("suggest");
    expect(outcome.assertLocationId).toBeNull();
    expect(outcome.location?.locationId).toBe("home");
  });

  it("suggests the place when nothing is asserted at all", () => {
    expect(observe(matched("home"), null).decision).toBe("suggest");
  });

  it("ignores a reading it cannot pin down, and leaves any standing question alone", () => {
    expect(observe(ambiguous, "home")).toMatchObject({
      decision: "ignored",
      reason: "ambiguous",
      location: null,
      suggestion: "unchanged"
    });
    expect(observe(unmatched, "home")).toMatchObject({ decision: "ignored", reason: "no_match" });
  });

  it("distinguishes having no saved places from being away from all of them", () => {
    const outcome = decideBrowserObservation({
      match: { kind: "none", toleranceMeters: 150, nearest: null },
      currentLocationId: null,
      locationStale: false,
      hasLocations: false,
      observedAt: at(30),
      now
    });
    expect(outcome.reason).toBe("no_locations");
  });
});

describe("nextSuggestion", () => {
  it("replaces, clears, or leaves the standing question alone", () => {
    const standing = {
      kind: "unknown" as const,
      observedAt: at(1),
      suggestedAt: at(1),
      source: "phone" as const
    };
    expect(nextSuggestion(standing, "unchanged")).toBe(standing);
    expect(nextSuggestion(standing, "clear")).toBeNull();
    const replacement = { ...standing, observedAt: at(2) };
    expect(nextSuggestion(standing, replacement)).toBe(replacement);
  });
});

describe("presence per device", () => {
  const PHONE_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
  const PHONE_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
  const fixOf = (device: string | undefined, locationId: string | null, minutes: number) => ({
    ...fix(locationId, minutes),
    ...(device ? { device } : {})
  });

  it("keeps the device on a reading and through a stored round trip, and drops a malformed id", () => {
    const record = observationRecord({
      match: matched("home"),
      source: "phone",
      accuracyMeters: 12,
      observedAt: at(0),
      recordedAt: at(0),
      device: PHONE_A
    });
    expect(record.device).toBe(PHONE_A);
    const state = parseDeviceLocationState({ observations: [record, { ...record, device: "NOT VALID" }] });
    expect(state.observations.map((entry) => entry.device)).toEqual([PHONE_A, undefined]);
  });

  it("does not let one phone's readings break or complete another's run", () => {
    // Phone A is at home for ten minutes; phone B reports somewhere else in between.
    const trail = [
      fixOf(PHONE_A, "home", 0),
      fixOf(PHONE_B, "work", 3),
      fixOf(PHONE_A, "home", 5),
      fixOf(PHONE_B, "work", 8),
      fixOf(PHONE_A, "home", 10)
    ];
    expect(sustainedLocationId(trail)).toBeNull();
    expect(sustainedLocationId(observationsOfDevice(trail, PHONE_A))).toBe("home");
    expect(sustainedLocationId(observationsOfDevice(trail, PHONE_B))).toBeNull();
    // A ping with no device reads only the device-less readings, as it always did.
    expect(observationsOfDevice(trail, undefined)).toEqual([]);
  });

  it("two phones that agree still need their own ten minutes each", () => {
    const trail = [fixOf(PHONE_A, "home", 0), fixOf(PHONE_B, "home", 6), fixOf(PHONE_B, "home", 11)];
    expect(sustainedLocationId(observationsOfDevice(trail, PHONE_A))).toBeNull();
    expect(sustainedLocationId(observationsOfDevice(trail, PHONE_B))).toBeNull();
  });

  it("caps the history per device, so a busy phone cannot push another's run out", () => {
    let observations: DeviceObservationRecord[] = [fixOf(PHONE_B, "home", 0)];
    for (let index = 1; index <= DEVICE_LOCATION_HISTORY_LIMIT + 5; index += 1)
      observations = appendObservation({ observations, suggestion: null }, fixOf(PHONE_A, "home", index));
    expect(observationsOfDevice(observations, PHONE_A)).toHaveLength(DEVICE_LOCATION_HISTORY_LIMIT);
    expect(observationsOfDevice(observations, PHONE_B)).toHaveLength(1);
  });
});
