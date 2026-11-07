import { withRoute } from "@/server/logging";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { secretStatuses } from "@/server/persistence/postgres/app-secrets-store";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";
import { secretsPolicy } from "@/server/secrets/secrets-policy";

/**
 * Passwords and keys, as status only: for each allowed name whether it is set, when, and whether this build can
 * still open it, plus whether saving is possible right now. A value is never returned by any route. The owner's own read.
 */
export const GET = withRoute("/api/settings/secrets", async (_request, _context, log) => {
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "Passwords and keys require PostgreSQL." }, { status: 503 });
  const sql = sqlPool(connectionString);
  const policy = secretsPolicy();
  try {
    const userId = await ensureUser(sql);
    return Response.json(
      {
        masterKeyConfigured: policy.masterKeyConfigured,
        ownerAuthRequired: policy.ownerAuthRequired,
        canWrite: policy.canWrite,
        secrets: await secretStatuses(sql, userId, policy.master)
      },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    log.setError(error);
    throw error;
  }
});
