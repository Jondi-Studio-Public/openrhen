import { runDerivedTick } from "@/server/derived/derived-runner";
import { redact, withRoute } from "@/server/logging";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * Runs the derived-rows extractors (communication understanding design, sections 3-4): the worker's tick posts here
 * with `{trigger:"scheduled"}` and only posts; the extractors, their cursors and the writes all live in `portal/server`.
 * Safe to call early, twice or at once: a per-person Postgres advisory lock lets one run through and answers `busy` to
 * the others, `manual` honours it exactly as `scheduled` does, and a rerun reads only what the cursors say is unread.
 * There is no off setting. A database error rolls the run back (the cursor never moves past rows that were not
 * written) and answers 502 so the worker tries again.
 */
export const POST = withRoute("/api/integrations/derived/tick", async (request, _context, log) => {
  const body = (await request.json().catch(() => null)) as { trigger?: unknown } | null;
  const trigger = body?.trigger === "manual" || body?.trigger === "scheduled" ? body.trigger : "manual";

  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ status: "skipped", reason: "no_database", trigger });

  try {
    const result = await runDerivedTick(sqlPool(connectionString));
    if (result.status === "busy") return Response.json({ status: "busy", trigger });
    return Response.json({ status: "ok", trigger, more: result.more, extractors: result.extractors });
  } catch (error) {
    log.setError(error);
    return Response.json(
      { error: error instanceof Error ? redact(error.message) : "The derived-rows tick failed.", trigger },
      { status: 502 }
    );
  }
});
