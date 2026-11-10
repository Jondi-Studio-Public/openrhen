import { OWNER_COOKIE, OWNER_HEADER, OWNER_SESSION_DAYS } from "@openrhen/contracts";
import { withRoute } from "@/server/logging";
import { ownerCookie, verifyOwnerCredential } from "@/server/owner-auth";
import { openWebSession } from "@/server/owner-credential-store";
import { agentRefusal, devicePool } from "@/server/devices/device-http";

/**
 * A signed-in device opens its web view: the device's header token is exchanged for a cookie session that is a
 * child of that credential. The child is revoked with the device, does not count toward the browser cap, inherits
 * `limited`, and is reused (its secret rotated in place) on every later launch, so there is one per device. The
 * caller is an app holding a header token, so no `Origin` is needed; a cookie alone is not accepted. The route checks
 * the token itself, because under owner auth `off` or `shadow` no gate has.
 */
export const POST = withRoute("/api/owner/web-session", async (request, _context, log) => {
  const refused = agentRefusal();
  if (refused) return refused;
  if (!request.headers.get(OWNER_HEADER)?.trim())
    return Response.json({ error: `Send the device's owner token in ${OWNER_HEADER}.` }, { status: 401 });
  const check = await verifyOwnerCredential(request);
  if (check.kind !== "ok")
    return Response.json(
      { error: check.kind === "invalid" ? check.error : "The owner credential is not recognised." },
      {
        status: check.kind === "invalid" ? check.status : 401,
        ...(check.kind === "invalid" && check.retryAfter
          ? { headers: { "retry-after": String(check.retryAfter) } }
          : {})
      }
    );
  if (check.credential !== "token")
    return Response.json({ error: "A web view opens from a device's owner token." }, { status: 401 });
  const pool = devicePool();
  if (pool instanceof Response) return pool;
  log.setCommandType("open_web_session");
  const session = await openWebSession(pool, check.id);
  if (!session) return Response.json({ error: "The owner credential was revoked." }, { status: 401 });
  return Response.json(
    {
      credential: session.summary,
      session: {
        cookie: OWNER_COOKIE,
        value: session.secret,
        expiresAt: session.summary.expiresAt,
        maxAgeSeconds: OWNER_SESSION_DAYS * 86_400
      }
    },
    { status: 201, headers: { "cache-control": "no-store", "set-cookie": ownerCookie(request, session.secret) } }
  );
});
