import { runModelTick } from "@/server/derived/model-runner";
import { redact, withRoute } from "@/server/logging";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * Runs the model-backed extractors once (communication understanding, slice 2b-4): the worker's model loop posts here
 * with `{trigger:"scheduled"}` and only posts. It is separate from `/api/integrations/derived/tick` because a model call
 * takes seconds to minutes and that tick is one transaction the worker aborts at 120 s; this one is not a transaction
 * and the worker waits up to 20 minutes for it. A run takes a lease on the extractor's batch, calls the model with no
 * lock held, then writes only if it still holds the lease and the source messages are still there
 * (`portal/server/derived/model-runner.ts` has the three phases and what a failure costs).
 *
 * Safe to call early, twice or at once: a second call answers `busy` (the activity lock) or reports `leased` for the
 * extractor. With no extractor registered it answers `no_extractors` and does nothing. There is no off setting: it
 * runs when an extractor is registered and the mail-understanding settings exist. The answer's `summary` and each
 * extractor's `message` say in plain words what happened and the exact call that fixes anything that needs one. A
 * database error answers 502 so the worker tries again; the lease then expires on its own.
 */
export const POST = withRoute("/api/integrations/derived/model-tick", async (request, _context, log) => {
  const body = (await request.json().catch(() => null)) as { trigger?: unknown } | null;
  const trigger = body?.trigger === "manual" || body?.trigger === "scheduled" ? body.trigger : "manual";

  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ status: "skipped", reason: "no_database", trigger });

  try {
    const result = await runModelTick(sqlPool(connectionString));
    if (result.status === "busy") return Response.json({ status: "busy", trigger });
    return Response.json({
      status: result.status,
      trigger,
      more: result.more,
      summary: result.summary,
      extractors: result.extractors
    });
  } catch (error) {
    log.setError(error);
    return Response.json(
      {
        error:
          error instanceof Error
            ? redact(error.message)
            : 'The model tick failed before it could report. Send POST /api/integrations/derived/model-tick {"trigger":"manual"} again; a lease it held expires by itself after 15 minutes. If it repeats, GET /api/health/database says whether the database is up.',
        trigger
      },
      { status: 502 }
    );
  }
});
