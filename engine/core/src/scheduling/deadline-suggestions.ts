import type { ForecastIntervention } from "../model/types.js";
import { localDateFormat } from "../model/zoned-formats.js";
import { formatDate, formatMinutes, formatTime } from "../recommendation/format.js";

/**
 * "What could keep you on plan": one plain sentence per flagged project, composed only from what the
 * forecast already measured (its interventions and latest safe start). It adds no scheduling maths,
 * never reorders Now and never swaps an item for another. It only ever suggests; the person decides.
 *
 * Ranking, smallest first, and the first that applies wins:
 * 1. Start by the latest safe start (with the missing minutes, when the forecast measured them). This
 *    spends the person's time, so it is offered only while that start is still ahead, that is, while
 *    there is slack left to act in. Once it has passed, or none is known, no time-spending line is written.
 * 2. Let indivisible work split (`split_work`), which spends nothing.
 * 3. Narrow an uncertain estimate (`clarify_estimate`).
 * 4. Ask for an extension (external date) or move the date (self-set), with the earliest date that fits.
 * 5. Nothing measured: say the date has passed or the work does not fit, and what the person can decide.
 */
export interface DeadlineSuggestionInput {
  verdict: "ok" | "tight" | "behind" | "overdue";
  /** Whose date it is: an external date is asked about, a self-set one is moved. */
  deadlineSource?: "external" | "internal" | "none" | undefined;
  deadlineAt: Date | null;
  slackMinutes: number | null;
  /** Earliest of the forecast's latest safe starts. */
  latestSafeStart: Date | null;
  /** Overdue only: when the remaining work would fit; null means nowhere inside the horizon. */
  earliestFeasibleAt?: Date | null | undefined;
  /** Present on a live forecast whose work does not fully fit. */
  interventions?: readonly ForecastIntervention[] | undefined;
  now: Date;
  timezone?: string | undefined;
  locale?: string | undefined;
}

export function suggestDeadlineAction(input: DeadlineSuggestionInput): string | null {
  if (input.verdict === "ok") return null;
  const { now, timezone, locale } = input;
  const interventions = input.interventions ?? [];
  const find = (kind: ForecastIntervention["kind"]) => interventions.find((item) => item.kind === kind);
  const when = (value: Date) => {
    const sameDay = timezone
      ? localDateFormat(timezone).format(value) === localDateFormat(timezone).format(now)
      : value.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
    return sameDay ? formatTime(value, timezone, locale) : formatDate(value, timezone, locale);
  };

  // 1. Time-spending, only while the latest safe start is still ahead.
  const start = input.latestSafeStart;
  if (input.verdict !== "overdue" && start && start.getTime() > now.getTime()) {
    const addTime = find("add_time");
    if (input.slackMinutes !== null && input.slackMinutes < 0) {
      // The expected work does not fit, so starting on time alone does not rescue it: say what is short.
      const short = formatMinutes(addTime ? addTime.minutes : -input.slackMinutes);
      const other = input.deadlineSource === "external" ? "ask for an extension" : "move your own date";
      return `Start by ${when(start)} at the latest, and free up about ${short} more (or ${other}, or reduce the scope) because the plan is short by that much.`;
    }
    const extra = addTime
      ? `; the project also needs ${formatMinutes(addTime.minutes)} more set aside before the deadline, so free up that time now or pause other work`
      : "";
    return `Start by ${when(start)} or this deadline becomes unreachable${extra}.`;
  }

  const lead = input.verdict === "overdue" ? "This deadline has passed. " : "";
  // 2. Splitting spends no time.
  const split = find("split_work");
  if (split) {
    const how =
      split.shape === "minimum_session"
        ? "shorten the minimum session of the work that cannot be placed"
        : "allow the work that cannot be placed whole to be split across sessions";
    return `${lead}There is enough time but not in the right shape: ${how}, then the plan can fit ${formatMinutes(split.minutes)} of it.`;
  }
  // 3. Narrowing an estimate spends no time either.
  const clarify = find("clarify_estimate");
  if (clarify) {
    return `${lead}The expected work fits but its risk buffer does not: narrow the estimate by breaking the work down or answering what makes it uncertain, which would free about ${formatMinutes(clarify.minutes)}.`;
  }
  // 4. Renegotiate the date.
  const external = input.deadlineSource === "external";
  const renegotiate = find("request_extension") ?? find("move_deadline");
  const feasible =
    input.verdict === "overdue" ? (input.earliestFeasibleAt ?? null) : (renegotiate?.proposedDeadlineAt ?? null);
  const known = input.verdict === "overdue" || renegotiate !== undefined;
  if (known) {
    if (feasible) {
      return external || renegotiate?.kind === "request_extension"
        ? `${lead}Ask for an extension to ${when(feasible)}, the earliest the remaining work fits without displacing anything, or hand part of it to someone else.`
        : `${lead}Move your own date to ${when(feasible)}, the earliest the remaining work fits without displacing anything.`;
    }
    return `${lead}The remaining work does not fit anywhere inside the forecast horizon: reduce the scope${external ? ", hand part of it to someone else" : ""}, or ${external ? "ask for an extension past it" : "move your own date past it"}.`;
  }
  // 5. Nothing measured.
  return `${lead}No smaller fix was measured for this deadline: decide whether to reduce the scope or ${external ? "ask for more time" : "move your own date"}.`;
}
