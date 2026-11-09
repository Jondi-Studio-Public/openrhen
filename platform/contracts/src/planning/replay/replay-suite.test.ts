import { describe, expect, it } from "vitest";
import { DEFAULT_SEED, KINDS } from "./replay-generate.js";
import { referenceReconciler } from "./replay-reference.js";
import { PATHS, runCases, runPaths, type ReplayPath } from "./replay-run.js";
import { newApplies, newWrongDuplicates, ratchetFailures, scoreGroups, violations } from "./replay-score.js";
import {
  baseline,
  generatedBaseline,
  GENERATED_COUNTS,
  generatedSuite,
  goldenCases,
  LARGE_COUNTS
} from "./replay-suite.js";

const runs = Object.fromEntries(
  PATHS.map((path) => [path, runCases(goldenCases, referenceReconciler, path)])
) as Record<ReplayPath, ReturnType<typeof runCases>>;

const refresh =
  "If this change is deliberate, update platform/contracts/test/replay/baseline.json in the same commit and give the reason in the commit message.";

/** Contracts carries no node types, so the sweep's switches are read through the global. */
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

describe("replay suite against the baseline", () => {
  it("does not let a ratcheted rate fall below the baseline", () => {
    const current = scoreGroups(runs.deterministic);
    const failures = [
      ...ratchetFailures(current.overall, baseline.metrics.deterministic.overall, baseline.tolerance),
      ...Object.entries(baseline.metrics.deterministic.byTag).flatMap(([tag, was]) =>
        ratchetFailures(current.byTag[tag]!, was, baseline.tolerance).map((f) => `${tag}: ${f}`)
      )
    ];
    expect(failures, refresh).toEqual([]);
  });

  it("records every metric exactly, so a change of behaviour shows in the baseline diff", () => {
    expect(scoreGroups(runs.deterministic), refresh).toEqual(baseline.metrics.deterministic);
    for (const path of ["oracle", "adversarial", "noisy"] as const) {
      expect(scoreGroups(runs[path]).overall, `${path}. ${refresh}`).toEqual(baseline.metrics.judge[path]);
    }
  });

  it("never commits a hard-invariant violation that the baseline does not list, on any path", () => {
    for (const path of PATHS) {
      const found = violations(runs[path]);
      expect(
        found.tieGuess.filter((id) => !baseline.knownViolations.tieGuess.includes(id)),
        `${path} tieGuess`
      ).toEqual([]);
      expect(
        found.mustNot.filter((id) => !baseline.knownViolations.mustNot.includes(id)),
        `${path} mustNot`
      ).toEqual([]);
    }
  });

  it("keeps the known-violation list honest: each entry still happens, so a fix shrinks the list", () => {
    const found = violations(runs.deterministic);
    expect(found, refresh).toEqual(baseline.knownViolations);
  });

  it("holds an adversarial chooser to no new applies", () => {
    expect(newApplies(runs.deterministic, runs.adversarial)).toEqual([]);
    expect(baseline.adversarialNewApplies).toEqual([]);
  });

  it("calls a chooser only to settle a held question, never on the deterministic path", () => {
    expect(runs.deterministic.some((r) => r.outcome.usedChooser)).toBe(false);
    for (const path of ["oracle", "adversarial", "noisy"] as const) {
      expect(runs[path].some((r) => r.outcome.usedChooser)).toBe(true);
    }
  });

  it("tracks the wrong duplicates an adversarial chooser adds, and lets that list only shrink", () => {
    const found = newWrongDuplicates(runs.deterministic, runs.adversarial);
    expect(found.filter((id) => !baseline.adversarialNewWrongDuplicates.includes(id))).toEqual([]);
    expect(found, refresh).toEqual(baseline.adversarialNewWrongDuplicates);
  });

  it("has the forty golden cases, every thin tag with at least three", () => {
    expect(goldenCases).toHaveLength(40);
    const count = (tag: string) => goldenCases.filter((c) => c.tags.includes(tag)).length;
    for (const tag of ["reminder-of-confirmation", "moved-deadline", "sender-contact"]) {
      expect(count(tag), tag).toBeGreaterThanOrEqual(3);
    }
  });

  it("is first-wins on a tie today (PR 3 changes this)", () => {
    const twins = runs.deterministic.find((r) => r.testCase.id === "event-twin-records")!;
    expect(twins.outcome).toMatchObject({ endState: "duplicate", tie: true });
  });

  it("reruns only the asked cases on the chooser paths, and that equals running everything", () => {
    const quick = runPaths(goldenCases, referenceReconciler);
    for (const path of PATHS) expect(quick[path].map((r) => r.outcome)).toEqual(runs[path].map((r) => r.outcome));
  });

  it("runs quickly, in memory", () => {
    const start = performance.now();
    for (const path of PATHS) runCases(goldenCases, referenceReconciler, path);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

describe("generated replay suite against its baseline", () => {
  const cases = generatedSuite();
  const generatedRuns = runPaths(cases, referenceReconciler);
  const gen = generatedBaseline;
  const regenerate =
    "If this change is deliberate, update platform/contracts/test/replay/baseline-generated.json in the same commit and give the reason in the commit message.";

  it("is the suite the baseline was taken from", () => {
    expect(gen.counts).toEqual(GENERATED_COUNTS);
    expect(cases).toHaveLength(Object.values(GENERATED_COUNTS).reduce((a, b) => a + b, 0));
    expect(gen.metrics.deterministic.overall.cases).toBe(cases.length);
  });

  it("does not let a ratcheted rate fall below the baseline, overall, per tag or per plan size", () => {
    const current = scoreGroups(generatedRuns.deterministic);
    const was = gen.metrics.deterministic;
    const failures = [
      ...ratchetFailures(current.overall, was.overall, gen.tolerance),
      ...Object.entries(was.byTag).flatMap(([tag, m]) =>
        ratchetFailures(current.byTag[tag]!, m, gen.tolerance).map((f) => `${tag}: ${f}`)
      ),
      ...Object.entries(was.bySize).flatMap(([size, m]) =>
        ratchetFailures(current.bySize[size]!, m, gen.tolerance).map((f) => `${size}: ${f}`)
      )
    ];
    expect(failures, regenerate).toEqual([]);
  });

  it("records every metric exactly", () => {
    expect(scoreGroups(generatedRuns.deterministic), regenerate).toEqual(gen.metrics.deterministic);
    for (const path of ["oracle", "adversarial", "noisy"] as const) {
      expect(scoreGroups(generatedRuns[path]).overall, `${path}. ${regenerate}`).toEqual(gen.metrics.judge[path]);
    }
  });

  it("commits no hard-invariant violation that the baseline does not list, on any path", () => {
    for (const path of PATHS) {
      const found = violations(generatedRuns[path]);
      expect(
        found.tieGuess.filter((id) => !gen.knownViolations.tieGuess.includes(id)),
        `${path} tieGuess`
      ).toEqual([]);
      expect(
        found.mustNot.filter((id) => !gen.knownViolations.mustNot.includes(id)),
        `${path} mustNot`
      ).toEqual([]);
    }
  });

  it("keeps the known-violation list honest: each entry still happens, so a fix shrinks the list", () => {
    expect(violations(generatedRuns.deterministic), regenerate).toEqual(gen.knownViolations);
  });

  it("holds an adversarial chooser to no new applies, and tracks its wrong duplicates", () => {
    expect(newApplies(generatedRuns.deterministic, generatedRuns.adversarial)).toEqual([]);
    expect(gen.adversarialNewApplies).toEqual([]);
    expect(newWrongDuplicates(generatedRuns.deterministic, generatedRuns.adversarial), regenerate).toEqual(
      gen.adversarialNewWrongDuplicates
    );
  });

  it("scores every plan size and every kind, so none can go unmeasured", () => {
    expect(Object.keys(gen.metrics.deterministic.bySize).sort()).toEqual(["1x", "20x", "5x"]);
    for (const kind of KINDS) expect(gen.metrics.deterministic.byTag[kind], kind).toBeDefined();
  });

  it("calls a chooser only for asked cases, and never on the deterministic path", () => {
    expect(generatedRuns.deterministic.some((r) => r.outcome.usedChooser)).toBe(false);
    expect(generatedRuns.oracle.some((r) => r.outcome.usedChooser)).toBe(true);
  });
});

/**
 * A local sweep of about 20,000 cases. It has no baseline to compare with, so it asserts the hard
 * invariants and prints the figures: `REPLAY_LARGE=1 REPLAY_SEED=anything corepack pnpm --filter
 * @openrhen/contracts exec vitest run src/planning/replay/replay-suite.test.ts`.
 */
describe.skipIf(!env.REPLAY_LARGE)("large replay sweep (REPLAY_LARGE)", () => {
  it("holds the invariants on a large seeded run", { timeout: 600_000 }, () => {
    const seed = env.REPLAY_SEED ?? DEFAULT_SEED;
    const cases = generatedSuite(LARGE_COUNTS, seed);
    const sweep = runPaths(cases, referenceReconciler);
    const groups = scoreGroups(sweep.deterministic);
    console.log(`replay sweep: ${cases.length} cases, seed ${seed}`);
    for (const [size, metrics] of Object.entries(groups.bySize)) {
      const p = metrics.appliedPrecision;
      console.log(
        `  ${size}: ${metrics.cases} cases, applied precision ${p.k}/${p.n}, questions per 100 ${metrics.questionsPer100}`
      );
    }
    expect(newApplies(sweep.deterministic, sweep.adversarial)).toEqual([]);
    expect(sweep.deterministic.some((r) => r.outcome.usedChooser)).toBe(false);
    // The tie-result change empties this: no resolved guess on a tied top rank, outside the known kinds.
    const kinds = new Set(violations(sweep.deterministic).tieGuess.map((id) => id.split("-").slice(3).join("-")));
    expect([...kinds].sort()).toEqual(["ask-twin", "deadline-twin", "numbered", "twin", "twin-contact"]);
  });
});
