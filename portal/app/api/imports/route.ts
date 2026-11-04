import { withRoute } from "@/server/logging";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";
import type { ImportBatchSummary } from "@/features/imports/import-queue";

type BatchRow = {
  id: string;
  source_type: ImportBatchSummary["sourceType"];
  input_kind: ImportBatchSummary["inputKind"];
  status: ImportBatchSummary["status"];
  version: number;
  created_at: Date;
  updated_at: Date;
  committed_at: Date | null;
  source_filename: string | null;
  record_count: number;
  blocking_count: number;
};

const toSummary = (row: BatchRow): ImportBatchSummary => ({
  id: row.id,
  sourceType: row.source_type,
  inputKind: row.input_kind,
  status: row.status,
  version: row.version,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  committedAt: row.committed_at?.toISOString() ?? null,
  filename: row.source_filename,
  recordCount: row.record_count,
  blockingCount: row.blocking_count
});

/**
 * The Inbox queue and the history beneath it. `batches` is everything previewed and not yet
 * committed, newest first; `history` is what was written, newest first and capped, because a
 * committed batch is a record of what happened rather than a decision still waiting to be made.
 * Records stay behind `/api/imports/[id]` until a batch is opened, so both lists together are still
 * one small response.
 *
 * Failed batches appear in neither: nothing was written and the review cannot recover them.
 */
export const GET = withRoute("/api/imports", async () => {
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "Import Centre requires PostgreSQL." }, { status: 503 });
  const sql = sqlPool(connectionString);
  const userId = await ensureUser(sql);
  const counts = sql`
      COALESCE((SELECT count(*)::int FROM import_records r WHERE r.batch_id = b.id AND NOT r.removed), 0) AS record_count,
      COALESCE((SELECT count(*)::int FROM import_records r
        WHERE r.batch_id = b.id AND NOT r.removed
          AND (jsonb_array_length(r.validation_errors) > 0 OR r.operation IN ('conflict', 'rejected'))), 0) AS blocking_count`;
  const [open, committed] = await Promise.all([
    sql<BatchRow[]>`
      SELECT b.id, b.source_type, b.input_kind, b.status, b.version, b.created_at, b.updated_at, b.committed_at,
        b.source_filename, ${counts}
      FROM import_batches b
      WHERE b.user_id = ${userId} AND b.status IN ('draft', 'ready', 'blocked')
      ORDER BY b.created_at DESC
      LIMIT 200`,
    sql<BatchRow[]>`
      SELECT b.id, b.source_type, b.input_kind, b.status, b.version, b.created_at, b.updated_at, b.committed_at,
        b.source_filename, ${counts}
      FROM import_batches b
      WHERE b.user_id = ${userId} AND b.status = 'committed'
      ORDER BY b.committed_at DESC NULLS LAST
      LIMIT 25`
  ]);
  return Response.json({ batches: open.map(toSummary), history: committed.map(toSummary) });
});
