import type { Sql } from "../sql-pool";

/**
 * "The source's removal has been applied to this commitment", remembered on the calendar link's snapshot as
 * `sourceClosed` (an ISO time). It is what lets a person's restore stick while the event stays cancelled (the diff
 * proposes nothing for an open commitment whose link carries it), and what a returning event clears (an `update` record
 * carrying `sourceReopen` or `sourceClear`, which exists even when no field changed). Set for both kinds of removal: the
 * source cancelled the event, or the event is merely missing from the read.
 */
export const SOURCE_CLOSED_KEY = "sourceClosed";

/** Whether a link's snapshot says the source's removal was applied. */
export function sourceClosedOf(snapshot: Record<string, unknown> | null | undefined): boolean {
  return typeof snapshot?.[SOURCE_CLOSED_KEY] === "string";
}

export async function markSourceClosed(sql: Sql, userId: string, linkId: string, at: Date = new Date()) {
  await sql`
    UPDATE calendar_event_links SET
      last_remote_snapshot = COALESCE(last_remote_snapshot, '{}'::jsonb) || ${sql.json({ [SOURCE_CLOSED_KEY]: at.toISOString() })}::jsonb,
      updated_at = CURRENT_TIMESTAMP
    WHERE id=${linkId} AND user_id=${userId}`;
}

export async function clearSourceClosed(sql: Sql, userId: string, linkId: string) {
  await sql`
    UPDATE calendar_event_links SET
      last_remote_snapshot = COALESCE(last_remote_snapshot, '{}'::jsonb) - ${SOURCE_CLOSED_KEY}::text,
      updated_at = CURRENT_TIMESTAMP
    WHERE id=${linkId} AND user_id=${userId}`;
}
