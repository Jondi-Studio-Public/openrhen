import { checkIns, sessions, sleepPlans } from "@openrhen/database";
import type { Row } from "../db-row";
import type { Sql } from "../sql-pool";

export type CheckInDirectiveKind =
  | "action"
  | "sleep"
  | "routine_step"
  | "routine_instance"
  | "deliverable"
  | "travel"
  | "protected_commitment"
  | "open_anchor";

export interface StoredCheckIn {
  id: string;
  version: number;
  slotAt: string;
  promptedAt: string | null;
  answeredAt: string | null;
  directiveKind: CheckInDirectiveKind;
  directiveTargetId: string | null;
  directivePhase: string | null;
  directiveTitle: string;
  status: "pending" | "on_track" | "deviated" | "unknown" | "superseded";
  deviationCategory: "work" | "family" | "life_admin" | "other" | null;
  deviationNote: string | null;
  deviationTargetId: string | null;
  answerSource: "in_app_banner" | "sheet" | "push_action" | null;
}

type CheckInRow = Row<
  typeof checkIns,
  | "id"
  | "version"
  | "slot_at"
  | "prompted_at"
  | "answered_at"
  | "directive_kind"
  | "directive_target_id"
  | "directive_phase"
  | "directive_title"
  | "status"
  | "deviation_category"
  | "deviation_note"
  | "deviation_target_id"
  | "answer_source"
> & {
  directive_kind: CheckInDirectiveKind;
  status: StoredCheckIn["status"];
  deviation_category: StoredCheckIn["deviationCategory"];
  answer_source: StoredCheckIn["answerSource"];
};

function mapCheckInRow(row: CheckInRow): StoredCheckIn {
  return {
    id: row.id,
    version: row.version,
    slotAt: row.slot_at.toISOString(),
    promptedAt: row.prompted_at?.toISOString() ?? null,
    answeredAt: row.answered_at?.toISOString() ?? null,
    directiveKind: row.directive_kind,
    directiveTargetId: row.directive_target_id,
    directivePhase: row.directive_phase,
    directiveTitle: row.directive_title,
    status: row.status,
    deviationCategory: row.deviation_category,
    deviationNote: row.deviation_note,
    deviationTargetId: row.deviation_target_id,
    answerSource: row.answer_source
  };
}

/**
 * The one check-in worth surfacing right now, deliberately separate from the narrow window
 * `readPortalState` carries in every poll response — this table is not part of the portal state
 * model at all (see the backup format's own note: it is authored data, but never round-tripped
 * through `state-replace`). Catch-up on return only ever shows the single latest slot: still
 * `pending` within its window, or the most recent `unknown` from while the tab was away. An older
 * `unknown`, or any slot behind a more recent `on_track`/`deviated`/`superseded` one, is never
 * surfaced — the design deliberately does not make a backlog out of missed check-ins.
 *
 * An `unknown` row only counts as unanswered while `answered_at` is null. 'unknown' is two different
 * facts wearing one status: the scheduler writes it on timeout (nobody said anything), and answering
 * "unsure" writes it too (somebody said "I don't know", which is an answer). Without the
 * `answered_at` test the second kind kept coming back as a catch-up prompt every poll — answering
 * "unsure" could not dismiss the banner, only re-arm it — while the device reader, which requires
 * `status='pending'`, showed nothing. The two readers now agree.
 *
 * The first read of a pending slot stamps `prompted_at`, which is what lets the timeout the
 * scheduler applies count from when the question was actually shown rather than from when its row
 * was created (which can be moments earlier, invisible to anyone). `{ stamp: false }` is the peek: an agent reading
 * status is not the owner being shown the question, so it must not start that timeout.
 */
export async function readCurrentCheckIn(
  sql: Sql,
  userId: string,
  options: { stamp?: boolean } = {}
): Promise<StoredCheckIn | null> {
  const rows = await sql<CheckInRow[]>`
    SELECT id,version,slot_at,prompted_at,answered_at,directive_kind,directive_target_id,directive_phase,directive_title,status,deviation_category,deviation_note,deviation_target_id,answer_source
    FROM check_in WHERE user_id=${userId} ORDER BY slot_at DESC LIMIT 1
  `;
  const latest = rows[0];
  if (!latest) return null;
  const open = latest.status === "pending" || (latest.status === "unknown" && latest.answered_at === null);
  if (!open) return null;
  if (options.stamp !== false && latest.status === "pending" && !latest.prompted_at) {
    const stamped = await sql<CheckInRow[]>`
      UPDATE check_in SET prompted_at=CURRENT_TIMESTAMP WHERE id=${latest.id} AND prompted_at IS NULL
      RETURNING id,version,slot_at,prompted_at,answered_at,directive_kind,directive_target_id,directive_phase,directive_title,status,deviation_category,deviation_note,deviation_target_id,answer_source
    `;
    if (stamped[0]) return mapCheckInRow(stamped[0]);
  }
  return mapCheckInRow(latest);
}

export interface CheckInShownResult {
  id: string;
  status: StoredCheckIn["status"];
  promptedAt: string | null;
  /** True on the call that recorded the time; false when it was already recorded or the row is no longer pending. */
  stamped: boolean;
}

/**
 * A surface reports it actually showed this check-in (a sheet opened, a notification was posted): stamps
 * `prompted_at` once, which is where the scheduler's timeout counts from. Idempotent: a repeat, or a row that has been
 * answered or has timed out, changes nothing and returns what is stored. Only the first call on a still-pending row
 * writes, so a late report can never move the timeout. `null` when the id is not this user's check-in.
 */
export async function markCheckInShown(sql: Sql, userId: string, id: string): Promise<CheckInShownResult | null> {
  const stamped = await sql<{ id: string; status: StoredCheckIn["status"]; prompted_at: Date }[]>`
    UPDATE check_in SET prompted_at=CURRENT_TIMESTAMP
    WHERE id=${id} AND user_id=${userId} AND status='pending' AND prompted_at IS NULL
    RETURNING id,status,prompted_at
  `;
  if (stamped[0])
    return {
      id: stamped[0].id,
      status: stamped[0].status,
      promptedAt: stamped[0].prompted_at.toISOString(),
      stamped: true
    };
  const rows = await sql<{ id: string; status: StoredCheckIn["status"]; prompted_at: Date | null }[]>`
    SELECT id,status,prompted_at FROM check_in WHERE id=${id} AND user_id=${userId}
  `;
  const row = rows[0];
  return row
    ? { id: row.id, status: row.status, promptedAt: row.prompted_at?.toISOString() ?? null, stamped: false }
    : null;
}

export interface CheckInSummary {
  answered: number;
  onTrack: number;
  deviated: number;
  unknown: number;
}

export interface CheckInTrailRow {
  id: string;
  slotAt: string;
  directiveTitle: string;
}

export interface CheckInTrail {
  /** The trail: unanswered hours the plan asked and nobody answered, oldest first. */
  rows: CheckInTrailRow[];
  /**
   * Candidate sleep starts for the ceiling reconciliation proposes, ascending — every recorded
   * `sleep_plans.actual_start_at` (never a merely planned one) from the session's `started_at`
   * onward. Deliberately not reduced to a single cap here: "after the session's last verified
   * moment" needs `lastVerifiedAt`, which this read has no way to compute (it can be later than the
   * session start, e.g. from an on-track answer given before the trail began) — the caller picks the
   * earliest entry after that moment.
   */
  sleepStarts: string[];
}

/**
 * The run of unanswered hours behind a stuck session — the evidence reconciliation reads to propose
 * an end time. See the session reconciliation design note, "Which check-ins are the trail": rows
 * with `slot_at >= sessions.started_at` for this session, snapshotting the session's own deliverable
 * target, still `status='unknown'` with `answered_at IS NULL` — exactly the hours the plan asked and
 * nobody answered. A superseded row never got ten minutes to be seen and is not evidence, so it is
 * never in this set regardless of its slot time.
 *
 * Returns `null` when the session itself cannot be found (or was never started) for `userId` — the
 * caller decides what "no session" means for its own response, this function only refuses to guess.
 */
export async function readCheckInTrail(sql: Sql, userId: string, sessionId: string): Promise<CheckInTrail | null> {
  const sessionRows = await sql<
    Row<typeof sessions, "started_at" | "target_id">[]
  >`SELECT started_at, target_id FROM sessions WHERE id=${sessionId} AND user_id=${userId}`;
  const session = sessionRows[0];
  if (!session || !session.started_at) return null;

  const trailRows = await sql<Row<typeof checkIns, "id" | "slot_at" | "directive_title">[]>`
    SELECT id, slot_at, directive_title
    FROM check_in
    WHERE user_id=${userId}
      AND slot_at >= ${session.started_at}
      AND directive_kind='deliverable'
      AND directive_target_id=${session.target_id}
      AND status='unknown'
      AND answered_at IS NULL
    ORDER BY slot_at ASC
  `;

  const sleepRows = await sql<(Row<typeof sleepPlans, "actual_start_at"> & { actual_start_at: Date })[]>`
    SELECT actual_start_at
    FROM sleep_plans
    WHERE user_id=${userId}
      AND actual_start_at IS NOT NULL
      AND actual_start_at >= ${session.started_at}
    ORDER BY actual_start_at ASC
  `;

  return {
    rows: trailRows.map((row) => ({
      id: row.id,
      slotAt: row.slot_at.toISOString(),
      directiveTitle: row.directive_title
    })),
    sleepStarts: sleepRows.map((row) => row.actual_start_at.toISOString())
  };
}

/** A bare tally for Review: how often a check-in actually got answered, and what it said. */
export async function readCheckInSummary(sql: Sql, userId: string): Promise<CheckInSummary> {
  const rows = await sql<{ on_track: number; deviated: number; unknown: number }[]>`
    SELECT
      count(*) FILTER (WHERE status = 'on_track')::int AS on_track,
      count(*) FILTER (WHERE status = 'deviated')::int AS deviated,
      count(*) FILTER (WHERE status = 'unknown')::int AS unknown
    FROM check_in WHERE user_id=${userId}
  `;
  const row = rows[0] ?? { on_track: 0, deviated: 0, unknown: 0 };
  return { answered: row.on_track + row.deviated, onTrack: row.on_track, deviated: row.deviated, unknown: row.unknown };
}
