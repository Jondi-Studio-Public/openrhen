import { historyWindowStart } from "@/shared/history-window";
import { localDayKey } from "@/features/today/today-view";
import type { StoredRecurrenceRule } from "@/state/portal-state";

/**
 * How many occurrences a recurring rule was expected to produce, for the "Recurring series ready"
 * adherence count on `/review`.
 *
 * Bounded to the same history window `/api/state` reads occurrences from (`historyWindowStart` in
 * `portal/shared/history-window.ts`), and never past `now`: the state document this counts against
 * only ever carries occurrence evidence inside that window, so counting the rule's whole
 * start…end span manufactures a permanent, growing backlog of "without materialized evidence" for
 * any series older than the window — the count should describe what the window could have shown
 * evidence for, not the rule's entire history.
 */
export function expectedOccurrences(rule: StoredRecurrenceRule, now: Date, timezone: string): number {
  if (!rule.endDate) return 0;
  const windowStartDay = localDayKey(historyWindowStart(now, timezone), timezone);
  const todayDay = localDayKey(now, timezone);
  const effectiveStart = rule.startDate > windowStartDay ? rule.startDate : windowStartDay;
  const effectiveEnd = rule.endDate < todayDay ? rule.endDate : todayDay;
  if (effectiveEnd < effectiveStart) return 0;
  const start = new Date(`${effectiveStart}T00:00:00Z`);
  const end = new Date(`${effectiveEnd}T00:00:00Z`);
  const days = Math.max(0, Math.floor((end.getTime() - start.getTime()) / 86_400_000));
  return (Math.floor(days / Math.max(1, rule.intervalDays)) + 1) * rule.windows.length;
}
