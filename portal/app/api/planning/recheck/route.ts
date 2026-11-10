import { withRoute } from "@/server/logging";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { enqueueFreshPlanRecheck } from "@/server/persistence/postgres/planning-evidence";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * Queues one fresh recalculation for a plan whose refresh chain died: the worker's `plan-recheck-watchdog` loop posts
 * `{userId}` here once it has seen no active job and no run for over 70 minutes. The portal does this, not the
 * worker, because only the portal reads the whole state; the job it queues is built from state read now, through
 * the same enqueue every write uses. Safe to call twice: a second job supersedes the first waiting one. There is
 * no off setting.
 */
export const POST = withRoute("/api/planning/recheck", async (request, _context, log) => {
  const body = (await request.json().catch(() => null)) as { userId?: unknown } | null;
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ status: "skipped", reason: "no_database" });
  try {
    const sql = sqlPool(connectionString);
    const ownerId = await ensureUser(sql);
    if (body?.userId !== ownerId)
      return Response.json(
        { error: 'Send POST /api/planning/recheck {"userId":"<the owner id>"}; this user is not served here.' },
        { status: 400 }
      );
    await enqueueFreshPlanRecheck(sql, ownerId);
    return Response.json({ status: "queued" });
  } catch (error) {
    log.setError(error);
    return Response.json(
      { error: "The plan recheck could not be queued. The worker tries again on its next tick." },
      { status: 502 }
    );
  }
});
