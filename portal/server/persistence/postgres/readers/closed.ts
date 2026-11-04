import {
  CLOSED_BADGE_WINDOW_HOURS,
  CLOSED_TABLES,
  CLOSE_TABLE_OF,
  UNDO_CLOSED_BY_SUFFIX,
  restoreVerbFor,
  type ClosedPage,
  type ClosedRow,
  type ClosedSummary,
  type ClosedTab,
  type CloseType
} from "@openrhen/contracts";
import { ancestorsOf } from "../close-ancestors";
import { OWNED_BY_USER } from "../closed-ownership";
import type { Sql } from "../sql-pool";

/**
 * The Closed page's read (archive-removals design sections 4 to 6): every closed row of the eight closable tables for
 * one user, newest first, with who closed it, why, the rows closed with it and the closed ancestor that blocks its
 * restore. It is a dedicated read; the state arrays carry no `closed_*`.
 *
 * Table, column and status names below come from constants in this file and `CLOSED_TABLES`, never from input. The
 * only inputs (user id, cursor, limit, `now`) are bound parameters; `type` and `tab` are matched against fixed lists.
 */

export const CLOSED_DEFAULT_LIMIT = 50;
export const CLOSED_MAX_LIMIT = 100;

interface TableShape {
  type: CloseType;
  /** The row's name column. */
  title: string;
  /** A scalar subquery for the parent's name (area, outcome or project), or null for a top-level type. */
  parent: string | null;
}

const SHAPES: Record<keyof typeof CLOSED_TABLES, TableShape> = {
  areas: { type: "area", title: "name", parent: null },
  outcomes: { type: "outcome", title: "title", parent: "(SELECT a.name FROM areas a WHERE a.id = t.area_id)" },
  projects: { type: "project", title: "title", parent: "(SELECT o.title FROM outcomes o WHERE o.id = t.outcome_id)" },
  actions: { type: "action", title: "title", parent: "(SELECT p.title FROM projects p WHERE p.id = t.project_id)" },
  deliverables: {
    type: "deliverable",
    title: "title",
    parent: "(SELECT p.title FROM projects p WHERE p.id = t.project_id)"
  },
  commitments: {
    type: "commitment",
    title: "title",
    parent: "(SELECT p.title FROM projects p WHERE p.id = t.project_id)"
  },
  routine_presets: { type: "routine_preset", title: "name", parent: null },
  condition_definitions: { type: "condition_definition", title: "name", parent: null }
};

const TABLES = Object.keys(SHAPES) as (keyof typeof SHAPES)[];

const quote = (statuses: readonly string[]) => statuses.map((status) => `'${status}'`).join(",");

/** A close that took back a create is not listed; a NULL `closed_by` (a row closed before the stamps) is. */
const NOT_UNDONE = `(t.closed_by IS NULL OR t.closed_by NOT LIKE '%${UNDO_CLOSED_BY_SUFFIX}')`;

/** `closed_at`, or `updated_at` for a closed row the stamps missed (the data health check flags those), so it still sorts. */
const SORT_AT = "COALESCE(t.closed_at, t.updated_at)";
const SORT_TEXT = `to_char(${SORT_AT} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export interface ClosedQuery {
  tab: ClosedTab;
  type?: CloseType;
  limit?: number;
  /** The `nextCursor` of an earlier page. */
  before?: string;
}

/** `<time to the microsecond>|<type>:<id>`, the sort key of the last row shown. */
const CURSOR = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z)\|([a-z_]+):(.{1,200})$/;

export function parseClosedCursor(raw: string): { at: string; key: string } | null {
  const match = CURSOR.exec(raw);
  return match ? { at: match[1]!, key: `${match[2]}:${match[3]}` } : null;
}

interface Found {
  type: CloseType;
  id: string;
  title: string;
  parent: string | null;
  status: ClosedTab;
  version: number;
  sort_text: string;
  closed_at: Date | null;
  closed_by: string | null;
  closed_reason: string | null;
  closed_from_status: string | null;
  closed_batch: string | null;
}

/** The select of one table's closed rows in the given tab (undefined when that table never holds that status). */
function selectOf(table: keyof typeof SHAPES, tab: ClosedTab): string | undefined {
  if (!(CLOSED_TABLES[table].closed as readonly string[]).includes(tab)) return undefined;
  const shape = SHAPES[table];
  return `SELECT '${shape.type}' AS type, t.id::text AS id, t.${shape.title} AS title, ${shape.parent ?? "NULL::text"} AS parent,
      t.status::text AS status, t.version AS version, ${SORT_TEXT} AS sort_text, t.closed_at, t.closed_by, t.closed_reason,
      t.closed_from_status, t.closed_batch
    FROM ${table} t WHERE ${OWNED_BY_USER[table]} AND t.status::text = '${tab}' AND ${NOT_UNDONE}`;
}

/** The ancestors of a row as a name and status, top down, to find the first closed one. */
async function blockedByOf(
  sql: Sql,
  type: CloseType,
  id: string
): Promise<NonNullable<ClosedRow["blockedBy"]> | null> {
  for (const ancestor of await ancestorsOf(sql, type, id)) {
    const table = CLOSE_TABLE_OF[ancestor.type];
    const shape = SHAPES[table];
    const row = (
      await sql.unsafe<{ status: string; title: string }[]>(
        `SELECT status::text AS status, ${shape.title} AS title FROM ${table} WHERE id = $1`,
        [ancestor.id]
      )
    )[0];
    if (row && (row.status === "archived" || row.status === "cancelled"))
      return { type: ancestor.type, id: ancestor.id, title: row.title, status: row.status };
  }
  return null;
}

export async function readClosed(sql: Sql, userId: string, query: ClosedQuery): Promise<ClosedPage> {
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? CLOSED_DEFAULT_LIMIT), 1), CLOSED_MAX_LIMIT);
  const cursor = query.before === undefined ? null : parseClosedCursor(query.before);
  if (query.before !== undefined && cursor === null) throw new RangeError("before must be the nextCursor of an earlier page.");

  const tables = TABLES.filter((table) => query.type === undefined || SHAPES[table].type === query.type);
  const selects = tables.map((table) => selectOf(table, query.tab)).filter((text): text is string => text !== undefined);

  let rows: Found[] = [];
  const batchSizes = new Map<string, number>();
  if (selects.length > 0) {
    const params: unknown[] = [userId];
    let where = "";
    if (cursor) {
      params.push(cursor.at, cursor.key);
      where = "WHERE (u.sort_text, u.type || ':' || u.id) < ($2, $3)";
    }
    params.push(limit + 1);
    rows = await sql.unsafe<Found[]>(
      `SELECT * FROM (${selects.join(" UNION ALL ")}) u ${where}
       ORDER BY u.sort_text DESC, u.type || ':' || u.id DESC LIMIT $${params.length}`,
      params as never[]
    );
    const batches = [...new Set(rows.map((row) => row.closed_batch).filter((batch): batch is string => batch !== null))];
    if (batches.length > 0) {
      const counted = TABLES.map(
        (table) =>
          `SELECT t.closed_batch FROM ${table} t WHERE ${OWNED_BY_USER[table]} AND t.closed_batch = ANY(string_to_array($2, ',')::uuid[]) AND t.status::text IN (${quote(CLOSED_TABLES[table].closed)})`
      ).join(" UNION ALL ");
      const sizes = await sql.unsafe<{ batch: string; n: number }[]>(
        `SELECT closed_batch::text AS batch, count(*)::int AS n FROM (${counted}) b GROUP BY closed_batch`,
        [userId, batches.join(",")] as never[]
      );
      for (const size of sizes) batchSizes.set(size.batch, size.n);
    }
  }
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;

  const out: ClosedRow[] = [];
  for (const row of page) {
    out.push({
      type: row.type,
      id: row.id,
      title: row.title,
      parent: row.parent,
      status: row.status,
      version: row.version,
      closedAt: row.closed_at === null ? null : new Date(row.closed_at).toISOString(),
      closedBy: row.closed_by,
      reason: row.closed_reason,
      fromStatus: row.closed_from_status,
      batchSize: row.closed_batch === null ? 0 : (batchSizes.get(row.closed_batch) ?? 1),
      // One ancestor walk per row on the page, never per row of the table.
      blockedBy: await blockedByOf(sql, row.type, row.id),
      restoreVerb: restoreVerbFor(row.status)
    });
  }
  const last = page.at(-1);
  return {
    rows: out,
    nextCursor: more && last ? `${last.sort_text}|${last.type}:${last.id}` : null,
    counts: await countsOf(sql, userId)
  };
}

/** Rows per tab, whatever the page's type filter. */
async function countsOf(sql: Sql, userId: string): Promise<ClosedPage["counts"]> {
  const counts = { archived: 0, cancelled: 0 };
  for (const tab of ["archived", "cancelled"] as const) {
    const parts = TABLES.filter((table) => (CLOSED_TABLES[table].closed as readonly string[]).includes(tab)).map(
      (table) =>
        `SELECT count(*)::int AS n FROM ${table} t WHERE ${OWNED_BY_USER[table]} AND t.status::text = '${tab}' AND ${NOT_UNDONE}`
    );
    const found = await sql.unsafe<{ n: number }[]>(parts.join(" UNION ALL "), [userId] as never[]);
    counts[tab] = found.reduce((sum, row) => sum + row.n, 0);
  }
  return counts;
}

/** `agent:<name>` and nothing else: no `:confirmed`, no `:undo`, no person, system or NULL (the same rule as `classifyClosedBy`). */
const PLAIN_AGENT = "^agent:[a-z0-9_-]{1,32}$";

/**
 * The badge: rows still closed that an agent closed in the 24 hours before `now`. A restored row has its stamps
 * nulled, so it leaves the count by itself. `now` is a parameter so a test needs no clock.
 */
export async function readClosedSummary(sql: Sql, userId: string, now: Date): Promise<ClosedSummary> {
  const since = new Date(now.getTime() - CLOSED_BADGE_WINDOW_HOURS * 3_600_000);
  const parts = TABLES.map(
    (table) =>
      `SELECT t.closed_at FROM ${table} t WHERE ${OWNED_BY_USER[table]} AND t.status::text IN (${quote(CLOSED_TABLES[table].closed)}) AND t.closed_at > $2 AND t.closed_at <= $3 AND t.closed_by ~ '${PLAIN_AGENT}'`
  );
  const found = await sql.unsafe<{ n: number; latest: Date | null }[]>(
    `SELECT count(*)::int AS n, max(closed_at) AS latest FROM (${parts.join(" UNION ALL ")}) c`,
    [userId, since, now] as never[]
  );
  const row = found[0];
  return {
    agentLast24h: row?.n ?? 0,
    latestAt: row?.latest ? new Date(row.latest).toISOString() : null
  };
}
