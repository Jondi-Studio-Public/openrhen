import { runWorkLabelTick } from "@/server/drift/work-label-runner";
import { withRoute } from "@/server/logging";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * Labels one area that has no label for its current text, with the owner's local model: the worker's work-label loop
 * posts here with `{trigger:"scheduled"}` and only posts. One area per call, because a model call can take minutes and
 * holds the shared local-model queue (`portal/server/drift/work-label-runner.ts` has the phases and what a failure
 * costs). Safe to call early, twice or at once: a second call while the activity store is busy answers `busy`, and an
 * area a call is already working on is not asked about again. There is no off setting: with no local model set it
 * answers `not_configured` and does nothing. The answer carries a status, a count flag and at most one area id,
 * never an area's text.
 */
export const POST = withRoute("/api/integrations/work-label/tick", async (request, _context, log) => {
  const body = (await request.json().catch(() => null)) as { trigger?: unknown } | null;
  const trigger = body?.trigger === "manual" || body?.trigger === "scheduled" ? body.trigger : "manual";
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ status: "skipped", reason: "no_database", trigger });
  try {
    const result = await runWorkLabelTick(sqlPool(connectionString));
    return Response.json({ ...result, trigger });
  } catch (error) {
    log.setError(error);
    return Response.json(
      {
        error:
          'The work-label job failed before it could report. Send POST /api/integrations/work-label/tick {"trigger":"manual"} again. If it repeats, GET /api/health/database says whether the database is up.',
        trigger
      },
      { status: 502 }
    );
  }
});
