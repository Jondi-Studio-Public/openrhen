import type { ImportBatch, ImportRecord, PreviewImport } from "@openrhen/contracts";
import type { Sql } from "../sql-pool";

/**
 * How a batch and its records are stored and read back: the row shapes of `import_batches` and
 * `import_records`, the status a set of records earns, and the one insert path every batch takes.
 */

/** `blocked` while any kept record would stop a commit; `ready` otherwise. */
export const batchStatus = (records: ImportRecord[]) =>
  records.some(
    (record) =>
      !record.removed && (record.errors.length || record.operation === "conflict" || record.operation === "rejected")
  )
    ? "blocked"
    : "ready";

/**
 * The statuses that count as "still open" for a batch: previewed, maybe edited, not yet committed
 * and not deleted. Shared between the lookup below and the partial unique index in `schema.ts`
 * (`import_batches_open_content_unique`) that keeps two uploads of the same file from racing their
 * way into two open drafts.
 */
export const OPEN_IMPORT_BATCH_STATUSES = ["draft", "ready", "blocked"] as const;

/** The newest open batch with this content, or null. Committed and failed batches never match. */
export async function findOpenBatchByHash(sql: Sql, userId: string, sourceType: string, contentHash: string) {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM import_batches
    WHERE user_id=${userId} AND source_type=${sourceType} AND content_hash=${contentHash}
      AND status IN ${sql(OPEN_IMPORT_BATCH_STATUSES)}
    ORDER BY created_at DESC LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

/** Whether a thrown value is a Postgres unique-violation error (SQLSTATE 23505). */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

/**
 * The one way a batch and its records enter the database. Every path that makes a batch — a
 * preview, a calendar provider diff, the blocked remainder of a partial commit — goes through here, so what
 * a batch carries (its source, hash, timezone, the fields' provenance) is decided in one place.
 */
export async function insertBatch(sql: Sql, userId: string, input: PreviewImport, records: ImportRecord[]) {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO import_batches (user_id, source_type, input_kind, timezone, template_version, status, source_text, source_filename, source_mime_type, content_hash, source_files)
    VALUES (${userId}, ${input.sourceType}, ${input.inputKind}, ${input.timezone}, ${input.templateVersion}, ${batchStatus(records)}, ${input.source.text ?? null}, ${input.source.filename ?? null}, ${input.source.mimeType ?? null}, ${input.source.contentHash ?? null}, ${sql.json((input.source.files ?? []) as never)})
    RETURNING id
  `;
  const batchId = rows[0]!.id;
  await writeRecords(sql, batchId, records);
  return batchId;
}

/** Rows per INSERT: well under the parameter ceiling at thirteen columns a row, and one statement for most batches. */
const INSERT_CHUNK = 500;

/** Writes the records of a batch, a chunk of rows per statement rather than a statement per row. */
export async function writeRecords(sql: Sql, batchId: string, records: ImportRecord[]) {
  for (let start = 0; start < records.length; start += INSERT_CHUNK) {
    const rows = records.slice(start, start + INSERT_CHUNK).map((record) => ({
      id: record.id,
      batch_id: batchId,
      import_key: record.importKey,
      entity_type: record.entityType,
      operation: record.operation,
      expected_version: record.expectedVersion,
      matched_entity_id: record.matchedEntityId,
      fields: sql.json(record.fields as never),
      relationships: sql.json(record.relationships as never),
      validation_errors: sql.json(record.errors as never),
      warnings: sql.json(record.warnings as never),
      removed: record.removed,
      sort_order: record.sortOrder
    }));
    await sql`INSERT INTO import_records ${sql(rows as never[])}`;
  }
}

/** The stored source of a batch as the contract carries it: only the parts that are set. */
export function batchSource(row: {
  source_text: string | null;
  source_filename: string | null;
  source_mime_type: string | null;
  content_hash: string | null;
  source_files: unknown;
}): ImportBatch["source"] {
  return {
    ...(row.source_text ? { text: row.source_text } : {}),
    ...(row.source_filename ? { filename: row.source_filename } : {}),
    ...(row.source_mime_type ? { mimeType: row.source_mime_type } : {}),
    ...(row.content_hash ? { contentHash: row.content_hash } : {}),
    ...(Array.isArray(row.source_files) && row.source_files.length ? { files: row.source_files as never } : {})
  };
}

export function mapRecord(row: any): ImportRecord {
  return {
    id: row.id,
    importKey: row.import_key,
    entityType: row.entity_type,
    operation: row.operation,
    expectedVersion: row.expected_version,
    matchedEntityId: row.matched_entity_id,
    fields: row.fields,
    relationships: row.relationships,
    errors: row.validation_errors,
    warnings: row.warnings,
    removed: row.removed,
    sortOrder: row.sort_order
  };
}

export function mapBatch(row: any, records: any[]): ImportBatch {
  return {
    id: row.id,
    sourceType: row.source_type,
    inputKind: row.input_kind,
    timezone: row.timezone,
    templateVersion: row.template_version,
    status: row.status,
    version: row.version,
    records: records.map(mapRecord),
    source: batchSource(row),
    createdAt: row.created_at.toISOString(),
    ...(row.committed_at ? { committedAt: row.committed_at.toISOString() } : {})
  };
}
