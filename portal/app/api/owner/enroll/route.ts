import { enrollBrowserSchema } from "@openrhen/contracts";
import { requestAgent } from "@/server/agent-actor";
import { withRoute } from "@/server/logging";
import { ownerAuthMode, ownerCookie, sameOrigin, verifyEnrollSecret, verifyOwnerCredential } from "@/server/owner-auth";
import { createOwnerCredential, OwnerCredentialError } from "@/server/owner-credential-store";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * Enrols this browser: makes a session, stores its hash, and sets the cookie (the design notes
 * section 3). While owner auth is `off` or `shadow`, a caller with no agent identity may enrol, which is the
 * bootstrap. Under `require` the caller needs a valid owner credential already, or sends an owner token or the
 * recovery token (`OWNER_RECOVERY_TOKEN`) as `secret`. This route is exempt from the wrapper's check because it
 * does that check itself.
 */
export const POST = withRoute("/api/owner/enroll", async (request, _context, log) => {
  if (requestAgent() !== null) return Response.json({ error: "Browsers are enrolled by the owner." }, { status: 403 });
  if (!sameOrigin(request))
    return Response.json(
      { error: "Enrol from this site's own Settings page (Origin must match Host)." },
      { status: 403 }
    );
  const parsed = enrollBrowserSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success)
    return Response.json({ error: "Enrolment validation failed.", issues: parsed.error.issues }, { status: 400 });
  if (ownerAuthMode() === "require") {
    const held = await verifyOwnerCredential(request);
    if (held.kind === "invalid" && held.status !== 401)
      return Response.json(
        { error: held.error },
        { status: held.status, ...(held.retryAfter ? { headers: { "retry-after": String(held.retryAfter) } } : {}) }
      );
    if (held.kind === "ok" && held.limited)
      return Response.json({ error: "A limited device credential cannot enrol a browser." }, { status: 403 });
    if (held.kind !== "ok") {
      if (!parsed.data.secret)
        return Response.json(
          { error: "Enrolling needs an owner credential: send an owner token or the recovery token as `secret`." },
          { status: 401 }
        );
      const verdict = await verifyEnrollSecret(request, parsed.data.secret);
      if (verdict === "throttled")
        return Response.json(
          { error: "Too many unrecognised credentials; wait before trying again." },
          { status: 429 }
        );
      if (verdict === "limited")
        return Response.json({ error: "A limited device credential cannot enrol a browser." }, { status: 403 });
      if (verdict === "bad") return Response.json({ error: "That token is not recognised." }, { status: 401 });
    }
  }
  log.setCommandType("enroll_owner_browser");
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "Owner credentials require PostgreSQL." }, { status: 503 });
  try {
    const { secret, summary } = await createOwnerCredential(sqlPool(connectionString), "browser", parsed.data.label);
    return Response.json(
      { credential: summary },
      { status: 201, headers: { "cache-control": "no-store", "set-cookie": ownerCookie(request, secret) } }
    );
  } catch (error) {
    if (error instanceof OwnerCredentialError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
});
