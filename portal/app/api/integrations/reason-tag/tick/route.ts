import { runReasonTagTick } from "@/server/drift/reason-tag-runner";
import { withRoute } from "@/server/logging";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * Tags the owner's recent reasons, oldest first, with their local model: the worker's reason-tag loop posts here with
 * `{trigger:"scheduled"}` and only posts. A call tags at most three reasons and stops at the first failure; one that
 * keeps failing is skipped for a growing wait and never holds up the ones after it
 * (`portal/server/drift/reason-tag-runner.ts` has the phases). Safe to call early, twice or at once: a second call while
 * the activity store is busy answers `busy`, and a reason a call is already working on is not asked about again. There
 * is no off setting: with no local model set it answers `not_configured` and does nothing. The answer carries a
 * status, counts and fixed sentences, never a reason's words or a tag.
 */
export const POST = withRoute("/api/integrations/reason-tag/tick", async (request, _context, log) => {
  const body = (await request.json().catch(() => null)) as { trigger?: unknown } | null;
  const trigger = body?.trigger === "manual" || body?.trigger === "scheduled" ? body.trigger : "manual";
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ status: "skipped", reason: "no_database", trigger });
  try {
    const result = await runReasonTagTick(sqlPool(connectionString));
    return Response.json({ ...result, trigger });
  } catch (error) {
    // Only the error's kind is logged: a database message can quote the row it refused, and rows here hold the owner's words.
    log.setError(new Error(`The reason-tag job failed (${error instanceof Error ? error.name : "unknown"}).`));
    return Response.json(
      {
        error:
          'The reason-tag job failed before it could report. Send POST /api/integrations/reason-tag/tick {"trigger":"manual"} again. If it repeats, GET /api/health/database says whether the database is up.',
        trigger
      },
      { status: 502 }
    );
  }
});
