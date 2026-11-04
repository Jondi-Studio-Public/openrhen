import type postgres from "postgres";
import { JOURNEY_BAND_MINUTES, type JourneyCell, type JourneyLatest, type JourneySummary } from "@openrhen/contracts";

/**
 * How far back `readJourneySummary` looks and `plan-retention.ts` prunes to
 * Own trips beyond this window carry no
 * signal a fresher trip would not already give, and Google's traffic pattern for a place this old is
 * not worth trusting either.
 */
export const JOURNEY_SUMMARY_WINDOW_DAYS = 180;

/**
 * Outlier bounds for an own trip judged against its cell's reference minutes
 * (the travel time model design note "Own trips (T2)"): under half or over double the reference.
 */
const OWN_TRIP_OUTLIER_LOW = 0.5;
const OWN_TRIP_OUTLIER_HIGH = 2;

/**
 * The plan-forecast request's journey summary (the travel time model design note "Persistence" /
 * "The lookup"), computed in one query over the last `JOURNEY_SUMMARY_WINDOW_DAYS` days of
 * `journey_samples`.
 *
 * Day type and 30-minute departure band are derived from each sample's `departed_at`, converted into
 * `timeZone` with `AT TIME ZONE`, matching the engine's `journeyBand`
 * (`platform/contracts/src/planning/journey.ts`, confirmed against its landed implementation rather
 * than assumed): `band = floor(minutes since local midnight / JOURNEY_BAND_MINUTES)`, and `dayType` is
 * `"weekend"` for a local Saturday or Sunday (ISO weekday 6 or 7), `"weekday"` otherwise. The two
 * implementations read the same instant through different mechanisms — `Intl.DateTimeFormat` in
 * `journeyBand`, `AT TIME ZONE` here — so `journey-summary.integration.test.ts`'s DST case pins their
 * agreement rather than hardcoding either one's output.
 *
 * An own trip is dropped from a cell's stats when it is an outlier for *that* cell specifically: a
 * band cell judges it against that band's own Google median; the any-time cell (grouped by pair and
 * mode alone) judges it against the pair's overall Google median. When a cell has no Google samples
 * at all, the destination's stored `condition_definitions.travel_minutes` stands in as the reference
 * instead; with neither, no filter applies and the trip counts everywhere. The same trip can therefore
 * be an outlier in its band cell but not in the any-time cell, or vice versa — each level's exclusion
 * is precomputed as its own column (`is_outlier_band`, `is_outlier_any`) in one `flagged` CTE, and
 * both levels are produced by one query, a `UNION ALL` of the band-cell aggregation and the any-time
 * aggregation. (A single `GROUPING SETS` pass was tried first and does not work here: Postgres refuses
 * `GROUPING()` inside a `FILTER` clause, and the exclusion genuinely differs per level, not just the
 * grouping columns, so there is no way to pick the right flag from inside a shared aggregate.)
 *
 * A cell with zero contributing samples after filtering (every own trip in it judged an outlier, no
 * Google samples either) is left out of the result rather than returned with an empty/zero stat line.
 */
export async function readJourneySummary(
  sql: postgres.Sql | postgres.TransactionSql,
  userId: string,
  at: Date,
  timeZone: string
): Promise<JourneySummary> {
  const [cellRows, latestRows] = await Promise.all([
    sql<
      {
        from_location_id: string;
        to_location_id: string;
        mode: string;
        day_type: "weekday" | "weekend" | null;
        band: number | null;
        pooled_count: number;
        pooled_median: string | null;
        pooled_p80: string | null;
        pooled_p95: string | null;
        own_count: number;
        own_median: string | null;
        own_p80: string | null;
        own_p95: string | null;
      }[]
    >`
      WITH samples AS (
        SELECT
          js.origin_location_id,
          js.destination_location_id,
          js.mode,
          js.minutes::double precision AS minutes,
          js.source,
          CASE
            WHEN EXTRACT(ISODOW FROM (js.departed_at AT TIME ZONE ${timeZone})) IN (6, 7) THEN 'weekend'
            ELSE 'weekday'
          END AS day_type,
          FLOOR(
            EXTRACT(EPOCH FROM (js.departed_at AT TIME ZONE ${timeZone})::time) / (${JOURNEY_BAND_MINUTES} * 60)
          )::int AS band
        FROM journey_samples js
        WHERE js.user_id = ${userId}
          AND js.observed_at >= ${at}::timestamptz - (${JOURNEY_SUMMARY_WINDOW_DAYS} * INTERVAL '1 day')
      ),
      google_band_stats AS (
        SELECT
          origin_location_id, destination_location_id, mode, day_type, band,
          percentile_disc(0.5) WITHIN GROUP (ORDER BY minutes) AS median
        FROM samples
        WHERE source = 'google'
        GROUP BY origin_location_id, destination_location_id, mode, day_type, band
      ),
      google_any_stats AS (
        SELECT
          origin_location_id, destination_location_id, mode,
          percentile_disc(0.5) WITHIN GROUP (ORDER BY minutes) AS median
        FROM samples
        WHERE source = 'google'
        GROUP BY origin_location_id, destination_location_id, mode
      ),
      fallback_minutes AS (
        -- Cast to double precision so this parameters-against-column comparison in flagged below
        -- unifies with the gb.median/ga.median (also double precision) side of the same CASE
        -- expression: left as a plain integer, Postgres's parameter type inference for the outlier
        -- bound parameters picks "integer" from this branch and then fails to bind the literal 0.5.
        SELECT id AS location_id, travel_minutes::double precision AS travel_minutes
        FROM condition_definitions
        WHERE user_id = ${userId} AND kind = 'location'
      ),
      flagged AS (
        SELECT
          s.*,
          CASE
            WHEN s.source <> 'own_trip' THEN FALSE
            WHEN gb.median IS NOT NULL THEN
              (s.minutes < ${OWN_TRIP_OUTLIER_LOW} * gb.median OR s.minutes > ${OWN_TRIP_OUTLIER_HIGH} * gb.median)
            WHEN f.travel_minutes IS NOT NULL THEN
              (s.minutes < ${OWN_TRIP_OUTLIER_LOW} * f.travel_minutes
                OR s.minutes > ${OWN_TRIP_OUTLIER_HIGH} * f.travel_minutes)
            ELSE FALSE
          END AS is_outlier_band,
          CASE
            WHEN s.source <> 'own_trip' THEN FALSE
            WHEN ga.median IS NOT NULL THEN
              (s.minutes < ${OWN_TRIP_OUTLIER_LOW} * ga.median OR s.minutes > ${OWN_TRIP_OUTLIER_HIGH} * ga.median)
            WHEN f.travel_minutes IS NOT NULL THEN
              (s.minutes < ${OWN_TRIP_OUTLIER_LOW} * f.travel_minutes
                OR s.minutes > ${OWN_TRIP_OUTLIER_HIGH} * f.travel_minutes)
            ELSE FALSE
          END AS is_outlier_any
        FROM samples s
        LEFT JOIN google_band_stats gb
          ON gb.origin_location_id = s.origin_location_id
          AND gb.destination_location_id = s.destination_location_id
          AND gb.mode = s.mode
          AND gb.day_type = s.day_type
          AND gb.band = s.band
        LEFT JOIN google_any_stats ga
          ON ga.origin_location_id = s.origin_location_id
          AND ga.destination_location_id = s.destination_location_id
          AND ga.mode = s.mode
        LEFT JOIN fallback_minutes f ON f.location_id = s.destination_location_id
      )
      -- Band cells and any-time cells are two aggregations of the same flagged rows, unioned into one
      -- query result: each level judges an own trip an outlier against its own reference
      -- (is_outlier_band vs. is_outlier_any), which a single GROUPING SETS pass cannot express since
      -- Postgres refuses GROUPING() inside a FILTER clause and the exclusion genuinely differs per
      -- level, not just the grouping columns.
      SELECT
        origin_location_id AS from_location_id,
        destination_location_id AS to_location_id,
        mode,
        day_type,
        band,
        count(*) FILTER (WHERE source = 'google' OR NOT is_outlier_band) AS pooled_count,
        percentile_disc(0.5) WITHIN GROUP (ORDER BY minutes)
          FILTER (WHERE source = 'google' OR NOT is_outlier_band) AS pooled_median,
        percentile_disc(0.8) WITHIN GROUP (ORDER BY minutes)
          FILTER (WHERE source = 'google' OR NOT is_outlier_band) AS pooled_p80,
        percentile_disc(0.95) WITHIN GROUP (ORDER BY minutes)
          FILTER (WHERE source = 'google' OR NOT is_outlier_band) AS pooled_p95,
        count(*) FILTER (WHERE source = 'own_trip' AND NOT is_outlier_band) AS own_count,
        percentile_disc(0.5) WITHIN GROUP (ORDER BY minutes)
          FILTER (WHERE source = 'own_trip' AND NOT is_outlier_band) AS own_median,
        percentile_disc(0.8) WITHIN GROUP (ORDER BY minutes)
          FILTER (WHERE source = 'own_trip' AND NOT is_outlier_band) AS own_p80,
        percentile_disc(0.95) WITHIN GROUP (ORDER BY minutes)
          FILTER (WHERE source = 'own_trip' AND NOT is_outlier_band) AS own_p95
      FROM flagged
      GROUP BY origin_location_id, destination_location_id, mode, day_type, band
      HAVING count(*) FILTER (WHERE source = 'google' OR NOT is_outlier_band) > 0

      UNION ALL

      SELECT
        origin_location_id AS from_location_id,
        destination_location_id AS to_location_id,
        mode,
        NULL::text AS day_type,
        NULL::int AS band,
        count(*) FILTER (WHERE source = 'google' OR NOT is_outlier_any) AS pooled_count,
        percentile_disc(0.5) WITHIN GROUP (ORDER BY minutes)
          FILTER (WHERE source = 'google' OR NOT is_outlier_any) AS pooled_median,
        percentile_disc(0.8) WITHIN GROUP (ORDER BY minutes)
          FILTER (WHERE source = 'google' OR NOT is_outlier_any) AS pooled_p80,
        percentile_disc(0.95) WITHIN GROUP (ORDER BY minutes)
          FILTER (WHERE source = 'google' OR NOT is_outlier_any) AS pooled_p95,
        count(*) FILTER (WHERE source = 'own_trip' AND NOT is_outlier_any) AS own_count,
        percentile_disc(0.5) WITHIN GROUP (ORDER BY minutes)
          FILTER (WHERE source = 'own_trip' AND NOT is_outlier_any) AS own_median,
        percentile_disc(0.8) WITHIN GROUP (ORDER BY minutes)
          FILTER (WHERE source = 'own_trip' AND NOT is_outlier_any) AS own_p80,
        percentile_disc(0.95) WITHIN GROUP (ORDER BY minutes)
          FILTER (WHERE source = 'own_trip' AND NOT is_outlier_any) AS own_p95
      FROM flagged
      GROUP BY origin_location_id, destination_location_id, mode
      HAVING count(*) FILTER (WHERE source = 'google' OR NOT is_outlier_any) > 0
    `,
    sql<
      {
        from_location_id: string;
        to_location_id: string;
        mode: string;
        minutes: string;
        departed_at: Date;
        observed_at: Date;
      }[]
    >`
      SELECT DISTINCT ON (origin_location_id, destination_location_id, mode)
        origin_location_id AS from_location_id,
        destination_location_id AS to_location_id,
        mode,
        minutes::double precision AS minutes,
        departed_at,
        observed_at
      FROM journey_samples
      WHERE user_id = ${userId}
        AND source = 'google'
        AND observed_at >= ${at}::timestamptz - (${JOURNEY_SUMMARY_WINDOW_DAYS} * INTERVAL '1 day')
      ORDER BY origin_location_id, destination_location_id, mode, observed_at DESC
    `
  ]);

  const cells: JourneyCell[] = cellRows.map((row) => ({
    fromLocationId: row.from_location_id,
    toLocationId: row.to_location_id,
    mode: row.mode as JourneyCell["mode"],
    dayType: row.day_type,
    band: row.band === null ? null : Number(row.band),
    pooled: {
      count: Number(row.pooled_count),
      median: row.pooled_median === null ? 0 : Number(row.pooled_median),
      p80: row.pooled_p80 === null ? 0 : Number(row.pooled_p80),
      p95: row.pooled_p95 === null ? 0 : Number(row.pooled_p95)
    },
    own: {
      count: Number(row.own_count),
      median: row.own_median === null ? 0 : Number(row.own_median),
      p80: row.own_p80 === null ? 0 : Number(row.own_p80),
      p95: row.own_p95 === null ? 0 : Number(row.own_p95)
    }
  }));

  const latest: JourneyLatest[] = latestRows.map((row) => ({
    fromLocationId: row.from_location_id,
    toLocationId: row.to_location_id,
    mode: row.mode as JourneyLatest["mode"],
    minutes: Number(row.minutes),
    departedAt: row.departed_at.toISOString(),
    observedAt: row.observed_at.toISOString()
  }));

  return { cells, latest };
}
