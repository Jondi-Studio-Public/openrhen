import {
  WORK_LABEL_CORRECTED_VALUES,
  WORK_LABEL_INFERRED_VIA,
  WORK_LABEL_ORIGINS,
  type WorkLabelRow
} from "@openrhen/contracts/drift/labels";
import { validateActivityEvent } from "@openrhen/contracts";
import {
  buildAreaSnapshots,
  type AreaItemRow,
  type AreaRow,
  type AreaSnapshot
} from "@/server/drift/work-label-prompt";
import { insertServerEventTx } from "./activity-store";
import type { Sql, TxSql } from "./sql-pool";

/**
 * Reads and writes for work labels (source `drift`, kind `work_label`; docs/architecture/drift.md). The writes go
 * through `validateActivityEvent`, the same judge as the API, and stamp `ingested_via`: `drift:label` for the model's
 * rows and NULL for the owner's own answers, which is how a reader tells them apart. No token can write the source
 * (`agent-routes.ts`), and the owner's generic route is not used for labels. Callers take the per-person activity lock.
 */

const ROW_LIMIT = 5000;
/** Per area, the open children listed (the prompt keeps at most 40 of them), so a large plan is not read whole. */
const ITEMS_PER_AREA = 60;
const ACTIVE = ["active", "paused"];

/**
 * The areas the model may be shown, with their text, after private ones are dropped. Privacy is filtered twice: in the
 * query, and again in `buildAreaSnapshots`, which is the tested rule. Outcomes carry no flag of their own; they follow
 * their area, which is dropped whole when private.
 */
export async function readAreaSnapshots(sql: Sql, userId: string): Promise<AreaSnapshot[]> {
  const areas = await sql<
    { id: string; name: string; description: string | null; private: boolean; status: string; closed_at: Date | null }[]
  >`
    SELECT id, name, description, private, status, closed_at FROM areas
    WHERE user_id = ${userId} AND NOT private AND closed_at IS NULL AND status IN ${sql(ACTIVE)}
    ORDER BY id`;
  if (areas.length === 0) return [];
  const items = await sql<
    {
      area_id: string;
      title: string;
      private: boolean;
      parent_private: boolean;
      status: string;
      closed_at: Date | null;
    }[]
  >`
    WITH items AS (
      SELECT o.area_id, 1 AS rank, o.title, o.id AS id, false AS private, false AS parent_private,
             o.status::text AS status, o.closed_at
      FROM outcomes o JOIN areas a ON a.id = o.area_id
      WHERE a.user_id = ${userId} AND NOT a.private AND o.closed_at IS NULL AND o.status IN ${sql(ACTIVE)}
      UNION ALL
      SELECT o.area_id, 2, p.title, p.id, p.private, false, p.status::text, p.closed_at
      FROM projects p JOIN outcomes o ON o.id = p.outcome_id JOIN areas a ON a.id = o.area_id
      WHERE a.user_id = ${userId} AND NOT a.private AND NOT p.private AND p.closed_at IS NULL
        AND o.status IN ${sql(ACTIVE)} AND p.status IN ${sql(ACTIVE)}
      UNION ALL
      SELECT o.area_id, 3, ac.title, ac.id, ac.private, p.private, ac.status::text, ac.closed_at
      FROM actions ac JOIN projects p ON p.id = ac.project_id JOIN outcomes o ON o.id = p.outcome_id
      JOIN areas a ON a.id = o.area_id
      WHERE a.user_id = ${userId} AND NOT a.private AND NOT p.private AND NOT ac.private
        AND p.closed_at IS NULL AND ac.closed_at IS NULL AND o.status IN ${sql(ACTIVE)} AND p.status IN ${sql(ACTIVE)}
    ), ranked AS (
      SELECT area_id, title, private, parent_private, status, closed_at,
             row_number() OVER (PARTITION BY area_id ORDER BY rank, title, id) AS n
      FROM items
    )
    SELECT area_id, title, private, parent_private, status, closed_at FROM ranked
    WHERE n <= ${ITEMS_PER_AREA} ORDER BY area_id, n`;
  const areaRows: AreaRow[] = areas.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    private: row.private,
    status: row.status,
    closedAt: row.closed_at
  }));
  const itemRows: AreaItemRow[] = items.map((row) => ({
    areaId: row.area_id,
    title: row.title,
    private: row.private,
    parentPrivate: row.parent_private,
    status: row.status,
    closedAt: row.closed_at
  }));
  return buildAreaSnapshots(areaRows, itemRows);
}

/** Whether the area is the person's (any area, private or not: the owner may answer for one). */
export async function areaExists(sql: Sql, userId: string, areaId: string): Promise<boolean> {
  const [row] = await sql<{ id: string }[]>`SELECT id FROM areas WHERE id::text = ${areaId} AND user_id = ${userId}`;
  return row !== undefined;
}

interface LabelRowRecord {
  id: string;
  attrs: Record<string, unknown>;
  ts_start: Date;
  ingested_at: Date;
  ingested_via: string | null;
}

/** Turns a stored row into the resolver's shape; a row that is not a well-formed label gives null and is ignored. */
export function toWorkLabelRow(row: LabelRowRecord): WorkLabelRow | null {
  const { attrs } = row;
  const areaId = attrs.area_id;
  const label = attrs.label;
  const origin = attrs.origin;
  if (typeof areaId !== "string" || typeof label !== "string" || typeof origin !== "string") return null;
  if (!(WORK_LABEL_CORRECTED_VALUES as readonly string[]).includes(label)) return null;
  if (!(WORK_LABEL_ORIGINS as readonly string[]).includes(origin)) return null;
  const hash = attrs.input_hash;
  const version = attrs.prompt_version;
  return {
    id: row.id,
    areaId,
    label: label as WorkLabelRow["label"],
    origin: origin as WorkLabelRow["origin"],
    inputHash: typeof hash === "string" ? hash : null,
    promptVersion: typeof version === "number" ? version : null,
    tsStart: row.ts_start,
    ingestedAt: row.ingested_at,
    ingestedVia: row.ingested_via
  };
}

/**
 * The label rows for the resolver: the newest inferred rows (bounded), and the owner's latest answer for every area
 * however old, so a busy history cannot push an answer out and let the label revert. Rows of another writer are
 * returned too and ignored by the resolver.
 */
export async function readWorkLabelRows(sql: Sql, userId: string): Promise<WorkLabelRow[]> {
  const inferred = await sql<LabelRowRecord[]>`
    SELECT id, attrs, ts_start, ingested_at, ingested_via FROM activity_events
    WHERE user_id = ${userId} AND source = 'drift' AND kind = 'work_label' AND attrs->>'origin' <> 'corrected'
    ORDER BY ts_start DESC, ingested_at DESC, id DESC
    LIMIT ${ROW_LIMIT}`;
  const corrected = await sql<LabelRowRecord[]>`
    SELECT DISTINCT ON (attrs->>'area_id') id, attrs, ts_start, ingested_at, ingested_via FROM activity_events
    WHERE user_id = ${userId} AND source = 'drift' AND kind = 'work_label' AND attrs->>'origin' = 'corrected'
      AND ingested_via IS NULL
    ORDER BY attrs->>'area_id', ts_start DESC, ingested_at DESC, id DESC`;
  return [...inferred, ...corrected].flatMap((row) => {
    const parsed = toWorkLabelRow(row);
    return parsed ? [parsed] : [];
  });
}

/** Which of these event keys are already stored. */
export async function heldLabelKeys(sql: Sql, userId: string, keys: readonly string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await sql<{ event_key: string }[]>`
    SELECT event_key FROM activity_events
    WHERE user_id = ${userId} AND source = 'drift' AND event_key IN ${sql(keys as string[])}`;
  return new Set(rows.map((row) => row.event_key));
}

export type WorkLabelWrite = { ok: true; added: boolean } | { ok: false; reason: string };

/**
 * Stores one label row inside the caller's transaction. `origin` decides the writer stamp: the model's rows are
 * `drift:label`, the owner's are NULL, and a row whose origin and stamp disagree is refused here as well as read past
 * by readers. A key already held is left as it is.
 */
export async function insertWorkLabel(
  tx: TxSql,
  userId: string,
  event: Record<string, unknown>,
  now: Date
): Promise<WorkLabelWrite> {
  const verdict = validateActivityEvent(event, now);
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  const row = verdict.event;
  if (row.source !== "drift" || row.kind !== "work_label")
    return { ok: false, reason: 'This call writes source "drift" kind "work_label" only.' };
  const via = row.attrs.origin === "inferred" ? WORK_LABEL_INFERRED_VIA : null;
  return { ok: true, added: await insertServerEventTx(tx, userId, row, via) };
}
