import type { OwnerSessionInfo } from "@openrhen/contracts";
import { requestAgent } from "@/server/agent-actor";
import { withRoute } from "@/server/logging";
import { ownerAuthMode, verifyOwnerCredential } from "@/server/owner-auth";

/** Who this request is, for the Settings card: the mode, and whether it carries a valid owner credential. */
export const GET = withRoute("/api/owner/session", async (request) => {
  const mode = ownerAuthMode();
  const check = await verifyOwnerCredential(request);
  const signedIn = check.kind === "ok";
  const info: OwnerSessionInfo = {
    mode,
    signedIn,
    via: check.kind === "ok" ? check.via : null,
    canManage: mode === "require" ? signedIn : requestAgent() === null,
    ...(check.kind === "ok" && check.limited ? { limited: true } : {})
  };
  return Response.json(info, { headers: { "cache-control": "no-store" } });
});
