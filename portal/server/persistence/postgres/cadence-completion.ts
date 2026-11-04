import type { Sql } from "./sql-pool";
import type { WriteSnapshot } from "./write-snapshot";

/** The local calendar day of an instant in the rule's own timezone, as `YYYY-MM-DD`. */
export function localDayIn(timezone: string, at: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(at);
}

interface RecurrenceRuleRow {
  id: string;
  timezone: string;
  completion_mode: string;
  target_total_minutes: number | null;
  accumulated_minutes: number;
  completed_at: Date | null;
}

/** Locks and returns the action's recurrence rule, if it has one. */
export async function lockRecurrenceRule(tx: Sql, actionId: string): Promise<RecurrenceRuleRow | undefined> {
  const rule = await tx<
    RecurrenceRuleRow[]
  >`SELECT id,timezone,completion_mode,target_total_minutes,accumulated_minutes,completed_at FROM action_recurrence_rules WHERE action_id=${actionId} FOR UPDATE`;
  return rule[0];
}

/**
 * Credits focused minutes to a total-time recurrence goal and closes the series when the target is
 * reached. Shared by a windowed occurrence and a cadence cycle, since both are one session
 * of the same kind of open-ended work. Returns whether the goal was reached by this credit.
 */
export async function accumulateRecurrenceMinutes(
  tx: Sql,
  actionId: string,
  rule: RecurrenceRuleRow | undefined,
  activeMinutes: number,
  at: Date,
  snap?: WriteSnapshot | null
): Promise<boolean> {
  if (!rule || rule.completion_mode !== "total_minutes" || rule.completed_at || activeMinutes <= 0) return false;
  const total = rule.accumulated_minutes + activeMinutes;
  const reached = rule.target_total_minutes !== null && total >= rule.target_total_minutes;
  await snap?.before("action_recurrence_rules", [rule.id]);
  await tx`UPDATE action_recurrence_rules SET accumulated_minutes=${total},completed_at=${reached ? at : null},version=version+1,updated_at=${at} WHERE id=${rule.id}`;
  if (reached) {
    await snap?.before("actions", [actionId]);
    await tx`UPDATE actions SET status='done',completed_at=${at},version=version+1,updated_at=${at} WHERE id=${actionId}`;
    // Set-based, so the snapshot takes the pending occurrences' ids first.
    const pending = await tx<
      { id: string }[]
    >`SELECT id FROM action_occurrences WHERE rule_id=${rule.id} AND status='pending'`;
    await snap?.before(
      "action_occurrences",
      pending.map((row) => row.id)
    );
    await tx`UPDATE action_occurrences SET status='cancelled',version=version+1,updated_at=${at} WHERE rule_id=${rule.id} AND status='pending'`;
  }
  return reached;
}

/**
 * Marks one cycle of a cadence action done. The completion is dated by the rule's local
 * day — done at most once a day, so a second record that day changes nothing — and the action is
 * reset for its next cycle rather than closed: remaining effort back to the estimate, status active.
 * A total-time goal still accrues the minutes and may close the series.
 *
 * A same-day repeat is detected before any write: the caller already locked the rule row (see
 * `lockRecurrenceRule`), so this check and the insert below are serialized against any concurrent
 * call for the same rule, and a duplicate genuinely touches nothing — no version bump on `actions`,
 * no effort reset — so it can never look like "changed on another device" or lose real progress.
 */
export async function recordCadenceCycle(
  tx: Sql,
  input: {
    actionId: string;
    rule: RecurrenceRuleRow;
    at: Date;
    minutes: number;
    sessionId: string | null;
    source: "session" | "manual";
    localDate?: string;
    /** The agent's write snapshot, when an agent is making this write (see `write-snapshot.ts`). */
    snap?: WriteSnapshot | null;
  }
): Promise<{ recorded: boolean; goalReached: boolean }> {
  const localDate = input.localDate ?? localDayIn(input.rule.timezone, input.at);
  const existing = await tx<
    { id: string }[]
  >`SELECT id FROM action_cadence_completions WHERE rule_id=${input.rule.id} AND local_date=${localDate}`;
  if (existing[0]) return { recorded: false, goalReached: false };
  const completion = await tx<
    { id: string }[]
  >`INSERT INTO action_cadence_completions (action_id,rule_id,completed_at,local_date,minutes,session_id,source) VALUES (${input.actionId},${input.rule.id},${input.at},${localDate},${Math.max(0, input.minutes)},${input.sessionId},${input.source}) RETURNING id`;
  input.snap?.inserted(
    "action_cadence_completions",
    completion.map((row) => row.id)
  );
  await input.snap?.before("actions", [input.actionId]);
  await tx`UPDATE actions SET remaining_minutes=expected_minutes,remaining_set_at=${input.at},status=CASE WHEN status IN ('done','cancelled','archived') THEN status ELSE 'active' END,estimate_needs_review=false,last_worked_at=${input.at},version=version+1,updated_at=${input.at} WHERE id=${input.actionId}`;
  const goalReached = await accumulateRecurrenceMinutes(
    tx,
    input.actionId,
    input.rule,
    input.minutes,
    input.at,
    input.snap
  );
  return { recorded: true, goalReached };
}
