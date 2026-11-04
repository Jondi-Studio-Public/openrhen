import { requestAgent } from "@/server/agent-actor";
import { withRoute } from "@/server/logging";
import { OwnerCredentialError, revokeOwnerCredential } from "@/server/owner-credential-store";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Revokes an enrolled browser or an owner token; it stops working on the very next request. */
export const DELETE = withRoute<{ params: Promise<{ id: string }> }>(
  "/api/owner/credentials/[id]",
  async (_request, context, log) => {
    if (requestAgent() !== null)
      return Response.json({ error: "Owner credentials are managed by the owner." }, { status: 403 });
    const { id } = await context.params;
    if (!UUID.test(id)) return Response.json({ error: "That credential does not exist." }, { status: 404 });
    log.setCommandType("revoke_owner_credential");
    const connectionString = databaseUrl();
    if (!connectionString) return Response.json({ error: "Owner credentials require PostgreSQL." }, { status: 503 });
    try {
      return Response.json({ credential: await revokeOwnerCredential(sqlPool(connectionString), id) });
    } catch (error) {
      if (error instanceof OwnerCredentialError)
        return Response.json({ error: error.message }, { status: error.status });
      throw error;
    }
  }
);
