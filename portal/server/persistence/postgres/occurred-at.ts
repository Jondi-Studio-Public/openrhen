import { OCCURRED_AT_FUTURE_GRACE_MS, OCCURRED_AT_MAX_BACK_MS } from "@openrhen/contracts";
import { requestAgent } from "@/server/agent-actor";
import { noteOccurredAtReport, type OccurredAtReport } from "@/server/occurred-at-report";
import { InvalidCommandError } from "./command-errors";
import { localMomentFormatter } from "./local-moment";
import type { Sql } from "./sql-pool";

/**
 * Real times for commands from the owner's device (`docs/design/real-times-for-owner-commands.md`). A command carries
 * `occurredAt`, the time the owner really did it. It is always recorded. It is used only when it is inside the bounds
 * and fits what the server holds; otherwise the command takes effect at receipt, the claimed time is kept with the
 * reason, and the reply says so.
 */
export interface OccurredAtOutcome {
  /** The time the owner claimed. */
  claimed: Date;
  /** True when the command takes effect at `at` = the claimed time. */
  applied: boolean;
  /** When the command takes effect: the claimed time (held at receipt if it sits inside the future grace), or receipt. */
  at: Date;
  /** The receipt time, kept for the record. */
  receipt: Date;
  /** Why the claimed time was not used; null when it was. */
  reason: string | null;
}

/** What goes into a change-log row's evidence and into the reply. */
export function occurredAtEvidence(outcome: OccurredAtOutcome): Record<string, unknown> {
  return {
    claimedAt: outcome.claimed.toISOString(),
    applied: outcome.applied,
    appliedAt: outcome.at.toISOString(),
    ...(outcome.reason ? { reason: outcome.reason } : {})
  };
}

/** Refuses `occurredAt` from an agent, with the fix. Call it before anything is written. */
export function assertOwnerOccurredAt(command: { occurredAt?: string | undefined }): void {
  if (command.occurredAt === undefined || requestAgent() === null) return;
  throw new InvalidCommandError(
    "occurredAt is accepted only from the owner's own device credential, not from an agent, so nothing was changed. " +
      "An agent states a past start with startedAt (up to 24 hours back, at most 5 minutes ahead) on start, select_alternative or start_activity, " +
      "and a past end with endedAt (not after now) on finish or finish_activity. For any other command, send it when it happens: the server stamps the time it received it. " +
      "Repeat the call without occurredAt."
  );
}

/** Reads the owner's local time for a sentence. */
async function formatter(tx: Sql, userId: string, receipt: Date) {
  return localMomentFormatter(tx, userId, receipt);
}

/** Checks that apply to every command: the future grace and the 7-day limit. Returns a reason, or null. */
function boundsReason(claimed: Date, receipt: Date, local: (moment: Date) => string): string | null {
  if (claimed.getTime() > receipt.getTime() + OCCURRED_AT_FUTURE_GRACE_MS)
    return `the time you gave (${local(claimed)}) is more than 5 minutes ahead of the server's clock`;
  if (claimed.getTime() < receipt.getTime() - OCCURRED_AT_MAX_BACK_MS)
    return `the time you gave (${local(claimed)}) is more than 7 days ago, which is the limit`;
  return null;
}

function decide(claimed: Date, receipt: Date, reason: string | null): OccurredAtOutcome {
  if (reason) return { claimed, applied: false, at: receipt, receipt, reason };
  // A time inside the grace after receipt is held at receipt, so no segment begins or ends in the future.
  return {
    claimed,
    applied: true,
    at: claimed.getTime() > receipt.getTime() ? receipt : claimed,
    receipt,
    reason: null
  };
}

/** The claimed time is recorded and never used (a sleep start or wake keeps receipt time). */
export async function recordOnlyOccurredAt(
  tx: Sql,
  userId: string,
  occurredAt: string,
  receipt: Date,
  why: string
): Promise<OccurredAtOutcome> {
  const claimed = new Date(occurredAt);
  const local = await formatter(tx, userId, receipt);
  return decide(claimed, receipt, `${why} (you gave ${local(claimed)})`);
}

/** A command with no session or segment of its own to place (a routine step's skip): only the bounds apply. */
export async function settleStandaloneOccurredAt(
  tx: Sql,
  userId: string,
  occurredAt: string,
  receipt: Date
): Promise<OccurredAtOutcome> {
  const claimed = new Date(occurredAt);
  const local = await formatter(tx, userId, receipt);
  return decide(claimed, receipt, boundsReason(claimed, receipt, local));
}

/** The claimed time of a check-in answer: inside the bounds and not before the slot the check-in was asked for. */
export async function settleCheckInOccurredAt(
  tx: Sql,
  userId: string,
  slotAt: Date,
  occurredAt: string,
  receipt: Date
): Promise<OccurredAtOutcome> {
  const claimed = new Date(occurredAt);
  const local = await formatter(tx, userId, receipt);
  const bounds = boundsReason(claimed, receipt, local);
  if (bounds) return decide(claimed, receipt, bounds);
  if (claimed.getTime() < slotAt.getTime())
    return decide(
      claimed,
      receipt,
      `the time you gave (${local(claimed)}) is before the check-in was asked (${local(slotAt)})`
    );
  return decide(claimed, receipt, null);
}

/**
 * The claimed time of a command that starts a session. It must be inside the bounds, after the last recorded wake and
 * after every finished session ended. (An open session is refused separately, before a start.)
 */
export async function settleStartOccurredAt(
  tx: Sql,
  userId: string,
  occurredAt: string,
  receipt: Date,
  excludeSessionId?: string
): Promise<OccurredAtOutcome> {
  const claimed = new Date(occurredAt);
  const local = await formatter(tx, userId, receipt);
  const bounds = boundsReason(claimed, receipt, local);
  if (bounds) return decide(claimed, receipt, bounds);
  const woke = await tx<
    { last_woke_at: Date | null }[]
  >`SELECT last_woke_at FROM user_preferences WHERE user_id=${userId}`;
  const lastWokeAt = woke[0]?.last_woke_at ?? null;
  if (lastWokeAt && claimed.getTime() < lastWokeAt.getTime())
    return decide(
      claimed,
      receipt,
      `the time you gave (${local(claimed)}) is before your last recorded wake (${local(lastWokeAt)})`
    );
  const overlap = await tx<
    { ended_at: Date }[]
  >`SELECT ended_at FROM sessions WHERE user_id=${userId} AND ended_at > ${claimed} AND id IS DISTINCT FROM ${excludeSessionId ?? null} ORDER BY ended_at DESC LIMIT 1`;
  if (overlap[0])
    return decide(
      claimed,
      receipt,
      `the time you gave (${local(claimed)}) overlaps an earlier session that ended at ${local(overlap[0].ended_at)}`
    );
  return decide(claimed, receipt, null);
}

/**
 * The claimed time of a command on a session that is already open. Besides the bounds it must come after everything the
 * session has recorded (its start and every segment boundary) and before any later session began.
 */
export async function settleSessionOccurredAt(
  tx: Sql,
  userId: string,
  session: { id: string; started_at: Date },
  occurredAt: string,
  receipt: Date
): Promise<OccurredAtOutcome> {
  const claimed = new Date(occurredAt);
  const local = await formatter(tx, userId, receipt);
  const bounds = boundsReason(claimed, receipt, local);
  if (bounds) return decide(claimed, receipt, bounds);
  const latestRows = await tx<
    { latest: Date | null }[]
  >`SELECT GREATEST(s.started_at,MAX(g.started_at),MAX(g.ended_at)) latest FROM sessions s LEFT JOIN session_segments g ON g.session_id=s.id WHERE s.id=${session.id} GROUP BY s.started_at`;
  const latest = latestRows[0]?.latest ?? session.started_at;
  // The segment table needs an end strictly after its start, so the claimed time must be strictly later.
  const effective = claimed.getTime() > receipt.getTime() ? receipt : claimed;
  if (effective.getTime() <= latest.getTime())
    return decide(
      claimed,
      receipt,
      `the time you gave (${local(claimed)}) is not after this session's last recorded change (${local(latest)})`
    );
  const later = await tx<
    { started_at: Date }[]
  >`SELECT started_at FROM sessions WHERE user_id=${userId} AND id<>${session.id} AND started_at > ${session.started_at} AND started_at < ${effective} ORDER BY started_at LIMIT 1`;
  if (later[0])
    return decide(
      claimed,
      receipt,
      `the time you gave (${local(claimed)}) is after a later session began at ${local(later[0].started_at)}`
    );
  return decide(claimed, receipt, null);
}

/** The words for the owner: what happened to the time he gave. */
export async function occurredAtReport(tx: Sql, userId: string, outcome: OccurredAtOutcome): Promise<OccurredAtReport> {
  const local = await formatter(tx, userId, outcome.receipt);
  const message = outcome.applied
    ? `Recorded at ${local(outcome.at)}, the time you did it.`
    : `Recorded at ${local(outcome.receipt)}, when the server received it, because ${outcome.reason}. The time you gave is kept on the record.`;
  return {
    claimedAt: outcome.claimed.toISOString(),
    applied: outcome.applied,
    appliedAt: outcome.at.toISOString(),
    ...(outcome.reason ? { reason: outcome.reason } : {}),
    message
  };
}

/** Notes the outcome so the route can put the sentence in its reply. */
export async function reportOccurredAt(tx: Sql, userId: string, outcome: OccurredAtOutcome): Promise<void> {
  noteOccurredAtReport(await occurredAtReport(tx, userId, outcome));
}

/** A retried command whose first run already landed: its sentence comes from the evidence the first run stored. */
export async function replayOccurredAtReport(sql: Sql, userId: string, commandId: string): Promise<void> {
  const rows = await sql<
    { evidence: { occurredAt?: Record<string, unknown> } | null }[]
  >`SELECT evidence FROM write_rows WHERE write_id=${commandId} AND user_id=${userId} AND evidence->'occurredAt' IS NOT NULL LIMIT 1`;
  const stored = rows[0]?.evidence?.occurredAt as
    { claimedAt: string; applied: boolean; appliedAt: string; reason?: string } | undefined;
  if (!stored) return;
  const at = new Date(stored.appliedAt);
  const local = await formatter(sql, userId, at);
  noteOccurredAtReport({
    ...stored,
    message: stored.applied
      ? `Recorded at ${local(at)}, the time you did it.`
      : `Recorded at ${local(at)}, when the server received it, because ${stored.reason}. The time you gave is kept on the record.`
  });
}

/** The reply for an answer whose check-in had closed before it arrived: nothing was answered, the words were kept. */
export async function closedCheckInReport(
  tx: Sql,
  userId: string,
  claimed: Date,
  receipt: Date,
  savedWords: boolean
): Promise<OccurredAtReport> {
  const local = await formatter(tx, userId, receipt);
  return {
    claimedAt: claimed.toISOString(),
    applied: false,
    appliedAt: receipt.toISOString(),
    delivered: false,
    reason: "the check-in closed",
    message: savedWords
      ? `Not delivered: the check-in closed before this answer reached the server (${local(receipt)}). Your words were saved as a capture marked with the time of the check-in, and the day's record was not changed.`
      : `Not delivered: the check-in closed before this answer reached the server (${local(receipt)}), and there were no words to keep, so nothing was saved and the day's record was not changed.`
  };
}
