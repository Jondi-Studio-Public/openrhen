import { requestAgent } from "@/server/agent-actor";
import { withRoute } from "@/server/logging";
import { ownerCookie, verifyOwnerCredential } from "@/server/owner-auth";
import { revokeOwnerCredential } from "@/server/owner-credential-store";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/** Signs this browser out: revokes its session (when it has one) and clears the cookie. */
export const POST = withRoute("/api/owner/signout", async (request, _context, log) => {
  if (requestAgent() !== null)
    return Response.json({ error: "Browsers are signed out by the owner." }, { status: 403 });
  log.setCommandType("sign_out_owner_browser");
  const check = await verifyOwnerCredential(request);
  const connectionString = databaseUrl();
  if (check.kind === "ok" && check.via === "cookie" && connectionString)
    await revokeOwnerCredential(sqlPool(connectionString), check.id);
  return Response.json(
    { signedOut: true },
    { headers: { "cache-control": "no-store", "set-cookie": ownerCookie(request, null) } }
  );
});
