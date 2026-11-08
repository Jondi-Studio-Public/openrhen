import { DERIVED_EXTRACTOR_KINDS, validateActivityEvent } from "@openrhen/contracts";
import { lockActivityUser } from "./activity-lock";
import { recordLineage } from "./derived-lineage-store";
import { ensureUser } from "./ensure-user";
import type { PoolSql, TxSql } from "./sql-pool";

/**
 * The in-process write for derived rows (communication understanding, slice 2a-2c). The ingest route cannot carry
 * lineage and does not say which id a held row has, so the extractor runner writes through this: one transaction that
 * inserts the rows, returns the id of EVERY row (the existing one, found by event key, when it was already held), and
 * links each row to the source rows it was read from. External tokens can never create lineage, which is why this has
 * no route.
 *
 * Each row goes through `validateActivityEvent`, the same judge as the API, so the runner cannot store what a client
 * would be refused. A row it refuses is reported alone and the rest are written. Only source `derived`, and only the kinds an extractor writes (`msg_class`, `fact`), are written here: the rule that the runner never writes a status, override or label is held by this function, not just by the extractors.
 */

const INSERT_CHUNK = 500;

export interface DerivedRowInput {
  /** The row as the API takes it: `{id, source: "derived", kind, start, attrs, ...}`. `id` becomes the event key. */
  event: unknown;
  /** The source rows (ids of `activity_events`) this row was read from. */
  sourceIds: readonly string[];
}

export type DerivedRowResult = { ok: true; id: string; added: boolean } | { ok: false; reason: string };

/** Opens its own transaction. `via` is the fixed extractor name recorded as `ingested_via`. */
export async function writeDerivedRows(
  sql: PoolSql,
  rows: readonly DerivedRowInput[],
  via: string,
  now: Date = new Date()
): Promise<DerivedRowResult[]> {
  const userId = await ensureUser(sql);
  return sql.begin((tx) => writeDerivedRowsTx(tx, userId, rows, via, now));
}

/**
 * Inside the caller's transaction. Takes the per-person activity lock first (re-entrant, so a caller that already holds
 * it is unaffected), so a delete of the source rows cannot slip between reading them and linking to them.
 */
export async function writeDerivedRowsTx(
  tx: TxSql,
  userId: string,
  rows: readonly DerivedRowInput[],
  via: string,
  now: Date = new Date()
): Promise<DerivedRowResult[]> {
  await lockActivityUser(tx, userId);
  const results: (DerivedRowResult | null)[] = rows.map(() => null);
  const keyOf: (string | null)[] = rows.map(() => null);
  const firstOfKey = new Map<string, number>();
  const sourcesOfKey = new Map<string, Set<string>>();
  const toInsert: { key: string; record: Record<string, unknown> }[] = [];

  rows.forEach((input, index) => {
    const verdict = validateActivityEvent(input.event, now);
    if (!verdict.ok) {
      results[index] = { ok: false, reason: verdict.reason };
      return;
    }
    const event = verdict.event;
    if (event.source !== "derived") {
      results[index] = {
        ok: false,
        reason: `The runner writes source "derived" only, not "${event.source}". Build the row with source "derived".`
      };
      return;
    }
    if (!(DERIVED_EXTRACTOR_KINDS as readonly string[]).includes(event.kind)) {
      results[index] = {
        ok: false,
        reason: `The runner writes ${DERIVED_EXTRACTOR_KINDS.join(" and ")} rows only, not "${event.kind}". A status, override or label is a person's or Mark's to write through the API.`
      };
      return;
    }
    keyOf[index] = event.key;
    const sources = sourcesOfKey.get(event.key) ?? new Set<string>();
    for (const id of input.sourceIds) sources.add(id);
    sourcesOfKey.set(event.key, sources);
    if (firstOfKey.has(event.key)) return; // a repeat inside the batch resolves to the first copy's id
    firstOfKey.set(event.key, index);
    toInsert.push({
      key: event.key,
      record: {
        user_id: userId,
        source: event.source,
        kind: event.kind,
        event_key: event.key,
        device: null,
        ts_start: event.tsStart,
        ts_end: event.tsEnd,
        tz_offset_min: event.tzOffsetMin,
        approximate: event.approximate,
        attrs: tx.json(event.attrs as never),
        content: null,
        import_id: null,
        ingested_via: via
      }
    });
  });

  const idOf = new Map<string, { id: string; added: boolean }>();
  for (let at = 0; at < toInsert.length; at += INSERT_CHUNK) {
    const chunk = toInsert.slice(at, at + INSERT_CHUNK);
    const inserted = await tx<{ id: string; event_key: string }[]>`
      INSERT INTO activity_events ${tx(chunk.map((item) => item.record))}
      ON CONFLICT (user_id, source, event_key) DO NOTHING
      RETURNING id, event_key`;
    for (const row of inserted) idOf.set(row.event_key, { id: row.id, added: true });
    const held = chunk.filter((item) => !idOf.has(item.key)).map((item) => item.key);
    if (held.length > 0) {
      const existing = await tx<{ id: string; event_key: string }[]>`
        SELECT id, event_key FROM activity_events
        WHERE user_id = ${userId} AND source = 'derived' AND event_key IN ${tx(held)}`;
      for (const row of existing) idOf.set(row.event_key, { id: row.id, added: false });
    }
  }

  keyOf.forEach((key, index) => {
    if (key === null) return;
    const found = idOf.get(key);
    results[index] = found
      ? { ok: true, id: found.id, added: found.added && firstOfKey.get(key) === index }
      : { ok: false, reason: "The row was not stored." };
  });

  for (const [key, sources] of sourcesOfKey) {
    const found = idOf.get(key);
    if (found && sources.size > 0) await recordLineage(tx, userId, [found.id], [...sources]);
  }
  return results.map((result) => result ?? { ok: false, reason: "The row was not stored." });
}
