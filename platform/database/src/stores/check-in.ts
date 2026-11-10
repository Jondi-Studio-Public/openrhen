import type postgres from "postgres";

/** Owner of the `check_in` write the push path makes: a channel reporting a push sent starts the check-in's timeout. */

/** Stamps `prompted_at` on a still-pending, not-yet-prompted check-in. Returns whether it stamped. */
export async function stampCheckInPrompted(sql: postgres.Sql, userId: string, checkInId: string): Promise<boolean> {
  const rows = await sql`
    UPDATE check_in SET prompted_at=CURRENT_TIMESTAMP
    WHERE id=${checkInId} AND user_id=${userId} AND status='pending' AND prompted_at IS NULL
    RETURNING id`;
  return rows.length > 0;
}
