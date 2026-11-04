import type { TransportMode } from "@openrhen/contracts";
import { TRAVEL_LOOKUP_DAILY_LIMIT } from "@openrhen/contracts";
import { notifyStateChanged } from "@openrhen/database";
import { fetchTravelMatrix } from "@/integrations/travel/travel-proxy-client";
import { localDayIn } from "@/server/persistence/postgres/cadence-completion";
import { recordStateChange } from "@/server/persistence/postgres/planning-evidence";
import type { PoolSql, Sql, TxSql } from "@/server/persistence/postgres/sql-pool";

/**
 * The one spender: every Google travel lookup —
 * the worker's scheduled ticks, a live pre-departure check, and Manual Measure alike — goes through
 * `spendTravelLookup`. It reserves the elements it is about to spend, calls the proxy, stores the
 * samples the reply carries, and calls `recordStateChange` once, all inside one transaction, so a
 * budget row and a set of samples can never exist without the recalculation that makes them visible
 * to the plan (one-write-path's invariant 2).
 */

/**
 * The elements a local day may not go below before {@link TRAVEL_LOOKUP_RESERVE_HOUR}, unless the
 * caller explicitly spends the reserve (a live pre-departure check or a person's own Manual Measure —
 * "Spending the budget (T5)", steps 1 and "Manual Measure"). Steps 2, 3 and 5 of the worker's own
 * schedule never pass `allowReserve`, so the scheduled top-up itself cannot eat into this floor.
 */
export const TRAVEL_LOOKUP_RESERVE = 15;

/** The local hour (24h) at which the reserve floor above stops applying for the day. */
export const TRAVEL_LOOKUP_RESERVE_HOUR = 21;

/** One destination a spend measures to, keyed by the location it belongs to. */
export interface TravelSpendDestination {
  locationId: string;
  latitude: number;
  longitude: number;
}

export interface TravelSpendRequest {
  /** The place the samples this spend stores are keyed from (`journey_samples.origin_location_id`). */
  originLocationId: string;
  origin: { latitude: number; longitude: number };
  /** Up to 25 — the proxy's own limit (`travelMatrixRequestSchema`). */
  destinations: TravelSpendDestination[];
  /** One mode per spend, so one element is spent per destination (Budget unit, T5). */
  mode: TransportMode;
  /** Stored as each sample's `departed_at`, and forwarded to the proxy for traffic-aware routing. */
  departureAt: Date;
}

export interface TravelSpendOptions {
  /**
   * Allows this spend to take the day's balance below {@link TRAVEL_LOOKUP_RESERVE} before
   * {@link TRAVEL_LOOKUP_RESERVE_HOUR} local — the live pre-departure check and Manual Measure both
   * pass this; the worker's scheduled today/tomorrow/top-up requests never do.
   */
  allowReserve?: boolean;
  /** Injectable for tests; defaults to `new Date()`. Also `observed_at` on every stored sample. */
  now?: Date;
  /** Evidence recorded on the `write_rows` row alongside the spend's own facts. */
  commandId?: string | null;
}

export interface TravelSpendResult {
  /** The quickest mode per destination — always this spend's own `mode`, since only one was asked for. */
  estimates: { locationId: string; minutes: number; mode: TransportMode }[];
  measurements: { locationId: string; mode: TransportMode; minutes: number }[];
  unroutable: string[];
  /** The local day's total spend after this call. */
  spent: number;
  /** `TRAVEL_LOOKUP_DAILY_LIMIT - spent`. */
  remaining: number;
}

/**
 * Refused before any request reached the provider: the transaction rolled back, and nothing was
 * spent, stored or logged. `remaining` is read inside the same transaction that refused the spend, so
 * it is exact as of the refusal.
 */
export class TravelBudgetRefusedError extends Error {
  constructor(
    public readonly reason: "exhausted" | "reserve_protected",
    public readonly remaining: number
  ) {
    super(
      reason === "exhausted"
        ? "Today's travel lookup budget is used up."
        : `Only the last ${TRAVEL_LOOKUP_RESERVE} lookups remain before ${TRAVEL_LOOKUP_RESERVE_HOUR}:00; this one is held back for a live check or Manual Measure.`
    );
    this.name = "TravelBudgetRefusedError";
  }
}

/** Whether `now`, read in `timeZone`, has reached the hour the reserve floor stops applying. */
function pastReserveHour(timeZone: string, now: Date): boolean {
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(now));
  return hour >= TRAVEL_LOOKUP_RESERVE_HOUR;
}

/**
 * Reserves `n` elements against the local day's budget and returns the new total spent, or `null`
 * when the spend was refused.
 *
 * Two statements, not one: the first (`INSERT … ON CONFLICT DO NOTHING`) only ever seeds a fresh
 * local date at `spent = 0`, so every day's very first spend goes through the same guarded `UPDATE`
 * as every later one — a plain `INSERT … ON CONFLICT DO UPDATE … WHERE …` would let a day's first
 * request skip the `WHERE` entirely (the guard applies only to the `DO UPDATE` branch, never to a
 * fresh row's own insert). The `UPDATE`'s `WHERE` is exactly the race-free check `schema.ts` documents
 * for the cap (two concurrent spenders serialize on the row lock either way), extended with the same
 * reserve floor in one `AND`, so the reserve is exactly as race-free as the cap is, at no extra cost.
 */
async function reserveElements(
  tx: TxSql,
  userId: string,
  localDate: string,
  n: number,
  allowReserve: boolean,
  reserveLifted: boolean
): Promise<number | null> {
  await tx`
    INSERT INTO travel_lookup_budget (user_id, local_date, spent) VALUES (${userId}, ${localDate}, 0)
    ON CONFLICT (user_id, local_date) DO NOTHING
  `;
  const rows = await tx<{ spent: number }[]>`
    UPDATE travel_lookup_budget SET spent = spent + ${n}
    WHERE user_id = ${userId} AND local_date = ${localDate}
      AND spent + ${n} <= ${TRAVEL_LOOKUP_DAILY_LIMIT}
      AND (
        ${allowReserve} OR ${reserveLifted}
        OR spent + ${n} <= ${TRAVEL_LOOKUP_DAILY_LIMIT - TRAVEL_LOOKUP_RESERVE}
      )
    RETURNING spent
  `;
  return rows[0]?.spent ?? null;
}

/** The day's spend so far, for a refusal message or the "N of 100 lookups left" read below. */
async function currentSpend(sql: Sql, userId: string, localDate: string): Promise<number> {
  const rows = await sql<{ spent: number }[]>`
    SELECT spent FROM travel_lookup_budget WHERE user_id=${userId} AND local_date=${localDate}
  `;
  return rows[0]?.spent ?? 0;
}

/**
 * The one spender. Runs entirely inside one transaction: reserving the elements, calling the proxy,
 * storing the samples it returns, and calling `recordStateChange` once. A proxy failure throws out of
 * the transaction callback, which rolls the reservation back with it — a lookup that never happened
 * must never have been spent, and Postgres's own rollback is simpler and more certain than restoring
 * the counter by hand.
 */
export async function spendTravelLookup(
  sql: PoolSql,
  userId: string,
  timeZone: string,
  request: TravelSpendRequest,
  options: TravelSpendOptions = {}
): Promise<TravelSpendResult> {
  if (!request.destinations.length) throw new Error("spendTravelLookup needs at least one destination.");
  const now = options.now ?? new Date();
  const allowReserve = options.allowReserve ?? false;
  const localDate = localDayIn(timeZone, now);
  const n = request.destinations.length;

  const result = await sql.begin(async (tx) => {
    const spent = await reserveElements(tx, userId, localDate, n, allowReserve, pastReserveHour(timeZone, now));
    if (spent === null) {
      const before = await currentSpend(tx, userId, localDate);
      const remaining = Math.max(0, TRAVEL_LOOKUP_DAILY_LIMIT - before);
      const reason = before + n > TRAVEL_LOOKUP_DAILY_LIMIT ? "exhausted" : "reserve_protected";
      throw new TravelBudgetRefusedError(reason, remaining);
    }

    // Left inside the transaction on purpose (see the file header): a failure here must roll the
    // reservation back with it, and the transaction's own rollback is what does that.
    const matrix = await fetchTravelMatrix({
      origin: request.origin,
      destinations: request.destinations.map((destination) => ({
        locationId: destination.locationId,
        latitude: destination.latitude,
        longitude: destination.longitude
      })),
      modes: [request.mode],
      departureAt: request.departureAt.toISOString()
    });

    if (matrix.measurements.length) {
      // The proxy's reply carries only coordinates, not location ids, so the origin id comes from
      // the caller's own request — the bulk-insert shape `imports/batch-records.ts` uses elsewhere.
      const rows = matrix.measurements.map((measurement) => ({
        user_id: userId,
        origin_location_id: request.originLocationId,
        destination_location_id: measurement.locationId,
        mode: measurement.mode,
        minutes: measurement.minutes,
        departed_at: request.departureAt,
        observed_at: now,
        source: "google"
      }));
      await tx`INSERT INTO journey_samples ${tx(rows as never[])}`;
    }

    await recordStateChange(tx, userId, {
      entityType: "journey_samples",
      operation: "measure",
      evidence: {
        mode: request.mode,
        destinationCount: request.destinations.length,
        measuredCount: matrix.measurements.length,
        unroutableCount: matrix.unroutable.length
      },
      commandId: options.commandId ?? null,
      at: now
    });

    return {
      estimates: matrix.estimates,
      measurements: matrix.measurements,
      unroutable: matrix.unroutable,
      spent,
      remaining: Math.max(0, TRAVEL_LOOKUP_DAILY_LIMIT - spent)
    };
  });

  // After commit, like every other writer that touches engine-consumed state (one-write-path.md):
  // NOTIFY fires only once the reservation, the samples and the write_rows row are all durable.
  notifyStateChanged(sql, { userId, kind: "state" });
  return result;
}

/** "N of 100 lookups left today", for the Situation panel (the panel UI itself is a later task). */
export async function readTravelLookupsRemaining(
  sql: PoolSql,
  userId: string,
  timeZone: string,
  now: Date = new Date()
): Promise<{ spent: number; remaining: number; limit: number }> {
  const spent = await currentSpend(sql, userId, localDayIn(timeZone, now));
  return { spent, remaining: Math.max(0, TRAVEL_LOOKUP_DAILY_LIMIT - spent), limit: TRAVEL_LOOKUP_DAILY_LIMIT };
}
