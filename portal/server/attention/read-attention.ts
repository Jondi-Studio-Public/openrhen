import {
  CATCH_UP_DUE_AFTER_HOURS,
  buildAttentionAnswer,
  attentionDoctorItems,
  catchUpDueItem,
  checkInOpenItem,
  proposalOutcomeItem,
  proposalsWaitingItem,
  sourceUnavailableItem,
  type AttentionAnswer,
  type AttentionItem,
  type AttentionNotIncluded,
  type AttentionSourceName,
  type AttentionSourceStatus
} from "@openrhen/contracts";
import { redact } from "@/server/logging";
import type { PoolSql } from "@/server/persistence/postgres/sql-pool";
import {
  canReadPlan,
  canReadProposals,
  defaultAttentionReaders,
  logSourceFailure,
  withFactsTimeout,
  type AttentionPulse,
  type AttentionReaders
} from "./readers";
import { clampAttentionSince, SINCE_NOTE, type SinceMoved } from "./since";

/**
 * The agent attention feed: what needs the agent or the owner right
 * now, computed on every call from the modules that own each fact. It stores nothing and changes nothing; its one
 * write is the proposals tool's existing `expireOld` rule, run only when proposals are read.
 */

export interface AttentionRequest {
  /** `requestAgent()`: null is the owner's view, which has no proposal kinds. */
  agent: string | null;
  /** `requestScopes()`: `undefined` is unscoped (environment token, header-only name, the owner). */
  scopes: readonly string[] | undefined;
  /** Already validated by `parseAttentionSince`. */
  since?: string | undefined;
  now?: Date | undefined;
}

/** The answer, plus a note when `since` was moved. Serialised in this order: the cursor comes after the items. */
export type AttentionResponse = AttentionAnswer & { sinceNote?: string };

export type AttentionResult = { answer: AttentionResponse } | { lapsed: Response };

const HOUR_MS = 3_600_000;

type Settled<T> = PromiseSettledResult<T>;

/** Settles a promise that may be absent (a source this token cannot read is never started). */
const settle = <T>(promise: Promise<T> | undefined): Promise<Settled<T>> | undefined =>
  promise === undefined ? undefined : Promise.allSettled([promise]).then(([result]) => result as Settled<T>);

export async function readAttention(
  sql: PoolSql,
  request: AttentionRequest,
  readers: AttentionReaders = defaultAttentionReaders(sql)
): Promise<AttentionResult> {
  const now = request.now ?? new Date();
  const generatedAt = now.toISOString();
  const { agent, scopes: held } = request;
  const proposalsReadable = agent !== null && canReadProposals(held);
  // The owner view lists no mail facts (no page shows them); an agent needs `read:plan`, the scope the feed itself needs.
  const factsReadable = agent !== null && canReadPlan(held);
  const userId = await readers.userId();
  const clamped = clampAttentionSince(request.since, now);

  const doctorP = readers.doctor(now);
  const entriesP = readers.entries(userId, now);
  const dueP = entriesP.then((entries) => readers.due(userId, now, entries));
  const pulseP = agent !== null ? readers.pulse(now) : undefined;
  const proposalsP = proposalsReadable ? readers.proposals(userId, agent, request.since) : undefined;
  const factsP = factsReadable ? withFactsTimeout(readers.facts(now, held, { quotes: true })) : undefined;
  const [doctor, entries, due, pulse, proposals, facts] = await Promise.all([
    settle(doctorP),
    settle(entriesP),
    settle(dueP),
    settle(pulseP),
    settle(proposalsP),
    settle(factsP)
  ]);

  // A lapse between the gate and here: the gate's own view (`lapsed` includes `everConfirmed`) answers its own 428.
  if (pulse?.status === "fulfilled" && pulse.value?.lapsed) return { lapsed: await readers.refusal(pulse.value) };

  const items: AttentionItem[] = [];
  const sources: AttentionSourceStatus[] = [];
  const read = <T>(source: AttentionSourceName, result: Settled<T> | undefined): T | undefined => {
    if (result === undefined) return undefined;
    if (result.status === "fulfilled") {
      sources.push({ source, ok: true });
      return result.value;
    }
    logSourceFailure(source, result.reason);
    sources.push({ source, ok: false });
    items.push(sourceUnavailableItem({ source, generatedAt, held }));
    return undefined;
  };

  const ledger = read("catch-up", due);
  const ledgerEntries = read("check-in", entries);
  read("pulse", pulse);
  const report = read("doctor", doctor);
  const proposalsRead = read("proposals", proposals);
  const factItems = read("facts", facts);
  if (factItems) items.push(...factItems);

  const checkIn = ledgerEntries?.find((entry) => entry.kind === "check_in");
  if (checkIn)
    items.push(
      checkInOpenItem({
        at: checkIn.plannedAt,
        checkInId: checkIn.id.slice("check-in:".length),
        held,
        generatedAt
      })
    );

  if (ledger?.due) {
    const since = ledger.since;
    const at =
      ledger.lapsed && ledger.pulse
        ? ledger.pulse.since.toISOString()
        : since
          ? new Date(since.getTime() + CATCH_UP_DUE_AFTER_HOURS * HOUR_MS).toISOString()
          : generatedAt;
    items.push(catchUpDueItem({ at, held, generatedAt }));
  }

  let droppedOwnedBlocking = false;
  if (report) {
    const mapped = attentionDoctorItems({
      items: report.items,
      generatedAt,
      held,
      unsettledNotDue: ledger && !ledger.due ? ledger.unsettled : 0
    });
    for (const check of mapped.unmappedChecks)
      console.error(
        JSON.stringify({
          level: "error",
          message: "Attention: a data-health check is outside the enum",
          check: redact(String(check)).slice(0, 80)
        })
      );
    items.push(...mapped.items);
    sources.push(...mapped.sources);
    droppedOwnedBlocking = mapped.droppedOwnedBlocking;
  }

  if (proposalsRead) {
    const { outcomes, waiting } = proposalsRead;
    for (const outcome of outcomes.outcomes) {
      const item = proposalOutcomeItem({
        id: outcome.id,
        status: outcome.status,
        at: outcome.at,
        kind: outcome.kind,
        summary: outcome.summary,
        note: outcome.note,
        ...(outcome.target ? { target: outcome.target } : {}),
        ...(outcome.reproposedAs ? { reproposedAs: outcome.reproposedAs } : {}),
        staleCount: outcomes.staleCount,
        held
      });
      if (item) items.push(item);
    }
    if (waiting)
      items.push(
        proposalsWaitingItem({
          count: waiting.count,
          oldestAt: waiting.oldestAt,
          ...(waiting.expiringAt ? { expiringAt: waiting.expiringAt } : {}),
          generatedAt
        })
      );
  }

  // The cursor comes only from a successful outcome query; otherwise it is the clamped `since` sent, or absent.
  const since = proposalsRead?.outcomes.since ?? clamped.since;
  const moved: SinceMoved | undefined = proposalsRead ? proposalsRead.outcomes.sinceClamped : clamped.moved;
  const notIncluded: AttentionNotIncluded[] =
    agent !== null && !proposalsReadable
      ? [{ kinds: ["proposal_decided", "proposals_waiting"], scope: "read:proposals" }]
      : [];
  if (agent !== null && !factsReadable) notIncluded.push({ kinds: ["fact_open"], scope: "read:plan" });
  const answer = buildAttentionAnswer({
    generatedAt,
    items,
    since,
    outcomeQueryNow: proposalsRead?.outcomes.queryNow,
    decidedWindowStart: proposalsRead?.windowStart,
    droppedOwnedBlocking,
    sources,
    notIncluded,
    checked: {
      catchUp: sources.some((s) => s.source === "catch-up" && s.ok),
      checkIn: sources.some((s) => s.source === "check-in" && s.ok),
      doctor: sources.some((s) => s.source === "doctor" && s.ok),
      facts: sources.some((s) => s.source === "facts" && s.ok),
      proposalsSince: proposalsRead?.outcomes.since
    }
  });
  const ordered: AttentionResponse = {
    generatedAt: answer.generatedAt,
    ...(answer.since ? { since: answer.since } : {}),
    ...(moved ? { sinceNote: SINCE_NOTE[moved] } : {}),
    counts: answer.counts,
    items: answer.items,
    ...(answer.cursor ? { cursor: answer.cursor } : {}),
    complete: answer.complete,
    sources: answer.sources,
    notIncluded: answer.notIncluded,
    ...(answer.empty ? { empty: answer.empty } : {})
  };
  return { answer: ordered };
}

export type { AttentionPulse };
