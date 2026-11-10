import { DEFAULT_LOCATION_STALE_AFTER_MINUTES, resolveSituation, type LocationObservation } from "@openrhen/contracts";
import { notifyStateChanged } from "@openrhen/database";
import { nextCurrentSituation, parseCurrentSituation } from "@/server/persistence/postgres/current-situation";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { recordStateChange } from "@/server/persistence/postgres/planning-evidence";
import { skipMootRoutineSteps } from "@/server/persistence/postgres/routine-step-arrival";
import { sqlPool, type PoolSql, type TxSql } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";
import { recordOwnTripOnArrival } from "@/server/travel/own-trip";
import { matchNearestLocation, type LocationCandidate } from "./nearest-location";
import {
  appendObservation,
  decideBrowserObservation,
  decidePhonePing,
  nextSuggestion,
  observationRecord,
  observationsOfDevice,
  parseDeviceLocationState,
  readingFreshness,
  StaleLocationReadingError,
  sustainedRun,
  type ObservationSource,
  type ObserveOutcome,
  type PendingLocationSuggestion,
  type PingOutcome
} from "./observation-policy";

/**
 * The one place a coordinate reading meets the database.
 *
 * Both endpoints land here so that the matcher, the policy and the assertion write path cannot drift
 * apart between them. The assertion itself is never written directly: it goes through
 * `nextCurrentSituation`, the same function the Settings panel's command runs, so a device-driven
 * arrival clears momentary overrides and reseeds the return leg exactly as a hand-picked one does.
 */

export interface PingResult {
  decision: PingOutcome["decision"];
  locationId: string | null;
  locationName: string | null;
  suggestion: PendingLocationSuggestion | null;
}

/**
 * The browser's answer. Kept flat and small on purpose — the client prompts from it directly.
 *
 * - `refreshed`: the reading agrees with the assertion, whose staleness clock has been pushed
 *   forward. `locationId`/`locationName`/`distanceMeters` describe the place confirmed.
 * - `suggest`: the reading points somewhere else, or the assertion had gone stale. Nothing was
 *   written to the assertion; the three location fields describe what to offer the person.
 * - `ignored`: nothing could be concluded. `reason` says why and the location fields are null.
 */
export interface ObserveResult {
  decision: ObserveOutcome["decision"];
  locationId: string | null;
  locationName: string | null;
  distanceMeters: number | null;
  reason: ObserveOutcome["reason"];
}

function assertReadingFresh(observedAt: string, now: Date): void {
  const freshness = readingFreshness(observedAt, now);
  if (freshness !== "ok") throw new StaleLocationReadingError(freshness);
}

export class LocationObservationStore {
  constructor(private readonly sql: PoolSql) {}

  /**
   * A reading from the phone, which may move the assertion once presence is sustained. `device` is the phone's install
   * id when it named one; sustained presence is then read over that phone's readings only.
   */
  async recordPhonePing(observation: LocationObservation, now = new Date(), device?: string): Promise<PingResult> {
    assertReadingFresh(observation.observedAt, now);
    const userId = await ensureUser(this.sql);
    let result: PingResult = { decision: "suggested", locationId: null, locationName: null, suggestion: null };
    await this.sql.begin(async (tx) => {
      const context = await readContext(tx, userId);
      const match = matchNearestLocation(observation, context.candidates);
      const record = observationRecord({
        match,
        source: "phone",
        accuracyMeters: observation.accuracyMeters,
        observedAt: observation.observedAt,
        recordedAt: now.toISOString(),
        ...(device ? { device } : {})
      });
      const observations = appendObservation(context.device, record);
      const ofThisPhone = observationsOfDevice(observations, device);
      const outcome = decidePhonePing({
        match,
        observations: ofThisPhone,
        currentLocationId: context.situation.locationId,
        observedAt: observation.observedAt,
        now,
        accuracyMeters: observation.accuracyMeters
      });
      const suggestion = nextSuggestion(context.device.suggestion, outcome.suggestion);
      // A phone-sustained arrival's own trip is recorded from when the sustained run actually began,
      // not from now (the travel time model design note, "Own trips (T2)", "Arrival") — `outcome`'s
      // own "asserted" decision is exactly the sustained-run case (`decidePhonePing` above).
      const ownTripArrivedAt =
        outcome.decision === "asserted" && outcome.assertLocationId
          ? new Date(sustainedRun(ofThisPhone)?.startedAt ?? now.toISOString())
          : now;
      await write(
        tx,
        userId,
        context,
        { observations, suggestion, lastPhonePingAt: now.toISOString() },
        outcome.assertLocationId,
        "phone",
        now,
        ownTripArrivedAt
      );
      result = {
        decision: outcome.decision,
        locationId: outcome.assertLocationId,
        locationName: outcome.assertLocationId ? (context.names.get(outcome.assertLocationId) ?? null) : null,
        suggestion
      };
    });
    // Every reading rewrites `device_location_state` at minimum, and that field is where
    // `pendingLocationSuggestion` in `/api/state` comes from — so even a ping that never moves the
    // assertion can still be worth an open tab reloading for (a new or cleared suggestion banner).
    notifyStateChanged(this.sql, { userId, kind: "state" });
    return result;
  }

  /** A reading from the open tab, which may confirm the assertion but never moves it. */
  async recordBrowserObservation(observation: LocationObservation, now = new Date()): Promise<ObserveResult> {
    assertReadingFresh(observation.observedAt, now);
    const userId = await ensureUser(this.sql);
    let result: ObserveResult = {
      decision: "ignored",
      locationId: null,
      locationName: null,
      distanceMeters: null,
      reason: "no_match"
    };
    await this.sql.begin(async (tx) => {
      const context = await readContext(tx, userId);
      const match = matchNearestLocation(observation, context.candidates);
      const record = observationRecord({
        match,
        source: "browser",
        accuracyMeters: observation.accuracyMeters,
        observedAt: observation.observedAt,
        recordedAt: now.toISOString()
      });
      const outcome = decideBrowserObservation({
        match,
        currentLocationId: context.situation.locationId,
        // The contract's own staleness rule, so the browser and the Now panel can never disagree
        // about whether the stored assertion is still worth anything. Only the situation feeds it.
        // Shared with `write()`'s own staleness check below rather than computed twice.
        locationStale: locationStaleAt(context, now),
        hasLocations: context.candidates.length > 0,
        observedAt: observation.observedAt,
        now,
        accuracyMeters: observation.accuracyMeters
      });
      await write(
        tx,
        userId,
        context,
        {
          observations: appendObservation(context.device, record),
          suggestion: nextSuggestion(context.device.suggestion, outcome.suggestion)
        },
        outcome.assertLocationId,
        "browser",
        now
      );
      result = {
        decision: outcome.decision,
        locationId: outcome.location?.locationId ?? null,
        locationName: outcome.location?.locationName ?? null,
        distanceMeters: outcome.location?.distanceMeters ?? null,
        reason: outcome.reason
      };
    });
    notifyStateChanged(this.sql, { userId, kind: "state" });
    return result;
  }

  /**
   * Dismisses a pending suggestion without touching the assertion. The only other thing that ever
   * clears one is a later reading answering it, so this is the one path where the person answers it
   * themselves by declining rather than confirming.
   */
  async clearSuggestion(): Promise<void> {
    const userId = await ensureUser(this.sql);
    await this.sql.begin(async (tx) => {
      const context = await readContext(tx, userId);
      await write(
        tx,
        userId,
        context,
        { observations: context.device.observations, suggestion: null },
        null,
        undefined,
        new Date()
      );
    });
    notifyStateChanged(this.sql, { userId, kind: "state" });
  }
}

interface ObservationContext {
  situation: ReturnType<typeof parseCurrentSituation>;
  device: ReturnType<typeof parseDeviceLocationState>;
  staleAfterMinutes: number;
  candidates: LocationCandidate[];
  names: Map<string, string>;
}

/**
 * Everything the decision needs, read under `FOR UPDATE` so two pings arriving together cannot each
 * decide against the same history and write over one another's.
 */
async function readContext(tx: TxSql, userId: string): Promise<ObservationContext> {
  const rows = await tx<
    { current_situation: unknown; device_location_state: unknown }[]
  >`SELECT current_situation, device_location_state FROM user_preferences WHERE user_id=${userId} FOR UPDATE`;
  // One-off places are deliberately included, unlike everywhere a person picks a place by hand. The
  // dentist a commitment was quietly created for is exactly where knowing you have arrived matters
  // most, and hiding it here would leave the phone unable to confirm the one place on today's plan.
  // They archive themselves once nothing upcoming refers to them, and `status='active'` drops them
  // then, so nowhere the person visited once stays a candidate forever.
  const places = await tx<{ id: string; name: string; latitude: string | number; longitude: string | number }[]>`
    SELECT id, name, latitude, longitude FROM condition_definitions
    WHERE user_id=${userId} AND kind='location' AND status='active'
      AND latitude IS NOT NULL AND longitude IS NOT NULL
  `;
  const candidates = places.map((place) => ({
    id: place.id,
    name: place.name,
    latitude: Number(place.latitude),
    longitude: Number(place.longitude)
  }));
  return {
    situation: parseCurrentSituation(rows[0]?.current_situation),
    device: parseDeviceLocationState(rows[0]?.device_location_state),
    // Was a per-user column nothing could ever write (no portal form, no CLI field) and was always
    // 480; dropped, so the constant is now the only value there is.
    staleAfterMinutes: DEFAULT_LOCATION_STALE_AFTER_MINUTES,
    candidates,
    names: new Map(candidates.map((candidate) => [candidate.id, candidate.name]))
  };
}

/** The contract's own staleness rule for the situation stored in `context`, at `now`, before any write. */
function locationStaleAt(context: ObservationContext, now: Date): boolean {
  return resolveSituation({
    situation: context.situation,
    definitions: [],
    now,
    staleAfterMinutes: context.staleAfterMinutes
  }).locationStale;
}

/**
 * One statement for both the device evidence and, when the policy allowed it, the assertion.
 *
 * A same-place reading that was already fresh changes nothing the plan or a settings save can see
 * (invariant 4, the one write path design note): it writes `current_situation` (for the newer
 * `locationSetAt`) and `device_location_state`, but bumps no `version`, skips no routine step and logs
 * nothing. Everything else that asserts a place — a place change (including from nothing), or a
 * same-place reading that was stale — bumps `version`, skips the arrived-at commitment's leftover
 * "before" steps only when the place itself changed, and calls `recordStateChange` once so the write
 * is both logged and recalculated together (the one write path). `source` is the reading's own origin;
 * `clearSuggestion`'s call never asserts, so it passes none.
 */
async function write(
  tx: TxSql,
  userId: string,
  context: ObservationContext,
  device: ReturnType<typeof parseDeviceLocationState>,
  assertLocationId: string | null,
  source: ObservationSource | undefined,
  now: Date,
  /**
   * When an own trip should say arrival happened, if not `now` — a phone-sustained arrival's own
   * trip is recorded from when the sustained run actually began (the travel time model design note,
   * "Own trips (T2)", "Arrival"), which `recordPhonePing` computes and passes in; every other caller
   * leaves this at `now`, the moment the write itself happens.
   */
  ownTripArrivedAt: Date = now
): Promise<void> {
  // Only a phone ping stamps `lastPhonePingAt`; every other writer carries the stored stamp forward.
  const stamp = device.lastPhonePingAt ?? context.device.lastPhonePingAt;
  if (stamp !== undefined) device = { ...device, lastPhonePingAt: stamp };
  const seen = device.pingTokenSeenAt ?? context.device.pingTokenSeenAt;
  if (seen !== undefined) device = { ...device, pingTokenSeenAt: seen };
  if (assertLocationId === null) {
    await tx`UPDATE user_preferences SET device_location_state=${tx.json(device as never)},updated_at=CURRENT_TIMESTAMP WHERE user_id=${userId}`;
    return;
  }
  const previousLocationId = context.situation.locationId;
  const samePlace = assertLocationId === previousLocationId;
  const staleBefore = locationStaleAt(context, now);
  const situation = nextCurrentSituation(context.situation, { locationId: assertLocationId });
  if (samePlace && !staleBefore) {
    await tx`UPDATE user_preferences SET current_situation=${tx.json(situation as never)},device_location_state=${tx.json(device as never)},updated_at=CURRENT_TIMESTAMP WHERE user_id=${userId}`;
    return;
  }
  await tx`UPDATE user_preferences SET current_situation=${tx.json(situation as never)},device_location_state=${tx.json(device as never)},version=version+1,updated_at=CURRENT_TIMESTAMP WHERE user_id=${userId}`;
  // A phone or browser reading that actually moved the assertion is the same "arrival wins" moment a
  // hand-picked location gets (entity-commands.ts) — see routine-step-arrival.ts. A
  // reading that only refreshed staleness on the same place changes nothing here to re-skip.
  let matchedCommitmentIds: string[] = [];
  let skippedStepIds: string[] = [];
  if (!samePlace) {
    const skip = await skipMootRoutineSteps(tx, userId, assertLocationId, now, { previousLocationId });
    matchedCommitmentIds = skip.matchedCommitmentIds;
    skippedStepIds = skip.skippedStepIds;
    // Own trips (the travel time model design note, "Own trips (T2)"): recorded inside this same
    // transaction, before the one recordStateChange call below, never adding a call of its own.
    if (previousLocationId)
      await recordOwnTripOnArrival(tx, userId, {
        fromLocationId: previousLocationId,
        fromLocationSetAt: context.situation.locationSetAt,
        toLocationId: assertLocationId,
        transportModes: situation.transportModes,
        arrivedAt: ownTripArrivedAt,
        underwayFromLocationId: context.situation.underway?.fromLocationId ?? null,
        underwayDepartedAt: context.situation.underway?.departedAt ?? null
      });
  }
  await recordStateChange(tx, userId, {
    entityType: "current_situation",
    entityId: assertLocationId,
    operation: "observe",
    at: now,
    evidence: { source, previousLocationId, staleBefore, matchedCommitmentIds, skippedStepIds }
  });
}

/** When the server last accepted a phone ping for this user, or null if it never has. */
export async function readLastPhonePingAt(sql: PoolSql, userId: string): Promise<Date | null> {
  const rows = await sql<
    { device_location_state: unknown }[]
  >`SELECT device_location_state FROM user_preferences WHERE user_id=${userId}`;
  const stamp = parseDeviceLocationState(rows[0]?.device_location_state).lastPhonePingAt;
  return stamp ? new Date(stamp) : null;
}

/**
 * When a configured ping token was first seen, stamping now if no stamp exists yet. Nothing else dates the token (it is
 * an environment setting), and Doctor needs the date to tell "set up yesterday" from "set up and never used".
 */
export async function ensurePingTokenSeenAt(
  sql: PoolSql,
  userId: string,
  now: Date = new Date()
): Promise<Date | null> {
  const rows = await sql<{ device_location_state: unknown }[]>`
    UPDATE user_preferences
    SET device_location_state = jsonb_set(COALESCE(device_location_state, '{}'::jsonb), '{pingTokenSeenAt}', to_jsonb(${now.toISOString()}::text))
    WHERE user_id = ${userId} AND COALESCE(device_location_state, '{}'::jsonb) -> 'pingTokenSeenAt' IS NULL
    RETURNING device_location_state`;
  if (rows[0]) return now;
  const existing = await sql<
    { device_location_state: unknown }[]
  >`SELECT device_location_state FROM user_preferences WHERE user_id=${userId}`;
  const stamp = parseDeviceLocationState(existing[0]?.device_location_state).pingTokenSeenAt;
  return stamp ? new Date(stamp) : null;
}

/** Runs one operation against the shared pool, or refuses when the portal has no database. */
export async function withLocationObservationStore<T>(
  operation: (store: LocationObservationStore) => Promise<T>
): Promise<T> {
  const connectionString = databaseUrl();
  if (!connectionString) throw new Error("Location observations require PostgreSQL.");
  return operation(new LocationObservationStore(sqlPool(connectionString)));
}
