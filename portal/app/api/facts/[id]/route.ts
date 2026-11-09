import { randomUUID } from "node:crypto";
import { requestAgent, requestAgentAuthenticated, requestClaim } from "@/server/agent-actor";
import { withRoute } from "@/server/logging";
import { actOnFact } from "@/server/persistence/postgres/fact-act-store";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * A mark on one open mail fact (communication understanding, slice 2b-9): `confirm` (hold an ask or commitment open),
 * `done`, `ignore`, `redate` or `reopen` (take back the agent's own mark). The planning, the guards and the answer texts
 * are `planFactAct`; the transaction, the receipt and the ledger row are `actOnFact`.
 *
 * Attribution is the point of this route: the mark is recorded under the name of the authenticated agent (a database,
 * OAuth or environment token), taken from the request and never from the body, and a caller with no such identity (the
 * owner's session, a bare `X-OpenRhen-Agent` label) is refused rather than recorded as the owner, whose word outranks an
 * agent's. The body holds the action and its values only; any other field, `by` among them, is refused.
 */
const FACT_ID = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BODY_KEYS = new Set(["action", "set", "commandId", "dryRun"]);

const STATUS: Record<string, number> = {
  unknown_action: 400,
  bad_id: 400,
  bad_params: 400,
  needs_stated: 400,
  not_found: 404,
  no_agent: 403
};

const json = (body: unknown, status: number) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

export const POST = withRoute<{ params: Promise<{ id: string }> }>("/api/facts/[id]", async (request, context, log) => {
  const agent = requestAgent();
  if (agent === null || !requestAgentAuthenticated())
    return json(
      {
        code: "no_agent",
        error:
          "A mark on a mail item is recorded under the name of the agent token that makes it, and this call carries none (the owner's session and a bare agent label are not tokens). Nothing was changed. Call it with an agent token that holds write:inbox."
      },
      403
    );
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Send a JSON object like {"action":"done"}.' }, 400);
  }
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return json({ error: 'Send a JSON object like {"action":"done"}.' }, 400);
  const fields = body as Record<string, unknown>;
  const extra = Object.keys(fields).filter((key) => !BODY_KEYS.has(key));
  if (extra.length > 0)
    return json(
      {
        error: `The body has no field "${extra[0]!.slice(0, 40)}": send only action, set, commandId and dryRun. basis and evidence travel as the X-OpenRhen-Basis and X-OpenRhen-Evidence headers (evidence percent-encoded), and who made the mark is taken from the token, never from the body. Nothing was changed.`
      },
      400
    );
  if (typeof fields.action !== "string") return json({ error: 'action is required, such as "done".' }, 400);
  const set = fields.set ?? {};
  if (
    set === null ||
    typeof set !== "object" ||
    Array.isArray(set) ||
    Object.values(set).some((value) => typeof value !== "string" && typeof value !== "number")
  )
    return json({ error: 'set must be an object of text or number values, such as {"days":"14"}.' }, 400);
  if (fields.commandId !== undefined && (typeof fields.commandId !== "string" || !UUID.test(fields.commandId)))
    return json({ error: "commandId must be a uuid." }, 400);
  if (fields.dryRun !== undefined && typeof fields.dryRun !== "boolean")
    return json({ error: "dryRun must be true or false." }, 400);
  const connectionString = databaseUrl();
  if (!connectionString)
    return json({ error: "Marking mail items needs PostgreSQL, and the portal has no database right now." }, 503);
  log.setCommandType(`fact_${fields.action.slice(0, 20)}`);

  const claim = requestClaim();
  const outcome = await actOnFact(sqlPool(connectionString), agent, {
    action: fields.action,
    // Not validated here: the planner refuses a malformed id before it reads anything.
    factId: FACT_ID.test(id) ? id : id.slice(0, 80),
    set: set as Record<string, unknown>,
    basis: claim?.basis,
    evidence: claim?.evidence,
    commandId: ((fields.commandId as string | undefined) ?? randomUUID()).toLowerCase(),
    dryRun: fields.dryRun === true
  });
  if (outcome.ok)
    return json(
      { ok: true, act: outcome.act, dryRun: outcome.dryRun, replay: outcome.replay, message: outcome.message },
      200
    );
  return json({ code: outcome.code, error: outcome.message }, STATUS[outcome.code] ?? 409);
});
