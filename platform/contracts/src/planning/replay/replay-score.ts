import { END_STATES, type EndState, type ReplayGold, type ReplayOutcome, type ReplayTarget } from "./replay-case.js";
import type { RunResult } from "./replay-run.js";

/**
 * Scoring for a replay run. Pure. Every rate is kept as a count pair `{k, n}` so a baseline file
 * is exact and diffs cleanly; `rateOf` and `wilson` turn one into a figure.
 */

export interface Rate {
  k: number;
  n: number;
}

export interface Metrics {
  cases: number;
  /** `confusion[gold][predicted]`. */
  confusion: Record<EndState, Record<EndState, number>>;
  precision: Record<EndState, Rate>;
  recall: Record<EndState, Rate>;
  /** Applied with the gold target (or an acceptable one) over all applied. */
  appliedPrecision: Rate;
  /** Applied to a wrong target over all applied to a target. */
  falseMergeRate: Rate;
  /** A create where gold is a duplicate or an update, over all creates. */
  wrongCreateRate: Rate;
  /** A duplicate verdict on a wrong target (or where gold is not a duplicate), over all duplicates. */
  wrongDuplicateRate: Rate;
  /** Applied where a person would Deny, over all applied. */
  denyRate: Rate;
  /** One minus the Deny rate: how often a shown Confirm was right. */
  confirmAccuracy: Rate;
  /** Tied cases over cases with a candidate. */
  tieRate: Rate;
  tieResolution: { chooserCorrect: Rate; asked: Rate; wronglyApplied: Rate };
  /** Gold target among the (at most five) candidates, over cases that have a gold target. */
  recallAt5: Rate;
  /** Resolved (applied, duplicate or no effect) with no chooser, over all cases. */
  noJudgeShare: Rate;
  unresolvedShare: Rate;
  questionsPer100: number;
}

export interface MetricGroups {
  overall: Metrics;
  byTag: Record<string, Metrics>;
  bySize: Record<string, Metrics>;
}

const rate = (k: number, n: number): Rate => ({ k, n });
export const rateOf = (r: Rate): number => (r.n === 0 ? 0 : r.k / r.n);

/** 95% Wilson score interval for a rate; small denominators give wide intervals. */
export function wilson(r: Rate): { lo: number; hi: number } {
  if (r.n === 0) return { lo: 0, hi: 1 };
  const z = 1.96;
  const p = r.k / r.n;
  const denom = 1 + (z * z) / r.n;
  const centre = (p + (z * z) / (2 * r.n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / r.n + (z * z) / (4 * r.n * r.n))) / denom;
  return { lo: Math.max(0, centre - margin), hi: Math.min(1, centre + margin) };
}

const sameTarget = (a: ReplayTarget, b: ReplayTarget) => a.kind === b.kind && a.id === b.id;

function acceptedTargets(gold: ReplayGold): ReplayTarget[] {
  return [gold.target, ...(gold.acceptableTargets ?? [])].filter((t): t is ReplayTarget => t !== undefined);
}

/** The outcome's target is the gold target, or an acceptable one; with no gold target there must be none. */
export function targetOk(gold: ReplayGold, target: ReplayTarget | undefined): boolean {
  const accepted = acceptedTargets(gold);
  if (accepted.length === 0) return target === undefined;
  return target !== undefined && accepted.some((t) => sameTarget(t, target));
}

/** End state, target, and op (and reason) all as gold says. */
export function isCorrect(gold: ReplayGold, outcome: ReplayOutcome): boolean {
  if (outcome.endState !== gold.endState) return false;
  if (gold.reason !== undefined && outcome.reason !== gold.reason) return false;
  if (outcome.endState === "applied" || outcome.endState === "duplicate") {
    if (gold.op !== undefined && outcome.op !== gold.op) return false;
    return targetOk(gold, outcome.target);
  }
  return true;
}

const resolvedStates = new Set<EndState>(["applied", "duplicate", "no_effect"]);

export function scoreResults(results: readonly RunResult[]): Metrics {
  const confusion = Object.fromEntries(
    END_STATES.map((g) => [g, Object.fromEntries(END_STATES.map((p) => [p, 0]))])
  ) as Metrics["confusion"];
  let applied = 0;
  let appliedCorrect = 0;
  let appliedWithTarget = 0;
  let falseMerge = 0;
  let creates = 0;
  let wrongCreate = 0;
  let duplicates = 0;
  let wrongDuplicate = 0;
  let denied = 0;
  let withCandidate = 0;
  let tied = 0;
  let tiedChooserCorrect = 0;
  let tiedAsked = 0;
  let tiedWronglyApplied = 0;
  let goldTargets = 0;
  let found = 0;
  let noJudge = 0;
  let unresolved = 0;
  let asked = 0;

  for (const { testCase, outcome } of results) {
    const { gold } = testCase;
    confusion[gold.endState][outcome.endState] += 1;
    const correct = isCorrect(gold, outcome);

    if (outcome.endState === "applied") {
      applied += 1;
      if (correct) appliedCorrect += 1;
      if (gold.deny === true) denied += 1;
      if (outcome.target !== undefined) {
        appliedWithTarget += 1;
        if (!targetOk(gold, outcome.target)) falseMerge += 1;
      }
      if (outcome.op === "create") {
        creates += 1;
        if (gold.endState === "duplicate" || gold.op === "update") wrongCreate += 1;
      }
    }
    if (outcome.endState === "duplicate") {
      duplicates += 1;
      if (!correct) wrongDuplicate += 1;
    }
    if (outcome.endState === "asked") asked += 1;
    if (outcome.endState === "unresolved") unresolved += 1;
    if (outcome.candidates.length > 0) withCandidate += 1;
    if (outcome.tie) {
      tied += 1;
      if (outcome.usedChooser && correct) tiedChooserCorrect += 1;
      if (outcome.endState === "asked") tiedAsked += 1;
      if ((outcome.endState === "applied" || outcome.endState === "duplicate") && !correct) tiedWronglyApplied += 1;
    }
    const accepted = acceptedTargets(gold);
    if (accepted.length > 0) {
      goldTargets += 1;
      if (outcome.candidates.some((c) => accepted.some((t) => t.id === c.id))) found += 1;
    }
    if (resolvedStates.has(outcome.endState) && !outcome.usedChooser) noJudge += 1;
  }

  const total = results.length;
  const precision = {} as Metrics["precision"];
  const recall = {} as Metrics["recall"];
  for (const state of END_STATES) {
    const predicted = END_STATES.reduce((sum, g) => sum + confusion[g][state], 0);
    const actual = END_STATES.reduce((sum, p) => sum + confusion[state][p], 0);
    precision[state] = rate(confusion[state][state], predicted);
    recall[state] = rate(confusion[state][state], actual);
  }

  return {
    cases: total,
    confusion,
    precision,
    recall,
    appliedPrecision: rate(appliedCorrect, applied),
    falseMergeRate: rate(falseMerge, appliedWithTarget),
    wrongCreateRate: rate(wrongCreate, creates),
    wrongDuplicateRate: rate(wrongDuplicate, duplicates),
    denyRate: rate(denied, applied),
    confirmAccuracy: rate(applied - denied, applied),
    tieRate: rate(tied, withCandidate),
    tieResolution: {
      chooserCorrect: rate(tiedChooserCorrect, tied),
      asked: rate(tiedAsked, tied),
      wronglyApplied: rate(tiedWronglyApplied, tied)
    },
    recallAt5: rate(found, goldTargets),
    noJudgeShare: rate(noJudge, total),
    unresolvedShare: rate(unresolved, total),
    questionsPer100: total === 0 ? 0 : Math.round((asked * 10000) / total) / 100
  };
}

const SIZE_TAG = /^\d+x$/;

/** Overall, per tag and per plan size (`1x`, `5x`, `20x`; cases without a size tag are `unsized`). */
export function scoreGroups(results: readonly RunResult[]): MetricGroups {
  const byTag = new Map<string, RunResult[]>();
  const bySize = new Map<string, RunResult[]>();
  for (const result of results) {
    const tags = result.testCase.tags;
    for (const tag of tags.filter((t) => !SIZE_TAG.test(t))) byTag.set(tag, [...(byTag.get(tag) ?? []), result]);
    const size = tags.find((t) => SIZE_TAG.test(t)) ?? "unsized";
    bySize.set(size, [...(bySize.get(size) ?? []), result]);
  }
  const score = (map: Map<string, RunResult[]>) =>
    Object.fromEntries(
      [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, rs]) => [key, scoreResults(rs)])
    );
  return { overall: scoreResults(results), byTag: score(byTag), bySize: score(bySize) };
}

export interface Violations {
  /** Resolved to one target on a tied top rank with no chooser: a guess. */
  tieGuess: string[];
  /** Did what the case's `mustNot` forbids. */
  mustNot: string[];
}

/** Hard invariants. Never ratcheted: the baseline may list known violations, and the list may only shrink. */
export function violations(results: readonly RunResult[]): Violations {
  const tieGuess: string[] = [];
  const mustNot: string[] = [];
  for (const { testCase, outcome } of results) {
    if (outcome.tie && !outcome.usedChooser && (outcome.endState === "applied" || outcome.endState === "duplicate")) {
      tieGuess.push(testCase.id);
    }
    const forbidden = testCase.gold.mustNot ?? [];
    if (
      outcome.endState === "applied" &&
      (forbidden.includes("apply") || (forbidden.includes("create") && outcome.op === "create"))
    ) {
      mustNot.push(testCase.id);
    }
  }
  return { tieGuess: tieGuess.sort(), mustNot: mustNot.sort() };
}

/** Cases an adversarial chooser made apply that the deterministic path did not: must be none. */
export function newApplies(deterministic: readonly RunResult[], other: readonly RunResult[]): string[] {
  const applied = new Set(deterministic.filter((r) => r.outcome.endState === "applied").map((r) => r.testCase.id));
  return other
    .filter((r) => r.outcome.endState === "applied" && !applied.has(r.testCase.id))
    .map((r) => r.testCase.id)
    .sort();
}

export const RATCHETED = ["appliedPrecision", "recallAt5", "noJudgeShare"] as const;

/** What fell below baseline. `tolerance` is a share of a rate; the fixed golden suite is exact, so 0. */
export function ratchetFailures(current: Metrics, baseline: Metrics, tolerance: number): string[] {
  const failures: string[] = [];
  for (const name of RATCHETED) {
    const now = rateOf(current[name]);
    const was = rateOf(baseline[name]);
    if (now < was - tolerance) {
      failures.push(
        `${name} fell from ${was.toFixed(4)} (${baseline[name].k}/${baseline[name].n}) to ${now.toFixed(4)} (${current[name].k}/${current[name].n})`
      );
    }
  }
  return failures;
}
