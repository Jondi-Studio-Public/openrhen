import type postgres from "postgres";

/**
 * Owner of writes to `push_outbox` for the check-in waiting push (`push/check-in-waiting-push.ts` builds the keys and
 * payload and calls these). The older leave-by and notice writers are still listed in `pending/write-owners`.
 */

export const CHECK_IN_WAITING_KIND = "check_in_waiting";

/** Inserts one waiting row; a repeat of the same dedupe key adds nothing. Returns whether a row was added. */
export async function insertCheckInWaitingRow(
  sql: postgres.Sql,
  input: { userId: string; dedupeKey: string; payload: unknown; expiresAt: Date }
): Promise<boolean> {
  const rows = await sql`
    INSERT INTO push_outbox (user_id, dedupe_key, kind, payload, status, expires_at)
    VALUES (${input.userId}, ${input.dedupeKey}, ${CHECK_IN_WAITING_KIND}, ${sql.json(input.payload as never)}, 'pending', ${input.expiresAt})
    ON CONFLICT (user_id, dedupe_key, channel) DO NOTHING
    RETURNING id`;
  return rows.length > 0;
}

/** Withdraws the pending row with this dedupe key. */
export async function cancelPendingByDedupeKey(sql: postgres.Sql, userId: string, dedupeKey: string): Promise<void> {
  await sql`UPDATE push_outbox SET status='cancelled' WHERE user_id=${userId} AND status='pending' AND dedupe_key=${dedupeKey}`;
}

/** Withdraws every pending waiting row whose check-in (named by `<prefix><id>`) is no longer pending. */
export async function cancelWaitingRowsForClosedCheckIns(
  sql: postgres.Sql,
  userId: string,
  dedupePrefix: string
): Promise<number> {
  const rows = await sql`
    UPDATE push_outbox o SET status='cancelled'
    WHERE o.user_id=${userId} AND o.kind=${CHECK_IN_WAITING_KIND} AND o.status='pending'
      AND NOT EXISTS (
        SELECT 1 FROM check_in c
        WHERE c.user_id=o.user_id AND c.status='pending' AND o.dedupe_key=${dedupePrefix} || c.id::text
      )
    RETURNING o.id`;
  return rows.length;
}
