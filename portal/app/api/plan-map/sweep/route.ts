import { runPlanReviewer } from "@openrhen/database";
import { redact, withRoute } from "@/server/logging";
import { runPlanHealth } from "@/server/persistence/postgres/plan-health-store";
import { sweepPlanMap } from "@/server/persistence/postgres/plan-map-store";
import { runPlanMapProposers } from "@/server/persistence/postgres/plan-map-proposers";
import { recordRun } from "@/server/persistence/postgres/run-log";
import { queueCatchUpNudge } from "@/server/persistence/postgres/catch-up";
import { planMapContext } from "@/server/plan-map/route-support";

/**
 * The daily plan-map sweep: the worker's daily trigger posts here with
 * `{trigger:"scheduled"}`, reachable like `connections/<id>/sync`. Idempotent and advisory: it deletes orphaned links,
 * expires stale suggestions and prunes the shadow log, then runs the rule proposers (a no-op while their
 * switch is off) so freshly expired pairs can come back with new evidence, the weekly reviewer (also a no-op while its switch is off), and the plan health checks (a no-op while the
 * `health_checks` switch is off) and writes their findings. It touches no plan row.
 */
export const POST = withRoute("/api/plan-map/sweep", async (request, _context, log) => {
  const body = (await request.json().catch(() => null)) as { trigger?: unknown } | null;
  const trigger = body?.trigger === "scheduled" ? "scheduled" : "manual";
  const context = await planMapContext();
  if (context instanceof Response) return context;
  const startedAt = new Date();
  try {
    const counts = await sweepPlanMap(context.sql, context.userId);
    // The proposers are advisory: a failure there must not fail the sweep that already finished.
    const proposers = await runPlanMapProposers(context.sql, context.userId).then(
      ({ mode, suggested, revived }) => ({ mode, suggested, revived }),
      (error: unknown) => {
        log.setError(error);
        return { error: error instanceof Error ? redact(error.message) : "The plan map proposers failed." };
      }
    );
    // So is the weekly reviewer, which does nothing unless its switch is on or shadow and a week has passed.
    const reviewer = await runPlanReviewer(context.sql, context.userId).then(
      ({ mode, ran, queued }) => ({ mode, ran, queued }),
      (error: unknown) => {
        log.setError(error);
        return { error: error instanceof Error ? redact(error.message) : "The weekly reviewer failed." };
      }
    );
    // So is the catch-up nudge: one push per away window once a catch-up is due.
    const catchUp = await queueCatchUpNudge(context.sql, context.userId).catch((error: unknown) => {
      log.setError(error);
      return { error: error instanceof Error ? redact(error.message) : "The catch-up nudge failed." };
    });
    // Health checks are advisory: a failure in them must not make the finished sweep look failed.
    const health = await runPlanHealth(context.sql, context.userId).catch((error: unknown) => {
      log.setError(error);
      return { mode: "error", error: error instanceof Error ? redact(error.message) : "The health checks failed." };
    });
    // A daily sweep that found nothing to do leaves no row; one that deleted, expired or proposed something does.
    const proposed = "error" in proposers ? 0 : proposers.suggested + proposers.revived;
    if (counts.orphanedLinksDeleted + counts.suggestionsExpired + counts.shadowRowsDeleted + proposed > 0)
      await recordRun({
        provider: "job:plan-map-sweep",
        trigger,
        status: "synced",
        startedAt,
        finishedAt: new Date(),
        summary: { ...counts, suggested: "error" in proposers ? 0 : proposers.suggested }
      });
    return Response.json({ status: "ok", trigger, ...counts, proposers, reviewer, catchUp, health });
  } catch (error) {
    log.setError(error);
    const message = error instanceof Error ? redact(error.message) : "The plan map sweep failed.";
    await recordRun({
      provider: "job:plan-map-sweep",
      trigger,
      status: "failed",
      startedAt,
      finishedAt: new Date(),
      summary: { error: message.slice(0, 500) }
    });
    return Response.json({ error: message, trigger }, { status: 502 });
  }
});
