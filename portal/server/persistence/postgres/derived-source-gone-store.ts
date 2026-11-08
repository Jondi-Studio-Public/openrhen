import { validateActivityEvent } from "@openrhen/contracts";
import {
  isOpenStatus,
  resolveFactStatus,
  statusEventKey,
  type StatusActor,
  type StatusRow,
  type FactStatus
} from "@openrhen/communication-readers";
import type { TxSql } from "./sql-pool";

/**
 * The runner's only status write (communication understanding, slice 2a-2d). Extractors still write `msg_class` and
 * `fact` only (`writeDerivedRowsTx` refuses everything else). The one exception is here: when retention is about to
 * delete the last source rows of a fact that is still open, the runner appends `source_gone` so the fact reads as "its
 * evidence was removed" instead of silently open. It can write that one status and nothing else: no `done`,
 * `cancelled` or `confirmed` (those are a person's or Mark's statements), and the row kind is fixed, so there is no
 * path to an override or a label.
 */

/** The fixed `ingested_via` on every `source_gone` row; the `extractor:` prefix makes it the lowest-ranked actor. */
export const RETENTION_VIA = "extractor:retention";

const INSERT_CHUNK = 500;
const idList = (tx: TxSql, ids: readonly string[]) => tx.json(ids as string[]);

/** Who a status row's `ingested_via` stands for: null is the person, `extractor:` an extractor, anything else Mark. */
export function actorOf(via: string | null): StatusActor {
  if (via === null) return "person";
  return via.startsWith("extractor:") ? "extractor" : "mark";
}

/**
 * Appends one `fact_status` row per fact id, in the caller's transaction. `status` is typed and checked at run time as
 * `source_gone` only. Idempotent (the key hashes fact, status, instant and author). Returns how many rows were new.
 */
export async function appendRunnerFactStatusTx(
  tx: TxSql,
  userId: string,
  factIds: readonly string[],
  status: "source_gone",
  now: Date
): Promise<number> {
  if ((status as string) !== "source_gone")
    throw new Error(
      `The runner may append the status "source_gone" only, not "${String(status)}". Other statuses are a person's or Mark's to write.`
    );
  const validFrom = now.toISOString();
  const records: Record<string, unknown>[] = [];
  for (const factId of new Set(factIds)) {
    const key = statusEventKey({
      kind: "fact_status",
      factId,
      field: "status",
      newValue: status,
      validFrom,
      by: RETENTION_VIA
    });
    const verdict = validateActivityEvent(
      {
        id: key,
        source: "derived",
        kind: "fact_status",
        start: validFrom,
        attrs: { fact_id: factId, status, valid_from: validFrom }
      },
      now
    );
    if (!verdict.ok) throw new Error(verdict.reason);
    const event = verdict.event;
    records.push({
      user_id: userId,
      source: "derived",
      kind: "fact_status",
      event_key: event.key,
      device: null,
      ts_start: event.tsStart,
      ts_end: null,
      tz_offset_min: null,
      approximate: false,
      attrs: tx.json(event.attrs as never),
      content: null,
      import_id: null,
      ingested_via: RETENTION_VIA
    });
  }
  let added = 0;
  for (let at = 0; at < records.length; at += INSERT_CHUNK) {
    const inserted = await tx`
      INSERT INTO activity_events ${tx(records.slice(at, at + INSERT_CHUNK))}
      ON CONFLICT (user_id, source, event_key) DO NOTHING RETURNING 1`;
    added += inserted.length;
  }
  return added;
}

/**
 * Before retention deletes `batchIds`: appends `source_gone` for every derived fact whose lineage sources are ALL in
 * the batch and whose resolved status is open. A fact that still has a source outside the batch is left alone (it gets
 * its mark when the last one goes); an already-closed fact is left alone, which is also what makes a rerun write
 * nothing. Must run in the same transaction as the delete. Returns how many facts were marked.
 */
export async function markSourceGoneTx(
  tx: TxSql,
  userId: string,
  batchIds: readonly string[],
  now: Date
): Promise<number> {
  if (batchIds.length === 0) return 0;
  const batch = idList(tx, batchIds);
  const facts = await tx<{ fact_id: string | null; ts_end: Date | null }[]>`
    SELECT d.attrs->>'fact_id' AS fact_id, d.ts_end
    FROM activity_events d
    WHERE d.user_id = ${userId} AND d.source = 'derived' AND d.kind = 'fact'
      AND d.id IN (SELECT l.derived_id FROM derived_lineage l WHERE l.source_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${batch})))
      AND NOT EXISTS (
        SELECT 1 FROM derived_lineage rest
        WHERE rest.derived_id = d.id AND rest.source_id NOT IN (SELECT value::uuid FROM jsonb_array_elements_text(${batch}))
      )`;
  const endOf = new Map<string, string | null>();
  for (const fact of facts) {
    if (fact.fact_id === null) continue;
    const end = fact.ts_end?.toISOString() ?? null;
    const held = endOf.get(fact.fact_id);
    endOf.set(fact.fact_id, held === undefined || (end !== null && (held === null || end > held)) ? end : held);
  }
  if (endOf.size === 0) return 0;
  const rows = await tx<{ fact_id: string; status: string; valid_from: string; via: string | null; key: string }[]>`
    SELECT attrs->>'fact_id' AS fact_id, attrs->>'status' AS status, attrs->>'valid_from' AS valid_from,
           ingested_via AS via, event_key AS key
    FROM activity_events
    WHERE user_id = ${userId} AND source = 'derived' AND kind = 'fact_status'
      AND attrs->>'fact_id' IN (SELECT value FROM jsonb_array_elements_text(${idList(tx, [...endOf.keys()])}))`;
  const byFact = new Map<string, StatusRow[]>();
  for (const row of rows) {
    const list = byFact.get(row.fact_id) ?? [];
    list.push({ status: row.status as FactStatus, validFrom: row.valid_from, actor: actorOf(row.via), key: row.key });
    byFact.set(row.fact_id, list);
  }
  const open: string[] = [];
  for (const [factId, end] of endOf)
    if (isOpenStatus(resolveFactStatus(byFact.get(factId) ?? [], { now, expiresAt: end }).status)) open.push(factId);
  return appendRunnerFactStatusTx(tx, userId, open, "source_gone", now);
}
