import { attentionDoctorItems, attentionItemWeight } from "@openrhen/contracts";
import type { PoolSql } from "@/server/persistence/postgres/sql-pool";
import {
  canReadPlan,
  canReadProposals,
  defaultAttentionReaders,
  FACTS_READ_TIMEOUT_MS,
  logSourceFailure,
  withFactsTimeout,
  type AttentionReaders
} from "./readers";

export { FACTS_READ_TIMEOUT_MS };
import type { AttentionRequest } from "./read-attention";

/**
 * The counts the status block needs (`GET /api/attention?counts=1`, the design notes):
 * how many blocking data-health items there are, whether a check-in is open or a catch-up is due, how many sources
 * failed, and how many of this agent's proposals the owner decided since its previous session. `healthBlocking +
 * sourcesFailed + checkInOpen + catchUpDue` is the feed's `counts.now`. The check-in is read from the ledger entries,
 * which never stamp `prompted_at`. It reads no pulse view and runs no `expireOld`. `factsOpen` is the weight of the
 * feed's `fact_open` items (open mail items, after the plan's own notes are taken out); they are `soon` or `fyi`, so it
 * is no part of `counts.now`. It is 0 for the owner view and for a token without `read:plan`, as the feed lists none.
 */
export interface AttentionStatusCounts {
  viewer: "agent" | "owner";
  healthBlocking: number;
  /** 1 when a check-in is open, as the feed's `check_in_open` item; 0 otherwise. */
  checkInOpen: number;
  /** 1 when a catch-up is due, as the feed's `catch_up_due` item; 0 otherwise. */
  catchUpDue: number;
  sourcesFailed: number;
  decided: number;
  /** Open mail items (derived facts), the sum of the weights of the feed's `fact_open` items. */
  factsOpen: number;
  /** The part of `factsOpen` the feed lists as `soon` (a timed fact due within 48 hours, an ask active in 3 days). */
  factsSoon: number;
  /** 1 when the mail facts could not be read (shown as a `soon` item in the feed, never part of `sourcesFailed` or `now`); 0 otherwise. */
  factsFailed: number;
}

/** How long the doctor half of the counts is reused. */
export const ATTENTION_COUNTS_MEMO_MS = 30_000;

/**
 * The doctor half, in memory, keyed by user id. It holds only a fulfilled doctor read: a failure is never kept, so
 * the next call retries it. It is the same for every caller of the one user (blocking items do not depend on who
 * asks), so `decided` and `viewer`, which do, are never kept here.
 */
const doctorHalf = new Map<string, { at: number; healthBlocking: number }>();

/** The facts half, kept the same way: a count only, never the items, and never a failure. */
const factsHalf = new Map<string, { at: number; factsOpen: number; factsSoon: number }>();

export function resetAttentionCountsMemo(): void {
  doctorHalf.clear();
  factsHalf.clear();
}

export async function readAttentionCounts(
  sql: PoolSql,
  request: AttentionRequest,
  readers: AttentionReaders = defaultAttentionReaders(sql)
): Promise<AttentionStatusCounts> {
  // `now` is the memo's clock; tests pass their own.
  const now = request.now ?? new Date();
  const { agent, scopes: held } = request;
  const userId = await readers.userId();

  const memo = doctorHalf.get(userId);
  const age = memo === undefined ? Number.NaN : now.getTime() - memo.at;
  const fresh = memo !== undefined && age >= 0 && age < ATTENTION_COUNTS_MEMO_MS;
  const healthBlockingP: Promise<number> = fresh
    ? Promise.resolve(memo.healthBlocking)
    : readers.doctor(now).then((report) => {
        const { healthBlocking } = attentionDoctorItems({
          items: report.items,
          generatedAt: now.toISOString(),
          held
        });
        doctorHalf.set(userId, { at: now.getTime(), healthBlocking });
        return healthBlocking;
      });
  // The owner view has no outcomes, and a token without `read:proposals` must not learn the count.
  const decidedP: Promise<number> =
    agent !== null && canReadProposals(held) ? readers.decided(userId, agent) : Promise.resolve(0);

  // The owner view lists no mail facts (no page shows them), and a token without `read:plan` must not learn the count.
  const factsMemo = factsHalf.get(userId);
  const factsAge = factsMemo === undefined ? Number.NaN : now.getTime() - factsMemo.at;
  const factsFresh = factsMemo !== undefined && factsAge >= 0 && factsAge < ATTENTION_COUNTS_MEMO_MS;
  const noFacts = { factsOpen: 0, factsSoon: 0 };
  const factsP: Promise<{ factsOpen: number; factsSoon: number }> =
    agent === null || !canReadPlan(held)
      ? Promise.resolve(noFacts)
      : factsFresh
        ? Promise.resolve(factsMemo)
        : withFactsTimeout(readers.facts(now, held, { quotes: false })).then((items) => {
            const weigh = (list: typeof items) => list.reduce((sum, item) => sum + attentionItemWeight(item), 0);
            const half = { factsOpen: weigh(items), factsSoon: weigh(items.filter((item) => item.urgency === "soon")) };
            factsHalf.set(userId, { at: now.getTime(), ...half });
            return half;
          });

  const entriesP = readers.entries(userId, now);
  const dueP = entriesP.then((entries) => readers.due(userId, now, entries));

  const [doctor, decided, entries, due, facts] = await Promise.allSettled([
    healthBlockingP,
    decidedP,
    entriesP,
    dueP,
    factsP
  ]);
  let sourcesFailed = 0;
  // As the feed: an unreadable ledger is one unavailable item for the check-in and one for the catch-up.
  if (entries.status === "rejected") {
    sourcesFailed += 1;
    logSourceFailure("check-in", entries.reason);
  }
  if (due.status === "rejected") {
    sourcesFailed += 1;
    logSourceFailure("catch-up", due.reason);
  }
  if (doctor.status === "rejected") {
    sourcesFailed += 1;
    logSourceFailure("doctor", doctor.reason);
  }
  if (decided.status === "rejected") {
    sourcesFailed += 1;
    logSourceFailure("proposals", decided.reason);
  }
  // The mail facts are optional: a failure is counted apart, so it never raises `now` or `sourcesFailed`.
  if (facts.status === "rejected") logSourceFailure("facts", facts.reason);
  return {
    viewer: agent === null ? "owner" : "agent",
    healthBlocking: doctor.status === "fulfilled" ? doctor.value : 0,
    checkInOpen: entries.status === "fulfilled" && entries.value.some((entry) => entry.kind === "check_in") ? 1 : 0,
    catchUpDue: due.status === "fulfilled" && due.value.due ? 1 : 0,
    sourcesFailed,
    decided: decided.status === "fulfilled" ? decided.value : 0,
    factsOpen: facts.status === "fulfilled" ? facts.value.factsOpen : 0,
    factsSoon: facts.status === "fulfilled" ? facts.value.factsSoon : 0,
    factsFailed: facts.status === "rejected" ? 1 : 0
  };
}
