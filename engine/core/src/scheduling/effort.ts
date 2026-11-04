import type { Action, ActionEffort, PlanningConfig, Project } from "../model/types.js";
import { defaultPlanningConfig } from "../model/types.js";

export function calculateActionEffort(
  action: Action,
  project: Project,
  config: PlanningConfig = defaultPlanningConfig
): ActionEffort {
  const baseline = Math.max(1, action.expectedMinutes);
  const optimistic = action.optimisticMinutes;
  const pessimistic = action.pessimisticMinutes;
  // The estimation method is a property of the stored estimate, never of the mutable remaining
  // value. Deriving it from remaining minutes silently switched method mid-project as work finished.
  // Three equal figures state no spread (a single-figure estimate), so they take the uncertainty
  // multiplier path; a PERT range of zero width would otherwise pad nothing whatever the project's
  // uncertainty.
  const hasPert =
    optimistic !== undefined &&
    pessimistic !== undefined &&
    optimistic <= baseline &&
    baseline <= pessimistic &&
    !(optimistic === baseline && baseline === pessimistic);
  const expected = hasPert ? (optimistic + 4 * baseline + pessimistic) / 6 : baseline;
  const deviation = hasPert ? (pessimistic - optimistic) / 6 : null;
  // Learned calibration corrects the *centre* of the estimate: it scales the mean the
  // stored baseline implies, never the padding on top of it. The padding comes from spread alone: a
  // PERT range's own deviation, or for a single-figure estimate the uncertainty multiplier, or the
  // spread learned from the samples once there are enough of them (replacing the multiplier rather
  // than stacking with it).
  const factor = project.estimateCalibration?.factor ?? 1;
  const mean = factor * expected;
  // The learned spread is area-wide, so it can only widen the padding the project's own uncertainty
  // already chose, never erase it.
  const ownMultiplier = config.uncertaintyMultipliers[project.uncertainty];
  const paddingMultiplier = Math.max(ownMultiplier, project.estimateCalibration?.spread ?? 0);
  const protectedOriginal = hasPert ? mean + EFFORT_Z * deviation! : mean * paddingMultiplier;
  // A single-figure estimate has no stated deviation, so the sd its padding implies is read back from
  // the padded figure; that is what lets these actions add up in quadrature with PERT ones.
  const impliedDeviation = hasPert ? deviation! : Math.max(0, protectedOriginal - mean) / EFFORT_Z;
  // Scaling is applied once, to each estimate, so a revised remaining value moves the forecast
  // proportionally instead of squaring it.
  const remainingRatio = action.remainingMinutes / baseline;
  const setup = action.remainingMinutes > 0 ? Math.max(0, action.setupMinutes ?? 0) : 0;
  // The stated worst case moves with the calibration like the rest of the estimate, and never sits
  // below the padded figure it is meant to bound.
  const pessimisticScaled = Math.ceil(Math.max((pessimistic ?? 0) * factor, protectedOriginal) * remainingRatio);

  return {
    actionId: action.id,
    optimisticMinutes: optimistic ?? null,
    mostLikelyMinutes: baseline,
    pessimisticMinutes: pessimistic ?? null,
    expectedMinutes: Math.round(mean * 100) / 100,
    standardDeviationMinutes: deviation === null ? null : Math.round(deviation * 100) / 100,
    riskAdjustedMinutes: Math.ceil(protectedOriginal) + setup,
    riskAdjustedRemainingMinutes: Math.max(0, Math.ceil(protectedOriginal * remainingRatio) + setup),
    pessimisticRemainingMinutes: Math.max(0, Math.max(action.remainingMinutes, pessimisticScaled) + setup),
    expectedRemainingMinutes: Math.max(0, mean * remainingRatio + setup),
    remainingDeviationMinutes: impliedDeviation * remainingRatio,
    remainingExceedsBaseline: action.remainingMinutes > baseline,
    method: hasPert ? "pert" : "uncertainty_multiplier",
    calibrationFactor: factor
  };
}

/** One-sided z for the 85th percentile, the confidence every protected figure is held to. */
const EFFORT_Z = 1.04;

/**
 * A project's remaining effort. Each action keeps its own ~p85 figure for the scheduler to reserve,
 * but those figures must not be added up as the project's answer: twelve independent p85s sum to
 * roughly p99. The project total is the sum of the means plus one z of the combined spread (the
 * variances add), so a long project is not padded twelve times over.
 */
export function projectEffort(actions: Action[], project: Project, config: PlanningConfig = defaultPlanningConfig) {
  const calculated = actions.map((action) => calculateActionEffort(action, project, config));
  const override = project.remainingEffortOverrideMinutes;
  const efforts = override === undefined ? calculated : applyRemainingOverride(calculated, override);
  const meanMinutes = efforts.reduce((sum, effort) => sum + effort.expectedRemainingMinutes, 0);
  const deviationMinutes = Math.sqrt(efforts.reduce((sum, effort) => sum + effort.remainingDeviationMinutes ** 2, 0));
  // Never below what the actions themselves say is left, and never above the plain per-action sum.
  const linearProtected = efforts.reduce((sum, effort) => sum + effort.riskAdjustedRemainingMinutes, 0);
  const quadratureProtected = Math.ceil(meanMinutes + EFFORT_Z * deviationMinutes);
  const riskAdjustedMinutes =
    override === undefined ? Math.min(linearProtected, quadratureProtected) : Math.max(0, Math.ceil(override));
  // The stated worst cases combine the same way: each action's distance from its mean to its own
  // pessimistic figure adds in quadrature, so one action keeps exactly its stated worst case and a long
  // project is not assumed to hit every worst case at once.
  const pessimisticQuadrature = Math.ceil(
    meanMinutes +
      Math.sqrt(
        efforts.reduce(
          (sum, effort) => sum + Math.max(0, effort.pessimisticRemainingMinutes - effort.expectedRemainingMinutes) ** 2,
          0
        )
      )
  );
  const pessimisticLinear = efforts.reduce((sum, effort) => sum + effort.pessimisticRemainingMinutes, 0);
  return {
    efforts,
    /** The project's honest ~p85 total, for feasibility. Per-action figures stay on `efforts`. */
    riskAdjustedMinutes,
    // An override sets the total, so the quadrature reduction (which treats its override-scaled
    // shares as independent, and shrinks as the work is split into more actions) does not apply.
    pessimisticMinutes: Math.max(
      riskAdjustedMinutes,
      override === undefined ? Math.min(pessimisticLinear, pessimisticQuadrature) : pessimisticLinear
    ),
    meanMinutes,
    deviationMinutes,
    /** What the per-action figures add to; what the scheduler reserves in total. */
    reservedProtectedMinutes: linearProtected
  };
}

function applyRemainingOverride(efforts: ActionEffort[], overrideMinutes: number): ActionEffort[] {
  if (!efforts.length) return efforts;
  const target = Math.max(0, Math.ceil(overrideMinutes));
  const originalProtected = efforts.reduce((sum, effort) => sum + effort.riskAdjustedRemainingMinutes, 0);
  const weights =
    originalProtected > 0
      ? efforts.map((effort) => effort.riskAdjustedRemainingMinutes / originalProtected)
      : efforts.map(() => 1 / efforts.length);
  const exact = weights.map((weight) => weight * target);
  const allocated = exact.map(Math.floor);
  let remainder = target - allocated.reduce((sum, minutes) => sum + minutes, 0);
  const remainderOrder = efforts
    .map((effort, index) => ({
      index,
      fraction: exact[index]! - allocated[index]!,
      actionId: effort.actionId
    }))
    .sort((a, b) => b.fraction - a.fraction || a.actionId.localeCompare(b.actionId));
  for (const item of remainderOrder) {
    if (remainder <= 0) break;
    allocated[item.index]! += 1;
    remainder -= 1;
  }
  const scale = originalProtected > 0 ? target / originalProtected : 0;
  return efforts.map((effort, index) => ({
    ...effort,
    riskAdjustedRemainingMinutes: allocated[index]!,
    expectedRemainingMinutes: effort.expectedRemainingMinutes * scale,
    remainingDeviationMinutes: effort.remainingDeviationMinutes * scale,
    pessimisticRemainingMinutes: Math.max(allocated[index]!, Math.ceil(effort.pessimisticRemainingMinutes * scale))
  }));
}
