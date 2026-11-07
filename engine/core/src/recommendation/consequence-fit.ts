/**
 * Comparison-derived consequence: a deterministic, bounded MAP Plackett-Luce fit.
 *
 * A ranked group (best first) is a run of sequential "who is first among the rest" events. Each item
 * carries a Gaussian prior centred on its stars, and each fitted value is bounded inside the
 * optimiser to within one star of those stars, so the stored order always equals the fitted order.
 * The function is pure: no clock, no randomness, items processed in sorted id order and comparisons
 * in sorted id order, a fixed iteration count and tolerance. Items without usable comparisons come
 * back as exactly their stars. Ties carry no information and are ignored.
 */

/** Bump when the solver, prior, noise or bounds change, so a stored fit can be told stale. */
export const SOLVER_VERSION = 1;

/** Prior standard deviation around an item's stars, in star units. */
export const PRIOR_SD = 0.8;
/** Fixed choice noise, in star units. */
export const CHOICE_TAU = 0.5;
/** How far a fitted value may move from its stars, in either direction. */
export const MAX_DEVIATION = 1;
/** Half-life of an answer, in days. */
export const AGE_HALF_LIFE_DAYS = 180;

const MAX_ITERATIONS = 500;
const TOLERANCE = 1e-9;
const BOUND_EPSILON = 1e-6;
const DEFAULT_STARS = 3;
const INACTIVE_STATUSES = new Set(["done", "cancelled", "archived"]);

export interface ConsequenceFitItem {
  id: string;
  stars: number;
  /** Completed, cancelled and archived items drop out of the fit and keep their stars. */
  status?: string;
}

export interface ConsequenceFitComparison {
  id: string;
  /** Item ids, best first (four in practice). */
  rankedIds: string[];
  /** "Equal / can't decide": carries no information and is ignored. */
  tie?: boolean;
  /** Evidence weight, usually `ageWeight(ageDays)` times a basis factor. */
  weight: number;
}

export interface ConsequenceFitOptions {
  priorSd?: number;
  tau?: number;
  maxDeviation?: number;
}

export interface ConsequenceFitResult {
  id: string;
  /** Fitted value, rounded to 2 decimals, finite and within 0..6. */
  value: number;
  /** The fit sits on a bound: the comparisons keep ranking this item beyond its stars. */
  pressedAgainstBound: boolean;
  /** Posterior variance estimate (Laplace); larger means a better candidate for the next group. */
  variance: number;
}

/** Weight of an answer given its age: halves every 180 days. Garbage or negative ages weigh 1 or less. */
export function ageWeight(ageDays: number): number {
  if (!Number.isFinite(ageDays)) return 0;
  return Math.pow(0.5, Math.max(0, ageDays) / AGE_HALF_LIFE_DAYS);
}

function cleanStars(stars: number): number {
  return Number.isFinite(stars) ? Math.min(5, Math.max(1, stars)) : DEFAULT_STARS;
}
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function key(comparison: ConsequenceFitComparison): string {
  return Array.isArray(comparison.rankedIds) ? comparison.rankedIds.join("\u0000") : "";
}
function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

interface UsableComparison {
  weight: number;
  /** Item indexes into the sorted active item list, best first. */
  order: number[];
}

export function fitConsequence(
  items: readonly ConsequenceFitItem[],
  comparisons: readonly ConsequenceFitComparison[],
  options: ConsequenceFitOptions = {}
): ConsequenceFitResult[] {
  const priorSd = options.priorSd !== undefined && options.priorSd > 0 ? options.priorSd : PRIOR_SD;
  const tau = options.tau !== undefined && options.tau > 0 ? options.tau : CHOICE_TAU;
  const maxDeviation =
    options.maxDeviation !== undefined && options.maxDeviation >= 0 ? options.maxDeviation : MAX_DEVIATION;
  const priorPrecision = 1 / (priorSd * priorSd);

  // First occurrence of a duplicate id wins (after sorting, so input order cannot matter).
  const sorted = [...items].sort((a, b) => byId(a, b) || cleanStars(a.stars) - cleanStars(b.stars));
  const unique: ConsequenceFitItem[] = [];
  for (const item of sorted) if (unique[unique.length - 1]?.id !== item.id) unique.push(item);
  const active = unique.filter((item) => !INACTIVE_STATUSES.has(item.status ?? ""));
  const index = new Map(active.map((item, i) => [item.id, i]));
  const stars = active.map((item) => cleanStars(item.stars));

  const usable: UsableComparison[] = [];
  const ordered = [...comparisons].sort((a, b) => byId(a, b) || compareText(key(a), key(b)));
  for (const comparison of ordered) {
    if (comparison.tie) continue;
    if (!Number.isFinite(comparison.weight) || comparison.weight <= 0) continue;
    if (!Array.isArray(comparison.rankedIds)) continue;
    const order: number[] = [];
    const seen = new Set<number>();
    for (const id of comparison.rankedIds) {
      const i = index.get(id);
      if (i === undefined || seen.has(i)) continue;
      seen.add(i);
      order.push(i);
    }
    if (order.length >= 2) usable.push({ weight: comparison.weight, order });
  }

  const n = active.length;
  const lower = stars.map((s) => Math.max(0, s - maxDeviation));
  const upper = stars.map((s) => Math.min(6, s + maxDeviation));
  const touched = Array.from<boolean>({ length: n }).fill(false);
  // Upper bound on each item's curvature from comparisons (log-sum-exp Hessian rows sum to <= 0.5/tau^2 per event).
  const curvatureBound = Array.from<number>({ length: n }).fill(0);
  for (const { weight, order } of usable) {
    order.forEach((item, position) => {
      touched[item] = true;
      const events = Math.min(position + 1, order.length - 1);
      curvatureBound[item]! += (weight * 0.5 * events) / (tau * tau);
    });
  }

  const value = [...stars];
  const gradient = Array.from<number>({ length: n });
  const exps = Array.from<number>({ length: 8 });
  for (let iteration = 0; iteration < MAX_ITERATIONS && usable.length; iteration += 1) {
    for (let i = 0; i < n; i += 1) gradient[i] = (value[i]! - stars[i]!) * priorPrecision;
    for (const { weight, order } of usable) {
      const size = order.length;
      for (let k = 0; k < size - 1; k += 1) {
        // Event k: order[k] is first among order[k..]. Shift by the first value for numerical safety.
        const base = value[order[k]!]!;
        let total = 0;
        for (let j = k; j < size; j += 1) {
          exps[j] = Math.exp((value[order[j]!]! - base) / tau);
          total += exps[j]!;
        }
        for (let j = k; j < size; j += 1) {
          const probability = exps[j]! / total;
          gradient[order[j]!]! += (weight / tau) * probability;
        }
        gradient[order[k]!]! -= weight / tau;
      }
    }
    let largestStep = 0;
    for (let i = 0; i < n; i += 1) {
      if (!touched[i]) continue;
      const scale = priorPrecision + curvatureBound[i]!;
      const next = Math.min(upper[i]!, Math.max(lower[i]!, value[i]! - gradient[i]! / scale));
      largestStep = Math.max(largestStep, Math.abs(next - value[i]!));
      value[i] = next;
    }
    if (largestStep < TOLERANCE) break;
  }

  // Laplace variance from the diagonal of the Hessian at the solution.
  const curvature = Array.from<number>({ length: n }).fill(priorPrecision);
  for (const { weight, order } of usable) {
    const size = order.length;
    for (let k = 0; k < size - 1; k += 1) {
      const base = value[order[k]!]!;
      let total = 0;
      for (let j = k; j < size; j += 1) {
        exps[j] = Math.exp((value[order[j]!]! - base) / tau);
        total += exps[j]!;
      }
      for (let j = k; j < size; j += 1) {
        const probability = exps[j]! / total;
        curvature[order[j]!]! += (weight * probability * (1 - probability)) / (tau * tau);
      }
    }
  }

  const fitted = new Map<string, ConsequenceFitResult>();
  active.forEach((item, i) => {
    const fittedValue = touched[i] ? round2(Math.min(upper[i]!, Math.max(lower[i]!, value[i]!))) : stars[i]!;
    const pressed = touched[i]! && (value[i]! <= lower[i]! + BOUND_EPSILON || value[i]! >= upper[i]! - BOUND_EPSILON);
    const variance = 1 / curvature[i]!;
    fitted.set(item.id, {
      id: item.id,
      value: fittedValue,
      pressedAgainstBound: pressed,
      variance: Number.isFinite(variance) ? variance : priorSd * priorSd
    });
  });
  // Dropped items keep their stars, so a caller always gets one row per distinct item.
  return unique.map(
    (item) =>
      fitted.get(item.id) ?? {
        id: item.id,
        value: cleanStars(item.stars),
        pressedAgainstBound: false,
        variance: priorSd * priorSd
      }
  );
}
