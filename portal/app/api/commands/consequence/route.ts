import {
  CONSEQUENCE_NEXT_CALL,
  consequenceResendStep,
  formatAgentCall,
  rankConsequenceGroupCommandSchema
} from "@openrhen/contracts";
import { notifyStateChanged } from "@openrhen/database";
import { withRoute } from "@/server/logging";
import { runRankConsequenceGroup } from "@/server/persistence/postgres/consequence-commands";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * Answers a group of items to rank (`rankConsequenceGroup`): `{ groupId, rankedIds }` best first, or `{ groupId, tie: true }`.
 * The owner's browser posts here, `rhen rank` and `rhen_save comparison` send it, and an agent token holding
 * `write:entity:comparison` may. Who answered comes from the request, never the body: a person's answer is `stated`,
 * an agent's carries its own `basis` and `evidence`. A refused answer is a 409 or 400 that names the group waiting and
 * the exact next call; an unreadable body is a 400. The answer refits the pool and recalculates the plan, so Now
 * reflects it.
 */
export const POST = withRoute("/api/commands/consequence", async (request, _context, log) => {
  const body: unknown = await request.json().catch(() => null);
  const parsed = rankConsequenceGroupCommandSchema.safeParse(
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? { commandId: crypto.randomUUID(), ...body }
      : body
  );
  if (!parsed.success)
    return Response.json(
      {
        error: `${parsed.error.issues[0]?.message ?? "Invalid answer."} ${consequenceResendStep()}`,
        issues: parsed.error.issues,
        nextCall: CONSEQUENCE_NEXT_CALL
      },
      { status: 400 }
    );
  const connectionString = databaseUrl();
  if (!connectionString)
    return Response.json(
      {
        error:
          "Ranking requires PostgreSQL, and the portal has no database connection right now, so this answer was not recorded. " +
          `Nothing was changed. Next: wait a minute and retry the same call with the same command id; to check the portal is back, read the waiting group with ${formatAgentCall(CONSEQUENCE_NEXT_CALL)} (GET /api/consequence/next).`,
        nextCall: CONSEQUENCE_NEXT_CALL
      },
      { status: 503 }
    );
  log.setCommandType("rank_consequence_group");
  const sql = sqlPool(connectionString);
  const { result } = await runRankConsequenceGroup(sql, parsed.data);
  try {
    notifyStateChanged(sql, { userId: await ensureUser(sql), kind: "state" });
  } catch (error) {
    console.error("rank_consequence_group: could not notify state_changed", error);
  }
  return Response.json({ result });
});
