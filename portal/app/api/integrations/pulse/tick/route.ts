import { ensurePulseRecorderSubscribed } from "@/server/events/state-events";
import { redact, withRoute } from "@/server/logging";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { runPulseRecorderTick } from "@/server/pulse/pulse-recorder";
import { runPulsePublisher } from "@/server/pulse/pulse-publisher";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * Runs the pulse recorder, then the publisher (the pulse criteria and publish design note,
 * "Recording", "Publish"): the worker's 60s tick posts here, and the debounced `state_changed`
 * subscriber calls both directly in-process — the recorder and the publisher each take their own per-user advisory lock,
 * so this route is safe to call early or concurrently with that subscriber. Neither step here is
 * destructive or accumulates state across calls beyond what the recorder/publisher themselves wrote,
 * and a publish failure never fails the tick: the next one retries it.
 */
export const POST = withRoute("/api/integrations/pulse/tick", async (request, _context, log) => {
  const body = (await request.json().catch(() => null)) as { trigger?: unknown } | null;
  const trigger = body?.trigger === "manual" || body?.trigger === "scheduled" ? body.trigger : "manual";

  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ status: "skipped", reason: "no_database", trigger });
  const sql = sqlPool(connectionString);
  ensurePulseRecorderSubscribed();

  try {
    const outcome = await runPulseRecorderTick(sql);
    let publish: string | undefined;
    try {
      const userId = await ensureUser(sql);
      const published = await runPulsePublisher(sql, userId);
      publish = published.status === "sent" ? published.outcome : published.reason;
    } catch (error) {
      // Never fails the tick itself — the recorder's own write already succeeded, and the next tick
      // retries the publish.
      log.setError(error);
      publish = "error";
    }
    return Response.json({ status: "ok", trigger, outcome: outcome.status, publish });
  } catch (error) {
    log.setError(error);
    return Response.json(
      { error: error instanceof Error ? redact(error.message) : "The pulse tick failed.", trigger },
      { status: 502 }
    );
  }
});
