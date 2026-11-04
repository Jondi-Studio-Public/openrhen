import { ensureUser } from "./ensure-user";
import type { PoolSql } from "./sql-pool";

/**
 * Review > Agent changes: the list behind `GET /api/agent-changes`, read from the write ledger.
 *
 * Every `writes` row whose actor is an agent (not null, not `system`) is one row of the list, whatever carried it
 * (the CLI with an agent token, stdio MCP, remote `/mcp`), newest first. Its `id` and `writeId` are `writes.id`,
 * its status is `writes.state` (a write that kept no images has no state and shows as `superseded`: nothing here
 * can put it back), and its `target` is `{ stateKey: "revert", id }`, the shape a server-checked journal entry has.
 * A revert is not a change, so `revert_*` writes are left out, and a changeset's members are hidden while the set
 * is in the ledger: the set is one row and is undone whole.
 *
 * Paging is by cursor, `<at>|<id>`: the sort key of the last row shown (time to the microsecond, then id).
 */

export const AGENT_JOURNAL_LIMIT = 100;
export const AGENT_CHANGES_DEFAULT_LIMIT = 20;
export const AGENT_CHANGES_MAX_LIMIT = 100;

/** One write as the "Agent changes" list shows it. */
export interface AgentChange {
  agent: string;
  /** `writes.id`, which the undo route and `undo --id` take. */
  id: string;
  at: string;
  label: string;
  status: "applied" | "undone" | "superseded";
  target: { stateKey: string; id?: string };
}

/** One row of the list: the `AgentChange` plus the ledger write it is explained from. */
export interface AgentChangeListRow extends AgentChange {
  /** `writes.id`, the same as `id`. */
  writeId: string | null;
}

export interface AgentChangesPage {
  changes: AgentChangeListRow[];
  /** Pass as `before` for the next older page; null when this page reached the end. */
  nextCursor: string | null;
}

export interface AgentChangesCursor {
  /** ISO time, microseconds (`2026-10-28T01:02:03.123456Z`). */
  at: string;
  id: string;
}

const ZERO = "1970-01-01T00:00:00.000000Z";

/** An ISO time as a fixed-width string with microseconds, so two of them compare as text. Unreadable becomes the epoch. */
export function sortTime(at: string): string {
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) return ZERO;
  const fraction = /\.(\d+)/.exec(at)?.[1];
  // The microseconds are read from `at` only when it is UTC; another offset keeps the millisecond part.
  const micro =
    fraction && /(Z|\+00:?00)$/.test(at)
      ? fraction.padEnd(6, "0").slice(0, 6)
      : String(new Date(ms).getUTCMilliseconds()).padStart(3, "0") + "000";
  return `${new Date(ms).toISOString().slice(0, 19)}.${micro}Z`;
}

const CURSOR_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Reads `?before=<at>|<id>`; null when it is not one. */
export function parseCursor(raw: string): AgentChangesCursor | null {
  const cut = raw.indexOf("|");
  if (cut < 1) return null;
  const at = raw.slice(0, cut);
  const id = raw.slice(cut + 1);
  if (Number.isNaN(Date.parse(at)) || !CURSOR_ID.test(id)) return null;
  return { at: sortTime(at), id };
}

export const formatCursor = (cursor: AgentChangesCursor): string => `${cursor.at}|${cursor.id}`;

export interface LedgerRow {
  id: string;
  actor: string;
  at: string;
  /** Epoch milliseconds of the last change to the write: when it was last undone or redone. */
  changed_ms: number;
  command_type: string;
  state: string | null;
  members: number | null;
  entity_type: string | null;
  operation: string | null;
  rows: number | string | null;
  title: string | null;
  /** The JSON type of the first image's before and after: `null` where the row did not exist before, or is gone after. */
  before_type: string | null;
  after_type: string | null;
}

const words = (text: string) => text.replaceAll("_", " ");

/**
 * What a ledger row is called, close to what the journal's labels read like (`update commitment "Spin class"`):
 * the first change's operation (a save is a create, an update or a delete by its images) and entity, its title when the
 * images kept one, and how many more rows it touched.
 * A changeset is named by its size. A write with no change row falls back to its command type.
 */
export function ledgerLabel(row: {
  commandType: string;
  members: number | null;
  entityType: string | null;
  operation: string | null;
  rows: number;
  title: string | null;
  beforeType?: string | null;
  afterType?: string | null;
}): string {
  if (row.commandType === "changeset")
    return `changeset of ${row.members ?? 0} ${row.members === 1 ? "write" : "writes"}`;
  if (!row.entityType) return words(row.commandType);
  const named = row.title ? ` "${row.title}"` : "";
  const more = row.rows > 1 ? ` and ${row.rows - 1} more` : "";
  // A save reads as what the images show it did: made a row that was not there, removed one, or changed one.
  const verb =
    row.operation !== null && row.operation !== "save"
      ? words(row.operation)
      : row.beforeType === "null"
        ? "create"
        : row.afterType === "null"
          ? "delete"
          : row.beforeType
            ? "update"
            : "save";
  return `${verb} ${words(row.entityType)}${named}${more}`;
}

/** The SQL a list and a single-write lookup share: an agent's write that is not a revert or a changeset's member. */
function listed(sql: PoolSql, userId: string) {
  return sql`w.user_id=${userId} AND w.actor IS NOT NULL AND w.actor <> 'system' AND left(w.command_type, 7) <> 'revert_'
    AND NOT EXISTS (
      SELECT 1 FROM writes c
      WHERE c.user_id=w.user_id AND c.command_type='changeset' AND c.response->'members' ? w.id::text)`;
}

/** Whether `id` is a write in the list (an agent's, not a revert or a hidden member), and the agent and state if so. */
export async function findLedgerWrite(
  sql: PoolSql,
  id: string,
  userId?: string
): Promise<{ id: string; agent: string; state: "applied" | "undone" | null } | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const owner = userId ?? (await ensureUser(sql));
  const rows = await sql<{ id: string; actor: string; state: string | null }[]>`
    SELECT w.id::text AS id, w.actor, w.state FROM writes w WHERE w.id=${id} AND ${listed(sql, owner)}`;
  const row = rows[0];
  return row
    ? { id: row.id, agent: row.actor, state: row.state === "applied" || row.state === "undone" ? row.state : null }
    : null;
}

/**
 * The newest `take` listed writes, optionally only `agent`'s, only those with a state (something to put back), and
 * only those older than `before`.
 */
export const ledgerRows = async (
  sql: PoolSql,
  userId: string,
  options: { before?: AgentChangesCursor | undefined; take: number; agent?: string; kept?: boolean }
) =>
  sql<LedgerRow[]>`
    SELECT w.id::text AS id, w.actor,
           to_char(w.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
           (extract(epoch FROM w.updated_at) * 1000)::float8 AS changed_ms,
           w.command_type, w.state,
           CASE WHEN jsonb_typeof(w.response->'members') = 'array' THEN jsonb_array_length(w.response->'members') END AS members,
           f.entity_type, f.operation, f.rows,
           COALESCE(i.image->'after'->>'title', i.image->'after'->>'name',
             i.image->'before'->>'title', i.image->'before'->>'name') AS title,
           jsonb_typeof(i.image->'before') AS before_type,
           jsonb_typeof(i.image->'after') AS after_type
    FROM writes w
    LEFT JOIN LATERAL (
      SELECT r.entity_type, r.entity_id, r.operation, count(*) OVER () AS rows
      FROM write_rows r WHERE r.write_id=w.id ORDER BY r.created_at, r.id LIMIT 1
    ) f ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(
        (SELECT e FROM jsonb_array_elements(w.images) e WHERE e->>'id' = f.entity_id LIMIT 1), w.images->0) AS image
      WHERE jsonb_typeof(w.images) = 'array'
    ) i ON true
    WHERE ${listed(sql, userId)}
      ${options.agent === undefined ? sql`` : sql`AND w.actor=${options.agent}`}
      ${options.kept ? sql`AND w.state IS NOT NULL` : sql``}
      ${
        options.before
          ? sql`AND (w.created_at < ${options.before.at}::timestamptz
                 OR (w.created_at = ${options.before.at}::timestamptz AND w.id::text COLLATE "C" < ${options.before.id}))`
          : sql``
      }
    ORDER BY w.created_at DESC, w.id::text COLLATE "C" DESC
    LIMIT ${options.take}`;

/** A ledger row's label, from the columns `ledgerRows` selects. */
export const labelOf = (row: LedgerRow): string =>
  ledgerLabel({
    commandType: row.command_type,
    members: row.members,
    entityType: row.entity_type,
    operation: row.operation,
    rows: Number(row.rows ?? 0),
    title: row.title,
    beforeType: row.before_type,
    afterType: row.after_type
  });

/**
 * One page of Review > Agent changes: the ledger's agent writes, newest first.
 * `limit` is clamped to 1 to `AGENT_CHANGES_MAX_LIMIT`.
 */
export async function listAgentChangesPage(
  sql: PoolSql,
  options: { limit?: number; before?: AgentChangesCursor; userId?: string } = {}
): Promise<AgentChangesPage> {
  const owner = options.userId ?? (await ensureUser(sql));
  const limit = Math.min(
    Math.max(Math.trunc(options.limit ?? AGENT_CHANGES_DEFAULT_LIMIT), 1),
    AGENT_CHANGES_MAX_LIMIT
  );
  const ledger = await ledgerRows(sql, owner, { before: options.before, take: limit + 1 });
  const merged: (AgentChangeListRow & { key: AgentChangesCursor })[] = ledger.map((row) => {
    const state = row.state === "applied" || row.state === "undone" ? row.state : "superseded";
    return {
      agent: row.actor,
      id: row.id,
      at: new Date(row.at).toISOString(),
      label: labelOf(row),
      status: state,
      target: { stateKey: "revert", id: row.id },
      writeId: row.id,
      key: { at: row.at, id: row.id }
    } satisfies AgentChangeListRow & { key: AgentChangesCursor };
  });
  const page = merged.slice(0, limit);
  const last = page[page.length - 1];
  return {
    changes: page.map(({ key: _key, ...row }) => row),
    nextCursor: merged.length > limit && last ? formatCursor(last.key) : null
  };
}
