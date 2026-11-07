import { createHash } from "node:crypto";
import type postgres from "postgres";

/**
 * The Now offer log's only writers (table `offer_log`, schema/core.ts). It lives outside `planning/` on purpose:
 * `watch-history/engine-blind.test.ts` forbids anything in `planning/`, the portal readers and the engine from naming
 * the table, so planning code calls these functions and never reads the log itself. Nothing here feeds back into a
 * plan.
 *
 * Every function runs inside the caller's transaction and has no try/catch: a failed insert rolls that transaction
 * back, by design (a plan or a command that cannot be logged does not happen, so the log never misses a row).
 */
type Sql = postgres.Sql | postgres.TransactionSql;

/** The events the table's CHECK allows. `shown` is written by PR 2's beacon; PR 1 writes the rest. */
export const OFFER_LOG_EVENTS = [
  "offered",
  "shown",
  "started",
  "skipped",
  "did_not_start",
  "blocked",
  "snoozed",
  "checked_in"
] as const;
export type OfferLogEvent = (typeof OFFER_LOG_EVENTS)[number];

/** How many candidates an `offered` row keeps; the full set stays in the 7-day planning tables. */
export const OFFER_LOG_TOP_CANDIDATES = 5;

/** One candidate as an `offered` row keeps it. */
export interface OfferedCandidate {
  targetType: string;
  targetId: string;
  executionOptionId: string | null;
  rank: number;
  score: number;
  eligible: boolean;
  minutes: number | null;
}

export interface OfferedInput {
  recommendationId: string;
  validUntil: Date;
  /** The primary the engine chose; null when it chose nothing. */
  primary: { targetType: string; targetId: string; executionOptionId: string | null; label: string | null } | null;
  /** The engine's candidates in rank order; only the first five are kept. */
  candidates: readonly OfferedCandidate[];
  actor: string | null;
}

/**
 * The part of an offer that decides whether it is a new offer: the primary and the top five, in order, with their
 * eligibility and minutes. Scores are left out because they drift on every recalculation.
 */
export function offerHash(primary: OfferedInput["primary"], candidates: readonly OfferedCandidate[]): string {
  const parts = {
    primary: primary ? [primary.targetType, primary.targetId, primary.executionOptionId] : null,
    top: candidates
      .slice(0, OFFER_LOG_TOP_CANDIDATES)
      .map((c) => [c.targetType, c.targetId, c.executionOptionId, c.eligible])
  };
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}

/** The user's timezone, read in the insert so every row carries the local zone it was written under. */
async function timezoneOf(sql: Sql, userId: string): Promise<string | null> {
  const rows = await sql<{ timezone: string }[]>`SELECT timezone FROM users WHERE id=${userId}`;
  return rows[0]?.timezone ?? null;
}

/**
 * Writes an `offered` row unless the user's latest one has the same hash (same primary, same top five). A replan every
 * few minutes that changes nothing a person would notice therefore writes nothing. A later `offered` row implicitly
 * closes the previous one. Returns whether a row was written.
 */
export async function recordOffered(sql: Sql, userId: string, input: OfferedInput): Promise<boolean> {
  const hash = offerHash(input.primary, input.candidates);
  const latest = await sql<{ hash: string | null }[]>`
    SELECT detail->>'hash' AS hash FROM offer_log
    WHERE user_id=${userId} AND event='offered'
    ORDER BY occurred_at DESC, id DESC LIMIT 1`;
  if (latest[0]?.hash === hash) return false;
  const top = input.candidates.slice(0, OFFER_LOG_TOP_CANDIDATES);
  const timezone = await timezoneOf(sql, userId);
  await sql`
    INSERT INTO offer_log (user_id, occurred_at, event, recommendation_id, surface, resolution_kind, target_type, target_id, execution_option_id, label, candidates, valid_until, actor, detail)
    VALUES (${userId}, clock_timestamp(), 'offered', ${input.recommendationId}, 'server', ${input.primary ? "recommended" : null}, ${input.primary?.targetType ?? "none"}, ${input.primary?.targetId ?? null}, ${input.primary?.executionOptionId ?? null}, ${input.primary?.label ?? null}, ${sql.json(top as never)}, ${input.validUntil}, ${input.actor}, ${sql.json({ hash, timezone } as never)})`;
  return true;
}

/** The events that are outcomes of an offer: they carry the target's rank in what was on offer. */
type RankedEvent = "started" | "skipped" | "did_not_start" | "blocked" | "snoozed";

export interface OutcomeInput {
  event: RankedEvent | "checked_in";
  /** The command this outcome belongs to; with `event` and `targetId` it is the row's idempotency key. */
  commandId: string;
  targetType: string;
  targetId: string;
  executionOptionId?: string | null;
  /** The recommendation the caller named, when it named one; else the latest `offered` row's. */
  recommendationId?: string | null;
  resolutionKind?: string | null;
  /** The target's title now, kept so a deleted target still reads. */
  label?: string | null;
  actor: string | null;
  detail?: Record<string, unknown>;
}

/**
 * Appends one outcome row. For everything but `checked_in` the rank is the target's rank in the user's latest `offered`
 * row, read before the command changes anything: `rank_basis` is `offered_row` when there was one, `none` when there was
 * not, and a target outside that row's top five gets a null rank and `detail.off_plan = true`.
 *
 * Idempotent on (command_id, event, target_id): replaying a command, or a catch-up that reuses one command id for
 * several sessions, inserts nothing new for a key it already has, and an unrelated conflict still fails the
 * transaction (the conflict target is named, never a bare DO NOTHING).
 */
export async function recordOutcome(sql: Sql, userId: string, input: OutcomeInput): Promise<void> {
  let rank: number | null = null;
  let rankBasis: "offered_row" | "none" | null = null;
  let recommendationId = input.recommendationId ?? null;
  const detail: Record<string, unknown> = { ...input.detail };
  if (input.event !== "checked_in") {
    const latest = await sql<{ id: string; recommendation_id: string | null; candidates: unknown }[]>`
      SELECT id, recommendation_id, candidates FROM offer_log
      WHERE user_id=${userId} AND event='offered'
      ORDER BY occurred_at DESC, id DESC LIMIT 1`;
    if (!latest[0]) {
      rankBasis = "none";
    } else {
      rankBasis = "offered_row";
      detail.offered_row_id = latest[0].id;
      recommendationId ??= latest[0].recommendation_id;
      const candidates = Array.isArray(latest[0].candidates) ? (latest[0].candidates as OfferedCandidate[]) : [];
      const match = candidates.find((c) => c.targetType === input.targetType && c.targetId === input.targetId);
      if (match) rank = match.rank;
      else detail.off_plan = true;
    }
  }
  detail.timezone = await timezoneOf(sql, userId);
  await sql`
    INSERT INTO offer_log (user_id, occurred_at, event, recommendation_id, surface, resolution_kind, target_type, target_id, execution_option_id, label, rank, rank_basis, actor, command_id, detail)
    VALUES (${userId}, clock_timestamp(), ${input.event}, ${recommendationId}, 'server', ${input.resolutionKind ?? null}, ${input.targetType}, ${input.targetId}, ${input.executionOptionId ?? null}, ${input.label ?? null}, ${rank}, ${rankBasis}, ${input.actor}, ${input.commandId}, ${sql.json(detail as never)})
    ON CONFLICT (command_id, event, target_id) WHERE command_id IS NOT NULL DO NOTHING`;
}
