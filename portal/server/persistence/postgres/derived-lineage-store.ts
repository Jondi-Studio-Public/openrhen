import type { Sql, TxSql } from "./sql-pool";

/**
 * Lineage for derived rows (communication-understanding design, sections 3-4): which source rows a derived row was
 * read from, so that deleting a source takes the derived rows with it. A derived row is a projection and may be
 * physically deleted (the append-only trigger blocks UPDATE only); a fact read from several messages stays until the
 * last of them goes. The store's delete paths call `deleteDerivedForSources` before deleting the source rows, in the
 * same transaction, because the foreign keys cascade the lineage rows away with the source and the helper needs them.
 */

/**
 * Ids go in as one JSON parameter and are expanded with `jsonb_array_elements_text`: a pool opened without type fetching
 * (the integration suites) cannot encode an array parameter, and the portal's other id-list queries do the same.
 * Lineage only ever points from rows whose source is `derived` or `derived-shadow`.
 */
const idList = (sql: Sql, ids: readonly string[]) => sql.json(ids as string[]);

/**
 * Links every derived row to every source row it was read from. Idempotent: a link already held is left as it is, so a
 * rerun of an extractor adds nothing. Ids that are not the person's rows are skipped, so a caller cannot link across
 * people. Returns how many links were new.
 */
export async function recordLineage(
  sql: Sql,
  userId: string,
  derivedIds: readonly string[],
  sourceIds: readonly string[]
): Promise<number> {
  if (derivedIds.length === 0 || sourceIds.length === 0) return 0;
  const derivedList = idList(sql, derivedIds);
  const sourceList = idList(sql, sourceIds);
  const added = await sql`
    INSERT INTO derived_lineage (user_id, derived_id, source_id)
    SELECT ${userId}, d.id, s.id
    FROM activity_events d
    CROSS JOIN activity_events s
    WHERE d.id IN (SELECT value::uuid FROM jsonb_array_elements_text(${derivedList})) AND d.user_id = ${userId}
      AND d.source IN ('derived', 'derived-shadow')
      AND s.id IN (SELECT value::uuid FROM jsonb_array_elements_text(${sourceList})) AND s.user_id = ${userId}
    ON CONFLICT (derived_id, source_id) DO NOTHING
    RETURNING 1`;
  return added.length;
}

/**
 * Deletes the derived rows whose lineage touches `sourceIds`, but only those with no lineage source left outside
 * that set (a source already gone has no lineage row, so it counts as removed). Must run before the source rows
 * are deleted, in the same transaction. Returns how many derived rows went.
 */
export async function deleteDerivedForSources(
  tx: TxSql,
  userId: string,
  sourceIds: readonly string[]
): Promise<number> {
  if (sourceIds.length === 0) return 0;
  const sourceList = idList(tx, sourceIds);
  const gone = await tx`
    DELETE FROM activity_events d
    WHERE d.user_id = ${userId}
      AND d.source IN ('derived', 'derived-shadow')
      AND d.id IN (SELECT l.derived_id FROM derived_lineage l WHERE l.source_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${sourceList})))
      AND NOT EXISTS (
        SELECT 1 FROM derived_lineage rest
        WHERE rest.derived_id = d.id AND rest.source_id NOT IN (SELECT value::uuid FROM jsonb_array_elements_text(${sourceList}))
      )
    RETURNING 1`;
  return gone.length;
}
