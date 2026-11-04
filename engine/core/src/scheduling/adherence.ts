import type {
  Action,
  ActionCadence,
  ActionOccurrence,
  ActionRecurrenceRule,
  ProjectAdherenceAction
} from "../model/types.js";
import { cadencePeriodStatus } from "../recurrence/cadence.js";
import { addLocalDays, dateOrdinal, localDate } from "../recurrence/recurrence.js";

const MAINTENANCE_MODES = new Set(["recurring", "cadence"]);

/**
 * A project whose every live action is recurring or cadence has nothing to be feasible
 * about: there is no deadline to hit and no effort ledger to allocate against, only whether the
 * cadence is being kept up. `actions` is the project's own live (non-terminal) actions — exactly
 * `projectActions` as `schedule.ts`'s project pass already has it in hand. A project with no live
 * actions at all is not maintenance; it falls through to the ordinary "no remaining action estimates"
 * guard, unchanged.
 */
export function isMaintenanceProject(actions: readonly Action[]): boolean {
  return actions.length > 0 && actions.every((action) => MAINTENANCE_MODES.has(action.schedulingMode ?? "one_off"));
}

interface LogicalActionPeriod {
  actionId: string;
  done: number;
  target: number;
  expectedSoFar: number;
  periodLabel: string;
  /** Every wanted occurrence for the full period is already in, this period, with days still left. */
  metFullTarget: boolean;
  /** The period immediately before this one closed with nothing done, and history says so directly. */
  missedLastPeriod: boolean;
}

type CadencePeriodShape = { unit: "days"; length: number } | { unit: "month" };

function periodLabelFor(period: CadencePeriodShape): string {
  if (period.unit === "month") return "this month";
  if (period.length === 1) return "today";
  if (period.length === 7) return "this week";
  return `this ${period.length}-day period`;
}

/** Whole days elapsed inside `[start, end]` as of `daysLeft` (counting today), clamped to the period's own length. */
function elapsedFraction(start: string, end: string, daysLeft: number): number {
  const periodTotalDays = dateOrdinal(end) - dateOrdinal(start) + 1;
  if (periodTotalDays <= 0) return 1;
  const elapsedDays = Math.max(0, Math.min(periodTotalDays, periodTotalDays - daysLeft + 1));
  return elapsedDays / periodTotalDays;
}

/**
 * A cadence action's period status, folding a plain-interval rule into the same period math as a
 * period/target rule: `intervalDays` becomes a one-target, `intervalDays`-long period, so a legacy
 * cadence's "done if the last completion falls in the current interval" comes for free from
 * `cadencePeriodStatus`'s own completion-log read rather than a second implementation of it.
 *
 * "Missed its last period entirely" is left false here: `ActionCadence.completionLocalDates` is
 * documented as scoped to dates "within reach of the current period" (model/types.ts), so reading it
 * a period further back would read as zero completions for every maintenance project's cadence
 * actions, not a genuine miss. See the adherence report on this gap — it is not fixable from the data
 * this rule carries.
 */
function cadenceActionPeriod(actionId: string, cadence: ActionCadence, now: Date): LogicalActionPeriod {
  const period: CadencePeriodShape = cadence.period ?? { unit: "days", length: Math.max(1, cadence.intervalDays) };
  const target = cadence.period ? Math.max(1, cadence.targetOccurrences ?? 1) : 1;
  const status = cadencePeriodStatus({ ...cadence, period }, now);
  const fraction = elapsedFraction(status.start, status.end, status.daysLeft);
  const expectedSoFar = Math.max(0, Math.min(target, Math.floor(target * fraction)));
  return {
    actionId,
    done: status.done,
    target,
    expectedSoFar,
    periodLabel: periodLabelFor(period),
    metFullTarget: status.remaining <= 0,
    missedLastPeriod: false
  };
}

/**
 * A recurring action's period status: the period is one cycle of the rule's own `intervalDays`
 * (a daily rule's period is a single day), and the full-period target is one occurrence per window.
 * "Done" and "expected" both read materialised occurrences (`state.occurrences`, threaded through as
 * `ScheduleArguments.occurrences`) rather than a proportional estimate: `missed` and a `pending`
 * occurrence whose window has already closed both count as due-and-not-done; a `pending` occurrence
 * whose window is still ahead is not yet due, so it counts toward neither `done` nor `expectedSoFar`.
 *
 * "Missed its last period entirely" reads the previous cycle's occurrences directly and only fires
 * when at least one is actually on record — an unmaterialised prior cycle (series younger than one
 * period, or history the caller did not include) reports false rather than a false miss.
 */
function recurringActionPeriod(
  actionId: string,
  rule: ActionRecurrenceRule,
  occurrences: readonly ActionOccurrence[],
  now: Date
): LogicalActionPeriod {
  const intervalDays = Math.max(1, rule.intervalDays);
  const target = Math.max(1, rule.windows.length);
  const today = localDate(now, rule.timezone);
  const seriesStart = dateOrdinal(rule.startDate);
  const cycles = Math.max(0, Math.floor((dateOrdinal(today) - seriesStart) / intervalDays));
  const periodStart = addLocalDays(rule.startDate, cycles * intervalDays);
  const periodEnd = addLocalDays(periodStart, intervalDays - 1);

  const inPeriod = occurrences.filter(
    (occurrence) =>
      occurrence.actionId === actionId &&
      occurrence.status !== "cancelled" &&
      occurrence.localDate >= periodStart &&
      occurrence.localDate <= periodEnd
  );
  const done = inPeriod.filter((occurrence) => occurrence.status === "completed").length;
  const missedSoFar = inPeriod.filter(
    (occurrence) =>
      occurrence.status === "missed" || (occurrence.status === "pending" && occurrence.windowEndsAt <= now)
  ).length;
  const expectedSoFar = Math.min(target, done + missedSoFar);

  const lastPeriodEnd = addLocalDays(periodStart, -1);
  const lastPeriodStart = addLocalDays(lastPeriodEnd, -(intervalDays - 1));
  const lastPeriodOccurrences = occurrences.filter(
    (occurrence) =>
      occurrence.actionId === actionId &&
      occurrence.status !== "cancelled" &&
      occurrence.localDate >= lastPeriodStart &&
      occurrence.localDate <= lastPeriodEnd
  );

  // The previous period is, by definition, already closed — no "still forming" guard is needed the
  // way the current period's `fraction` needs one, so any records found for it are final.
  return {
    actionId,
    done,
    target,
    expectedSoFar,
    periodLabel: periodLabelFor({ unit: "days", length: intervalDays }),
    metFullTarget: done >= target,
    missedLastPeriod:
      lastPeriodOccurrences.length > 0 && lastPeriodOccurrences.every((occurrence) => occurrence.status !== "completed")
  };
}

export interface AdherenceComputation {
  ratio: number;
  health: "behind" | "at_risk" | "on_track" | "ahead";
  reason: string;
  actions: ProjectAdherenceAction[];
}

/**
 * The adherence measure behind a maintenance project's health: per action, how much of the current
 * period's target is done versus expected by now (§2 of the adherence design), rolled up into one
 * ratio and a concrete reason. `actions` should be `isMaintenanceProject`-true; `occurrences` is the
 * project's materialised occurrence records (recurring actions only — cadence reads its own rule).
 */
export function computeProjectAdherence(
  actions: readonly Action[],
  occurrences: readonly ActionOccurrence[],
  now: Date
): AdherenceComputation {
  // One entry per logical series: a recurring template fans out into one synthesized `Action` per
  // pending occurrence (see `prepare()` in engine.ts), all sharing `templateActionId`, so grouping by
  // that (falling back to the action's own id for cadence, which never fans out) counts each series
  // exactly once regardless of how many of its occurrences happen to be scheduled right now.
  const byLogicalId = new Map<string, Action>();
  for (const action of actions) {
    const logicalId = action.templateActionId ?? action.id;
    if (!byLogicalId.has(logicalId)) byLogicalId.set(logicalId, action);
  }

  const periods = [...byLogicalId.entries()]
    .map(([logicalId, action]): LogicalActionPeriod => {
      if (action.schedulingMode === "cadence" && action.cadence)
        return cadenceActionPeriod(logicalId, action.cadence, now);
      if (action.schedulingMode === "recurring" && action.recurrenceRule)
        return recurringActionPeriod(logicalId, action.recurrenceRule, occurrences, now);
      // A recurring/cadence action missing its own rule cannot be measured; report it fully met so a
      // data gap never drags the ratio down for something that was never actually observed behind.
      return {
        actionId: logicalId,
        done: 0,
        target: 0,
        expectedSoFar: 0,
        periodLabel: "this period",
        metFullTarget: true,
        missedLastPeriod: false
      };
    })
    .sort((a, b) => a.actionId.localeCompare(b.actionId));

  const totalDone = periods.reduce((sum, period) => sum + period.done, 0);
  const totalExpected = periods.reduce((sum, period) => sum + period.expectedSoFar, 0);
  const ratio = totalExpected > 0 ? totalDone / totalExpected : 1;
  const missedLastPeriod = periods.filter((period) => period.missedLastPeriod);
  const everyMetFullTarget = periods.length > 0 && periods.every((period) => period.metFullTarget);

  let health: AdherenceComputation["health"];
  if (ratio < 0.5 || missedLastPeriod.length > 0) health = "behind";
  else if (ratio < 0.8) health = "at_risk";
  else if (everyMetFullTarget) health = "ahead";
  else health = "on_track";

  const titleOf = (actionId: string) => byLogicalId.get(actionId)?.title ?? actionId;
  const sharedLabel =
    periods.length && periods.every((period) => period.periodLabel === periods[0]!.periodLabel)
      ? ` ${periods[0]!.periodLabel}`
      : "";
  const behind = periods.filter((period) => period.done < period.expectedSoFar);
  const detailPhrase = behind.length
    ? `; ${behind.map((period) => `${titleOf(period.actionId)} is ${period.expectedSoFar - period.done} behind`).join(", ")}`
    : missedLastPeriod.length
      ? `; ${missedLastPeriod.map((period) => titleOf(period.actionId)).join(", ")} missed the last period entirely`
      : "";
  const reason = `Adherence ${totalDone} of ${totalExpected} due so far${sharedLabel}${detailPhrase}.`;

  return {
    ratio,
    health,
    reason,
    actions: periods.map((period) => ({
      actionId: period.actionId,
      done: period.done,
      expectedSoFar: period.expectedSoFar,
      target: period.target,
      periodLabel: period.periodLabel
    }))
  };
}
