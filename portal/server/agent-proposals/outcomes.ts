import {
  AGENT_PROPOSAL_EXPIRY_DAYS,
  AGENT_SESSION_IDLE_GAP_MINUTES,
  ATTENTION_WINDOW_DAYS,
  attentionIso,
  decidedWindowStart,
  type AttentionOutcomeStatus
} from "@openrhen/contracts";
import type { PoolSql, Sql } from "@/server/persistence/postgres/sql-pool";
import { expireOld } from "./store";

/**
 * The persistence half of the agent attention feed (the design notes, 7 and 9): which
 * of one agent's proposals the owner has decided (or let expire), and how many the status block should count. The
 * feed's model lives in `platform/contracts/src/planning/attention.ts`; this file only reads rows.
 *
 * Rules shared by both queries:
 * - Only the viewer agent's own rows, and never a shadow row (a write the portal held back is not a proposal the owner
 *   was asked about).
 * - An expiry happens at `created_at + 14 days`, not when `expireOld` stamped it (a stamp can be days late, or held
 *   behind an uncommitted changeset). So a row is an expiry when it is stamped `expired` OR is still `pending` past
 *   that time, and its time is that expression either way. The count never runs `expireOld`.
 * - The other three outcomes happened at `resolved_at`.
 */

const DAY_MS = 86_400_000;
/** `settle` commits its own statement; this covers the gap between its `now()` and its commit (section 9). */
export const OUTCOME_OVERLAP_SECONDS = 30;
/** The largest `limit` of the proposals list (`PROPOSAL_LIST_MAX_LIMIT`), which the stale fallback list uses. */
const STALE_LIST_CAP = 200;

/** When the row expires: the one expression every expiry test and every expiry time uses. */
const EXPIRES = `(o.created_at + make_interval(days => ${AGENT_PROPOSAL_EXPIRY_DAYS}))`;
/** When the outcome happened. */
const HAPPENED = `(CASE WHEN o.status IN ('expired','pending') THEN ${EXPIRES} ELSE o.resolved_at END)`;
/** The sorted key names of a row's `target_versions`: the targets it was written against. */
const TARGETS = (alias: string) =>
  `(SELECT coalesce(array_agg(k ORDER BY k), ARRAY[]::text[]) FROM jsonb_object_keys(${alias}.target_versions) AS k)`;

/**
 * A later proposal of the same agent marks an outcome re-proposed. "Later" means created after the outcome
 * happened. "Same" means: the same `coalesce_key` when the outcome has one; otherwise the same `kind` and the same
 * target, where the target is the non-empty set of entity keys the applier derived from the payload when it was
 * proposed (`target_versions` keys such as `project:<id>`). A proposal with no target never matches on target, so
 * two untargeted proposals of one kind are not "the same change". A newer row in any status counts (even one the
 * owner rejected, or a shadow row): the agent did act on the outcome, which is all the match asks.
 */
const REPROPOSED = `LEFT JOIN LATERAL (
  SELECT n.id FROM agent_proposals n
  WHERE n.user_id = o.user_id AND n.agent = o.agent AND n.id <> o.id AND n.created_at > ${HAPPENED}
    AND ((o.coalesce_key IS NOT NULL AND n.coalesce_key = o.coalesce_key)
      OR (o.coalesce_key IS NULL AND n.kind = o.kind AND cardinality(${TARGETS("o")}) > 0
          AND ${TARGETS("n")} = ${TARGETS("o")}))
  ORDER BY n.created_at, n.id LIMIT 1
) re ON true`;

/** The rows that are outcomes after `$3`: the three stamped statuses by `resolved_at`, expiries by their expiry time. */
const OUTCOME_FILTER = `o.user_id = $1 AND o.agent = $2 AND o.shadow = false
  AND ((o.status IN ('confirmed','rejected','stale') AND o.resolved_at > $3::timestamptz)
    OR ((o.status = 'expired' OR (o.status = 'pending' AND ${EXPIRES} <= now())) AND ${EXPIRES} > $3::timestamptz))`;

export interface ProposalOutcome {
  id: string;
  status: AttentionOutcomeStatus;
  /** ISO. An expiry's is `created_at + 14 days`, not the stamp time. */
  at: string;
  kind: string;
  /** Outside text (agent-written summary, the owner's note): only ever quoted. */
  summary: string;
  note: string | null;
  /** The record the payload names, for a stale outcome's read; ids are agent-written and validated by the model. */
  target?: { entity?: string; id?: string };
  /** The id of the earliest later proposal that matches (see `REPROPOSED`). */
  reproposedAs?: string;
}

export interface ProposalOutcomeResult {
  outcomes: ProposalOutcome[];
  /**
   * This agent's stale proposals the proposals list would show, at most 200: the `limit` that puts an outcome's own
   * proposal on the `status: "stale"` fallback list.
   */
  staleCount: number;
  /**
   * The database `now()` the query ran at, after the feed's own `expireOld`. This is the cursor. It exists only
   * when the query succeeded: on any failure this function throws, so a caller cannot take a cursor from a failed read.
   */
  queryNow: string;
  /** The lower bound used: `since` clamped to the last 7 days and to `queryNow`, before the 30 s overlap. */
  since: string;
  /** Set when the `since` sent was moved: a future value, or one older than the window. */
  sinceClamped?: "future" | "older_than_window";
}

/** The payload's target, read defensively: the jsonb is written by an agent. */
export function outcomeTarget(kind: string, payload: unknown): { entity?: string; id?: string } | undefined {
  if (kind !== "entity_command" || payload === null || typeof payload !== "object") return undefined;
  const { command, body } = payload as { command?: unknown; body?: unknown };
  if (body === null || typeof body !== "object") return undefined;
  const fields = body as Record<string, unknown>;
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  let entity: unknown;
  let id: unknown;
  if (command === "save_project") {
    entity = "project";
    id = record(fields.project)?.id;
  } else if (command === "save_action") {
    entity = "action";
    id = record(fields.action)?.id;
  } else if (command === "save_entity") {
    entity = fields.entityType;
    id = record(fields.entity)?.id;
  } else return undefined;
  return {
    ...(typeof entity === "string" ? { entity } : {}),
    ...(typeof id === "string" ? { id } : {})
  };
}

interface OutcomeRow {
  id: string;
  status: "confirmed" | "rejected" | "stale" | "expired" | "pending";
  happened_at: Date;
  kind: string;
  summary: string;
  resolution_note: string | null;
  payload: unknown;
  reproposed_as: string | null;
}

/**
 * The outcomes of `agent`'s proposals after `since` (default and floor: 7 days ago; a future value is clamped to
 * the database clock), less a 30 second overlap on the lower bound. Runs the feed's own `expireOld` first, as its own
 * statement, so this is the only place the feed writes: call it only when proposals are read (an agent viewer holding
 * `read:proposals`). The owner view (`agent` null) has no outcomes: nothing is read and nothing is written.
 *
 * Throws when `expireOld` or the query fails. The caller then has no `queryNow` and must not move a cursor
 * (`attentionCursor` with the clamped `since` it sent, or none).
 */
export async function readProposalOutcomes(
  sql: PoolSql,
  userId: string,
  agent: string | null,
  options: { since?: string | undefined } = {}
): Promise<ProposalOutcomeResult | undefined> {
  if (agent === null) return undefined;
  await expireOld(sql, userId);
  // One transaction so `now()` is one reading for the clamp and the query; it is taken before the rows are read, so
  // a cursor made from it can only be early (a repeat), never past a row this answer missed.
  return sql.begin(async (tx) => {
    const sent = attentionIso(options.since);
    const [clock] = await tx<{ now: Date }[]>`SELECT now() AS now`;
    const nowMs = clock!.now.getTime();
    const floorMs = nowMs - ATTENTION_WINDOW_DAYS * DAY_MS;
    const sentMs = sent === undefined ? undefined : Date.parse(sent);
    const sinceMs = sentMs === undefined ? floorMs : Math.min(Math.max(sentMs, floorMs), nowMs);
    const lower = new Date(sinceMs - OUTCOME_OVERLAP_SECONDS * 1000).toISOString();
    const rows = await tx.unsafe<OutcomeRow[]>(
      `SELECT o.id, o.status, ${HAPPENED} AS happened_at, o.kind, o.summary, o.resolution_note, o.payload, re.id AS reproposed_as
       FROM agent_proposals o ${REPROPOSED}
       WHERE ${OUTCOME_FILTER}
       ORDER BY happened_at DESC, o.id`,
      [userId, agent, lower] as never[]
    );
    const [stale] = await tx<{ count: number }[]>`
      SELECT count(*)::int AS count FROM agent_proposals WHERE user_id=${userId} AND agent=${agent} AND status='stale'`;
    return {
      outcomes: rows.map((row) => ({
        id: row.id,
        status: row.status === "pending" ? ("expired" as const) : row.status,
        at: row.happened_at.toISOString(),
        kind: row.kind,
        summary: row.summary,
        note: row.resolution_note,
        ...(outcomeTarget(row.kind, row.payload) ? { target: outcomeTarget(row.kind, row.payload)! } : {}),
        ...(row.reproposed_as ? { reproposedAs: row.reproposed_as } : {})
      })),
      staleCount: Math.min(stale?.count ?? 0, STALE_LIST_CAP),
      queryNow: clock!.now.toISOString(),
      since: new Date(sinceMs).toISOString(),
      ...(sentMs !== undefined && sentMs > nowMs
        ? { sinceClamped: "future" as const }
        : sentMs !== undefined && sentMs < floorMs
          ? { sinceClamped: "older_than_window" as const }
          : {})
    };
  });
}

/**
 * The start of the decided window: the start of this agent's previous closed `calls` session (one idle for more than
 * the session gap, so the session making this request never counts), floored at 7 days, 24 hours with none. Uses the
 * `(user_id, agent, ended_at)` index; the clock is the database's.
 */
export async function readDecidedWindowStart(
  sql: Sql,
  userId: string,
  agent: string
): Promise<{ now: string; start: string }> {
  const [row] = await sql<{ now: Date; previous: Date | null }[]>`
    SELECT now() AS now,
      (SELECT started_at FROM agent_sessions
        WHERE user_id=${userId} AND agent=${agent} AND source='calls'
          AND ended_at < now() - make_interval(mins => ${AGENT_SESSION_IDLE_GAP_MINUTES})
        ORDER BY ended_at DESC LIMIT 1) AS previous`;
  const now = row!.now.toISOString();
  return { now, start: decidedWindowStart(now, row!.previous?.toISOString() ?? null) };
}

/**
 * How many of `agent`'s outcomes happened after `windowStart`, that it has not already acted on: non-shadow, an
 * expiry counted at `created_at + 14 days` whether or not `expireOld` has stamped it, and any outcome a later
 * proposal re-proposed left out. Reads only: no `expireOld`, no UPDATE, so a status call gains no write.
 */
export async function countDecidedOutcomes(
  sql: Sql,
  userId: string,
  agent: string,
  windowStart: string
): Promise<number> {
  const rows = await sql.unsafe<{ count: number }[]>(
    `SELECT count(*)::int AS count FROM agent_proposals o ${REPROPOSED} WHERE ${OUTCOME_FILTER} AND (re.id IS NULL OR o.status IN ('confirmed', 'rejected'))`,
    [userId, agent, windowStart] as never[]
  );
  return rows[0]?.count ?? 0;
}

/** The status block's `decided`: the window, then the count over it. */
export async function readDecidedCount(
  sql: Sql,
  userId: string,
  agent: string
): Promise<{ count: number; windowStart: string }> {
  const { start } = await readDecidedWindowStart(sql, userId, agent);
  return { count: await countDecidedOutcomes(sql, userId, agent, start), windowStart: start };
}
