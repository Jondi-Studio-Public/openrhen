import { sleepPlans } from "@openrhen/database";
import type { StoredSleepPlan } from "@/state/portal-state";
import type { Row } from "../db-row";

/** The columns read from one `sleep_plans` row, shared by every query that selects the full set. */
export type SleepPlanRow = Row<
  typeof sleepPlans,
  | "id"
  | "version"
  | "planned_start_at"
  | "planned_wake_at"
  | "desired_minutes"
  | "allowed_minutes"
  | "sleep_deficit_minutes"
  | "anchor_deviation_minutes"
  | "hard_errors"
  | "explanation"
  | "status"
  | "actual_start_at"
  | "actual_wake_at"
  | "input_version"
  | "score_components"
  | "stay_up_answer_minutes"
  | "placement_choice"
> & { status: StoredSleepPlan["status"] };

/**
 * Maps one `sleep_plans` row to its client-facing shape. Shared by the hot `readPortalState` path
 * (routine-read.ts, windowed narrowly since it is hit on every poll and every command) and the
 * separate sleep-log history read (sleep-log-read.ts, windowed independently and much further back),
 * so the two stay byte-for-byte consistent without either widening the other's query.
 */
export function mapSleepPlanRow(row: SleepPlanRow): StoredSleepPlan {
  const evidence =
    row.score_components && typeof row.score_components === "object"
      ? (row.score_components as Record<string, unknown>)
      : {};
  const wake =
    evidence.wakeConstraint && typeof evidence.wakeConstraint === "object"
      ? (evidence.wakeConstraint as Record<string, unknown>)
      : undefined;
  return {
    id: row.id,
    version: row.version,
    plannedStartAt: row.planned_start_at.toISOString(),
    plannedWakeAt: row.planned_wake_at.toISOString(),
    desiredMinutes: row.desired_minutes,
    allowedMinutes: row.allowed_minutes,
    sleepDeficitMinutes: row.sleep_deficit_minutes,
    anchorDeviationMinutes: row.anchor_deviation_minutes,
    hardErrors: Array.isArray(row.hard_errors)
      ? row.hard_errors.filter((value): value is string => typeof value === "string")
      : [],
    explanation: row.explanation,
    status: row.status,
    ...(row.input_version === "override" ? { overridden: true } : {}),
    ...(row.input_version === "manual" ? { manual: true } : {}),
    ...(typeof evidence.targetMinutes === "number" ? { targetMinutes: evidence.targetMinutes } : {}),
    ...(typeof evidence.minimumShortfallMinutes === "number"
      ? { minimumShortfallMinutes: evidence.minimumShortfallMinutes }
      : {}),
    ...(evidence.replannedFromMissedStart === true ? { replannedFromMissedStart: true } : {}),
    ...(wake && typeof wake.commitmentId === "string" && typeof wake.protectedStartAt === "string"
      ? {
          wakeConstraint: {
            commitmentId: wake.commitmentId,
            ...(typeof wake.title === "string" ? { title: wake.title } : {}),
            protectedStartAt: wake.protectedStartAt
          }
        }
      : {}),
    ...(row.actual_start_at ? { actualStartAt: row.actual_start_at.toISOString() } : {}),
    ...(row.actual_wake_at ? { actualWakeAt: row.actual_wake_at.toISOString() } : {}),
    // The DB check on `stay_up_answer_minutes` already restricts it to 0/30/60/90 (the offer's own
    // literal choice set, the sleep placement design note "The stay-up offer"); narrowed here too so
    // the column's `number | null` doesn't widen `StoredSleepPlan`'s own literal-union field.
    ...(row.stay_up_answer_minutes === 0 ||
    row.stay_up_answer_minutes === 30 ||
    row.stay_up_answer_minutes === 60 ||
    row.stay_up_answer_minutes === 90
      ? { stayUpAnswerMinutes: row.stay_up_answer_minutes }
      : {}),
    ...(row.placement_choice === "early" || row.placement_choice === "near"
      ? { placementChoice: row.placement_choice }
      : {}),
    // Recomputed live by `planSleep` every run, never stored of its own accord — echoed here from the
    // same evidence blob `wakeConstraint`/`targetMinutes` already ride on, so a night newly close to
    // its deviation shows the warning on the very read that produced it, not one recompute later.
    ...(evidence.deviationOptions && typeof evidence.deviationOptions === "object"
      ? { deviationOptions: evidence.deviationOptions as StoredSleepPlan["deviationOptions"] }
      : {})
  };
}
