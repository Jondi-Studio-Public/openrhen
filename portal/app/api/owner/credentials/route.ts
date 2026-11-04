import { createOwnerTokenSchema } from "@openrhen/contracts";
import { requestAgent } from "@/server/agent-actor";
import { withRoute } from "@/server/logging";
import { verifyOwnerCredential } from "@/server/owner-auth";
import { createOwnerCredential, listOwnerCredentials, OwnerCredentialError } from "@/server/owner-credential-store";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

// Owner only: the wrapper refuses an agent token under `require`; this also refuses a self-declared name under `off`.
const ownerOnly = () =>
  requestAgent() === null
    ? null
    : Response.json({ error: "Owner credentials are managed by the owner." }, { status: 403 });

/** Every enrolled browser and owner token, with `current` on the one this request used. Never a secret or a hash. */
export const GET = withRoute("/api/owner/credentials", async (request) => {
  const refused = ownerOnly();
  if (refused) return refused;
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "Owner credentials require PostgreSQL." }, { status: 503 });
  const check = await verifyOwnerCredential(request);
  const credentials = (await listOwnerCredentials(sqlPool(connectionString))).map((credential) => ({
    ...credential,
    current: check.kind === "ok" && check.id === credential.id
  }));
  return Response.json({ credentials }, { headers: { "cache-control": "no-store" } });
});

/** Makes an owner token. The raw token is in this response and nowhere else. */
export const POST = withRoute("/api/owner/credentials", async (request, _context, log) => {
  const refused = ownerOnly();
  if (refused) return refused;
  const parsed = createOwnerTokenSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success)
    return Response.json({ error: "Token validation failed.", issues: parsed.error.issues }, { status: 400 });
  log.setCommandType("create_owner_token");
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "Owner credentials require PostgreSQL." }, { status: 503 });
  try {
    const { secret, summary } = await createOwnerCredential(sqlPool(connectionString), "token", parsed.data.label);
    return Response.json(
      { token: secret, credential: summary },
      { status: 201, headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof OwnerCredentialError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
});
