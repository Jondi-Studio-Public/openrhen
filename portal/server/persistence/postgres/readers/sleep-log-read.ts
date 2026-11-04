import type { StoredSleepPlan } from "@/state/portal-state";
import { mapSleepPlanRow, type SleepPlanRow } from "./sleep-plan-row";
import type { Sql } from "../sql-pool";

/**
 * The sleep log's own read path, deliberately separate from the narrow window `readPortalState`
 * uses (routine-read.ts: one day back, or 14 for a manual entry). That query is a hot path — hit on
 * every client poll and every command, and it feeds the engine — so it must not be widened just to
 * let a history view reach back further. This query answers that need on its own, windowed however
 * far the caller asks and nowhere else.
 *
 * It is a log, so it carries nights that happened or are happening, plus at most tonight's plan: the
 * engine keeps a week of planned nights ahead, and listing those as history read as a week already
 * slept. A cancelled plan was replaced by another and is not a night at all.
 */
export async function readSleepLog(
  sql: Sql,
  userId: string,
  options: { sinceDays: number }
): Promise<StoredSleepPlan[]> {
  // The app clock, not the database's, so a pinned test clock reads the same window.
  const now = new Date();
  const rows = await sql<SleepPlanRow[]>`
    SELECT id,version,planned_start_at,planned_wake_at,desired_minutes,allowed_minutes,sleep_deficit_minutes,
      anchor_deviation_minutes,hard_errors,explanation,status,actual_start_at,actual_wake_at,input_version,
      score_components,stay_up_answer_minutes,placement_choice
    FROM sleep_plans
    WHERE user_id=${userId} AND planned_wake_at > ${now}::timestamptz - make_interval(days => ${options.sinceDays})
      AND status <> 'cancelled'
      AND (status <> 'planned' OR planned_start_at <= ${now}::timestamptz + interval '24 hours')
    ORDER BY planned_start_at DESC
  `;
  return rows.map(mapSleepPlanRow);
}
