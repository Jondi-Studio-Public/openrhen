import {
  AGENT_PROPOSAL_EXPIRY_DAYS,
  AGENT_PROPOSAL_PENDING_CAP,
  type AgentProposal,
  type AgentProposalStatus,
  type ProposeAgentChange,
  type ResolveAgentProposal
} from "@openrhen/contracts";
import { notifyStateChanged } from "@openrhen/database";
import { runWithActor } from "@/server/agent-actor";
import { CommandConflictError, InvalidCommandError } from "@/server/persistence/postgres/command-errors";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import type { PoolSql, TxSql } from "@/server/persistence/postgres/sql-pool";
import { notFoundRefusal, refusalText } from "@openrhen/contracts";
import { proposalApplier, proposalKinds, versionConflicts, type StoredProposal, type TargetVersions } from "./appliers";
import { AgentProposalError } from "./errors";
import { overCapMessage, overPendingCap } from "./cap";
import { payloadHash } from "./payload-hash";

export const PROPOSAL_LIST_DEFAULT_LIMIT = 20;
export const PROPOSAL_LIST_MAX_LIMIT = 200;

interface ProposalRow {
  id: string;
  agent: string;
  kind: string;
  summary: string;
  payload: Record<string, unknown>;
  payload_hash: string;
  basis: AgentProposal["basis"];
  evidence: string | null;
  target_versions: TargetVersions;
  status: AgentProposalStatus;
  coalesce_key: string | null;
  revision: number;
  created_at: Date;
  updated_at: Date;
  resolved_at: Date | null;
  resolved_by: string | null;
  resolution_note: string | null;
  shadow: boolean;
}

const COLUMNS = `id, agent, kind, summary, payload, payload_hash, basis, evidence, target_versions, status, coalesce_key, revision, created_at, updated_at, resolved_at, resolved_by, resolution_note, shadow`;

/** A row as the routes return it: only the fields of `agentProposalSchema`, dates as ISO strings. */
export function toProposal(row: ProposalRow): AgentProposal {
  return {
    id: row.id,
    agent: row.agent,
    kind: row.kind,
    summary: row.summary,
    payload: row.payload,
    basis: row.basis,
    evidence: row.evidence,
    targetVersions: row.target_versions,
    status: row.status,
    coalesceKey: row.coalesce_key,
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null,
    resolvedBy: row.resolved_by,
    resolutionNote: row.resolution_note,
    ...(row.shadow ? { shadow: true } : {})
  };
}

/** Marks pending proposals older than the expiry window `expired`; run on every read, so no job is needed. */
export async function expireOld(sql: PoolSql | TxSql, userId: string): Promise<void> {
  await sql`UPDATE agent_proposals SET status='expired', resolved_at=now(), resolved_by='system', resolution_note=${`Expired after ${AGENT_PROPOSAL_EXPIRY_DAYS} days without a decision.`} WHERE user_id=${userId} AND status='pending' AND created_at < now() - make_interval(days => ${AGENT_PROPOSAL_EXPIRY_DAYS})`;
}

const select = (sql: PoolSql | TxSql, where: string, ...values: unknown[]) =>
  sql.unsafe<ProposalRow[]>(`SELECT ${COLUMNS} FROM agent_proposals WHERE ${where}`, values as never[]);

/**
 * Records a proposal from `agent`. A retry with the same `commandId`, or a pending proposal with the
 * same payload, returns the stored row. A pending proposal with the same `coalesceKey` is replaced in
 * place (latest wins, `created_at` kept, `revision` counted). Past the pending cap the write is refused.
 */
export async function proposeAgentChange(
  sql: PoolSql,
  agent: string | null,
  input: ProposeAgentChange & {
    /** Set by the route wrapper for a write `directWrites: shadow` held back; an agent cannot set it. */
    shadow?: boolean | undefined;
  }
): Promise<{ proposal: AgentProposal; outcome: "created" | "coalesced" | "existing" }> {
  if (agent === null)
    throw new AgentProposalError(
      400,
      "This request carries no agent name, so a proposal cannot be filed under one. Tell the person this token needs a name (they create it with an agent name), or send the X-OpenRhen-Agent header."
    );
  const applier = proposalApplier(input.kind);
  if (!applier)
    throw new AgentProposalError(
      400,
      `This portal has no applier for proposals of kind "${input.kind}". Use one of: ${proposalKinds().join(", ")}.`,
      { validValues: { kind: proposalKinds() } }
    );
  let targetVersions: TargetVersions = input.targetVersions ?? {};
  if (applier.hooks.validate) {
    const checked = applier.hooks.validate(input.payload);
    if (!checked.ok) throw new AgentProposalError(400, checked.error);
    // What the validator derived from the payload wins over the agent's own claim.
    targetVersions = { ...input.targetVersions, ...checked.targetVersions };
  }
  const userId = await ensureUser(sql);
  // A caller in the portal that built its own line from the command (a downgraded save, a catch-up settle) keeps
  // it; otherwise the applier writes it from the payload.
  const summary =
    input.summary ?? (await applier.hooks.summarize?.({ sql, userId }, input.payload)) ?? `Proposed ${input.kind}`;
  const hash = payloadHash(input.payload);
  return sql.begin(async (tx) => {
    // One proposer at a time per agent, so the cap and the coalescing key hold under concurrent calls.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`agent_proposals:${userId}:${agent}`}))`;
    await expireOld(tx, userId);
    if (input.commandId) {
      const retried = await select(tx, "id=$1 AND user_id=$2 AND agent=$3", input.commandId, userId, agent);
      if (retried[0]) return { proposal: toProposal(retried[0]), outcome: "existing" as const };
    }
    const same = await select(
      tx,
      "user_id=$1 AND agent=$2 AND status='pending' AND payload_hash=$3",
      userId,
      agent,
      hash
    );
    if (same[0]) return { proposal: toProposal(same[0]), outcome: "existing" as const };
    if (input.coalesceKey) {
      const merged = await select(
        tx,
        "user_id=$1 AND agent=$2 AND status='pending' AND coalesce_key=$3 FOR UPDATE",
        userId,
        agent,
        input.coalesceKey
      );
      if (merged[0]) {
        const updated = await tx<ProposalRow[]>`
          UPDATE agent_proposals SET kind=${input.kind}, summary=${summary}, payload=${tx.json(input.payload as never)}, payload_hash=${hash}, basis=${input.basis}, evidence=${input.evidence ?? null}, target_versions=${tx.json(targetVersions as never)}, shadow=${input.shadow === true}, revision=revision+1, updated_at=now()
          WHERE id=${merged[0].id} RETURNING *`;
        return { proposal: toProposal(updated[0]!), outcome: "coalesced" as const };
      }
    }
    const pending = await tx<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM agent_proposals WHERE user_id=${userId} AND agent=${agent} AND status='pending'`;
    if (overPendingCap(pending[0]?.count ?? 0))
      throw new AgentProposalError(429, overCapMessage(agent), { cap: AGENT_PROPOSAL_PENDING_CAP });
    try {
      const inserted = await tx<ProposalRow[]>`
        INSERT INTO agent_proposals (id, user_id, agent, kind, summary, payload, payload_hash, basis, evidence, target_versions, coalesce_key, shadow)
        VALUES (${input.commandId ?? crypto.randomUUID()}, ${userId}, ${agent}, ${input.kind}, ${summary}, ${tx.json(input.payload as never)}, ${hash}, ${input.basis}, ${input.evidence ?? null}, ${tx.json(targetVersions as never)}, ${input.coalesceKey ?? null}, ${input.shadow === true})
        RETURNING *`;
      return { proposal: toProposal(inserted[0]!), outcome: "created" as const };
    } catch (error) {
      // The agent's commandId is the row id, so reusing another proposal's id is a conflict, not a fault.
      if ((error as { code?: string }).code === "23505")
        throw new AgentProposalError(409, "That commandId already belongs to another proposal.");
      throw error;
    }
  });
}

export interface ListAgentProposalsQuery {
  status?: AgentProposalStatus | undefined;
  agent?: string | undefined;
  limit?: number | undefined;
}

/** Newest first. Expires old pending rows before reading, so an expired proposal is never listed as pending. */
export async function listAgentProposals(
  sql: PoolSql,
  userId: string,
  query: ListAgentProposalsQuery = {}
): Promise<AgentProposal[]> {
  await expireOld(sql, userId);
  const limit = Math.min(Math.max(query.limit ?? PROPOSAL_LIST_DEFAULT_LIMIT, 1), PROPOSAL_LIST_MAX_LIMIT);
  const rows = await sql<ProposalRow[]>`
    SELECT ${sql.unsafe(COLUMNS)} FROM agent_proposals
    WHERE user_id=${userId}
      AND (${query.status ?? null}::text IS NULL OR status=${query.status ?? null})
      AND (${query.agent ?? null}::text IS NULL OR agent=${query.agent ?? null})
    ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
  return rows.map(toProposal);
}

async function settle(
  sql: PoolSql,
  id: string,
  status: Exclude<AgentProposalStatus, "pending">,
  note: string | null,
  revision?: number
): Promise<AgentProposal | null> {
  // With a revision, only that revision settles: one the agent swapped in while the confirm applied stays pending.
  const rows = await sql<ProposalRow[]>`
    UPDATE agent_proposals SET status=${status}, resolved_at=now(), resolved_by='owner', resolution_note=${note}, updated_at=now()
    WHERE id=${id} AND status='pending' AND (${revision ?? null}::int IS NULL OR revision=${revision ?? null}) RETURNING *`;
  return rows[0] ? toProposal(rows[0]) : null;
}

/**
 * The owner's decision. `requester` is the agent behind the request, if any: an agent never resolves a
 * proposal, whatever its token allows. A confirm replays the stored payload through its applier as the
 * proposing agent (the `write_rows` row names the agent and records `confirmedBy: owner`); if the target
 * changed since the proposal, it is marked `stale` and nothing is applied.
 */
export async function resolveAgentProposal(
  sql: PoolSql,
  requester: string | null,
  id: string,
  input: ResolveAgentProposal
): Promise<AgentProposal> {
  if (requester !== null) throw new AgentProposalError(403, "Only the owner can confirm or reject a proposal.");
  const userId = await ensureUser(sql);
  await expireOld(sql, userId);
  const rows = await select(sql, "id=$1 AND user_id=$2", id, userId);
  const row = rows[0];
  if (!row) throw new AgentProposalError(404, `${refusalText(notFoundRefusal("proposal", id))}`);
  if (row.status !== "pending")
    throw new AgentProposalError(409, `That proposal is already ${row.status}.`, { proposal: toProposal(row) });

  if (input.decision === "reject") {
    const rejected = await settle(sql, id, "rejected", input.note ?? null);
    if (!rejected) throw new AgentProposalError(409, "That proposal was already decided.");
    return rejected;
  }

  // The agent replaced it (coalescing) after the card was drawn: what the person read is not what would apply.
  if (input.revision !== row.revision)
    throw new AgentProposalError(409, "The agent changed this after you opened it. Read it again before confirming.", {
      changed: true,
      proposal: toProposal(row)
    });
  const applier = proposalApplier(row.kind);
  if (!applier) throw new AgentProposalError(422, `This portal cannot apply proposals of kind "${row.kind}".`);
  const context = { sql, userId };
  const stored: StoredProposal = {
    id: row.id,
    agent: row.agent,
    kind: row.kind,
    payload: row.payload,
    targetVersions: row.target_versions,
    revision: row.revision
  };
  const stale = async (conflicts: ReturnType<typeof versionConflicts>) => {
    const settled = await settle(sql, id, "stale", "The record changed after the agent proposed this.", row.revision);
    throw new AgentProposalError(409, "The record changed after the agent proposed this, so nothing was applied.", {
      stale: true,
      conflicts,
      proposal: settled ?? toProposal(row)
    });
  };
  if (applier.hooks.currentVersions) {
    const conflicts = versionConflicts(row.target_versions, await applier.hooks.currentVersions(context, stored));
    if (conflicts.length > 0) await stale(conflicts);
  }
  try {
    await runWithActor(row.agent, () => applier.apply(context, stored), "owner");
  } catch (error) {
    // The write path's own check is the race-free one: a record edited between the read above and the write lands here.
    if (error instanceof CommandConflictError) return stale([]);
    if (error instanceof InvalidCommandError) throw new AgentProposalError(422, error.message);
    throw error;
  }
  const confirmed = await settle(sql, id, "confirmed", input.note ?? null, row.revision);
  try {
    notifyStateChanged(sql, { userId, kind: "state" });
  } catch (error) {
    console.error("resolveAgentProposal: could not notify state_changed", error);
  }
  // A concurrent confirm replayed the same receipt and won the update; report the stored row.
  return confirmed ?? toProposal((await select(sql, "id=$1", id))[0]!);
}
