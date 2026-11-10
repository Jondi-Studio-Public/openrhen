import { requestAgent } from "@/server/agent-actor";
import { withRoute } from "@/server/logging";
import { ownerOutcomeOf } from "@/server/owner-auth";
import { addressOf } from "@/server/devices/device-http";
import { OwnerCredentialError, revokeOwnerCredential } from "@/server/owner-credential-store";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Revokes an enrolled browser or an owner token, and the web-view sessions under it; it stops working on the very
 * next request. A limited credential (a paired phone) may revoke only itself, or the device it is the web view of.
 */
export const DELETE = withRoute<{ params: Promise<{ id: string }> }>(
  "/api/owner/credentials/[id]",
  async (request, context, log) => {
    if (requestAgent() !== null)
      return Response.json({ error: "Owner credentials are managed by the owner." }, { status: 403 });
    const { id } = await context.params;
    if (!UUID.test(id)) return Response.json({ error: "That credential does not exist." }, { status: 404 });
    const owner = ownerOutcomeOf(request)?.owner;
    if (owner?.limited && id !== owner.id && id !== owner.parentId)
      return Response.json(
        { error: "This device is signed in with a limited credential; it can only sign itself out." },
        { status: 403, headers: { "x-owner-reason": "limited-credential" } }
      );
    log.setCommandType("revoke_owner_credential");
    const connectionString = databaseUrl();
    if (!connectionString) return Response.json({ error: "Owner credentials require PostgreSQL." }, { status: 503 });
    try {
      return Response.json({
        credential: await revokeOwnerCredential(sqlPool(connectionString), id, new Date(), {
          actorId: owner?.id ?? null,
          address: addressOf(request)
        })
      });
    } catch (error) {
      if (error instanceof OwnerCredentialError)
        return Response.json({ error: error.message }, { status: error.status });
      throw error;
    }
  }
);
