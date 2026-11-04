import { redact, withRoute } from "@/server/logging";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";
import { runPushDrain } from "@/server/push/push-drain";

/**
 * `POST /api/push/test`: enqueues a `test:<uuid>`
 * row and drains at once, so the Notifications page's "Send a test" button gets an immediate answer
 * rather than waiting on the worker's own tick.
 */
export const POST = withRoute("/api/push/test", async (_request, _context, log) => {
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "Push requires PostgreSQL." }, { status: 503 });
  const sql = sqlPool(connectionString);
  try {
    const userId = await ensureUser(sql);
    const dedupeKey = `test:${crypto.randomUUID()}`;
    const payload = { title: "OpenRhen", body: "Push notifications are on.", tag: dedupeKey, url: "/now" };
    await sql`
      INSERT INTO push_outbox (user_id, dedupe_key, kind, payload, status, expires_at)
      VALUES (${userId}, ${dedupeKey}, 'test', ${sql.json(payload as never)}, 'pending', now() + interval '5 minutes')
    `;
    const result = await runPushDrain(sql, userId);
    if (result.sent === 0)
      return Response.json(
        { ok: false, error: "No subscription received the test push. Turn on notifications for this device first." },
        { status: 502 }
      );
    return Response.json({ ok: true });
  } catch (error) {
    log.setError(error);
    return Response.json(
      { error: error instanceof Error ? redact(error.message) : "The test push failed." },
      { status: 500 }
    );
  }
});
