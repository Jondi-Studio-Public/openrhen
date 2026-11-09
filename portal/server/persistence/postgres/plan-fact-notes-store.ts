import type { Sql } from "./sql-pool";

/** The plan holds a mail fact in this action: an open action hides the fact, a closed one does not. */
export interface PlanFactHold {
  /** Some action with the id in its note is still open (not done, cancelled or archived). */
  open: boolean;
  /** The latest `updated_at` among the open actions holding it; null when none is open. */
  openUpdatedAt: Date | null;
}

/**
 * The mail facts the plan holds: every `fact_id:<40 hex>` written in the notes of an action, the id read as a whole
 * token (a longer hex string that merely starts with it is not the fact). Mark records a plan item made from a derived
 * fact by putting that text in its note, so the attention feed hides a fact only while such an action is open (not
 * done, cancelled or archived), and relists it when a later mail came after the action was last touched. A commitment
 * has no note field, so a fact saved only as a commitment is not matched (stated limit). Read only.
 */
export async function readPlanFactHolds(sql: Sql, userId: string): Promise<Map<string, PlanFactHold>> {
  const rows = await sql<{ id: string; open: boolean; updated: Date | null }[]>`
    SELECT m[1] AS id,
           bool_or(x.status NOT IN ('done', 'cancelled', 'archived')) AS open,
           max(x.updated_at) FILTER (WHERE x.status NOT IN ('done', 'cancelled', 'archived')) AS updated
    FROM actions x
    JOIN projects p ON p.id = x.project_id
    JOIN outcomes o ON o.id = p.outcome_id
    JOIN areas a ON a.id = o.area_id
    CROSS JOIN LATERAL regexp_matches(x.notes, '(?<![0-9a-f])fact_id:([0-9a-f]{40})(?![0-9a-f])', 'g') AS m
    WHERE a.user_id = ${userId} AND x.notes LIKE '%fact_id:%'
    GROUP BY m[1]`;
  return new Map(rows.map((row) => [row.id, { open: row.open, openUpdatedAt: row.updated }]));
}
