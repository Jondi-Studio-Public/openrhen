import {
  DEADLINE_RISK_VERDICTS,
  deadlineAtRiskItem,
  type AttentionItem,
  type DeadlineRiskVerdict
} from "@openrhen/contracts";
import type { PoolSql } from "@/server/persistence/postgres/sql-pool";

/**
 * The plan's deadline outlook as attention items (`deadline_at_risk`). The outlook is stored on the latest plan run
 * (`result.deadlineOutlook`, written by the engine); this reads that field only and builds one item per project whose
 * verdict is `behind` or `overdue`. A project that has recovered is simply absent the next time the plan is calculated,
 * so the item goes away with no acknowledgement. A plan stored before the outlook existed has none and lists nothing.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isRiskVerdict = (value: unknown): value is DeadlineRiskVerdict =>
  (DEADLINE_RISK_VERDICTS as readonly unknown[]).includes(value);

/** The latest plan run's stored outlook, or null when there is no run or the run predates the field. */
export async function readDeadlineOutlook(sql: PoolSql, userId: string): Promise<unknown> {
  const rows = await sql<{ outlook: unknown }[]>`
    SELECT result->'deadlineOutlook' AS outlook FROM planning_runs
    WHERE user_id=${userId} AND superseded_at IS NULL ORDER BY calculated_at DESC LIMIT 1`;
  return rows[0]?.outlook ?? null;
}

export function deadlineItems(
  outlook: unknown,
  options: { held: readonly string[] | undefined; generatedAt: string }
): AttentionItem[] {
  if (!isRecord(outlook) || !Array.isArray(outlook.projects)) return [];
  const seen = new Set<string>();
  const items: AttentionItem[] = [];
  for (const row of outlook.projects as unknown[]) {
    if (!isRecord(row) || !isRiskVerdict(row.verdict) || typeof row.projectId !== "string") continue;
    if (seen.has(row.projectId)) continue;
    seen.add(row.projectId);
    const item = deadlineAtRiskItem({
      projectId: row.projectId,
      verdict: row.verdict,
      title: row.title,
      deadlineAt: row.deadlineAt,
      slackMinutes: typeof row.slackMinutes === "number" ? row.slackMinutes : null,
      suggestion: row.suggestion,
      held: options.held,
      generatedAt: options.generatedAt
    });
    if (item) items.push(item);
  }
  return items;
}
