import { attentionDoctorItems } from "@openrhen/contracts";
import type { PoolSql } from "@/server/persistence/postgres/sql-pool";
import { canReadProposals, defaultAttentionReaders, logSourceFailure, type AttentionReaders } from "./readers";
import type { AttentionRequest } from "./read-attention";

/**
 * The counts the status block needs (`GET /api/attention?counts=1`, the design notes):
 * how many blocking data-health items there are, how many sources failed, and how many of this agent's proposals the
 * owner decided since its previous session. It reads nothing else: no check-in, no catch-up entries, no pulse view,
 * and it runs no `expireOld`.
 */
export interface AttentionStatusCounts {
  viewer: "agent" | "owner";
  healthBlocking: number;
  sourcesFailed: number;
  decided: number;
}

/** How long the doctor half of the counts is reused. */
export const ATTENTION_COUNTS_MEMO_MS = 30_000;

/**
 * The doctor half, in memory, keyed by user id. It holds only a fulfilled doctor read: a failure is never kept, so
 * the next call retries it. It is the same for every caller of the one user (blocking items do not depend on who
 * asks), so `decided` and `viewer`, which do, are never kept here.
 */
const doctorHalf = new Map<string, { at: number; healthBlocking: number }>();

export function resetAttentionCountsMemo(): void {
  doctorHalf.clear();
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

  const [doctor, decided] = await Promise.allSettled([healthBlockingP, decidedP]);
  let sourcesFailed = 0;
  if (doctor.status === "rejected") {
    sourcesFailed += 1;
    logSourceFailure("doctor", doctor.reason);
  }
  if (decided.status === "rejected") {
    sourcesFailed += 1;
    logSourceFailure("proposals", decided.reason);
  }
  return {
    viewer: agent === null ? "owner" : "agent",
    healthBlocking: doctor.status === "fulfilled" ? doctor.value : 0,
    sourcesFailed,
    decided: decided.status === "fulfilled" ? decided.value : 0
  };
}
