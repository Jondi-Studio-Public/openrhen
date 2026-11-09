import { describe, expect, it } from "vitest";
import type { PoolRow } from "./pool-load.js";
import { planRefit } from "./refit-plan.js";
import { usableComparisons, type LoggedComparison } from "./usable-comparisons.js";

const DAY = "2026-11-09";
const row = (id: string, overrides: Partial<PoolRow> = {}): PoolRow => ({
  id,
  stars: 3,
  status: "active",
  materialHash: `h-${id}`,
  title: id,
  cohort: "projects",
  private: false,
  refined: null,
  refinedForStars: null,
  refinedAsOf: null,
  ...overrides
});
const log: LoggedComparison = {
  id: "1",
  itemIds: ["a", "b", "c", "d"],
  itemStars: [3, 3, 3, 3],
  itemHashes: ["h-a", "h-b", "h-c", "h-d"],
  ranking: ["a", "b", "c", "d"],
  tie: false,
  basis: "stated",
  answeredAt: new Date("2026-11-09T01:00:00Z")
};
const rows = (overrides: Record<string, Partial<PoolRow>> = {}) =>
  ["a", "b", "c", "d"].map((id) => row(id, overrides[id]));

describe("refit plan", () => {
  it("writes each item's fitted value with its current stars", () => {
    const items = rows();
    const plan = planRefit(items, usableComparisons(items, [log], DAY, "UTC"), DAY);
    expect(plan.clears).toEqual([]);
    expect(plan.writes.map((w) => w.id)).toEqual(["a", "b", "c", "d"]);
    expect(plan.writes.every((w) => w.stars === 3)).toBe(true);
    expect(plan.writes[0]!.value).toBeGreaterThan(plan.writes[3]!.value);
  });

  it("overwrites for_stars with the current stars on every fit, even when the value is unchanged", () => {
    const items = rows();
    const first = planRefit(items, usableComparisons(items, [log], DAY, "UTC"), DAY);
    // The stored row says it was fitted for 2 stars (an older fit); the value happens to match.
    const stored = rows(
      Object.fromEntries(first.writes.map((w) => [w.id, { refined: w.value, refinedForStars: 2, refinedAsOf: DAY }]))
    );
    const again = planRefit(stored, usableComparisons(stored, [log], DAY, "UTC"), DAY);
    expect(again.writes.map((w) => [w.id, w.stars])).toEqual([
      ["a", 3],
      ["b", 3],
      ["c", 3],
      ["d", 3]
    ]);
  });

  it("leaves a row that already holds exactly the target alone, so a quiet refit writes nothing", () => {
    const items = rows();
    const first = planRefit(items, usableComparisons(items, [log], DAY, "UTC"), DAY);
    const stored = rows(
      Object.fromEntries(first.writes.map((w) => [w.id, { refined: w.value, refinedForStars: 3, refinedAsOf: DAY }]))
    );
    expect(planRefit(stored, usableComparisons(stored, [log], DAY, "UTC"), DAY)).toEqual({ writes: [], clears: [] });
  });

  it("clears the three columns of an item left with no usable comparison, and does not fit a stale star edit", () => {
    // `a` was edited to 4 stars after the answer: the whole answer is dropped, so everything stored is cleared.
    const stored = rows({
      a: { stars: 4, refined: 3.4, refinedForStars: 3, refinedAsOf: "2026-11-01" },
      b: { refined: 3.1, refinedForStars: 3, refinedAsOf: "2026-11-01" },
      c: {},
      d: {}
    });
    const plan = planRefit(stored, usableComparisons(stored, [log], DAY, "UTC"), DAY);
    expect(plan.writes).toEqual([]);
    expect(plan.clears).toEqual(["a", "b"]);
  });

  it("clears an inactive item's stored value", () => {
    const stored = rows({ d: { status: "done", refined: 2.5, refinedForStars: 3, refinedAsOf: DAY } });
    const plan = planRefit(stored, usableComparisons(stored, [log], DAY, "UTC"), DAY);
    expect(plan.clears).toEqual(["d"]);
    expect(plan.writes.map((w) => w.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps every written value finite and within 0..6", () => {
    const items = rows();
    const plan = planRefit(items, usableComparisons(items, [log, { ...log, id: "2" }], DAY, "UTC"), DAY);
    for (const w of plan.writes) {
      expect(Number.isFinite(w.value)).toBe(true);
      expect(w.value).toBeGreaterThanOrEqual(0);
      expect(w.value).toBeLessThanOrEqual(6);
    }
  });
});
