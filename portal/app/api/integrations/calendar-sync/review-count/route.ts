import { intervalCalendarSourceIds } from "@openrhen/contracts";
import { withRoute } from "@/server/logging";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * How many calendar events are waiting for a decision in the Inbox, per provider, for the Calendars
 * badge: the records of the open (draft, ready or blocked) review batch each provider's sync holds back.
 * Every record in an open batch counts, including ones left unticked by default (all-day events), since
 * each is still undecided; committing or discarding the batch clears them.
 */
export const GET = withRoute("/api/integrations/calendar-sync/review-count", async () => {
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "Review counts require PostgreSQL." }, { status: 503 });
  const providers = intervalCalendarSourceIds();
  const sql = sqlPool(connectionString);
  const userId = await ensureUser(sql);
  const rows = await sql<{ source_type: string; batch_id: string; held: number }[]>`
    SELECT b.source_type, (array_agg(b.id ORDER BY b.created_at DESC))[1] AS batch_id, count(r.id)::int AS held
    FROM import_batches b JOIN import_records r ON r.batch_id = b.id
    WHERE b.user_id = ${userId} AND b.status IN ('draft', 'ready', 'blocked')
      AND b.source_type IN ${sql(providers)}
      AND r.entity_type IN ('fixed_commitment', 'fixed_commitment_recurrence')
    GROUP BY b.source_type
  `;
  const counts: Record<string, number> = Object.fromEntries(providers.map((provider) => [provider, 0]));
  const batchIds: Record<string, string | null> = Object.fromEntries(providers.map((provider) => [provider, null]));
  for (const row of rows) {
    counts[row.source_type] = row.held;
    batchIds[row.source_type] = row.batch_id;
  }
  return Response.json({ counts, batchIds, total: Object.values(counts).reduce((sum, held) => sum + held, 0) });
});
