import {
  DEFAULT_LOCATION_STALE_AFTER_MINUTES,
  EMPTY_JOURNEY_INDEX,
  resolveMode,
  type PlanForecastResponse,
  type TransportMode
} from "@openrhen/contracts";
import { parseDeviceLocationState } from "@/server/location/observation-policy";
import type { TxSql } from "@/server/persistence/postgres/sql-pool";
import type { WriteSnapshot } from "@/server/persistence/postgres/write-snapshot";

/**
 * Own trips (the travel time model design note, "Own trips (T2)"): a Google-free sample recorded
 * from the person's own arrival, inside the same transaction and under the same `recordStateChange`
 * call every arrival write already makes — this module never calls it itself.
 */

/** A trip over this long is trail noise, not a journey (T2's own "gap over 4 hours" refusal). */
export const OWN_TRIP_MAX_GAP_HOURS = 4;

export interface OwnTripSample {
  fromLocationId: string;
  toLocationId: string;
  mode: TransportMode;
  minutes: number;
  departedAt: Date;
  observedAt: Date;
}

/**
 * Pure: the sample to record, or `null` when there is no usable departure or the gap is too long to
 * trust (over {@link OWN_TRIP_MAX_GAP_HOURS}, or non-positive — a departure at or after the arrival
 * itself, which the evidence should never produce but which must not become a negative-minute row).
 */
export function ownTripSample(input: {
  fromLocationId: string;
  toLocationId: string;
  mode: TransportMode;
  arrivedAt: Date;
  departedAt: Date | undefined;
}): OwnTripSample | null {
  if (!input.departedAt) return null;
  const gapMs = input.arrivedAt.getTime() - input.departedAt.getTime();
  // An invalid Date makes the gap NaN, which must never become a sample (`toISOString` would throw).
  if (!Number.isFinite(gapMs) || gapMs <= 0 || gapMs > OWN_TRIP_MAX_GAP_HOURS * 3_600_000) return null;
  return {
    fromLocationId: input.fromLocationId,
    toLocationId: input.toLocationId,
    mode: input.mode,
    minutes: gapMs / 60_000,
    departedAt: input.departedAt,
    observedAt: input.arrivedAt
  };
}

export interface DeviceObservationAt {
  observedAt: Date;
  locationId: string | null;
}

/**
 * Pure: when the trip away from `fromLocationId` (P) most likely started. The last evidence at P — `locationSetAt`,
 * the latest answered check-in, the latest session end, or the latest device observation at P,
 * whichever is latest and before arrival — sets a floor; the first device observation *away* from P
 * after that floor, if there is one, is the real departure. `undefined` when there is no evidence at
 * all (should not happen once the not-stale check has already passed, since `locationSetAt` is
 * always set once a place has ever been asserted).
 */
export function departureEvidence(input: {
  arrivedAt: Date;
  fromLocationId: string;
  locationSetAt: Date | undefined;
  latestAnsweredCheckInAt: Date | undefined;
  latestSessionEndAt: Date | undefined;
  /** Every matched device observation, any order — this function does its own filtering and sorting. */
  observations: readonly DeviceObservationAt[];
}): Date | undefined {
  const before = (value: Date | undefined): value is Date =>
    value !== undefined && value.getTime() < input.arrivedAt.getTime();
  const floors = [input.locationSetAt, input.latestAnsweredCheckInAt, input.latestSessionEndAt].filter(before);
  const observationsAtP = input.observations
    .filter((o) => o.locationId === input.fromLocationId && before(o.observedAt))
    .sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  const latestAtP = observationsAtP[observationsAtP.length - 1];
  if (latestAtP) floors.push(latestAtP.observedAt);
  if (!floors.length) return undefined;
  const lastEvidenceAtP = new Date(Math.max(...floors.map((date) => date.getTime())));

  const away = input.observations
    .filter(
      (o) =>
        o.locationId !== null &&
        o.locationId !== input.fromLocationId &&
        o.observedAt.getTime() > lastEvidenceAtP.getTime() &&
        o.observedAt.getTime() <= input.arrivedAt.getTime()
    )
    .sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime())[0];
  return away ? away.observedAt : lastEvidenceAtP;
}

/** The mode the latest plan's leg from `fromLocationId` to `toLocationId` used, if any. */
export function latestPlanLegMode(
  result: PlanForecastResponse | undefined,
  fromLocationId: string,
  toLocationId: string
): TransportMode | undefined {
  for (const timeline of result?.derivedState.commitmentTimelines ?? []) {
    if (
      timeline.journeyBefore?.fromLocationId === fromLocationId &&
      timeline.journeyBefore.toLocationId === toLocationId
    )
      return timeline.journeyBefore.mode;
    if (timeline.journeyAfter?.fromLocationId === fromLocationId && timeline.journeyAfter.toLocationId === toLocationId)
      return timeline.journeyAfter.mode;
  }
  return undefined;
}

export interface RecordOwnTripInput {
  /** The place asserted before this arrival (P); no sample when there was none. */
  fromLocationId: string | null;
  /** P's own `locationSetAt`, from the situation this arrival is replacing. */
  fromLocationSetAt: string | undefined;
  /** The place just asserted (X). */
  toLocationId: string;
  /** The modes the leg's own resolution may choose among, absent a plan or place/user mode. */
  transportModes: readonly TransportMode[];
  arrivedAt: Date;
  /**
   * The situation's own `underway` (if any), from before this arrival replaces it
   * When its `fromLocationId` matches P, its own
   * `departedAt` is better evidence of the real departure than the device-trail heuristic
   * (`departureEvidence`) — a direct On my way tap beats an inference from other signals.
   */
  underwayFromLocationId?: string | null;
  underwayDepartedAt?: string | null;
  /** An agent's write keeps the trip it records, so it can be undone (write-snapshot.ts). */
  snap?: WriteSnapshot | null;
}

/**
 * Records an own trip on arrival, inside `tx`, or does nothing — called from every arrival write
 * (the manual assertion in `entity-commands.ts`, a phone or browser assertion in
 * `location-observation-store.ts`), always before that same transaction's one `recordStateChange`
 * call, never adding one of its own.
 *
 * No sample when: there was no previous place, it is the same place, P was stale or never asserted
 * (the same condition that makes an origin "assumed" elsewhere), either place is not a located
 * definition, no departure evidence exists, the gap exceeds 4 hours, or no travel mode can be
 * resolved at all.
 */
export async function recordOwnTripOnArrival(tx: TxSql, userId: string, input: RecordOwnTripInput): Promise<void> {
  const { fromLocationId, toLocationId, arrivedAt } = input;
  if (!fromLocationId || fromLocationId === toLocationId) return;

  const setAt = input.fromLocationSetAt ? new Date(input.fromLocationSetAt) : undefined;
  const ageMinutes = setAt ? (arrivedAt.getTime() - setAt.getTime()) / 60_000 : undefined;
  if (ageMinutes === undefined || ageMinutes > DEFAULT_LOCATION_STALE_AFTER_MINUTES) return;

  const places = await tx<
    {
      id: string;
      latitude: string | number | null;
      longitude: string | number | null;
      usual_transport_mode: string | null;
    }[]
  >`
    SELECT id, latitude, longitude, usual_transport_mode FROM condition_definitions
    WHERE user_id=${userId} AND kind='location' AND id = ANY(ARRAY[${fromLocationId}, ${toLocationId}])
  `;
  const byId = new Map(places.map((place) => [place.id, place]));
  const from = byId.get(fromLocationId);
  const to = byId.get(toLocationId);
  if (!from || !to || from.latitude == null || from.longitude == null || to.latitude == null || to.longitude == null)
    return;

  const [checkInRows, sessionRows, userPrefRows, planRows] = await Promise.all([
    tx<{ answered_at: Date }[]>`
      SELECT answered_at FROM check_in WHERE user_id=${userId} AND answered_at < ${arrivedAt}
      ORDER BY answered_at DESC LIMIT 1
    `,
    tx<{ ended_at: Date }[]>`
      SELECT ended_at FROM sessions WHERE user_id=${userId} AND ended_at IS NOT NULL AND ended_at < ${arrivedAt}
      ORDER BY ended_at DESC LIMIT 1
    `,
    tx<{ default_transport_mode: string | null; device_location_state: unknown }[]>`
      SELECT default_transport_mode, device_location_state FROM user_preferences WHERE user_id=${userId}
    `,
    tx<{ result: unknown }[]>`
      SELECT result FROM planning_runs WHERE user_id=${userId} AND superseded_at IS NULL
      ORDER BY calculated_at DESC LIMIT 1
    `
  ]);

  const deviceState = parseDeviceLocationState(userPrefRows[0]?.device_location_state);
  const observations: DeviceObservationAt[] = deviceState.observations
    .filter((observation) => observation.match.kind === "matched")
    .map((observation) => ({
      observedAt: new Date(observation.observedAt),
      locationId: (observation.match as { locationId: string }).locationId
    }));

  const underwayMatches = input.underwayFromLocationId === fromLocationId && input.underwayDepartedAt;
  const departedAt = underwayMatches
    ? new Date(input.underwayDepartedAt!)
    : departureEvidence({
        arrivedAt,
        fromLocationId,
        locationSetAt: setAt,
        latestAnsweredCheckInAt: checkInRows[0]?.answered_at,
        latestSessionEndAt: sessionRows[0]?.ended_at,
        observations
      });

  const planResult = planRows[0]?.result as PlanForecastResponse | undefined;
  const planMode = latestPlanLegMode(planResult, fromLocationId, toLocationId);
  const mode: TransportMode | undefined =
    planMode ??
    resolveMode({
      ...(to.usual_transport_mode ? { placeUsualMode: to.usual_transport_mode as TransportMode } : {}),
      ...(userPrefRows[0]?.default_transport_mode
        ? { userDefaultMode: userPrefRows[0].default_transport_mode as TransportMode }
        : {}),
      transportModes: input.transportModes,
      journeys: EMPTY_JOURNEY_INDEX,
      from: { id: fromLocationId, latitude: Number(from.latitude), longitude: Number(from.longitude) },
      to: { id: toLocationId, latitude: Number(to.latitude), longitude: Number(to.longitude) }
    });
  if (!mode) return;

  const sample = ownTripSample({ fromLocationId, toLocationId, mode, arrivedAt, departedAt });
  if (!sample) return;

  const [inserted] = await tx<{ id: string }[]>`
    INSERT INTO journey_samples
      (user_id, origin_location_id, destination_location_id, mode, minutes, departed_at, observed_at, source)
    VALUES
      (${userId}, ${sample.fromLocationId}, ${sample.toLocationId}, ${sample.mode}, ${sample.minutes},
       ${sample.departedAt.toISOString()}, ${sample.observedAt.toISOString()}, 'own_trip')
    RETURNING id
  `;
  input.snap?.inserted("journey_samples", [inserted!.id]);
}
