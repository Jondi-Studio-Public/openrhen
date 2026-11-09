import type postgres from "postgres";
import { CONSEQUENCE_POOLS, loadComparisons, loadPoolRows, type ConsequencePool } from "./pool-load.js";
import { planRefit } from "./refit-plan.js";
import { localDay, usableComparisons, type DropReason } from "./usable-comparisons.js";

/**
 * Refits the comparison-derived consequence of one user's projects and actions from the comparison log
 * (comparison-consequence-ranking design, 3.3 to 3.5) and stores it in `consequence_refined`,
 * `consequence_refined_for_stars` and `consequence_refined_as_of`.
 *
 * The stored value is a cache of a pure function of the items, the log and the local day, so every writer can ignore
 * it: a comparison write, a state replace, an import, a restore and the daily roll just call this. Per pool it takes a
 * transaction-scoped advisory lock keyed on the user and the pool, reads, fits and writes in one transaction. A failure
 * rolls the whole refit back (to a savepoint when the caller is already in a transaction), leaves the previous values in
 * place and is reported in the outcome, never thrown, so a refit can never fail the write that asked for it. The
 * engine falls back to stars on its own when a value is missing or was fitted for different stars.
 *
 * `for_stars` is the item's CURRENT stars on every fit, so an item whose stars changed since its answers is dropped by
 * the fit (its answers hold the old stars) and ends with null columns, not a value fitted for stars it no longer has.
 * Items left with no usable comparison get all three columns set to null. Ordinary saves never write these columns.
 */
type Sql = postgres.Sql | postgres.TransactionSql;

export interface RefitPoolOutcome {
  pool: ConsequencePool;
  considered: number;
  written: number;
  cleared: number;
  dropped: Record<DropReason, number>;
}

export interface RefitOutcome {
  ok: boolean;
  /** The values now stored for rows this refit wrote or cleared, keyed by item id; null means cleared. */
  changed: Map<string, { value: number; forStars: number } | null>;
  pools: RefitPoolOutcome[];
  error?: string;
}

/** The advisory-lock key: one lock per user and pool, shared by the refit and the group writers. */
export function consequenceLockKey(userId: string, pool: ConsequencePool): string {
  return `consequence:${userId}:${pool}`;
}

/** Takes the per-user, per-pool lock for the rest of the transaction. */
export async function lockConsequencePool(sql: Sql, userId: string, pool: ConsequencePool): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${consequenceLockKey(userId, pool)}, 0))`;
}

/**
 * Takes both pools' locks in the one fixed order (project, then action) that `refitConsequence` also uses. A writer
 * that refits must hold both before it touches either, or a project answer and an action answer deadlock.
 */
export async function lockConsequencePools(sql: Sql, userId: string): Promise<void> {
  for (const pool of CONSEQUENCE_POOLS) await lockConsequencePool(sql, userId, pool);
}

/** Runs `work` in a transaction: the caller's own (as a savepoint, so a failure undoes only this work) or a new one. */
export async function inTransaction<T>(sql: Sql, work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  if ("savepoint" in sql) return (await (sql as postgres.TransactionSql).savepoint((tx) => work(tx))) as T;
  return (await (sql as postgres.Sql).begin((tx) => work(tx))) as T;
}

/** The user's current local day, from their stored time zone. */
export async function userLocalDay(sql: Sql, userId: string, now: Date): Promise<string> {
  const rows = await sql<{ timezone: string }[]>`SELECT timezone FROM users WHERE id = ${userId}`;
  return localDay(now, rows[0]?.timezone ?? "UTC");
}

const table = { project: "projects", action: "actions" } as const;

function emptyDrops(): Record<DropReason, number> {
  return { tie: 0, stale: 0, too_few_items: 0, inferred_ceiling: 0, aged_out: 0, bad_row: 0 };
}

async function refitPool(
  tx: postgres.TransactionSql,
  userId: string,
  pool: ConsequencePool,
  asOfDay: string,
  timezone: string,
  changed: RefitOutcome["changed"]
): Promise<RefitPoolOutcome> {
  await lockConsequencePool(tx, userId, pool);
  const rows = await loadPoolRows(tx, userId, pool);
  const log = await loadComparisons(tx, userId, pool);
  const usable = usableComparisons(rows, log, asOfDay, timezone);
  const { writes, clears } = planRefit(rows, usable, asOfDay);
  const name = table[pool];
  if (writes.length)
    await tx.unsafe(
      `UPDATE "${name}" t SET consequence_refined = v.value, consequence_refined_for_stars = v.stars, consequence_refined_as_of = $2::date
       FROM json_to_recordset($1::text::json) AS v(id uuid, value real, stars smallint)
       WHERE t.id = v.id`,
      [JSON.stringify(writes), asOfDay]
    );
  if (clears.length)
    await tx.unsafe(
      `UPDATE "${name}" SET consequence_refined = NULL, consequence_refined_for_stars = NULL, consequence_refined_as_of = NULL
       WHERE id = ANY($1::text::uuid[])`,
      [`{${clears.join(",")}}`]
    );
  for (const write of writes) changed.set(write.id, { value: write.value, forStars: write.stars });
  for (const id of clears) changed.set(id, null);

  const dropped = emptyDrops();
  for (const drop of usable.dropped) dropped[drop.reason] += 1;
  return { pool, considered: rows.length, written: writes.length, cleared: clears.length, dropped };
}

/**
 * Refits both pools for one user as of a local calendar day (`YYYY-MM-DD`). Never throws: see the header.
 * Pass the caller's transaction to make the refit part of it (replace, import, comparison write) or a pool handle to
 * run it in a transaction of its own.
 */
export async function refitConsequence(sql: Sql, userId: string, asOfDay: string): Promise<RefitOutcome> {
  const changed: RefitOutcome["changed"] = new Map();
  try {
    const pools = await inTransaction(sql, async (tx) => {
      const users = await tx<{ timezone: string }[]>`SELECT timezone FROM users WHERE id = ${userId}`;
      if (!users[0]) return [] as RefitPoolOutcome[];
      const outcomes: RefitPoolOutcome[] = [];
      for (const pool of CONSEQUENCE_POOLS)
        outcomes.push(await refitPool(tx, userId, pool, asOfDay, users[0].timezone, changed));
      return outcomes;
    });
    return { ok: true, changed, pools };
  } catch (error) {
    // The savepoint or transaction has rolled back: previous values stand, and the engine falls back to stars on any
    // value that no longer matches.
    console.error(
      JSON.stringify({
        level: "error",
        message: "Consequence refit failed; previous values kept",
        userId,
        error: error instanceof Error ? error.message : String(error)
      })
    );
    return { ok: false, changed: new Map(), pools: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/** Refits as of the user's local day right now. */
export async function refitConsequenceNow(sql: Sql, userId: string, now: Date = new Date()): Promise<RefitOutcome> {
  return refitConsequence(sql, userId, await userLocalDay(sql, userId, now));
}

/**
 * The day-roll hook: refits only when some stored value was fitted on an earlier day than `now` (in the user's zone), so
 * the age weights move with the calendar and a quiet day costs one cheap query. Returns null when nothing was stale.
 */
export async function refitConsequenceIfStale(
  sql: Sql,
  userId: string,
  now: Date,
  timezone: string
): Promise<RefitOutcome | null> {
  const today = localDay(now, timezone);
  const stale = await sql<{ stale: boolean }[]>`
    SELECT (
      EXISTS (SELECT 1 FROM projects p JOIN outcomes o ON o.id = p.outcome_id JOIN areas a ON a.id = o.area_id
              WHERE a.user_id = ${userId} AND p.consequence_refined_as_of IS NOT NULL AND p.consequence_refined_as_of <> ${today}::date)
      OR EXISTS (SELECT 1 FROM actions ac JOIN projects p ON p.id = ac.project_id JOIN outcomes o ON o.id = p.outcome_id JOIN areas a ON a.id = o.area_id
              WHERE a.user_id = ${userId} AND ac.consequence_refined_as_of IS NOT NULL AND ac.consequence_refined_as_of <> ${today}::date)
    ) AS stale`;
  if (!stale[0]?.stale) return null;
  return refitConsequence(sql, userId, today);
}
