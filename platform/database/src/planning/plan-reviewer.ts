import type postgres from "postgres";
import {
  nextDaytimeDelivery,
  composeDigest,
  explorerResultSchema,
  reviewerDedupeKey,
  reviewerDue,
  summariseBackends,
  type ExplorerBackend,
  type ExplorerRunRecord,
  type PlanMapMode,
  type ReviewerDigest,
  type ReviewerInput
} from "@openrhen/contracts";
import { readNudgeSummary } from "./plan-nudge-shadow.js";

/**
 * The weekly reviewer. Once a week, from the daily plan-map
 * sweep, it summarises the week's shadow evidence into a few lines. It has no switch: the digest is
 * written to `plan_shadow_log` (add-on `reviewer`) and queued as one push message (never for a quiet week). It
 * reads evidence and writes nothing else: no plan row, no link, no finding, and the engine never reads it.
 */

const ADDON = "reviewer";
const DAY_MS = 86_400_000;
const WEEK_DAYS = 7;
/** A digest stays deliverable this long if the phone is away, then expires like any other push. */
const PUSH_TTL_DAYS = 3;

type Sql = postgres.Sql;

export interface ReviewerRunOutcome {
  mode: PlanMapMode;
  /** A digest was composed and logged this call. */
  ran: boolean;
  /** The digest was queued as a push (only with the switch `on`, and never for a quiet week). */
  queued: boolean;
  digest: ReviewerDigest | null;
}

async function explorerRecords(sql: Sql, userId: string, since: Date): Promise<ExplorerRunRecord[]> {
  const rows = await sql<{ item_type: string; item_id: string; would_have: Record<string, unknown> }[]>`
    SELECT item_type, item_id, would_have FROM plan_shadow_log
    WHERE user_id = ${userId} AND addon = 'explorer' AND created_at >= ${since}`;
  const records: ExplorerRunRecord[] = [];
  for (const row of rows) {
    const result = explorerResultSchema.safeParse(row.would_have.result);
    const backend = row.would_have.backend;
    if (!result.success || (backend !== "haiku" && backend !== "local")) continue;
    records.push({
      backend: backend as ExplorerBackend,
      model: String(row.would_have.model ?? ""),
      taskId: row.item_id,
      result: result.data,
      score: (row.would_have.score as ExplorerRunRecord["score"]) ?? null,
      cached: row.would_have.cached === true,
      kind: row.item_type === "live" ? "live" : "task"
    });
  }
  return records;
}

/** Gathers the week's evidence as the pure digest reads it. Read-only. */
export async function readReviewerInput(sql: Sql, userId: string, now: Date): Promise<ReviewerInput> {
  const since = new Date(now.getTime() - WEEK_DAYS * DAY_MS);
  const [openByCheck, topOpen, decided, links, nudge, records] = await Promise.all([
    sql<{ check_name: string; count: number }[]>`
      SELECT check_name, count(*)::int AS count FROM plan_findings
      WHERE user_id = ${userId} AND status = 'open' GROUP BY check_name ORDER BY count(*) DESC, check_name`,
    sql<{ text: string }[]>`
      SELECT text FROM plan_findings WHERE user_id = ${userId} AND status = 'open'
      ORDER BY created_at DESC, id LIMIT 2`,
    sql<{ status: string; count: number }[]>`
      SELECT status, count(*)::int AS count FROM plan_findings
      WHERE user_id = ${userId} AND status IN ('accepted', 'dismissed') AND decided_at >= ${since} GROUP BY status`,
    sql<{ waiting: number; confirmed: number; rejected: number }[]>`
      SELECT count(*) FILTER (WHERE status = 'suggested')::int AS waiting,
        count(*) FILTER (WHERE status = 'confirmed' AND decided_at >= ${since})::int AS confirmed,
        count(*) FILTER (WHERE status = 'rejected' AND decided_at >= ${since})::int AS rejected
      FROM plan_links WHERE user_id = ${userId}`,
    readNudgeSummary(sql, userId, since),
    explorerRecords(sql, userId, since)
  ]);
  const decidedCount = (status: string): number => decided.find((row) => row.status === status)?.count ?? 0;
  return {
    findings: {
      openByCheck: openByCheck.map((row) => ({ check: row.check_name, count: row.count })),
      topOpen: topOpen.map((row) => row.text),
      acceptedThisWeek: decidedCount("accepted"),
      dismissedThisWeek: decidedCount("dismissed")
    },
    links: {
      waiting: links[0]?.waiting ?? 0,
      confirmedThisWeek: links[0]?.confirmed ?? 0,
      rejectedThisWeek: links[0]?.rejected ?? 0
    },
    nudge,
    explorer: summariseBackends(records)
  };
}

/** What the digest would say now, without logging or sending anything. */
export async function previewReviewerDigest(sql: Sql, userId: string, now: Date = new Date()): Promise<ReviewerDigest> {
  return composeDigest(await readReviewerInput(sql, userId, now));
}

/**
 * Runs the reviewer for one sweep. Does nothing while a digest was logged within
 * the last six days. The log row and the push are written in one transaction, so a failure leaves no
 * half-sent week and the next sweep simply tries again.
 */
export async function runPlanReviewer(sql: Sql, userId: string, now: Date = new Date()): Promise<ReviewerRunOutcome> {
  const mode: PlanMapMode = "on";
  const idle: ReviewerRunOutcome = { mode, ran: false, queued: false, digest: null };
  const [last] = await sql<{ at: Date | null }[]>`
    SELECT max(created_at) AS at FROM plan_shadow_log WHERE user_id = ${userId} AND addon = ${ADDON}`;
  if (!reviewerDue(last?.at ? new Date(last.at) : null, now)) return idle;

  const digest = composeDigest(await readReviewerInput(sql, userId, now));
  const dedupeKey = reviewerDedupeKey(now);
  const push = mode === "on" && !digest.quiet;
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO plan_shadow_log (user_id, run_id, addon, item_type, item_id, would_have, reason, created_at)
      VALUES (${userId}, ${crypto.randomUUID()}, ${ADDON}, 'digest', ${dedupeKey},
        ${tx.json({ title: digest.title, lines: digest.lines, quiet: digest.quiet, pushed: push } as never)},
        ${digest.quiet ? "Quiet week, nothing to report." : digest.body}, ${now})`;
    if (push) {
      // `test` is the one outbox kind whose check constraint needs no migration and whose drain path is
      // generic; the tag and key identify this as the weekly digest.
      const payload = { title: digest.title, body: digest.body, tag: dedupeKey, url: "/inbox" };
      // The sweep runs at night: hold the push for the person's wake time.
      const [day] = await tx<
        { timezone: string; preferred_wake_time: string | null; planning_horizon_end: string | null }[]
      >`SELECT u.timezone, p.preferred_wake_time, p.planning_horizon_end
        FROM users u LEFT JOIN user_preferences p ON p.user_id = u.id WHERE u.id = ${userId}`;
      const deliverAt = day
        ? nextDaytimeDelivery(now, day.timezone, day.preferred_wake_time, day.planning_horizon_end)
        : now;
      await tx`
        INSERT INTO push_outbox (user_id, dedupe_key, kind, payload, status, next_attempt_at, expires_at)
        VALUES (${userId}, ${dedupeKey}, 'test', ${tx.json(payload as never)}, 'pending', ${deliverAt},
          ${new Date(deliverAt.getTime() + PUSH_TTL_DAYS * DAY_MS)})
        ON CONFLICT (user_id, dedupe_key, channel) DO NOTHING`;
    }
  });
  return { mode, ran: true, queued: push, digest };
}
