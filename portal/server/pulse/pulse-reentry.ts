import { cancelBackOnPlanPush } from "./back-on-plan-push";
import type { Sql } from "../persistence/postgres/sql-pool";
import type { WriteSnapshot } from "../persistence/postgres/write-snapshot";

/**
 * The pulse side of re-entry. Reads the open `pulse_segments` row to
 * learn whether the pulse is `off/lapsed` and since when it was last confirmed, and writes the segment that ends
 * the lapse. The recorder (`pulse-recorder.ts`) owns every other write to the pulse.
 */

/** The reason the recorder gives an `off` segment that needs re-entry. */
export const LAPSED_REASON = "lapsed";
/** The reason of the `on` segment re-entry writes. */
export const REENTERED_REASON = "reentered";

export interface PulseWindow {
  state: "on" | "unknown" | "off" | "free" | "asleep";
  reason: string | null;
  since: Date;
  /** The last real confirmation: the open segment's, else the newest any segment recorded. Null: never confirmed. */
  lastConfirmedAt: Date | null;
  silenceUntil: Date | null;
  /** Any pulse confirmation, check-in or re-entry ever recorded (a segment's or the memory's `confirmed_at`). False: a pulse that has not started. */
  everConfirmed: boolean;
}

/** Whether the open segment is the lapsed state that only re-entry heals. */
export function isLapsed(window: Pick<PulseWindow, "state" | "reason"> | null | undefined): boolean {
  return window?.state === "off" && window.reason === LAPSED_REASON;
}

/** The pulse as it stands, or null for a user the recorder has never evaluated. */
export async function readPulseWindow(sql: Sql, userId: string, lock = false): Promise<PulseWindow | null> {
  const rows = lock
    ? await sql<{ started_at: Date; state: PulseWindow["state"]; reason: string | null; confirmed_at: Date | null }[]>`
        SELECT started_at, state, reason, confirmed_at FROM pulse_segments
        WHERE user_id=${userId} AND ended_at IS NULL LIMIT 1 FOR UPDATE`
    : await sql<{ started_at: Date; state: PulseWindow["state"]; reason: string | null; confirmed_at: Date | null }[]>`
        SELECT started_at, state, reason, confirmed_at FROM pulse_segments
        WHERE user_id=${userId} AND ended_at IS NULL LIMIT 1`;
  const open = rows[0];
  if (!open) return null;
  let lastConfirmedAt = open.confirmed_at;
  if (!lastConfirmedAt) {
    const newest = await sql<{ at: Date | null }[]>`
      SELECT max(confirmed_at) AS at FROM pulse_segments WHERE user_id=${userId}`;
    lastConfirmedAt = newest[0]?.at ?? null;
  }
  const memory = await sql<
    { silence: Date | null; confirmed: Date | null }[]
  >`SELECT silence_until AS silence, last_confirmed_at AS confirmed FROM pulse_state WHERE user_id=${userId}`;
  const silenceUntil = memory[0]?.silence ?? null;
  return {
    state: open.state,
    reason: open.reason,
    since: open.started_at,
    lastConfirmedAt,
    silenceUntil,
    everConfirmed: lastConfirmedAt !== null || memory[0]?.confirmed != null
  };
}

/**
 * Ends the lapse: closes the open segment at `at` and opens `on/reentered` with `confirmed_at = at`, who made the
 * confirmation going into `source` when the column exists. Both rows are handed to the write snapshot so one undo
 * puts the lapsed segment back. Returns the new segment's id.
 */
export async function writeReentrySegment(
  tx: Sql,
  userId: string,
  options: { at: Date; confirmedBy: "person" | "agent"; snapshot: WriteSnapshot | null }
): Promise<string> {
  const { at, confirmedBy, snapshot } = options;
  const open = await tx<{ id: string }[]>`SELECT id FROM pulse_segments WHERE user_id=${userId} AND ended_at IS NULL`;
  await snapshot?.before(
    "pulse_segments",
    open.map((row) => row.id)
  );
  await tx`UPDATE pulse_segments SET ended_at=${at}, updated_at=now() WHERE user_id=${userId} AND ended_at IS NULL`;
  const created = await tx<{ id: string }[]>`
    INSERT INTO pulse_segments (user_id, started_at, state, reason, confirmed_at, source)
    VALUES (${userId}, ${at}, 'on', ${REENTERED_REASON}, ${at}, ${confirmedBy})
    RETURNING id`;
  await snapshot?.before("pulse_state", [userId]);
  // The recorder reads its memory (`last_confirmed_at`, the unknown clock) from `pulse_state`, so move it with the
  // segment. `reentered_at` is deliberately not stamped: the segment already says `on/reentered`, and a stamp left
  // behind would re-enter the pulse after an undo restored the lapsed segment.
  await tx`
    INSERT INTO pulse_state (user_id, last_evaluated_at, last_contact_at, last_contact_source, last_confirmed_at,
                             confirmed_by, unknown_since, unknown_minutes, unanswered_prompts, entered_lapsed_at)
    VALUES (${userId}, ${at}, ${at}, ${confirmedBy}, ${at}, ${confirmedBy}, NULL, 0, 0, NULL)
    ON CONFLICT (user_id) DO UPDATE SET
      last_evaluated_at=${at}, last_contact_at=${at}, last_contact_source=${confirmedBy}, last_confirmed_at=${at},
      confirmed_by=${confirmedBy}, unknown_since=NULL, unknown_minutes=0, unanswered_prompts=0,
      entered_lapsed_at=NULL, updated_at=CURRENT_TIMESTAMP`;
  await cancelBackOnPlanPush(tx, userId);
  const id = created[0]!.id;
  snapshot?.inserted("pulse_segments", [id]);
  return id;
}
