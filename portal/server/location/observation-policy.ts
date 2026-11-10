import { DEVICE_INSTALL_ID_PATTERN } from "@openrhen/contracts";
import type { LocationMatch, NearbyLocation } from "./nearest-location";

/**
 * What a coordinate reading is allowed to do to the assertion.
 *
 * The assertion — `current_situation.locationId` — is a statement the person made about where they
 * are, and every location-derived capability hangs off it. A reading is evidence, not a statement,
 * so the rules are asymmetric on purpose:
 *
 * - Evidence that **agrees** with the assertion refreshes its staleness clock. Nothing moves, and
 *   the person stops being asked to re-confirm a place they demonstrably have not left.
 * - Evidence that **disagrees** moves the assertion only from the phone, and only once presence at
 *   the new place has been sustained for {@link SUSTAINED_PRESENCE_MINUTES}. One fix is a fix; a
 *   run of them over ten minutes is arriving somewhere. Passing a saved place in a car produces the
 *   first and not the second.
 * - Everything else — a single disagreeing reading, an ambiguous one, a reading matching nothing —
 *   leaves a pending suggestion for the interface to raise as a question later. The portal asks; it
 *   does not decide.
 * - A reading from the **browser** never moves the assertion at all, however convincing. The tab is
 *   open on whatever machine happens to be in front of the person, and one of them lives on a desk.
 *
 * Both endpoints share these rules; the routes are two thin doors onto this one module.
 */

/** How long a run of agreeing phone fixes must span before it counts as being somewhere. */
export const SUSTAINED_PRESENCE_MINUTES = 10;

/**
 * How many readings are kept. Enough to see a sustained arrival at any plausible ping interval,
 * short enough that the row stays small and yesterday leaves on its own.
 */
export const DEVICE_LOCATION_HISTORY_LIMIT = 20;

/**
 * How many distinct `device` ids the trail keeps. A caller holding the shared location token chooses its own device
 * id, so without a bound it could grow the row without limit; past this the least recently heard-from device goes.
 */
export const MAX_TRACKED_DEVICES = 16;

/**
 * How far from the server's clock a reading's own `observedAt` may be. A phone may queue pings
 * through a blackspot and deliver them later, but not for hours: a reading older than this would
 * re-stamp "now" onto a place the household may have left long ago. A reading dated in the future
 * (a wrong phone clock) would become the permanent "newest" and be judged against forever, so only
 * a little clock skew is forgiven.
 */
export const MAX_READING_AGE_MINUTES = 60;
export const MAX_READING_FUTURE_SKEW_MINUTES = 5;

/**
 * Coarsest accuracy at which a reading that merely lands inside a saved place may refresh the
 * assertion or count towards sustained presence. A 5 km cell-tower fix that happens to cover exactly
 * one saved place is a match by the tolerance rule, but it is not evidence of being there.
 */
export const MAX_ASSERTING_ACCURACY_METERS = 500;

/** Two agreeing fixes further apart than this are two visits, not one stay. */
export const MAX_SUSTAINED_GAP_MINUTES = 60;

export class StaleLocationReadingError extends Error {
  constructor(readonly reason: "stale" | "future") {
    super(
      reason === "stale"
        ? "The location reading is too old to be used."
        : "The location reading is dated in the future."
    );
  }
}

/** Whether a reading's own timestamp is close enough to receipt time to be evidence of where we are. */
export function readingFreshness(observedAt: string, now: Date): "ok" | "stale" | "future" {
  const ageMinutes = (now.getTime() - Date.parse(observedAt)) / 60_000;
  if (ageMinutes > MAX_READING_AGE_MINUTES) return "stale";
  if (ageMinutes < -MAX_READING_FUTURE_SKEW_MINUTES) return "future";
  return "ok";
}

export type ObservationSource = "phone" | "browser";

/**
 * One reading, reduced to what it concluded. The coordinates that produced it are not kept — the
 * policy never reads them back, and a stored track would be the one genuinely sensitive thing in
 * this database.
 */
export interface DeviceObservationRecord {
  /**
   * The install id of the phone that sent it, when it named one (its owner token's device, or the ping's `device`).
   * Presence is read per device, so two phones cannot break each other's run. Absent for the browser and for a ping
   * that came in on the shared location token without a device.
   */
  device?: string;
  /** The device's clock at the moment of the fix. Orders the trail; never measures presence. */
  observedAt: string;
  /** The server's clock when it arrived. Sustained presence is measured on this, not on `observedAt`. */
  recordedAt: string;
  source: ObservationSource;
  accuracyMeters: number;
  match:
    | { kind: "matched"; locationId: string; distanceMeters: number }
    | { kind: "ambiguous"; locationIds: string[] }
    | { kind: "none" };
}

/**
 * A question waiting to be put to the person. At most one is held: a newer reading supersedes an
 * older question rather than queueing behind it, because the only useful prompt is about now.
 */
export type PendingLocationSuggestion = {
  observedAt: string;
  suggestedAt: string;
  source: ObservationSource;
} & (
  | { kind: "move"; locationId: string; locationName: string; distanceMeters: number }
  | { kind: "ambiguous"; candidates: NearbyLocation[] }
  | { kind: "unknown" }
);

export interface DeviceLocationState {
  /** Oldest first, capped at {@link DEVICE_LOCATION_HISTORY_LIMIT}. */
  observations: DeviceObservationRecord[];
  suggestion: PendingLocationSuggestion | null;
  /**
   * When the server last accepted a phone ping (ISO instant, server receipt time, never the device's
   * `observedAt`, no coordinates). Server-side only: nothing in `/api/state` reads it.
   */
  lastPhonePingAt?: string;
  /** When Doctor first saw a ping token configured (ISO); dates the "set up but never pinged" check. Server-side only. */
  pingTokenSeenAt?: string;
}

/**
 * What the caller must do with the stored suggestion: replace it, clear it, or leave it standing.
 * "Leave it standing" is a real third case — an ambiguous browser reading is no reason to throw away
 * a question the phone raised a minute ago.
 */
export type SuggestionEffect = PendingLocationSuggestion | "clear" | "unchanged";

export function emptyDeviceLocationState(): DeviceLocationState {
  return { observations: [], suggestion: null };
}

/**
 * Reads the stored jsonb back, dropping anything malformed rather than throwing. A column written by
 * an older build must never be able to stop a ping from being answered.
 */
export function parseDeviceLocationState(value: unknown): DeviceLocationState {
  if (!value || typeof value !== "object") return emptyDeviceLocationState();
  const raw = value as Record<string, unknown>;
  const observations = Array.isArray(raw.observations)
    ? raw.observations.flatMap((entry) => {
        const record = parseObservation(entry);
        return record ? [record] : [];
      })
    : [];
  const state: DeviceLocationState = { observations, suggestion: parseSuggestion(raw.suggestion) };
  if (typeof raw.lastPhonePingAt === "string" && !Number.isNaN(Date.parse(raw.lastPhonePingAt)))
    state.lastPhonePingAt = raw.lastPhonePingAt;
  if (typeof raw.pingTokenSeenAt === "string" && !Number.isNaN(Date.parse(raw.pingTokenSeenAt)))
    state.pingTokenSeenAt = raw.pingTokenSeenAt;
  return state;
}

function observationSource(value: unknown): ObservationSource | null {
  return value === "phone" || value === "browser" ? value : null;
}

function parseObservation(value: unknown): DeviceObservationRecord | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const source = observationSource(raw.source);
  if (typeof raw.observedAt !== "string" || typeof raw.recordedAt !== "string" || source === null) return null;
  if (typeof raw.accuracyMeters !== "number") return null;
  const match = raw.match as Record<string, unknown> | undefined;
  if (!match || typeof match !== "object") return null;
  const base = {
    ...(typeof raw.device === "string" && DEVICE_INSTALL_ID_PATTERN.test(raw.device) ? { device: raw.device } : {}),
    observedAt: raw.observedAt,
    recordedAt: raw.recordedAt,
    source,
    accuracyMeters: raw.accuracyMeters
  };
  if (match.kind === "matched" && typeof match.locationId === "string" && typeof match.distanceMeters === "number")
    return { ...base, match: { kind: "matched", locationId: match.locationId, distanceMeters: match.distanceMeters } };
  if (match.kind === "ambiguous" && Array.isArray(match.locationIds))
    return {
      ...base,
      match: { kind: "ambiguous", locationIds: match.locationIds.filter((id): id is string => typeof id === "string") }
    };
  if (match.kind === "none") return { ...base, match: { kind: "none" } };
  return null;
}

function parseSuggestion(value: unknown): PendingLocationSuggestion | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const source = observationSource(raw.source);
  if (typeof raw.observedAt !== "string" || typeof raw.suggestedAt !== "string" || source === null) return null;
  const base = { observedAt: raw.observedAt, suggestedAt: raw.suggestedAt, source };
  if (raw.kind === "move" && typeof raw.locationId === "string" && typeof raw.locationName === "string")
    return {
      ...base,
      kind: "move",
      locationId: raw.locationId,
      locationName: raw.locationName,
      distanceMeters: typeof raw.distanceMeters === "number" ? raw.distanceMeters : 0
    };
  if (raw.kind === "ambiguous" && Array.isArray(raw.candidates))
    return {
      ...base,
      kind: "ambiguous",
      candidates: raw.candidates.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const candidate = entry as Record<string, unknown>;
        return typeof candidate.locationId === "string" && typeof candidate.locationName === "string"
          ? [
              {
                locationId: candidate.locationId,
                locationName: candidate.locationName,
                distanceMeters: typeof candidate.distanceMeters === "number" ? candidate.distanceMeters : 0
              }
            ]
          : [];
      })
    };
  if (raw.kind === "unknown") return { ...base, kind: "unknown" };
  return null;
}

/** Converts a match into the form the history keeps. */
export function observationRecord(args: {
  match: LocationMatch;
  source: ObservationSource;
  accuracyMeters: number;
  observedAt: string;
  recordedAt: string;
  device?: string;
}): DeviceObservationRecord {
  const base = {
    ...(args.device ? { device: args.device } : {}),
    observedAt: args.observedAt,
    recordedAt: args.recordedAt,
    source: args.source,
    accuracyMeters: args.accuracyMeters
  };
  if (args.match.kind === "matched")
    return {
      ...base,
      match: {
        kind: "matched",
        locationId: args.match.location.locationId,
        distanceMeters: args.match.location.distanceMeters
      }
    };
  if (args.match.kind === "ambiguous")
    return {
      ...base,
      match: { kind: "ambiguous", locationIds: args.match.candidates.map((candidate) => candidate.locationId) }
    };
  return { ...base, match: { kind: "none" } };
}

/**
 * Appends a reading and trims to the cap, per device: each phone keeps its own {@link DEVICE_LOCATION_HISTORY_LIMIT}
 * readings, and the browser and a ping with no device share one more, so a busy phone cannot push another's run out.
 * Sorted by the device's clock rather than by arrival, so a ping queued through a signal blackspot lands in the run it
 * actually belongs to instead of looking like a fresh arrival at the moment the phone got signal back.
 */
export function appendObservation(
  state: DeviceLocationState,
  record: DeviceObservationRecord
): DeviceObservationRecord[] {
  const sorted = [...state.observations, record].sort(
    (left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt)
  );
  const kept = new Map<string, number>();
  const keep = sorted.map(() => false);
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const key = sorted[index]!.device ?? "";
    const count = kept.get(key) ?? 0;
    if (count < DEVICE_LOCATION_HISTORY_LIMIT) {
      keep[index] = true;
      kept.set(key, count + 1);
    }
  }
  const trimmed = sorted.filter((_, index) => keep[index]);
  const lastHeard = new Map<string, number>();
  for (const entry of trimmed) if (entry.device) lastHeard.set(entry.device, Date.parse(entry.observedAt));
  if (lastHeard.size <= MAX_TRACKED_DEVICES) return trimmed;
  const dropped = new Set(
    [...lastHeard.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(MAX_TRACKED_DEVICES)
      .map(([device]) => device)
  );
  return trimmed.filter((entry) => !entry.device || !dropped.has(entry.device));
}

/** The readings one phone sent (`device` undefined: the browser's and the device-less pings'), for the presence rule. */
export function observationsOfDevice(
  observations: readonly DeviceObservationRecord[],
  device: string | undefined
): DeviceObservationRecord[] {
  return observations.filter((entry) => entry.device === device);
}

export interface SustainedRun {
  locationId: string;
  /** The oldest reading's own clock in the run — when the sustained presence actually began, which
   * is the arrival time an own trip records for a phone-sustained arrival
   * (the travel time model design note, "Own trips (T2)", "Arrival"). */
  startedAt: string;
}

/**
 * The trailing run of readings that agree on a place, if that run spans long enough to be presence.
 *
 * The run is read backwards from the newest reading and breaks at the first reading that concluded
 * anything else, so one ambiguous fix mid-run restarts the clock. Readings are not required to be
 * all close together, but no two neighbours may be more than {@link MAX_SUSTAINED_GAP_MINUTES} apart,
 * and fixes coarser than {@link MAX_ASSERTING_ACCURACY_METERS} do not count. The span rule exists to
 * stop a single drive-by fix from counting. Gap and span are read on the server's `recordedAt`, not the
 * device's `observedAt`: the sender picks that one, so it cannot be what proves ten minutes passed.
 */
export function sustainedRun(
  observations: readonly DeviceObservationRecord[],
  minimumMinutes = SUSTAINED_PRESENCE_MINUTES
): SustainedRun | null {
  const newest = observations.at(-1);
  if (!newest || newest.match.kind !== "matched") return null;
  if (newest.accuracyMeters > MAX_ASSERTING_ACCURACY_METERS) return null;
  const locationId = newest.match.locationId;
  let oldest = newest;
  for (let index = observations.length - 2; index >= 0; index -= 1) {
    const entry = observations[index]!;
    if (entry.match.kind !== "matched" || entry.match.locationId !== locationId) break;
    // A coarse fix inside the place proves nothing about staying there, and a long silence between
    // two agreeing fixes means the run was broken by time the trail does not cover.
    if (entry.accuracyMeters > MAX_ASSERTING_ACCURACY_METERS) break;
    const gapMinutes = (Date.parse(oldest.recordedAt) - Date.parse(entry.recordedAt)) / 60_000;
    if (gapMinutes > MAX_SUSTAINED_GAP_MINUTES) break;
    oldest = entry;
  }
  const spanMinutes = (Date.parse(newest.recordedAt) - Date.parse(oldest.recordedAt)) / 60_000;
  return spanMinutes >= minimumMinutes ? { locationId, startedAt: oldest.observedAt } : null;
}

/** The place the trailing run of readings agrees on, if that run spans long enough to be presence. */
export function sustainedLocationId(
  observations: readonly DeviceObservationRecord[],
  minimumMinutes = SUSTAINED_PRESENCE_MINUTES
): string | null {
  return sustainedRun(observations, minimumMinutes)?.locationId ?? null;
}

export interface PingOutcome {
  decision: "asserted" | "refreshed" | "suggested";
  /**
   * Written back through the situation write path, which is what refreshes the staleness clock;
   * `null` leaves the assertion untouched. Re-asserting the place already held is exactly what the
   * "still here" button in Settings does, so agreement and arrival share one mechanism.
   */
  assertLocationId: string | null;
  suggestion: SuggestionEffect;
}

/**
 * The phone's rule. `observations` must already include the reading being decided on, because
 * whether it is sustained is a fact about the run it completes, not about the reading alone.
 */
export function decidePhonePing(args: {
  match: LocationMatch;
  observations: readonly DeviceObservationRecord[];
  currentLocationId: string | null;
  observedAt: string;
  now: Date;
  source?: ObservationSource;
  /** The newest reading's own accuracy; a coarse fix may not refresh the assertion. */
  accuracyMeters?: number;
}): PingOutcome {
  const source = args.source ?? "phone";
  const context = { observedAt: args.observedAt, suggestedAt: args.now.toISOString(), source };
  if (args.match.kind === "ambiguous")
    return {
      decision: "suggested",
      assertLocationId: null,
      suggestion: { ...context, kind: "ambiguous", candidates: args.match.candidates }
    };
  if (args.match.kind === "none")
    return { decision: "suggested", assertLocationId: null, suggestion: { ...context, kind: "unknown" } };
  const matched = args.match.location;
  if ((args.accuracyMeters ?? 0) > MAX_ASSERTING_ACCURACY_METERS && matched.locationId === args.currentLocationId)
    return { decision: "suggested", assertLocationId: null, suggestion: "unchanged" };
  // Agreement is the common case and the cheap one: the clock moves and the pending question, if
  // any, is answered by the evidence rather than left waiting for the person.
  if (matched.locationId === args.currentLocationId)
    return { decision: "refreshed", assertLocationId: matched.locationId, suggestion: "clear" };
  if (sustainedLocationId(args.observations) === matched.locationId)
    return { decision: "asserted", assertLocationId: matched.locationId, suggestion: "clear" };
  return {
    decision: "suggested",
    assertLocationId: null,
    suggestion: {
      ...context,
      kind: "move",
      locationId: matched.locationId,
      locationName: matched.locationName,
      distanceMeters: matched.distanceMeters
    }
  };
}

export interface ObserveOutcome {
  decision: "refreshed" | "suggest" | "ignored";
  location: NearbyLocation | null;
  reason: "ambiguous" | "no_match" | "no_locations" | null;
  assertLocationId: string | null;
  suggestion: SuggestionEffect;
}

/**
 * The browser's rule, for a single reading from an open tab.
 *
 * A stale assertion is treated as disagreement even when the reading matches it. Staleness means the
 * portal has already stopped trusting the place, and silently reinstating it from a desktop machine
 * that never moves would defeat the expiry entirely — so the person is asked instead.
 */
export function decideBrowserObservation(args: {
  match: LocationMatch;
  currentLocationId: string | null;
  locationStale: boolean;
  hasLocations: boolean;
  observedAt: string;
  now: Date;
  /** The reading's own accuracy; a coarse fix may not refresh the assertion. */
  accuracyMeters?: number;
}): ObserveOutcome {
  const context = { observedAt: args.observedAt, suggestedAt: args.now.toISOString(), source: "browser" as const };
  if (args.match.kind === "ambiguous")
    return {
      decision: "ignored",
      location: null,
      reason: "ambiguous",
      assertLocationId: null,
      suggestion: "unchanged"
    };
  if (args.match.kind === "none")
    return {
      decision: "ignored",
      location: null,
      reason: args.hasLocations ? "no_match" : "no_locations",
      assertLocationId: null,
      suggestion: "unchanged"
    };
  const matched = args.match.location;
  if (
    matched.locationId === args.currentLocationId &&
    !args.locationStale &&
    (args.accuracyMeters ?? 0) > MAX_ASSERTING_ACCURACY_METERS
  )
    return { decision: "ignored", location: null, reason: "no_match", assertLocationId: null, suggestion: "unchanged" };
  if (matched.locationId === args.currentLocationId && !args.locationStale)
    return {
      decision: "refreshed",
      location: matched,
      reason: null,
      assertLocationId: matched.locationId,
      suggestion: "clear"
    };
  return {
    decision: "suggest",
    location: matched,
    reason: null,
    assertLocationId: null,
    suggestion: {
      ...context,
      kind: "move",
      locationId: matched.locationId,
      locationName: matched.locationName,
      distanceMeters: matched.distanceMeters
    }
  };
}

/** Applies a {@link SuggestionEffect} to what is stored. */
export function nextSuggestion(
  current: PendingLocationSuggestion | null,
  effect: SuggestionEffect
): PendingLocationSuggestion | null {
  if (effect === "unchanged") return current;
  if (effect === "clear") return null;
  return effect;
}
