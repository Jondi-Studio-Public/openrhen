import { AGENT_WAKE_MAX_ATTEMPTS, agentWakeMessage, type AgentWakeEvent } from "@openrhen/contracts";
import type postgres from "postgres";

/**
 * The only thing that POSTs an agent wake. A row is claimed
 * (`status='sent'`) BEFORE the POST, so a crash or a second worker can never send it twice: at-most-once.
 * Neither the token nor any gateway output is ever written to a row or returned.
 */

/** Rows older than this are deleted by `pruneAgentWakes`. */
export const AGENT_WAKE_RETENTION_DAYS = 30;
/** Stale rows dropped in one call before giving up until the next tick. */
const MAX_ROWS_PER_CALL = 10;
const REQUEST_TIMEOUT_MS = 5000;

export type AgentWakeSendResult =
  | { outcome: "sent"; id: string; httpStatus: number }
  | { outcome: "sent-unconfirmed"; id: string; reason: string }
  | { outcome: "refused"; id: string; attempts: number; dead: boolean }
  | { outcome: "none"; dropped: number };

function ipv4Octets(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return octets.every((n) => n >= 0 && n <= 255) ? octets : null;
}

/** Returns the normalized base URL (no trailing slash), or null when it is unusable. Empty means unconfigured. */
export function validateAgentWakeUrl(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.protocol === "http:") {
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const octets = ipv4Octets(host);
    const allowed =
      host === "localhost" ||
      host === "::1" ||
      host.endsWith(".ts.net") ||
      (octets !== null && (octets[0] === 127 || (octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127)));
    if (!allowed) return null;
  }
  return text.replace(/\/+$/, "");
}

interface WakeRow {
  id: string;
  event: AgentWakeEvent;
  target_id: string;
  attempts: number;
}

async function isStale(sql: postgres.Sql, row: WakeRow & { user_id: string }): Promise<boolean> {
  if (row.event === "check_in_unanswered") {
    const rows = await sql`
      SELECT 1 FROM check_in
      WHERE id::text = ${row.target_id} AND user_id = ${row.user_id} AND status = 'unknown' AND answered_at IS NULL`;
    return rows.length === 0;
  }
  if (row.event === "pulse_lapsed") {
    const rows = await sql`
      SELECT 1 FROM pulse_segments
      WHERE user_id = ${row.user_id} AND ended_at IS NULL AND state = 'off' AND reason = 'lapsed' LIMIT 1`;
    return rows.length === 0;
  }
  if (row.event === "pulse_unknown") {
    const rows = await sql`
      SELECT 1 FROM pulse_segments
      WHERE user_id = ${row.user_id} AND ended_at IS NULL AND state = 'unknown' LIMIT 1`;
    return rows.length === 0;
  }
  throw new Error(`Unknown agent wake event: ${String(row.event satisfies never)}`);
}

function isRefusal(error: unknown): boolean {
  const codes = new Set(["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN"]);
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && codes.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function isTimeout(error: unknown): boolean {
  const name = error && typeof error === "object" ? (error as { name?: unknown }).name : undefined;
  return name === "TimeoutError" || name === "AbortError";
}

export async function sendNextAgentWake(
  sql: postgres.Sql,
  input: { url: string; token: string; fetchImpl?: typeof fetch; now?: Date }
): Promise<AgentWakeSendResult> {
  const base = validateAgentWakeUrl(input.url);
  if (!base || !input.token) return { outcome: "none", dropped: 0 };
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = (input.now ?? new Date()).toISOString();

  await sql`
    UPDATE agent_wakes SET status = 'dead', last_error = 'expired'
    WHERE status = 'pending' AND expires_at < ${now}::timestamptz`;

  let dropped = 0;
  for (let i = 0; i < MAX_ROWS_PER_CALL; i += 1) {
    const claimed = await sql<(WakeRow & { user_id: string })[]>`
      UPDATE agent_wakes SET status = 'sent', sent_at = ${now}::timestamptz
      WHERE id = (
        SELECT id FROM agent_wakes
        WHERE status = 'pending' AND expires_at >= ${now}::timestamptz
        ORDER BY created_at, id
        FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id, user_id, event, target_id, attempts`;
    const row = claimed[0];
    if (!row) return { outcome: "none", dropped };

    if (await isStale(sql, row)) {
      await sql`UPDATE agent_wakes SET status = 'dead', last_error = 'stale' WHERE id = ${row.id}`;
      dropped += 1;
      continue;
    }

    try {
      const response = await fetchImpl(`${base}/hooks/agent`, {
        method: "POST",
        headers: { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message: agentWakeMessage(row.event, row.target_id), name: "rhen" }),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      await response.body?.cancel().catch(() => undefined);
      await sql`UPDATE agent_wakes SET last_error = ${`HTTP ${response.status}`} WHERE id = ${row.id}`;
      return { outcome: "sent", id: row.id, httpStatus: response.status };
    } catch (error) {
      if (isRefusal(error)) {
        const attempts = row.attempts + 1;
        const dead = attempts >= AGENT_WAKE_MAX_ATTEMPTS;
        await sql`
          UPDATE agent_wakes
          SET status = ${dead ? "dead" : "pending"}, attempts = ${attempts}, sent_at = NULL, last_error = 'connection refused'
          WHERE id = ${row.id}`;
        return { outcome: "refused", id: row.id, attempts, dead };
      }
      // A timeout or any other failure may have reached the gateway: stay 'sent', never retry.
      const reason = isTimeout(error) ? "timeout" : "network error";
      await sql`UPDATE agent_wakes SET last_error = ${reason} WHERE id = ${row.id}`;
      return { outcome: "sent-unconfirmed", id: row.id, reason };
    }
  }
  return { outcome: "none", dropped };
}

/** Deletes wakes older than 30 days. Returns how many. */
export async function pruneAgentWakes(sql: postgres.Sql, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - AGENT_WAKE_RETENTION_DAYS * 24 * 60 * 60_000).toISOString();
  const rows = await sql`DELETE FROM agent_wakes WHERE created_at < ${cutoff}::timestamptz RETURNING id`;
  return rows.length;
}
