import { checkIns, sessions } from "@openrhen/database";
import {
  DRIFT_COLLAPSE_WINDOW_MINUTES,
  countDriftEpisodes,
  detectDriftEpisodes,
  type DriftCounts,
  type DriftEpisode
} from "@openrhen/contracts/drift";
import type { Row } from "@/server/persistence/postgres/db-row";
import type { Sql } from "@/server/persistence/postgres/sql-pool";

/**
 * The body of `GET /api/drift-report`: the drift episodes the owner's own plan data shows in a window. Read-only, and
 * bounded twice: by time (the window, widened only by the collapse window) and by rows (`DRIFT_REPORT_MAX_ROWS` per
 * table). It reads the check-in and session tables; nothing here reads the activity store.
 */
export const DRIFT_REPORT_DEFAULT_DAYS = 30;
export const DRIFT_REPORT_MAX_DAYS = 90;
export const DRIFT_REPORT_MAX_ROWS = 5000;

type CheckInRow = Row<typeof checkIns, "id" | "status" | "answered_at" | "answer_source" | "answered_by">;
type SessionRow = Row<
  typeof sessions,
  | "id"
  | "status"
  | "started_at"
  | "started_recorded_at"
  | "ended_at"
  | "ended_recorded_at"
  | "plan_sanction"
  | "created_at"
>;

export interface DriftReport {
  generatedAt: string;
  window: { from: string; to: string };
  /** Sessions created before this are skipped; null means none were, and old rows with no sanction count as drift. */
  legacyBefore: string | null;
  /** True when a table hit the row bound, so the window holds more than the report counted. Narrow the window. */
  truncated: boolean;
  counts: DriftCounts;
  episodes: Array<{
    id: string;
    type: DriftEpisode["type"];
    occurredAt: string;
    knownAt: string;
    pinned: boolean;
    evidence: Array<{ signal: string; id: string; at: string }>;
  }>;
}

export interface DriftReportOptions {
  from: Date;
  to: Date;
  legacyBefore?: Date | null;
  now?: Date;
}

export async function readDriftReport(sql: Sql, userId: string, options: DriftReportOptions): Promise<DriftReport> {
  const margin = DRIFT_COLLAPSE_WINDOW_MINUTES * 60_000;
  const from = new Date(options.from.getTime() - margin);
  const to = new Date(options.to.getTime() + margin);
  const limit = DRIFT_REPORT_MAX_ROWS;
  const checkInRows = await sql<CheckInRow[]>`
    SELECT id, status, answered_at, answer_source, answered_by
    FROM check_in
    WHERE user_id=${userId} AND status='deviated' AND answered_at >= ${from} AND answered_at < ${to}
    ORDER BY answered_at DESC
    LIMIT ${limit}
  `;
  // A session counts when it overlaps the window: started before the end and not ended before the start.
  const sessionRows = await sql<SessionRow[]>`
    SELECT id, status, started_at, started_recorded_at, ended_at, ended_recorded_at, plan_sanction, created_at
    FROM sessions
    WHERE user_id=${userId} AND started_at IS NOT NULL AND started_at < ${to}
      AND (ended_at IS NULL OR ended_at >= ${from})
    ORDER BY started_at DESC
    LIMIT ${limit}
  `;
  const episodes = detectDriftEpisodes({
    checkIns: checkInRows.map((row) => ({
      id: row.id,
      status: row.status,
      answeredAt: row.answered_at,
      answerSource: row.answer_source,
      answeredBy: row.answered_by
    })),
    sessions: sessionRows.map((row) => ({
      id: row.id,
      status: row.status,
      startedAt: row.started_at,
      startedRecordedAt: row.started_recorded_at,
      endedAt: row.ended_at,
      endedRecordedAt: row.ended_recorded_at,
      planSanction: row.plan_sanction,
      createdAt: row.created_at
    })),
    legacyBefore: options.legacyBefore ?? null,
    window: { from: options.from, to: options.to }
  });
  return {
    generatedAt: (options.now ?? new Date()).toISOString(),
    window: { from: options.from.toISOString(), to: options.to.toISOString() },
    legacyBefore: options.legacyBefore ? options.legacyBefore.toISOString() : null,
    truncated: checkInRows.length >= limit || sessionRows.length >= limit,
    counts: countDriftEpisodes(episodes),
    episodes: episodes.map((episode) => ({
      id: episode.id,
      type: episode.type,
      occurredAt: episode.occurredAt.toISOString(),
      knownAt: episode.knownAt.toISOString(),
      pinned: episode.pinned,
      evidence: episode.evidence.map((item) => ({ signal: item.signal, id: item.id, at: item.at.toISOString() }))
    }))
  };
}
