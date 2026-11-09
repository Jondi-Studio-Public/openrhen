import { createHash } from "node:crypto";
import { sanitiseQuoted } from "@openrhen/contracts";
import {
  foldFactStates,
  planFactAct,
  type FactActPlan,
  type FactActRefusal,
  type FactHistoryEntry
} from "@openrhen/communication-readers";
import { ingestActivityEventsTx } from "./activity-store";
import { lockActivityUser } from "./activity-lock";
import { commandRequestHash, claimCommandReceipt, hasCommandReceipt } from "./command-receipt";
import { ensureUser } from "./ensure-user";
import { clearFactListingCache } from "./fact-listing-store";
import { readFactEvidence, readFactFoldInput } from "./open-facts-store";
import type { PoolSql, Sql } from "./sql-pool";
import { WriteSnapshot } from "./write-snapshot";

/**
 * Mark's marks on open mail facts (communication understanding, slice 2b-9, room `facts`): the I/O around the pure
 * `planFactAct`. One transaction does everything that has to be atomic: it takes the per-person activity lock
 * (waiting at most `FACT_ACT_LOCK_WAIT`), claims the command's receipt (the write ledger row Review > Agent changes lists), reads the
 * fact tables under the lock, plans, inserts the derived rows through the same ingest path as every other writer
 * (`ingestActivityEventsTx`, with the authenticated agent as `ingested_via`) and snapshots them, so the owner can undo
 * the mark from Review > Agent changes (the undo deletes the derived row; a redo puts it back) and the agent from `rhen_undo`.
 *
 * `now` is taken before the lock wait, so a write the owner makes while this one waits is recorded later and, under the
 * fold's rule that a person's later-recorded status wins, outranks it. A refusal rolls the transaction back: no receipt
 * is left, so repeating the call re-evaluates. The same command id with the same payload replays the stored answer.
 * A dry run reads the live fact and plans, and writes nothing (it takes no lock and is not counted).
 */

export const FACT_ACT_LOCK_WAIT = "5s";
export const FACT_ACT_STATEMENT_TIMEOUT = "15s";

export interface FactActRequest {
  action: string;
  factId: string;
  set: Record<string, unknown>;
  basis?: string | undefined;
  evidence?: string | undefined;
  /** The command id (a uuid): the write's ledger id and the key that makes a repeat a replay. */
  commandId: string;
  dryRun: boolean;
  /** The clock; default the current time. For tests. */
  now?: Date | undefined;
}

export type FactActOutcome =
  | { ok: true; act: string; message: string; dryRun: boolean; replay: boolean }
  | { ok: false; code: FactActRefusal | "busy" | "undone"; message: string };

/**
 * Every call counts against this, a refusal and a dry run included (a refusal leaves no receipt, so the ledger cannot
 * count it). Per process and per agent; a restart clears it, which only ever lets a few more calls through.
 */
export const FACT_CALLS_PER_HOUR = 120;
const calls = new Map<string, number[]>();
export function resetFactCallLog(): void {
  calls.clear();
}
function tooManyCalls(agent: string, nowMs: number): boolean {
  const recent = (calls.get(agent) ?? []).filter((at) => at > nowMs - 3_600_000);
  if (recent.length >= FACT_CALLS_PER_HOUR) {
    calls.set(agent, recent);
    return true;
  }
  recent.push(nowMs);
  calls.set(agent, recent);
  return false;
}

const UNDONE =
  "That command-id belongs to a mark that has since been undone, so nothing was written now. To mark the item again, repeat the call with a new command-id (the limits still count the earlier mark).";

const BUSY =
  "The mail reader is busy right now, so nothing was changed. Wait 10 seconds and repeat the identical call (the same command-id).";

class Refused extends Error {
  constructor(readonly plan: Extract<FactActPlan, { ok: false }>) {
    super(plan.message);
  }
}

const sha1 = (parts: readonly unknown[]) => createHash("sha1").update(JSON.stringify(parts)).digest("hex");

/** The code of a Postgres error (lock_timeout 55P03, statement_timeout 57014) that means "busy, nothing changed". */
const isBusy = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "55P03" || code === "57014";
};

const hashOf = (request: FactActRequest, set: Record<string, unknown>) =>
  commandRequestHash(`fact_${request.action}`, {
    factId: request.factId,
    set,
    basis: request.basis ?? null,
    evidence: request.evidence ?? null
  });

async function storedAnswer(
  sql: Sql,
  userId: string,
  commandId: string
): Promise<{ message: string | undefined; undone: boolean }> {
  const [row] = await sql<{ response: { message?: unknown } | null; state: string | null }[]>`
    SELECT response, state FROM writes WHERE id = ${commandId} AND user_id = ${userId}`;
  return {
    message: typeof row?.response?.message === "string" ? row.response.message : undefined,
    undone: row?.state === "undone"
  };
}

/** What a replay answers: the stored words, or, when the mark has been undone since, that and what to do. */
async function replayOutcome(sql: Sql, userId: string, request: FactActRequest): Promise<FactActOutcome> {
  const earlier = await storedAnswer(sql, userId, request.commandId);
  if (earlier.undone) return { ok: false, code: "undone", message: UNDONE };
  return {
    ok: true,
    act: request.action,
    dryRun: false,
    replay: true,
    message: `Already recorded by an earlier identical call; nothing more was written. ${earlier.message ?? ""}`.trim()
  };
}

/** This agent's marks of the last day from the write ledger, whose receipts an undo leaves in place. */
async function readHistory(
  tx: Sql,
  userId: string,
  agent: string,
  exceptCommandId: string,
  now: Date
): Promise<FactHistoryEntry[]> {
  const rows = await tx<{ act: string; at: Date; fact_id: string | null }[]>`
    SELECT substring(command_type from 6) AS act, created_at AS at, response->>'factId' AS fact_id
    FROM writes
    WHERE user_id = ${userId} AND actor = ${agent} AND left(command_type, 5) = 'fact_' AND id <> ${exceptCommandId}
      AND created_at > ${new Date(now.getTime() - 86_400_000)}`;
  return rows.map((row) => ({ at: row.at.toISOString(), act: row.act, factId: row.fact_id }));
}

export async function actOnFact(sql: PoolSql, agent: string, request: FactActRequest): Promise<FactActOutcome> {
  // Taken before the lock wait (see the header).
  const now = request.now ?? new Date();
  if (tooManyCalls(agent, now.getTime()))
    return {
      ok: false,
      code: "rate",
      message: `You have made ${FACT_CALLS_PER_HOUR} calls on mail items in the last hour, refusals and dry runs included, which is the limit. Nothing was changed. Wait, and tell the owner which items are waiting.`
    };
  // Shape first: an unknown action, a bad id or a key the action does not take is answered without a database read.
  const shape = planFactAct({
    action: request.action,
    factId: request.factId,
    by: agent,
    now,
    set: request.set,
    fold: { now, facts: [] }
  });
  if (!shape.ok && shape.code !== "not_found") return shape;
  const set = Object.fromEntries(Object.entries(request.set).map(([key, value]) => [key, String(value)]));
  const userId = await ensureUser(sql);

  try {
    if (request.dryRun) {
      const read = await sql.begin("isolation level repeatable read read only", async (tx) => {
        await tx.unsafe(`SET LOCAL statement_timeout = '${FACT_ACT_STATEMENT_TIMEOUT}'`);
        return readFactFoldInput(tx, userId, { now });
      });
      const plan = planFactAct({ ...baseInput(request, agent, now), fold: read.input });
      if (!plan.ok) return plan;
      return {
        ok: true,
        act: plan.act,
        dryRun: true,
        replay: false,
        message: `Dry run: checked against the live item, nothing was written, and it does not count toward the limits. A real call would answer: ${plan.message}`
      };
    }

    const receipt = {
      id: request.commandId,
      userId,
      commandType: `fact_${request.action}`,
      requestHash: hashOf(request, set)
    };
    if (await hasCommandReceipt(sql, receipt)) return await replayOutcome(sql, userId, request);

    const outcome = await sql.begin(async (tx): Promise<FactActOutcome> => {
      await tx.unsafe(`SET LOCAL lock_timeout = '${FACT_ACT_LOCK_WAIT}'`);
      await lockActivityUser(tx, userId);
      await tx.unsafe(`SET LOCAL statement_timeout = '${FACT_ACT_STATEMENT_TIMEOUT}'`);
      // The receipt is the write ledger row (actor: the authenticated agent). A racing retry of the same call finds it taken.
      if (!(await claimCommandReceipt(tx, receipt))) return await replayOutcome(tx, userId, request);
      const read = await readFactFoldInput(tx, userId, { now });
      const history = await readHistory(tx, userId, agent, request.commandId, now);
      const plan = planFactAct({ ...baseInput(request, agent, now), fold: read.input, history });
      if (!plan.ok) throw new Refused(plan);
      const markItem = await describeItem(tx, userId, read.input, plan.factId);

      const events = plan.rows.map((row, index) => ({
        id: sha1([request.commandId, plan.factId, plan.act, row.kind, index]),
        source: "derived",
        kind: row.kind,
        start: row.validFrom,
        attrs: row.attrs
      }));
      // `ingested_via` is the authenticated agent, never anything in the request body (the row validator refuses attrs.by).
      const stored = await ingestActivityEventsTx(
        tx,
        userId,
        { events },
        agent,
        new Date(Math.max(now.getTime(), ...plan.rows.map((row) => Date.parse(row.validFrom))))
      );
      if (stored.rejected.length > 0 || stored.added !== events.length)
        throw new Error(
          `A mail mark was not stored: ${stored.rejected.map((r) => r.reason).join(" ") || "its key was already held"}`
        );
      const ids = await tx<{ id: string }[]>`
        SELECT id::text AS id FROM activity_events
        WHERE user_id = ${userId} AND source = 'derived' AND event_key IN ${tx(events.map((event) => event.id))}`;
      // The mark is undoable: the ledger row keeps the derived rows, the undo deletes them and a redo puts them back.
      const snapshot = WriteSnapshot.forWrite(tx, userId, request.commandId, "fact_mark");
      snapshot.inserted(
        "activity_events",
        ids.map((row) => row.id)
      );
      await snapshot.save();
      await tx`
        UPDATE writes SET response = ${tx.json({ message: plan.message, act: plan.act, factId: plan.factId, rows: events.length, markItem })}
        WHERE id = ${request.commandId} AND user_id = ${userId}`;
      return { ok: true as const, act: plan.act, dryRun: false, replay: false, message: plan.message };
    });
    clearFactListingCache();
    return outcome;
  } catch (error) {
    if (error instanceof Refused) return error.plan;
    if (isBusy(error)) return { ok: false, code: "busy", message: BUSY };
    throw error;
  }
}

/**
 * What the owner reads in Review > Agent changes to know what was marked: the type, the due time, the short id and, when
 * the mail text can still be read, a short sanitised quote of it. A purged or changed source says so instead. No raw
 * attrs and no unsanitised text.
 */
async function describeItem(
  tx: Sql,
  userId: string,
  input: Parameters<typeof foldFactStates>[0],
  factId: string
): Promise<string> {
  const fold = foldFactStates(input).find((candidate) => candidate.factId === factId);
  if (fold === undefined) return `item ${factId.slice(0, 8)}`;
  const due = fold.dueAt ? `due ${new Date(fold.dueAt).toISOString().slice(0, 16)}Z` : "no due time";
  const [evidence] = await readFactEvidence(tx, userId, { keys: [fold.rowKey] });
  const quote = evidence?.state === "ok" ? sanitiseQuoted(evidence.text) : undefined;
  const text = quote
    ? `"${quote.length > 120 ? `${quote.slice(0, 119)}…` : quote}"`
    : "(the mail text is no longer available to quote)";
  return `${fold.factType} ${factId.slice(0, 8)}, ${due}: ${text}`;
}

function baseInput(request: FactActRequest, agent: string, now: Date) {
  return {
    action: request.action,
    factId: request.factId,
    by: agent,
    now,
    set: request.set,
    basis: request.basis,
    evidence: request.evidence
  };
}
