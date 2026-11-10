import { withRoute } from "@/server/logging";
import { listCredentialEvents } from "@/server/owner-credential-store";
import { agentRefusal, devicePool } from "@/server/devices/device-http";

/** Who paired, redeemed and revoked what, newest first, for the Devices page. Never a secret or a hash. */
export const GET = withRoute("/api/owner/credential-events", async () => {
  const refused = agentRefusal();
  if (refused) return refused;
  const pool = devicePool();
  if (pool instanceof Response) return pool;
  return Response.json({ events: await listCredentialEvents(pool) }, { headers: { "cache-control": "no-store" } });
});
