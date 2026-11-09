import { describe, expect, it } from "vitest";
import { SOLVER_VERSION, ageWeight, fitConsequence } from "../../src/index.js";
import type { ConsequenceFitComparison, ConsequenceFitItem } from "../../src/index.js";

const items = (stars: Record<string, number>): ConsequenceFitItem[] =>
  Object.entries(stars).map(([id, value]) => ({ id, stars: value }));
const compare = (
  id: string,
  rankedIds: string[],
  extra: Partial<ConsequenceFitComparison> = {}
): ConsequenceFitComparison => ({
  id,
  rankedIds,
  weight: 1,
  ...extra
});
const valueOf = (results: ReturnType<typeof fitConsequence>, id: string) => results.find((row) => row.id === id)!;

const four = { a: 3, b: 3, c: 3, d: 3 };

describe("ageWeight", () => {
  it("halves every 180 days and never exceeds 1", () => {
    expect(ageWeight(0)).toBe(1);
    expect(ageWeight(180)).toBeCloseTo(0.5, 12);
    expect(ageWeight(360)).toBeCloseTo(0.25, 12);
    expect(ageWeight(-10)).toBe(1);
    expect(ageWeight(Number.NaN)).toBe(0);
  });
  it("exposes a solver version", () => {
    expect(SOLVER_VERSION).toBeGreaterThan(0);
  });
});

describe("fitConsequence", () => {
  it("returns exactly the stars for items with no comparisons", () => {
    const results = fitConsequence(items({ a: 2, b: 4, c: 3, d: 5, lonely: 1 }), [compare("g1", ["a", "b", "c", "d"])]);
    expect(valueOf(results, "lonely").value).toBe(1);
    expect(valueOf(results, "lonely").pressedAgainstBound).toBe(false);
    expect(fitConsequence(items({ x: 4 }), []).map((row) => row.value)).toEqual([4]);
  });

  it("is identical when items and comparisons arrive in a different order", () => {
    const comparisons = [
      compare("g1", ["a", "b", "c", "d"]),
      compare("g2", ["b", "a", "d", "c"], { weight: 0.7 }),
      compare("g3", ["c", "d", "a", "b"], { weight: 0.4 }),
      compare("g4", ["a", "c", "b", "d"])
    ];
    const baseline = fitConsequence(items(four), comparisons);
    const shuffledComparisons = [comparisons[2]!, comparisons[0]!, comparisons[3]!, comparisons[1]!];
    const shuffledItems = items({ d: 3, b: 3, a: 3, c: 3 });
    expect(fitConsequence(shuffledItems, shuffledComparisons)).toEqual(baseline);
    expect(fitConsequence(items(four), comparisons)).toEqual(baseline);
  });

  it("pulls values apart in the answered order", () => {
    const results = fitConsequence(items(four), [compare("g1", ["a", "b", "c", "d"])]);
    const [a, b, c, d] = ["a", "b", "c", "d"].map((id) => valueOf(results, id).value);
    expect(a!).toBeGreaterThan(b!);
    expect(b!).toBeGreaterThan(c!);
    expect(c!).toBeGreaterThan(d!);
    expect(a!).toBeGreaterThan(3);
    expect(d!).toBeLessThan(3);
  });

  it("keeps every value inside one star of its stars and flags items pressed against the bound", () => {
    const comparisons = Array.from({ length: 30 }, (_, n) =>
      compare(`g${String(n).padStart(2, "0")}`, ["a", "b", "c", "d"])
    );
    const results = fitConsequence(items(four), comparisons);
    for (const row of results) expect(Math.abs(row.value - 3)).toBeLessThanOrEqual(1);
    expect(valueOf(results, "a").value).toBe(4);
    expect(valueOf(results, "a").pressedAgainstBound).toBe(true);
    expect(valueOf(results, "d").value).toBe(2);
    expect(valueOf(results, "d").pressedAgainstBound).toBe(true);
    // The stored order equals the fitted order even at the bound.
    const stored = results.map((row) => row.value);
    expect([...stored].sort((x, y) => y - x)).toEqual(stored);
  });

  it("stays within 0..6 at the extreme star values", () => {
    const comparisons = Array.from({ length: 40 }, (_, n) =>
      compare(`g${String(n).padStart(2, "0")}`, ["hi", "lo", "x", "y"])
    );
    const results = fitConsequence(items({ hi: 5, lo: 1, x: 5, y: 1 }), comparisons);
    for (const row of results) {
      expect(row.value).toBeGreaterThanOrEqual(0);
      expect(row.value).toBeLessThanOrEqual(6);
    }
  });

  it("shrinks toward the prior when answers contradict each other", () => {
    const agree = fitConsequence(items(four), [
      compare("g1", ["a", "b", "c", "d"]),
      compare("g2", ["a", "b", "c", "d"])
    ]);
    const contradict = fitConsequence(items(four), [
      compare("g1", ["a", "b", "c", "d"]),
      compare("g2", ["d", "c", "b", "a"])
    ]);
    const spread = (rows: typeof agree) => valueOf(rows, "a").value - valueOf(rows, "d").value;
    expect(spread(contradict)).toBeLessThan(spread(agree));
    expect(Math.abs(spread(contradict))).toBeLessThan(0.05);
  });

  it("ignores ties, and unknown ids and invalid weights carry no information", () => {
    const base = fitConsequence(items(four), [compare("g1", ["a", "b", "c", "d"])]);
    const withNoise = fitConsequence(items(four), [
      compare("g1", ["a", "b", "c", "d"]),
      compare("t1", ["d", "c", "b", "a"], { tie: true }),
      compare("z1", ["d", "ghost", "b", "a"], { weight: 0 }),
      compare("z2", ["ghost", "other"]),
      compare("z3", ["a", "b"], { weight: -1 })
    ]);
    expect(withNoise).toEqual(base);
    const onlyTie = fitConsequence(items(four), [compare("t1", ["a", "b", "c", "d"], { tie: true })]);
    expect(onlyTie.map((row) => row.value)).toEqual([3, 3, 3, 3]);
  });

  it("drops completed items from the fit while they keep their stars", () => {
    const withDone = fitConsequence(
      [...items({ a: 3, b: 3, c: 3 }), { id: "d", stars: 3, status: "done" }],
      [compare("g1", ["a", "b", "c", "d"])]
    );
    const without = fitConsequence(items({ a: 3, b: 3, c: 3 }), [compare("g1", ["a", "b", "c"])]);
    expect(valueOf(withDone, "d").value).toBe(3);
    for (const id of ["a", "b", "c"]) expect(valueOf(withDone, id)).toEqual(valueOf(without, id));
  });

  it("gives less certain items a larger variance than well-compared ones", () => {
    const results = fitConsequence(items({ ...four, quiet: 3 }), [
      compare("g1", ["a", "b", "c", "d"]),
      compare("g2", ["b", "a", "d", "c"])
    ]);
    expect(valueOf(results, "quiet").variance).toBeGreaterThan(valueOf(results, "a").variance);
    for (const row of results) expect(Number.isFinite(row.variance)).toBe(true);
  });

  it("never produces a non-finite or out-of-range value from garbage input", () => {
    const garbage = fitConsequence(
      [
        { id: "a", stars: Number.NaN },
        { id: "b", stars: Number.POSITIVE_INFINITY },
        { id: "c", stars: -50 },
        { id: "d", stars: 900 },
        { id: "a", stars: 2 }
      ],
      [
        compare("g1", ["a", "b", "c", "d"], { weight: Number.NaN }),
        compare("g2", ["a", "b", "c", "d"], { weight: Number.POSITIVE_INFINITY }),
        compare("g3", ["a", "a", "a", "b"]),
        compare("g4", ["a", "b", "c", "d"], { weight: 1e12 }),
        compare("g5", ["d", "c", "b", "a"], { weight: 1e-300 }),
        { id: "g6", rankedIds: undefined as unknown as string[], weight: 1 }
      ]
    );
    expect(garbage).toHaveLength(4);
    for (const row of garbage) {
      expect(Number.isFinite(row.value)).toBe(true);
      expect(Number.isFinite(row.variance)).toBe(true);
      expect(row.value).toBeGreaterThanOrEqual(0);
      expect(row.value).toBeLessThanOrEqual(6);
      expect(Math.round(row.value * 100) / 100).toBe(row.value);
    }
  });
});
