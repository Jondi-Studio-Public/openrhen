import type { EnergyType } from "@openrhen/contracts";
import type { Action, Project, RecommendationCandidate } from "../model/types.js";
import { STRETCH_NEAR_DEADLINE_MS } from "./stretch.js";

/**
 * Energy cost note (low-energy deadlines design, Part 2).
 *
 * Counts what the declared energy is holding back: candidates whose ONLY blocker is the declared-energy
 * check (scoring them again with that check waived makes them eligible). It describes; it never prescribes,
 * and nothing here changes eligibility, tiers, ranking or any other output.
 */

const ENERGY_RANK: Record<Exclude<EnergyType, "recovery">, number> = { low: 1, medium: 2, high: 3 };

/** Most blocked actions named in `dueSoon`; `blockedCount` always counts every one. */
export const ENERGY_COST_DUE_SOON_LIMIT = 5;

export interface EnergyCostDueSoon {
  actionId: string;
  title: string;
  /** The external date that makes it due soon: the earliest one still ahead, else the one that passed. */
  deadlineAt: Date | null;
}

export interface EnergyCost {
  declaredEnergy: Exclude<EnergyType, "recovery">;
  /** Actions only the declared energy keeps out of the plan. */
  blockedCount: number;
  /** Blocked actions with an external date inside 48 hours, or already overdue, behind or at risk; earliest first. */
  dueSoon: EnergyCostDueSoon[];
}

export interface DeriveEnergyCostInput {
  now: Date;
  /** Fresh declared energy; absent (none or stale) means no cut and so no note. */
  currentEnergy: EnergyType | undefined;
  candidates: readonly RecommendationCandidate[];
  projectOf: (action: Action) => Project | undefined;
  /** Scores one action with its energy check waived; the same helper the stretch offer uses. */
  rescoreWaived: (action: Action) => RecommendationCandidate;
}

const EXTERNAL_TIERS = new Set<RecommendationCandidate["criticalTier"]>([
  "overdue_external",
  "behind_external",
  "at_risk_external"
]);

export function deriveEnergyCost(input: DeriveEnergyCostInput): EnergyCost | null {
  const { now, currentEnergy } = input;
  if (!currentEnergy || currentEnergy === "recovery") return null;
  // One per deliverable (its options are ways to spend the same time), else one per action.
  const blocked = new Set<string>();
  const dueByKey = new Map<string, EnergyCostDueSoon>();

  for (const candidate of input.candidates) {
    const { action } = candidate;
    if (candidate.eligible || action.energy === "recovery") continue;
    if (ENERGY_RANK[action.energy]! - ENERGY_RANK[currentEnergy]! < 1) continue;
    // Another way to advance the same deliverable already fits: nothing is held back.
    if (
      action.deliverableId &&
      input.candidates.some((other) => other.eligible && other.action.deliverableId === action.deliverableId)
    )
      continue;
    // Low energy must be the only blocker: with the check dropped for this action it becomes eligible.
    if (!input.rescoreWaived(action).eligible) continue;
    const key = action.deliverableId ?? action.id;
    blocked.add(key);

    const project = input.projectOf(action);
    const dates = [project?.externalDeadlineAt, action.externalDeadlineAt].filter(
      (date): date is Date => date instanceof Date
    );
    const ahead = dates.filter((d) => d.getTime() >= now.getTime()).sort((a, b) => a.getTime() - b.getTime());
    const passed = dates.filter((d) => d.getTime() < now.getTime()).sort((a, b) => a.getTime() - b.getTime());
    const near = ahead[0] !== undefined && ahead[0].getTime() - now.getTime() <= STRETCH_NEAR_DEADLINE_MS;
    if (near || EXTERNAL_TIERS.has(candidate.criticalTier)) {
      const entry = { actionId: action.id, title: action.title, deadlineAt: ahead[0] ?? passed[0] ?? null };
      const known = dueByKey.get(key);
      const at = (item: EnergyCostDueSoon) => item.deadlineAt?.getTime() ?? Number.POSITIVE_INFINITY;
      if (!known || at(entry) < at(known)) dueByKey.set(key, entry);
    }
  }
  const blockedCount = blocked.size;
  if (blockedCount === 0) return null;
  const due = [...dueByKey.values()];
  due.sort(
    (a, b) =>
      (a.deadlineAt?.getTime() ?? Number.POSITIVE_INFINITY) - (b.deadlineAt?.getTime() ?? Number.POSITIVE_INFINITY)
  );
  return { declaredEnergy: currentEnergy, blockedCount, dueSoon: due.slice(0, ENERGY_COST_DUE_SOON_LIMIT) };
}
