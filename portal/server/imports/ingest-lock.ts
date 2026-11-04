import type { PoolSql } from "@/server/persistence/postgres/sql-pool";

/**
 * Serialises whole ingest passes of one kind.
 *
 * The mail ingests claim their rows with `SELECT … FOR UPDATE SKIP LOCKED`, touch them and commit,
 * then process outside the transaction. The row lock ends at that commit and nothing records the
 * claim, so a second pass starting during the first (the LISTEN-triggered pass, the five-minute
 * sweep, a manual Sync now) selected the same rows and could insert the same proposal twice: each
 * pass checks "is there already a pending proposal for this key?" and both can miss before either
 * inserts.
 *
 * A transaction-scoped advisory lock (`pg_advisory_xact_lock`) taken in a transaction held open for the
 * whole pass makes the passes of one `key` run one at a time. A pass that arrives while another runs
 * waits, then claims whatever is still unclaimed, so a manual sync still reports honestly and rows that
 * landed meanwhile are not missed. The lock is released by the transaction ending, with no separate
 * unlock call that could fail and hand a connection that still holds the lock back to the pool; it also
 * dies with its connection, so a crashed process cannot leave one held.
 */
export async function withIngestLock<T>(sql: PoolSql, key: string, pass: () => Promise<T>): Promise<T> {
  const lockKey = "ingest:" + key;
  let locked = false;
  try {
    // postgres.js's `begin` overloads resolve their return type through `UnwrapPromiseArray<T>`, which a
    // generic `T` cannot unify with; the cast only works around that typing gap.
    return (await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      locked = true;
      return pass();
    })) as T;
  } catch (error) {
    if (locked) throw error;
    // The lock could not be taken (the database is unreachable): the pass itself fails the same way and
    // reports it, as it always has.
    return pass();
  }
}
