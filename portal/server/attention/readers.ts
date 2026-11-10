import { scopeCovers, type AttentionItem, type CatchUpEntry, type DoctorReport } from "@openrhen/contracts";
import { readDecidedCount, readDecidedWindowStart, readProposalOutcomes } from "@/server/agent-proposals/outcomes";
import type { ProposalOutcomeResult } from "@/server/agent-proposals/outcomes";
import { readProposalsWaiting, type ProposalsWaiting } from "@/server/agent-proposals/waiting";
import { redact } from "@/server/logging";
import { allEntries, readCatchUpDue, type CatchUpDue } from "@/server/persistence/postgres/catch-up";
import { readDoctorReport } from "@/server/persistence/postgres/doctor";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { readPulseReentryView } from "@/server/persistence/postgres/reenter";
import type { PoolSql } from "@/server/persistence/postgres/sql-pool";
import { reentryRefusal } from "@/server/pulse/reentry-gate";
import { readDeadlineOutlook } from "./deadline-items";
import { readFactItems } from "./fact-items";
import { FACTS_READ_TIMEOUT_MS, guardedFactsRead, withFactsTimeout } from "./facts-guard";

/** The pulse as the gate reads it: `lapsed` already includes the gate's `everConfirmed` test. */
export type AttentionPulse = NonNullable<Awaited<ReturnType<typeof readPulseReentryView>>>;

export interface ProposalsRead {
  outcomes: ProposalOutcomeResult;
  /** Start of the decided window (the previous closed session's start, floored at 7 days). */
  windowStart: string;
  waiting: ProposalsWaiting | null;
}

/**
 * The feed's reads, one per source. `defaultAttentionReaders` is the real set; a test passes a partial set to make a
 * source fail or to count its calls. Every reader here writes nothing, except that `proposals` runs the feed's one
 * `expireOld` (inside `readProposalOutcomes`, only when proposals are read).
 */
export interface AttentionReaders {
  userId(): Promise<string>;
  doctor(now: Date): Promise<DoctorReport>;
  entries(userId: string, now: Date): Promise<CatchUpEntry[]>;
  due(userId: string, now: Date, entries: readonly CatchUpEntry[]): Promise<CatchUpDue>;
  pulse(now: Date): Promise<AttentionPulse | null>;
  refusal(pulse: AttentionPulse): Promise<Response>;
  proposals(userId: string, agent: string, since: string | undefined): Promise<ProposalsRead>;
  decided(userId: string, agent: string): Promise<number>;
  /**
   * The open mail facts as items (`fact_open`), for a token that holds `read:plan`. `quotes: false` (the counts) skips
   * reading the mail text; the items are otherwise the same, so the counts and the feed agree.
   */
  facts(now: Date, held: readonly string[] | undefined, options: { quotes: boolean }): Promise<AttentionItem[]>;
  /** The latest plan run's stored `deadlineOutlook` (null before one exists), read-only; the feed turns it into items. */
  deadlines(userId: string): Promise<unknown>;
}

export { FACTS_READ_TIMEOUT_MS, withFactsTimeout };

export function defaultAttentionReaders(sql: PoolSql): AttentionReaders {
  return {
    userId: () => ensureUser(sql),
    doctor: (now) => readDoctorReport(sql, { now }),
    // `since = null`, as the ledger reads it: a check-in older than the last owner write must not drop out.
    entries: (userId, now) => allEntries(sql, userId, now, null),
    due: (userId, now, entries) => readCatchUpDue(sql, userId, now, { entries }),
    pulse: (now) => readPulseReentryView(sql, now),
    refusal: (pulse) => reentryRefusal(sql, pulse.view),
    proposals: async (userId, agent, since) => {
      const { start } = await readDecidedWindowStart(sql, userId, agent);
      // Runs the feed's own `expireOld` first; a throw leaves the caller with no cursor.
      const outcomes = (await readProposalOutcomes(sql, userId, agent, { since }))!;
      return { outcomes, windowStart: start, waiting: await readProposalsWaiting(sql, userId, agent) };
    },
    decided: async (userId, agent) => (await readDecidedCount(sql, userId, agent)).count,
    deadlines: (userId) => readDeadlineOutlook(sql, userId),
    facts: async (now, held, options) =>
      guardedFactsRead(await ensureUser(sql), now, options.quotes, () =>
        readFactItems(sql, { now, held, quotes: options.quotes })
      )
  };
}

/** Whether the token may read proposals. `undefined` scopes (environment token, header-only name, owner) is unscoped. */
export function canReadProposals(scopes: readonly string[] | undefined): boolean {
  return scopes === undefined || scopes.some((held) => scopeCovers(held, "read:proposals"));
}

/** Whether the token may read the open mail facts (`read:plan`, which the feed itself needs). `undefined` is unscoped. */
export function canReadPlan(scopes: readonly string[] | undefined): boolean {
  return scopes === undefined || scopes.some((held) => scopeCovers(held, "read:plan"));
}

/** Logs a failed source: its name and the error's class name, never its message (it can hold imported text). */
export function logSourceFailure(source: string, reason: unknown): void {
  const name = reason instanceof Error ? reason.name : typeof reason;
  console.error(
    JSON.stringify({
      level: "error",
      message: "Attention source could not be read",
      source,
      errorName: redact(String(name)).slice(0, 80)
    })
  );
}
