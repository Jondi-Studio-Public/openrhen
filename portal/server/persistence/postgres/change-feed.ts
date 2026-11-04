import { ENTITY_TABLES } from "./agent-change-detail";
import type { Sql } from "./sql-pool";

/** Default and ceiling for one page of `GET /api/changes`: a feed agents read should be small by default. */
export const CHANGE_FEED_DEFAULT_LIMIT = 20;
export const CHANGE_FEED_MAX_LIMIT = 200;

export interface ChangeFeedQuery {
  since?: Date;
  /** An agent's name, `human` (no actor) or `system`. */
  agent?: string;
  entity?: string;
  /** One entity's id: a uuid, or for a composite-keyed row the JSON array of its key values. */
  entityId?: string;
  limit: number;
  /** `createdAt~id` of the oldest row of the previous page. */
  before?: { createdAt: Date; id: string };
  evidence: boolean;
  /** Add each row's stored image facts (`imageTable`, `inserted`, `afterVersion`). */
  images?: boolean;
  count?: { by: "agent" | "entity" };
}

export type ChangeFeedQueryResult = { ok: true; query: ChangeFeedQuery } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = /^[a-z0-9_-]{1,32}$/;
const ENTITY = /^[a-z0-9_]{1,64}$/;
// `write_rows.entity_id` is a uuid, a short text key, or a JSON array of key values (composite tables).
const ENTITY_ID = /^[A-Za-z0-9_.:\-[\]",]{1,200}$/;

/** Validates `GET /api/changes` query parameters; a bad one is a 400 naming it. */
export function parseChangeFeedQuery(params: URLSearchParams): ChangeFeedQueryResult {
  const query: ChangeFeedQuery = {
    limit: CHANGE_FEED_DEFAULT_LIMIT,
    evidence: params.get("evidence") === "1",
    images: params.get("images") === "1"
  };

  const since = params.get("since");
  if (since !== null) {
    const date = new Date(since);
    if (Number.isNaN(date.getTime())) return { ok: false, error: "since must be an ISO date-time." };
    query.since = date;
  }
  const agent = params.get("agent");
  if (agent !== null) {
    if (!NAME.test(agent)) return { ok: false, error: "agent must be a name, human, or system." };
    query.agent = agent;
  }
  const entity = params.get("entity");
  if (entity !== null) {
    if (!ENTITY.test(entity)) return { ok: false, error: "entity must be an entity type such as project or session." };
    query.entity = entity;
  }
  const entityId = params.get("entityId");
  if (entityId !== null) {
    if (!ENTITY_ID.test(entityId)) return { ok: false, error: "entityId must be the id of an entity." };
    query.entityId = entityId;
  }
  const limit = params.get("limit");
  if (limit !== null) {
    const value = Number(limit);
    if (!Number.isInteger(value) || value < 1 || value > CHANGE_FEED_MAX_LIMIT)
      return { ok: false, error: `limit must be a whole number from 1 to ${CHANGE_FEED_MAX_LIMIT}.` };
    query.limit = value;
  }
  const before = params.get("before");
  if (before !== null) {
    const [createdAt, id] = before.split("~");
    const date = new Date(createdAt ?? "");
    if (!id || !UUID.test(id) || Number.isNaN(date.getTime()))
      return { ok: false, error: "before must be a cursor from a previous result." };
    query.before = { createdAt: date, id };
  }
  if (params.get("count") === "1") {
    const by = params.get("by") ?? "agent";
    if (by !== "agent" && by !== "entity") return { ok: false, error: "by must be agent or entity." };
    query.count = { by };
  }
  return { ok: true, query };
}

export interface ChangeFeedRow {
  id: string;
  at: string;
  entityType: string;
  entityId: string | null;
  operation: string;
  actor: string | null;
  commandId: string | null;
  /** True only when a before-image is still stored, so a caller knows whether a change could be reversed. */
  beforeRecorded: boolean;
  evidence?: Record<string, unknown>;
  /** With `images=1` only: the table of the write's stored image for this entity, null when none is kept. */
  imageTable?: string | null;
  /** With `images=1` only: the image shows the row did not exist before (before null, after present). */
  inserted?: boolean;
  /** With `images=1` only: the `version` of the after image when it is a number. */
  afterVersion?: number | null;
}

export type ChangeFeedResult =
  { changes: ChangeFeedRow[]; cursor: string | null } | { total: number; counts: { value: string; count: number }[] };

/** Reads `write_rows` (with each write's actor) newest first, filtered and keyset-paged, or counted by agent or entity type. */
export async function readChangeFeed(sql: Sql, userId: string, query: ChangeFeedQuery): Promise<ChangeFeedResult> {
  const since = query.since ? sql`AND r.created_at > ${query.since}` : sql``;
  const agent =
    query.agent === undefined
      ? sql``
      : query.agent === "human"
        ? sql`AND w.actor IS NULL`
        : sql`AND w.actor = ${query.agent}`;
  const entity = query.entity ? sql`AND r.entity_type = ${query.entity}` : sql``;
  const entityId = query.entityId ? sql`AND r.entity_id = ${query.entityId}` : sql``;

  if (query.count) {
    const column = query.count.by === "agent" ? sql`COALESCE(w.actor, 'human')` : sql`r.entity_type`;
    const rows = await sql<{ value: string; count: number }[]>`
      SELECT ${column} AS value, count(*)::int AS count FROM write_rows r JOIN writes w ON w.id = r.write_id
      WHERE r.user_id = ${userId} ${since} ${agent} ${entity} ${entityId}
      GROUP BY 1 ORDER BY count DESC, value`;
    return { total: rows.reduce((sum, row) => sum + row.count, 0), counts: rows.map((row) => ({ ...row })) };
  }

  const before = query.before ? sql`AND (r.created_at, r.id) < (${query.before.createdAt}, ${query.before.id})` : sql``;
  const rows = await sql<
    {
      id: string;
      created_at: Date;
      entity_type: string;
      entity_id: string | null;
      operation: string;
      actor: string | null;
      command_id: string | null;
      before_recorded: boolean;
      evidence: Record<string, unknown> | null;
      image_table: string | null;
      inserted: boolean | null;
      after_version: number | null;
    }[]
  >`
    SELECT r.id, r.created_at, r.entity_type, r.entity_id, r.operation, w.actor, r.write_id AS command_id,
      jsonb_typeof(r.evidence -> 'before') = 'object' AS before_recorded,
      ${query.evidence ? sql`r.evidence` : sql`NULL::jsonb`} AS evidence,
      ${query.images ? sql`img.image_table, img.inserted, img.after_version` : sql`NULL::text AS image_table, NULL::boolean AS inserted, NULL::int AS after_version`}
    FROM write_rows r JOIN writes w ON w.id = r.write_id
    ${
      query.images
        ? sql`LEFT JOIN LATERAL (
      SELECT e ->> 'table' AS image_table,
        (e -> 'before' IS NULL OR jsonb_typeof(e -> 'before') = 'null') AND jsonb_typeof(e -> 'after') = 'object' AS inserted,
        CASE WHEN jsonb_typeof(e #> '{after,version}') = 'number' THEN (e #>> '{after,version}')::int END AS after_version
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(w.images) = 'array' THEN w.images ELSE '[]'::jsonb END) e
      WHERE e ->> 'id' = r.entity_id
        AND (${sql.json(ENTITY_TABLES as never)}::jsonb ->> r.entity_type IS NULL OR e ->> 'table' = ${sql.json(ENTITY_TABLES as never)}::jsonb ->> r.entity_type)
      LIMIT 1
    ) img ON true`
        : sql``
    }
    WHERE r.user_id = ${userId} ${since} ${agent} ${entity} ${entityId} ${before}
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT ${query.limit + 1}`;
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    changes: page.map((row) => ({
      id: row.id,
      at: row.created_at.toISOString(),
      entityType: row.entity_type,
      entityId: row.entity_id,
      operation: row.operation,
      actor: row.actor,
      commandId: row.command_id,
      beforeRecorded: row.before_recorded === true,
      ...(query.evidence && row.evidence ? { evidence: row.evidence } : {}),
      ...(query.images
        ? { imageTable: row.image_table, inserted: row.inserted === true, afterVersion: row.after_version }
        : {})
    })),
    cursor: rows.length > query.limit && last ? `${last.created_at.toISOString()}~${last.id}` : null
  };
}
