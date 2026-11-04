import { scopeCovers, settleCatchUpCommandSchema } from "@openrhen/contracts";
import { requestAgent, requestDirectWrites, requestScopes } from "@/server/agent-actor";
import { catchUpSettleSummary } from "@/server/agent-proposals/appliers";
import { proposalErrorResponse } from "@/server/agent-proposals/errors";
import { proposeAgentChange } from "@/server/agent-proposals/store";
import { withRoute } from "@/server/logging";
import { getStateStore } from "@/server/persistence/state-store";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * Settles catch-up entries. The person's settle applies, and so does a database
 * token's that holds `write:catch-up` while its `directWrites` is `on` for at least one class (the
 * Settings "Writes apply directly" switch sets them all, and turning it off stops this too), whatever its basis:
 * the change log names the agent and records the basis and evidence, and an applied settle is snapshotted
 * (`revertible` in the answer) so `rhen undo` and the owner's "Agent changes" list can put it back. Any
 * other agent (only `propose:catch-up`, direct writes off or shadow, a header-only name, an environment
 * token) is held as a proposal for the person to confirm in the Inbox. A drop,
 * a bulk form and a long list apply too: settling is the catch-up after a break, a dropped entry is a status
 * and not a deleted row, and holding them would bring back the confirm-on-the-website loop (owner decision, 2026-10-27).
 */
export const POST = withRoute("/api/commands/catch-up-settle", async (request, _context, log) => {
  const parsed = settleCatchUpCommandSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json({ error: "Settle validation failed.", issues: parsed.error.issues }, { status: 400 });
  log.setCommandType("settle_catch_up");
  const agent = requestAgent();
  const mayApply =
    (requestScopes() ?? []).some((scope) => scopeCovers(scope, "write:catch-up")) &&
    Object.values(requestDirectWrites() ?? {}).includes("on");
  if (agent === null || mayApply) {
    const settled = await getStateStore().settleCatchUp(parsed.data);
    // Only an agent settle that changed something is snapshotted (catch-up.ts saves one when an entry applied or
    // the window closed); a proposal below changed nothing yet.
    // One that ended an activity session is not kept (`revertible: false` in the result), so it names none.
    const changed = settled.result.closed || settled.result.results.some((item) => item.outcome === "applied");
    return Response.json(
      agent === null || !changed || settled.result.revertible === false
        ? settled
        : { ...settled, revertible: parsed.data.commandId }
    );
  }
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "Catch-up requires PostgreSQL." }, { status: 503 });
  const { commandId, basis, evidence, ...payload } = parsed.data;
  try {
    const { proposal, outcome } = await proposeAgentChange(sqlPool(connectionString), agent, {
      kind: "settle_catch_up",
      summary: catchUpSettleSummary(parsed.data.verdicts.length, parsed.data.closeWindow),
      payload: { ...payload, basis, ...(evidence ? { evidence } : {}) },
      basis,
      evidence,
      commandId
    });
    return Response.json({ proposal, outcome }, { status: outcome === "created" ? 202 : 200 });
  } catch (error) {
    return proposalErrorResponse(error);
  }
});
