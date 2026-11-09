import type { Action, CapacityWindow, FixedCommitment, ProjectForecast, SleepPlan } from "../model/types.js";
import { normalizePlanningSlots, slotFitsAction } from "../scheduling/slots.js";

/** The candidate extra-time choices offered, in the order tried. */
const CHOICE_MINUTES = [30, 60, 90] as const;

export interface StayUpOfferChoice {
  minutes: number;
  bedtimeAt: Date;
  wakeAt: Date;
  sleepMinutes: number;
}
export interface StayUpOfferResult {
  nightId: string;
  projectId: string;
  projectTitle: string;
  actionId: string;
  actionTitle: string;
  minutesBehind: number;
  opensAt: Date;
  closesAt: Date;
  choices: StayUpOfferChoice[];
}

/**
 * Tonight's "stay up for it?" offer. All five
 * conditions must hold; the offer never shortens a night below the minimum or past the awake limit.
 */
export function computeStayUpOffer(args: {
  now: Date;
  night: SleepPlan | undefined;
  bedtimeRoutineMinutes: number;
  forecasts: ProjectForecast[];
  /** Project id → title, from the wire state (the engine's own `Project` model carries no title). */
  projectTitles: Map<string, string>;
  actions: Action[];
  capacityWindows: CapacityWindow[];
  commitments: FixedCommitment[];
  minimumSleepMinutes: number;
  maxAwakeHours: number;
  previousWakeAt: Date;
  arrivalMarginMinutes: number;
}): StayUpOfferResult | undefined {
  const { night } = args;
  // Condition 1: tonight's night, not overridden, not a missed start, and unanswered.
  if (!night) return undefined;
  if (night.replannedFromMissedStart) return undefined;
  if (night.stayUpAnswerMinutes !== undefined) return undefined;
  const routineStart = new Date(night.plannedStartAt.getTime() - args.bedtimeRoutineMinutes * 60_000);
  // Condition 2: now falls in [routineStart - 15min, plannedStart).
  const opensAt = new Date(routineStart.getTime() - 15 * 60_000);
  if (!(args.now >= opensAt && args.now < night.plannedStartAt)) return undefined;

  // Condition 3: some deadline-based project is behind.
  const behindForecasts = args.forecasts.filter(
    (forecast) => forecast.health === "behind" && (forecast.healthBasis ?? "feasibility") === "feasibility"
  );
  if (!behindForecasts.length) return undefined;

  // An allow-list, as the scorer uses: a deny-list let "cancelled" through.
  const isReady = (action: Action) =>
    (action.status === "planned" || action.status === "active" || action.status === "doing") &&
    action.dependenciesComplete;

  // Condition 4: that project's top work (earliest latest-safe-start, an unplaced unit counting as
  // earliest) is ready. "Top work" is taken across every behind project at once, the same as ranking
  // would: the single readiest, most-pressing action anywhere behind wins.
  type Candidate = { forecast: ProjectForecast; action: Action; latestSafeStart: number };
  let best: Candidate | undefined;
  for (const forecast of behindForecasts) {
    if (!args.projectTitles.has(forecast.projectId)) continue;
    const unplaced = new Set(forecast.unplacedUnitIds ?? []);
    for (const action of args.actions.filter((item) => item.projectId === forecast.projectId && isReady(item))) {
      // An unplaced unit counts as pressing at maximum: its latest safe start has already passed.
      const latestSafeStart = unplaced.has(action.id)
        ? -Infinity
        : (forecast.latestSafeStarts[action.id]?.getTime() ?? Infinity);
      if (!best || latestSafeStart < best.latestSafeStart) best = { forecast, action, latestSafeStart };
    }
  }
  if (!best) return undefined;
  const minutesBehind =
    best.forecast.expectedMarginMinutes !== null ? Math.max(0, -best.forecast.expectedMarginMinutes) : 0;

  // Condition 5: at least one choice N in {30,60,90} survives.
  const choices: StayUpOfferChoice[] = [];
  for (const minutes of CHOICE_MINUTES) {
    if (minutes < best.action.minimumSessionMinutes) continue;
    const newBedtime = new Date(night.plannedStartAt.getTime() + minutes * 60_000);
    // Never past the awake limit.
    if (newBedtime.getTime() - args.previousWakeAt.getTime() > args.maxAwakeHours * 60 * 60_000) continue;
    const sleepMinutes = Math.round((night.plannedWakeAt.getTime() - newBedtime.getTime()) / 60_000);
    if (sleepMinutes < args.minimumSleepMinutes) continue;
    const windowStart = routineStart;
    const windowEnd = new Date(routineStart.getTime() + minutes * 60_000);
    const slots = normalizePlanningSlots({
      from: windowStart,
      until: windowEnd,
      capacityWindows: args.capacityWindows,
      // As if tonight's sleep did not cover it: only ordinary commitments block this window, never
      // the sleep/bedtime-routine ranges the engine derives from this very night.
      commitments: args.commitments.filter(
        (commitment) => !commitment.id.startsWith("sleep:") && !commitment.id.startsWith("sleep-routine:")
      ),
      arrivalMarginMinutes: args.arrivalMarginMinutes
    });
    const coversWhole = slots.length > 0 && slots.every((slot) => slotFitsAction(slot, best.action));
    if (!coversWhole) continue;
    choices.push({ minutes, bedtimeAt: newBedtime, wakeAt: night.plannedWakeAt, sleepMinutes });
  }
  if (!choices.length) return undefined;

  return {
    nightId: night.id,
    projectId: best.forecast.projectId,
    projectTitle: args.projectTitles.get(best.forecast.projectId) ?? best.forecast.projectId,
    actionId: best.action.id,
    actionTitle: best.action.title,
    minutesBehind,
    opensAt,
    closesAt: night.plannedStartAt,
    choices
  };
}
