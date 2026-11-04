import type { JournalEntry } from "@openrhen/cli/in-process";
import { AGENT_JOURNAL_LIMIT, labelOf, ledgerRows } from "./persistence/postgres/agent-changes";
import type { PoolSql } from "./persistence/postgres/sql-pool";

/**
 * An agent's undo journal as the write ledger keeps it: the writes whose actor is the agent and that kept something
 * to put back (`writes.state` is set), as the CLI's server-checked `JournalEntry`s, oldest first. This is what lets
 * `rhen_undo` on the remote `/mcp` endpoint read the ledger instead of a journal of its own: `undo` still
 * picks the agent's newest applied entry (or `--id`), and posts its write id to `/api/commands/revert`, whose
 * checks and `writes.state` are the whole record. Nothing here is saved; the status of an entry is the ledger's.
 *
 * Two things the ledger does not hold are rebuilt: `undoSeq` (which undo came last, so `redo` takes it first) from
 * when each undone write last changed, and `undoneBy: "owner"` (the person undid it, so the agent may not redo it)
 * from the newest undo of the write having been made with no agent actor. A changeset's undo is recorded per
 * member, so for a set it is the newest undo of any of its members.
 */

const REVERT_PATH = "/api/commands/revert";

/** The agent's ledger writes as journal entries, oldest first (at most `AGENT_JOURNAL_LIMIT`). */

export async function ledgerJournalEntries(sql: PoolSql, userId: string, agent: string): Promise<JournalEntry[]> {
  const rows = await ledgerRows(sql, userId, { take: AGENT_JOURNAL_LIMIT, agent, kept: true });
  const undone = rows.filter((row) => row.state === "undone");
  const byOwner = await undoneByOwner(
    sql,
    userId,
    undone.map((row) => row.id)
  );
  const order = new Map(
    [...undone]
      .sort((a, b) => a.changed_ms - b.changed_ms || (a.id < b.id ? -1 : 1))
      .map((row, index) => [row.id, index + 1])
  );
  return rows.reverse().map((row): JournalEntry => {
    const status = row.state === "undone" ? "undone" : "applied";
    return {
      id: row.id,
      at: new Date(row.at).toISOString(),
      label: labelOf(row),
      undo: { path: REVERT_PATH, payload: { target: row.id, direction: "undo" } },
      redo: { path: REVERT_PATH, payload: { target: row.id, direction: "redo" } },
      target: { stateKey: "revert", id: row.id },
      status,
      serverChecked: true,
      ...(status === "undone" ? { undoSeq: order.get(row.id)! } : {}),
      ...(byOwner.has(row.id) ? { undoneBy: "owner" as const } : {})
    };
  });
}

/** Which of the undone writes `ids` the person undid last: the newest undo of the write, or of any member of a set. */
async function undoneByOwner(sql: PoolSql, userId: string, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const writeOf = new Map(ids.map((id) => [id, id]));
  for (const set of await sql<{ id: string; members: unknown }[]>`
    SELECT id::text AS id, response->'members' AS members FROM writes
    WHERE user_id=${userId} AND command_type='changeset' AND id::text IN ${sql(ids)}`)
    if (Array.isArray(set.members))
      for (const member of set.members) if (typeof member === "string") writeOf.set(member, set.id);
  const newest = new Map<string, { at: number; byOwner: boolean }>();
  for (const row of await sql<{ target: string; at_ms: number; by_owner: boolean }[]>`
    SELECT DISTINCT ON (r.evidence->>'target') r.evidence->>'target' AS target,
           (extract(epoch FROM r.created_at) * 1000)::float8 AS at_ms, rw.actor IS NULL AS by_owner
    FROM write_rows r JOIN writes rw ON rw.id=r.write_id
    WHERE r.user_id=${userId} AND r.operation='undo' AND r.evidence->>'target' IN ${sql([...writeOf.keys()])}
    ORDER BY r.evidence->>'target', r.created_at DESC, r.id DESC`) {
    const write = writeOf.get(row.target)!;
    const seen = newest.get(write);
    if (!seen || row.at_ms > seen.at) newest.set(write, { at: row.at_ms, byOwner: row.by_owner });
  }
  return new Set([...newest].filter(([, undo]) => undo.byOwner).map(([write]) => write));
}
