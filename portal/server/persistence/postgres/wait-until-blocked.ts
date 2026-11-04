import type postgres from "postgres";

/**
 * Integration-test helper: resolves once another backend in this database is parked on a lock
 * (`pg_stat_activity.wait_event_type = 'Lock'`: row, transaction-id or advisory), so a test can
 * assert ordering only after the contending statement is really waiting. A fixed sleep can elapse
 * before that statement has started on a loaded machine and leave the assertion vacuous.
 *
 * Scoped to `current_database()`, which each suite owns, so suites sharing a cluster never see each
 * other's waiters. Polled from the pool, not a holder transaction (a transaction sees one
 * `pg_stat_activity` snapshot throughout). Throws on timeout, so a missing lock fails the test.
 */
export async function waitUntilBlocked(
  sql: postgres.Sql,
  options: { timeoutMs?: number; queryLike?: string } = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const queryLike = options.queryLike ?? "%";
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const waiting = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock' AND query LIKE ${queryLike}`;
    if (waiting[0]!.count > 0) return;
    if (Date.now() >= deadline) throw new Error(`No backend became blocked on a lock within ${timeoutMs} ms.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
