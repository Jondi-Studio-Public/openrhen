import type { CurrentSituation, EnergyType } from "@openrhen/contracts";
import { localDate } from "../recurrence/recurrence.js";
import type { Action, Project, ProjectForecast, RecommendationCandidate } from "../model/types.js";
import { resolvedLatestSafeStart } from "./score.js";

/**
 * Stretch offers (low-energy deadlines design, F1-13, Part 1).
 *
 * Declared low energy cuts an action the energy does not fit. When that cut is the ONLY thing
 * between the person and an action with a near external deadline, the engine can offer a bounded
 * "stretch": work on it anyway, by choice. Nothing here changes eligibility, tiers or weights;
 * the offer is derived afterwards, and accepting it waives the energy check for that
 * one action through `energyWaivedActionIds`.
 */

/** An external date this close makes the action offerable even when its tier is still ordinary. */
export const STRETCH_NEAR_DEADLINE_MS = 48 * 3_600_000;
/** A two-step energy gap (low for high) caps the session. */
export const STRETCH_TWO_STEP_CAP_MINUTES = 45;

const ENERGY_RANK: Record<Exclude<EnergyType, "recovery">, number> = { low: 1, medium: 2, high: 3 };

export type StretchReason = "overdue_external" | "behind_external" | "at_risk_external" | "external_within_48h";

export interface StretchOffer {
  actionId: string;
  title: string;
  declaredEnergy: Exclude<EnergyType, "recovery">;
  requiredEnergy: Exclude<EnergyType, "recovery">;
  /** How many steps the action's energy is above the declared energy: 1 or 2. */
  energyGap: 1 | 2;
  /** Focused minutes on offer: the rescored session, capped at 45 for a two-step gap. */
  minutes: number;
  /** The two-step cap (45) when the gap is two steps, else null. */
  cappedAtMinutes: number | null;
  reason: StretchReason;
  /** The external date that makes this worth offering: the earliest one still ahead, else the one passed. */
  externalDeadlineAt: Date | null;
  /** The latest safe start the engine measured, when it has one. */
  latestSafeStartAt: Date | null;
}

/** What the caller knows about earlier answers; the engine never stores or decides these. */
export interface StretchContext {
  /** Actions declined today (or since energy was last declared). Never offered again while listed. */
  declinedActionIds?: readonly string[];
  /** "No stretches tonight": nothing is offered at all. */
  declinedAll?: boolean;
  /** When the person next wakes. Absent means the sleep-first check is skipped. */
  nextWakeAt?: Date;
}

export interface DeriveStretchInput {
  now: Date;
  /** Fresh declared energy; absent (none or stale) means no cut and so no offer. */
  currentEnergy: EnergyType | undefined;
  /** The ranked candidates, in the order the plan would take them. */
  candidates: readonly RecommendationCandidate[];
  projectOf: (action: Action) => Project | undefined;
  forecastOf: (action: Action) => ProjectForecast | undefined;
  /** Scores one action with its energy check waived; the same call Now makes for an accepted stretch. */
  rescoreWaived: (action: Action) => RecommendationCandidate;
  context?: StretchContext;
}

const EXTERNAL_REASON: Partial<Record<RecommendationCandidate["criticalTier"], StretchReason>> = {
  overdue_external: "overdue_external",
  behind_external: "behind_external",
  at_risk_external: "at_risk_external"
};

export function deriveStretchOffer(input: DeriveStretchInput): StretchOffer | null {
  const { now, currentEnergy, context } = input;
  if (!currentEnergy || currentEnergy === "recovery" || context?.declinedAll) return null;
  const declined = new Set(context?.declinedActionIds ?? []);

  for (const candidate of input.candidates) {
    const { action } = candidate;
    if (candidate.eligible || declined.has(action.id)) continue;
    // Another way to advance the same deliverable already fits the declared energy: no stretch needed.
    if (
      action.deliverableId &&
      input.candidates.some((other) => other.eligible && other.action.deliverableId === action.deliverableId)
    )
      continue;
    // Recovery work is never "stretched": rest needs no energy and has its own rule.
    if (action.energy === "recovery") continue;
    const gap = ENERGY_RANK[action.energy]! - ENERGY_RANK[currentEnergy]!;
    if (gap < 1) continue;

    // Low energy must be the only blocker: with the check dropped for this action it becomes eligible.
    const rescored = input.rescoreWaived(action);
    if (!rescored.eligible) continue;
    const minutes = Math.min(rescored.recommendedMinutes ?? 0, gap >= 2 ? STRETCH_TWO_STEP_CAP_MINUTES : Infinity);
    if (minutes <= 0) continue;

    const project = input.projectOf(action);
    const externalDates = [project?.externalDeadlineAt, action.externalDeadlineAt].filter(
      (date): date is Date => date instanceof Date
    );
    if (externalDates.length === 0) continue;
    const ahead = externalDates
      .filter((date) => date.getTime() >= now.getTime())
      .sort((a, b) => a.getTime() - b.getTime());
    const passed = externalDates
      .filter((date) => date.getTime() < now.getTime())
      .sort((a, b) => a.getTime() - b.getTime());
    const latestSafeStart =
      resolvedLatestSafeStart(input.forecastOf(action), action.forecastUnitId ?? action.id, now) ?? null;

    let reason: StretchReason | undefined = EXTERNAL_REASON[candidate.criticalTier];
    if (!reason) {
      // Tier still ordinary: only an external date inside 48h qualifies.
      const nearest = ahead[0];
      if (!nearest || nearest.getTime() - now.getTime() > STRETCH_NEAR_DEADLINE_MS) continue;
      // Sleep first if it still fits: when the person wakes before the latest safe start, resting
      // and starting fresh loses nothing, so tonight is not offered. With no measured latest safe
      // start there is nothing to compare, and the date inside 48h stands on its own.
      if (latestSafeStart && context?.nextWakeAt && latestSafeStart.getTime() > context.nextWakeAt.getTime()) continue;
      reason = "external_within_48h";
    }

    return {
      actionId: action.id,
      title: action.title,
      declaredEnergy: currentEnergy,
      requiredEnergy: action.energy,
      energyGap: gap >= 2 ? 2 : 1,
      minutes,
      cappedAtMinutes: gap >= 2 ? STRETCH_TWO_STEP_CAP_MINUTES : null,
      reason,
      externalDeadlineAt: ahead[0] ?? passed[0] ?? null,
      latestSafeStartAt: latestSafeStart
    };
  }
  return null;
}

export interface ResolveStretchInput {
  /** The stored situation; its `stretch` holds the answers. */
  situation: Pick<CurrentSituation, "energySetAt" | "stretch"> | undefined;
  now: Date;
  timeZone: string;
  /** Whether declared energy is fresh; stale or absent energy means there is no cut to waive. */
  energyFresh: boolean;
  /** The earliest planned wake after `now`, when there is one. */
  nextWakeAt?: Date;
}

export interface ResolvedStretchState {
  /** Accepted stretches still running: the declared-energy check is waived for these ids. */
  energyWaivedActionIds: string[];
  /** When each waiver ends (exclusive); the day-plan replay stops waiving an id at its instant. */
  energyWaivedUntil: Record<string, Date>;
  context: StretchContext;
}

/**
 * Turns the stored stretch answers into engine arguments. Pure.
 * - An accepted record is active while `now < until` and it was accepted at or after the energy was
 *   last declared: re-declaring energy ends a stretch (the loan record stays).
 * - A decline counts for the local day it was made in, and is cleared by an energy re-declaration.
 *   "No stretches tonight" lasts the local day and is NOT cleared by one.
 */
export function resolveStretchState(input: ResolveStretchInput): ResolvedStretchState {
  const { situation, now, timeZone } = input;
  const stretch = situation?.stretch;
  const energySetAt = situation?.energySetAt ? new Date(situation.energySetAt).getTime() : undefined;
  const today = localDate(now, timeZone);
  const energyWaivedActionIds: string[] = [];
  const energyWaivedUntil: Record<string, Date> = {};

  if (input.energyFresh && energySetAt !== undefined) {
    for (const record of stretch?.accepted ?? []) {
      const until = new Date(record.until);
      if (!(now.getTime() < until.getTime()) || new Date(record.acceptedAt).getTime() < energySetAt) continue;
      const known = energyWaivedUntil[record.actionId];
      if (!known || known < until) energyWaivedUntil[record.actionId] = until;
      if (!energyWaivedActionIds.includes(record.actionId)) energyWaivedActionIds.push(record.actionId);
    }
  }

  const declinedActionIds = [
    ...new Set(
      (stretch?.declined ?? [])
        .filter((entry) => {
          const at = new Date(entry.at);
          return localDate(at, timeZone) === today && (energySetAt === undefined || at.getTime() >= energySetAt);
        })
        .map((entry) => entry.actionId)
    )
  ];
  const declinedAll =
    stretch?.declinedAllAt !== undefined && localDate(new Date(stretch.declinedAllAt), timeZone) === today;

  return {
    energyWaivedActionIds,
    energyWaivedUntil,
    context: { declinedActionIds, declinedAll, ...(input.nextWakeAt ? { nextWakeAt: input.nextWakeAt } : {}) }
  };
}
