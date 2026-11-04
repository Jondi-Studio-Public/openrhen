/** Closing the recurring-action occurrence a commitment routine step stands in for. */
import { localDayIn } from "./cadence-completion";
import type { Sql } from "./sql-pool";
import type { WriteSnapshot } from "./write-snapshot";

/**
 * Marks the occurrence a finished routine step was standing in for as done.
 *
 * The step names a window rather than an occurrence, so the day it was scheduled for picks which
 * occurrence it satisfied — the same rule the planner uses to hide that window from the day in the
 * first place. `routine_covered` goes back to false with it: the work is recorded now, so the
 * occurrence should read as done rather than stay folded into preparation that has already ended.
 *
 * Silent when the step names no window, or was never placed: there is then nothing it stood in for.
 */
export async function completeStepActionOccurrence(
  sql: Sql,
  userId: string,
  stepId: string,
  at: Date,
  snap?: WriteSnapshot | null
) {
  const rows = await sql<
    { action_window_id: string | null; scheduled_start_at: Date | null; timezone: string }[]
  >`SELECT s.action_window_id,s.scheduled_start_at,u.timezone FROM routine_steps s JOIN users u ON u.id=s.user_id WHERE s.id=${stepId} AND s.user_id=${userId}`;
  const step = rows[0];
  if (!step?.action_window_id || !step.scheduled_start_at) return;
  const localDate = localDayIn(step.timezone, step.scheduled_start_at);
  // The exact occurrence this closes, kept as it is now (an agent's write is undone from these images).
  await snap?.watch("action_occurrences", "t.window_id = $1 AND t.local_date = $2::date AND t.status = 'pending'", [
    step.action_window_id,
    localDate
  ]);
  await sql`UPDATE action_occurrences SET status='completed',completed_at=${at},routine_covered=false,version=version+1,updated_at=${at} WHERE window_id=${step.action_window_id} AND local_date=${localDate} AND status='pending'`;
}
