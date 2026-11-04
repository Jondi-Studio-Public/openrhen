import {
  AGENT_SESSION_IDLE_GAP_MINUTES,
  AGENT_SESSION_MAX_TOUCHED,
  AGENT_SESSION_SCHEMA_VERSION,
  summariseAgentTime,
  type AgentTimeSummary,
  type IngestResult,
  type ReportedSession
} from "@openrhen/contracts";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import type { PoolSql } from "@/server/persistence/postgres/sql-pool";

/**
 * Agent time storage. Two writers share one table: the portal itself, counting an
 * agent's own requests into sessions, and `ingestAgentSessions`, taking the records an external client reports.
 */

/** Counts one use of a route template; once the cap is reached a new template counts as `other`. */
export function bumpTouched(touched: Record<string, number>, route: string): Record<string, number> {
  const next = { ...touched };
  const key = route in next || Object.keys(next).length < AGENT_SESSION_MAX_TOUCHED ? route : "other";
  next[key] = (next[key] ?? 0) + 1;
  return next;
}

const asCounts = (value: unknown): Record<string, number> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, number>) : {};

/**
 * Notes one request from an agent. It extends the agent's open calls session (one whose last call is within the
 * idle gap) or opens a new one. Does nothing when the portal has no user yet. Serialised per agent by the caller.
 */
export async function recordAgentCall(
  sql: PoolSql,
  input: { agent: string; route: string; write: boolean },
  now: Date = new Date()
): Promise<void> {
  await sql.begin(async (tx) => {
    const users = await tx<{ id: string }[]>`SELECT id FROM users ORDER BY created_at LIMIT 1`;
    const userId = users[0]?.id;
    if (!userId) return;
    const since = new Date(now.getTime() - AGENT_SESSION_IDLE_GAP_MINUTES * 60_000);
    const open = await tx<{ id: string; touched: unknown }[]>`
      SELECT id, touched FROM agent_sessions
      WHERE user_id=${userId} AND agent=${input.agent} AND source='calls' AND ended_at >= ${since}
      ORDER BY ended_at DESC LIMIT 1 FOR UPDATE`;
    const row = open[0];
    const touched = bumpTouched(asCounts(row?.touched), input.route);
    if (row) {
      await tx`
        UPDATE agent_sessions
        SET ended_at=GREATEST(ended_at, ${now}), request_count=request_count+1,
            write_count=write_count+${input.write ? 1 : 0}, touched=${tx.json(touched as never)}, updated_at=${now}
        WHERE id=${row.id}`;
      return;
    }
    await tx`
      INSERT INTO agent_sessions (user_id, agent, source, kind, started_at, ended_at, request_count, write_count, touched, created_at, updated_at)
      VALUES (${userId}, ${input.agent}, 'calls', 'work', ${now}, ${now}, 1, ${input.write ? 1 : 0}, ${tx.json(touched as never)}, ${now}, ${now})`;
  });
}

interface ReportedRow {
  id: string;
  kind: string;
  title: string | null;
  summary: string | null;
  topics: unknown;
  turn_count: number | null;
  started_at: Date;
  ended_at: Date;
}

const same = (row: ReportedRow, session: ReportedSession): boolean =>
  row.kind === session.kind &&
  row.title === (session.title ?? null) &&
  row.summary === (session.summary ?? null) &&
  JSON.stringify(row.topics) === JSON.stringify(session.topics) &&
  row.turn_count === (session.turns ?? null) &&
  row.started_at.getTime() === Date.parse(session.startedAt) &&
  row.ended_at.getTime() === Date.parse(session.endedAt);

/**
 * Stores reported sessions for `agent`, keyed by the client's own id: an id already stored for this agent is
 * replaced, so a client may repost an open conversation with a later end. One transaction for the whole batch.
 * A repeated id inside one batch is applied in order, so the last wins.
 */
export async function ingestAgentSessions(
  sql: PoolSql,
  agent: string,
  sessions: readonly ReportedSession[],
  now: Date = new Date()
): Promise<IngestResult> {
  const userId = await ensureUser(sql);
  const results = await sql.begin(async (tx) => {
    const out: IngestResult["results"] = [];
    for (const session of sessions) {
      const existing = await tx<ReportedRow[]>`
        SELECT id, kind, title, summary, topics, turn_count, started_at, ended_at FROM agent_sessions
        WHERE user_id=${userId} AND agent=${agent} AND external_id=${session.id} FOR UPDATE`;
      const row = existing[0];
      if (row && same(row, session)) {
        out.push({ id: session.id, status: "unchanged" });
        continue;
      }
      if (row) {
        await tx`
          UPDATE agent_sessions
          SET kind=${session.kind}, title=${session.title ?? null}, summary=${session.summary ?? null},
              topics=${tx.json(session.topics as never)}, turn_count=${session.turns ?? null},
              started_at=${session.startedAt}, ended_at=${session.endedAt}, schema_version=${AGENT_SESSION_SCHEMA_VERSION}, updated_at=${now}
          WHERE id=${row.id}`;
        out.push({ id: session.id, status: "updated" });
        continue;
      }
      await tx`
        INSERT INTO agent_sessions (user_id, agent, source, external_id, kind, title, summary, topics, turn_count, started_at, ended_at, schema_version, created_at, updated_at)
        VALUES (${userId}, ${agent}, 'reported', ${session.id}, ${session.kind}, ${session.title ?? null}, ${session.summary ?? null},
                ${tx.json(session.topics as never)}, ${session.turns ?? null}, ${session.startedAt}, ${session.endedAt},
                ${AGENT_SESSION_SCHEMA_VERSION}, ${now}, ${now})`;
      out.push({ id: session.id, status: "created" });
    }
    return out;
  });
  return { schemaVersion: AGENT_SESSION_SCHEMA_VERSION, results };
}

export interface RecentAgentSession {
  agent: string;
  source: "calls" | "reported";
  kind: string;
  title: string | null;
  startedAt: string;
  endedAt: string;
  requestCount: number;
  writeCount: number;
}

export interface AgentTimeReading extends AgentTimeSummary {
  days: number;
  recent: RecentAgentSession[];
}

interface Row {
  agent: string;
  source: "calls" | "reported";
  kind: string;
  title: string | null;
  topics: unknown;
  started_at: Date;
  ended_at: Date;
  request_count: number;
  write_count: number;
}

/** Agent time over the last `days` days, with the ten newest sessions. */
export async function readAgentTime(sql: PoolSql, days: number, now: Date = new Date()): Promise<AgentTimeReading> {
  const userId = await ensureUser(sql);
  const windowStart = new Date(now.getTime() - days * 86_400_000);
  const rows = await sql<Row[]>`
    SELECT agent, source, kind, title, topics, started_at, ended_at, request_count, write_count
    FROM agent_sessions
    WHERE user_id=${userId} AND ended_at > ${windowStart} AND started_at < ${now}
    ORDER BY started_at DESC`;
  const summary = summariseAgentTime(
    rows.map((row) => ({
      agent: row.agent,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      topics: Array.isArray(row.topics) ? (row.topics as string[]) : []
    })),
    windowStart,
    now
  );
  return {
    ...summary,
    days,
    recent: rows.slice(0, 10).map((row) => ({
      agent: row.agent,
      source: row.source,
      kind: row.kind,
      title: row.title,
      startedAt: row.started_at.toISOString(),
      endedAt: row.ended_at.toISOString(),
      requestCount: row.request_count,
      writeCount: row.write_count
    }))
  };
}
