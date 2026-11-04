import { dailyPlans } from "@openrhen/database";
import type { DailyPlan } from "@/state/portal-state";
import type { Row } from "../db-row";
import { localDateString } from "../row-values";
import type { Sql } from "../sql-pool";

export async function readDailyPlan(sql: Sql, userId: string, readAt: Date): Promise<DailyPlan | undefined> {
  const dailyPlanRows = await sql<
    (Row<typeof dailyPlans, "id" | "local_date" | "horizon_override_at" | "recovery_skipped" | "version"> & {
      desired_action_ids: unknown;
      deferred_items: unknown;
      carried_override_at: Date | null;
      skipped_dates: unknown;
    })[]
  >`
      SELECT id, local_date, horizon_override_at, recovery_skipped, version,
        (SELECT COALESCE(json_agg(d.action_id ORDER BY d.position), '[]'::json)
          FROM daily_plan_desired_actions d WHERE d.daily_plan_id = daily_plans.id) AS desired_action_ids,
        (SELECT COALESCE(json_agg(json_build_object('actionId', f.action_id, 'reason', f.reason) ORDER BY f.position), '[]'::json)
          FROM daily_plan_deferred_actions f WHERE f.daily_plan_id = daily_plans.id) AS deferred_items,
        (SELECT o.horizon_override_at FROM daily_plans o WHERE o.user_id=${userId} AND o.horizon_override_at > ${readAt}
          ORDER BY o.local_date DESC LIMIT 1) AS carried_override_at,
        (SELECT COALESCE(json_agg(to_char(s.local_date, 'YYYY-MM-DD')), '[]'::json)
          FROM daily_plans s WHERE s.user_id=${userId} AND s.recovery_skipped
            AND s.local_date >= (SELECT MAX(m.local_date) FROM daily_plans m WHERE m.user_id=${userId}) - 1) AS skipped_dates
      FROM daily_plans WHERE user_id=${userId} ORDER BY local_date DESC LIMIT 1
    `;
  if (!dailyPlanRows[0]) return undefined;
  return {
    id: dailyPlanRows[0].id,
    version: dailyPlanRows[0].version,
    // The driver hands a `date` column back as a Date; the contract wants the calendar day.
    localDate: localDateString(dailyPlanRows[0].local_date),
    desiredActionIds: Array.isArray(dailyPlanRows[0].desired_action_ids)
      ? dailyPlanRows[0].desired_action_ids.filter((value): value is string => typeof value === "string")
      : [],
    deferredItems: Array.isArray(dailyPlanRows[0].deferred_items)
      ? dailyPlanRows[0].deferred_items.filter((value): value is { actionId: string; reason: string } =>
          Boolean(value && typeof value === "object" && "actionId" in value && "reason" in value)
        )
      : [],
    recoverySkipped: dailyPlanRows[0].recovery_skipped === true,
    recoverySkippedDates: Array.isArray(dailyPlanRows[0].skipped_dates)
      ? dailyPlanRows[0].skipped_dates.filter((value): value is string => typeof value === "string")
      : [],
    // Handed through as stored; which day an override belongs to is the engine's rule
    // (`dailyHorizonEnd`). The newest row's own override wins; when it has none, the newest
    // override still in the future is carried, because it is an absolute instant: yesterday's
    // extension to 02:00 must survive today's row (desired wins saved at 00:10) until it
    // passes, and once it has passed it is never carried into the next day.
    ...((dailyPlanRows[0].horizon_override_at ?? dailyPlanRows[0].carried_override_at)
      ? {
          horizonOverrideAt: (dailyPlanRows[0].horizon_override_at ??
            dailyPlanRows[0].carried_override_at)!.toISOString()
        }
      : {})
  };
}
