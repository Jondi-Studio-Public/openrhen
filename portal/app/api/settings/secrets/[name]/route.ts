import { putSecretSchema, secretNameSchema, SECRET_NAMES } from "@openrhen/contracts";
import { BodyTooLargeError, readBodyCapped } from "@/server/imports/capped-body";
import { withRoute } from "@/server/logging";
import { deleteSecret, putSecret } from "@/server/persistence/postgres/app-secrets-store";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";
import { secretsPolicy } from "@/server/secrets/secrets-policy";

/** A key is a few dozen characters; anything near this is not one. */
const MAX_BODY_BYTES = 8 * 1024;
type Context = { params: Promise<{ name: string }> };

const unknownName = () =>
  Response.json(
    { error: `Unknown password or key name. The names this app can hold are: ${SECRET_NAMES.join(", ")}.` },
    { status: 404 }
  );

/**
 * Saves or replaces one password or key (`{ "value": "..." }`). Write-only: the answer says it was saved and when,
 * never the value. Refused with 409, and an explanation of exactly what to set, unless a master key is configured
 * and owner sign-in is `require`. The value is read from the body here and goes only to the sealing function: it is
 * never logged, and a failure is logged without the request's content.
 */
export const PUT = withRoute("/api/settings/secrets/[name]", async (request: Request, { params }: Context, log) => {
  const { name: rawName } = await params;
  const name = secretNameSchema.safeParse(rawName);
  if (!name.success) return unknownName();
  const policy = secretsPolicy();
  if (!policy.canWrite || policy.master.status !== "ok")
    return Response.json({ error: policy.refusal, ...policyFacts(policy) }, { status: 409 });
  let body: string;
  try {
    body = await readBodyCapped(request, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError)
      return Response.json({ error: "That value is too long to be a key." }, { status: 413 });
    throw error;
  }
  let input: unknown = null;
  try {
    input = JSON.parse(body);
  } catch {
    /* validation below returns a safe error */
  }
  const parsed = putSecretSchema.safeParse(input);
  if (!parsed.success)
    return Response.json(
      { error: 'Send {"value": "<the key>"}: one non-empty value, up to 2048 characters.' },
      { status: 400 }
    );
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "Passwords and keys require PostgreSQL." }, { status: 503 });
  try {
    const sql = sqlPool(connectionString);
    const userId = await ensureUser(sql);
    const saved = await putSecret(sql, userId, name.data, parsed.data.value, policy.master);
    log.setCommandType("save_secret");
    return Response.json(
      { name: name.data, isSet: true, updatedAt: saved.updatedAt.toISOString(), state: "set" },
      { headers: { "cache-control": "no-store" } }
    );
  } catch {
    // Not the error itself: a driver message can echo what was being written.
    log.setError(new Error("Saving a password or key failed."));
    return Response.json({ error: "The key could not be saved. Check the portal log and try again." }, { status: 500 });
  }
});

/**
 * Removes one saved password or key. Needs owner sign-in but not the master key: deleting a sealed row opens nothing,
 * and a lost or broken key must not trap the person with rows they can no longer replace or clear.
 */
export const DELETE = withRoute("/api/settings/secrets/[name]", async (_request: Request, { params }: Context, log) => {
  const { name: rawName } = await params;
  const name = secretNameSchema.safeParse(rawName);
  if (!name.success) return unknownName();
  const policy = secretsPolicy();
  if (!policy.ownerAuthRequired)
    return Response.json(
      {
        error: "Set OPENRHEN_OWNER_AUTH=require in the portal's environment (and restart it) to remove saved keys.",
        ...policyFacts(policy)
      },
      { status: 409 }
    );
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "Passwords and keys require PostgreSQL." }, { status: 503 });
  try {
    const sql = sqlPool(connectionString);
    const userId = await ensureUser(sql);
    const removed = await deleteSecret(sql, userId, name.data);
    log.setCommandType("delete_secret");
    return Response.json({ name: name.data, isSet: false, updatedAt: null, state: "unset", removed });
  } catch {
    log.setError(new Error("Removing a password or key failed."));
    return Response.json(
      { error: "The key could not be removed. Check the portal log and try again." },
      { status: 500 }
    );
  }
});

function policyFacts(policy: ReturnType<typeof secretsPolicy>) {
  return { masterKeyConfigured: policy.masterKeyConfigured, ownerAuthRequired: policy.ownerAuthRequired };
}
