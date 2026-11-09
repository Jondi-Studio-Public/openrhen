import {
  CONSEQUENCE_NEXT_CALL,
  DEFAULT_TIMEZONE,
  buildConsequenceGroupView,
  consequenceAnswerCall,
  consequenceWordingForDay,
  formatAgentCall,
  isConsequenceWording,
  localDateOf,
  type AgentCall,
  type ConsequenceGroupView,
  type RankConsequenceGroupCommand,
  type RankConsequenceGroupResult
} from "@openrhen/contracts";
import {
  ConsequenceComparisonError,
  issueNextConsequenceGroupForUser,
  loadPoolRows,
  recordComparison,
  type ConsequencePool
} from "@openrhen/database";
import { changeLogActor, requestAgent, requestClaim } from "@/server/agent-actor";
import { claimCommandReceipt, commandRequestHash, refuseCommandIdReuse } from "./command-receipt";
import { CommandConflictError, InvalidCommandError } from "./command-errors";
import { ensureUser } from "./ensure-user";
import { recordStateChange } from "./planning-evidence";
import type { PoolSql, Sql } from "./sql-pool";

/**
 * Comparison-based consequence ranking, the server side the portal card, `rhen rank` and an agent all use
 * (comparison-consequence-ranking design, 3.7).
 *
 * `readNextConsequenceGroup` hands out the next group of items to rank (or the one still waiting), asked in the wording
 * the person's local calendar day gives (the two wordings alternate by day). Handing a group out records it as issued,
 * which is bookkeeping and never changes the plan, so the read is safe to repeat. A caller that is an agent never gets
 * a group with a private item in it.
 *
 * `runRankConsequenceGroup` records one answer. Who answered is derived from the request, never sent: no agent header
 * is the person (basis forced to `stated`), an agent token is an agent (its own basis and evidence, held to the rules
 * in the database package). The answer refits the pool in the same transaction, and `recordStateChange` then enqueues a
 * recalculation so Now reflects it. A refused answer changes nothing and says which group is waiting and the exact
 * next call.
 */

export interface NextGroupOptions {
  pool?: ConsequencePool;
  now?: Date;
}

/** The next group to rank as it is shown, or null when nothing can be asked (too few comparable items, or every pair is cooling). */
export async function readNextConsequenceGroup(
  sql: PoolSql,
  options: NextGroupOptions = {}
): Promise<ConsequenceGroupView | null> {
  const userId = await ensureUser(sql);
  const now = options.now ?? new Date();
  const user = (await sql<{ timezone: string | null }[]>`SELECT timezone FROM users WHERE id=${userId}`)[0];
  const wording = consequenceWordingForDay(localDateOf(now, user?.timezone ?? DEFAULT_TIMEZONE));
  const issued = await issueNextConsequenceGroupForUser(sql, userId, {
    now,
    wording,
    agentFacing: requestAgent() !== null,
    ...(options.pool ? { pool: options.pool } : {})
  });
  if (!issued) return null;
  const rows = new Map((await loadPoolRows(sql, userId, issued.pool)).map((row) => [row.id, row]));
  return buildConsequenceGroupView({
    groupId: issued.groupId,
    pool: issued.pool,
    wording: isConsequenceWording(issued.wording) ? issued.wording : wording,
    reissued: issued.reissued,
    items: issued.itemIds.map((id) => ({ id, title: rows.get(id)?.title ?? id, stars: rows.get(id)?.stars ?? 3 }))
  });
}

/** The answer's refusal as the portal raises it: the database's own text, then "Nothing was changed. Next: <the exact call>". */
function refusal(error: ConsequenceComparisonError): CommandConflictError | InvalidCommandError {
  const call: AgentCall =
    error.group && error.group.askNext !== true
      ? consequenceAnswerCall(error.group.groupId, error.group.itemIds)
      : CONSEQUENCE_NEXT_CALL;
  const body = error.message.replaceAll("idempotencyKey", "command-id");
  const message = `${body} Nothing was changed. Next: ${formatAgentCall(call)}`;
  return error.code === "bad_input" || error.code === "basis_not_allowed" || error.code === "ranking_mismatch"
    ? new InvalidCommandError(message, { nextCall: call })
    : new CommandConflictError(message, { nextCall: call });
}

export async function runRankConsequenceGroup(
  sql: PoolSql,
  command: RankConsequenceGroupCommand,
  clock?: Date
): Promise<{ result: RankConsequenceGroupResult }> {
  const userId = await ensureUser(sql);
  const requestHash = commandRequestHash("rank_consequence_group", command);
  const replay = async (queryable: Sql): Promise<RankConsequenceGroupResult | null> => {
    const prior = await queryable<
      { response: RankConsequenceGroupResult | null; command_type: string; request_hash: string | null }[]
    >`SELECT response, command_type, request_hash FROM writes WHERE id=${command.commandId} AND user_id=${userId}`;
    if (prior[0]) refuseCommandIdReuse(prior[0], { commandType: "rank_consequence_group", requestHash });
    return prior[0]?.response ?? null;
  };
  const earlier = await replay(sql);
  if (earlier) return { result: { ...earlier, replayed: true } };

  const agent = requestAgent();
  const by = agent === null ? ("person" as const) : ("agent" as const);
  const claim = requestClaim();
  // A person's answer is the person's word by definition; an agent says where its answer comes from (default: a guess).
  const basis = by === "person" ? ("stated" as const) : (command.basis ?? claim?.basis ?? "inferred");
  const evidence = command.evidence ?? (by === "agent" ? claim?.evidence : undefined);

  return sql.begin(async (tx) => {
    if (
      !(await claimCommandReceipt(tx, {
        id: command.commandId,
        userId,
        commandType: "rank_consequence_group",
        requestHash
      }))
    ) {
      const stored = await replay(tx);
      if (stored) return { result: { ...stored, replayed: true } };
      throw new CommandConflictError(
        "That answer is already being applied by another request. Repeat the identical call with the same command-id.",
        { nextCall: CONSEQUENCE_NEXT_CALL }
      );
    }
    const at = clock ?? new Date();
    let recorded;
    try {
      recorded = await recordComparison(tx, userId, {
        groupId: command.groupId,
        ...(command.tie === true ? { tie: true } : { rankedIds: command.rankedIds ?? [] }),
        answeredBy: by,
        basis,
        ...(evidence !== undefined ? { evidence } : {}),
        ...(command.wording !== undefined ? { wording: command.wording } : {}),
        agentFacing: by === "agent",
        idempotencyKey: command.commandId,
        now: at
      });
    } catch (error) {
      if (error instanceof ConsequenceComparisonError) throw refusal(error);
      throw error;
    }
    // The refit already ran inside `recordComparison`; this enqueues the recalculation so Now picks the new values up.
    await recordStateChange(tx, userId, {
      entityType: "consequence_comparison",
      entityId: recorded.comparisonId,
      operation: "rank",
      commandId: command.commandId,
      evidence: {
        groupId: recorded.groupId,
        tie: command.tie === true,
        by,
        actor: changeLogActor(),
        basis,
        ...(evidence ? { statedEvidence: evidence } : {})
      },
      at
    });
    const result: RankConsequenceGroupResult = {
      comparisonId: recorded.comparisonId,
      groupId: recorded.groupId,
      replayed: false,
      by,
      basis,
      next: 'Recorded. Ask for the next group with rhen_inbox room "compare" (CLI: rhen rank); nothing is waiting until you do.'
    };
    await tx`UPDATE writes SET response=${tx.json(result as never)}, updated_at=now() WHERE id=${command.commandId}`;
    return { result };
  });
}
