import { describe, expect, it } from "vitest";
import { fitConsequence } from "@openrhen/contracts/consequence-fit";
import {
  INFERRED_ITEM_DAY_CEILING,
  INFERRED_ITEM_TOTAL_CEILING,
  localDay,
  usableComparisons,
  wholeDaysBetween,
  type LoggedComparison,
  type PoolItem
} from "./usable-comparisons.js";

const item = (id: string, stars = 3, status = "active", hash = `h-${id}`): PoolItem => ({
  id,
  stars,
  status,
  materialHash: hash
});
const ITEMS = ["a", "b", "c", "d"].map((id) => item(id));

const answer = (
  id: string,
  at: string,
  overrides: Partial<LoggedComparison> = {},
  ranking = ["a", "b", "c", "d"]
): LoggedComparison => ({
  id,
  itemIds: ["a", "b", "c", "d"],
  itemStars: [3, 3, 3, 3],
  itemHashes: ["h-a", "h-b", "h-c", "h-d"],
  ranking,
  tie: false,
  basis: "stated",
  answeredAt: new Date(at),
  ...overrides
});

const DAY = "2026-11-09";

describe("local days", () => {
  it("reads the calendar day in the person's zone, and an unknown zone as UTC", () => {
    const at = new Date("2026-11-08T20:30:00Z");
    expect(localDay(at, "Australia/Sydney")).toBe("2026-11-09");
    expect(localDay(at, "America/Los_Angeles")).toBe("2026-11-08");
    expect(localDay(at, "Not/AZone")).toBe("2026-11-08");
  });
  it("counts whole calendar days, never negative", () => {
    expect(wholeDaysBetween("2026-11-08", "2026-11-09")).toBe(1);
    expect(wholeDaysBetween("2026-02-27", "2026-03-01")).toBe(2);
    expect(wholeDaysBetween("2026-11-10", "2026-11-09")).toBe(0);
  });
});

describe("usable comparisons: weights", () => {
  it("weights a same-day stated answer 1 and halves it every 180 local days", () => {
    const today = usableComparisons(ITEMS, [answer("1", "2026-11-09T01:00:00Z")], DAY, "UTC");
    expect(today.comparisons[0]!.weight).toBe(1);
    const old = usableComparisons(ITEMS, [answer("1", "2026-05-13T01:00:00Z")], DAY, "UTC");
    expect(old.comparisons[0]!.weight).toBeCloseTo(0.5, 6);
  });

  it("takes the age in calendar days of the person's zone, not 24-hour blocks", () => {
    // 23:30 Sydney on the 8th is 12:30Z; at 00:30 Sydney on the 9th it is one calendar day old, though an hour old.
    const sydney = usableComparisons(ITEMS, [answer("1", "2026-11-08T12:30:00Z")], DAY, "Australia/Sydney");
    expect(sydney.comparisons[0]!.weight).toBeCloseTo(Math.pow(0.5, 1 / 180), 9);
    const utc = usableComparisons(ITEMS, [answer("1", "2026-11-08T12:30:00Z")], DAY, "UTC");
    expect(utc.comparisons[0]!.weight).toBeCloseTo(Math.pow(0.5, 1 / 180), 9);
    const same = usableComparisons(ITEMS, [answer("1", "2026-11-08T14:30:00Z")], DAY, "Australia/Sydney");
    expect(same.comparisons[0]!.weight).toBe(1);
  });

  it("counts observed as stated and inferred as half", () => {
    const result = usableComparisons(
      ITEMS,
      [
        answer("1", "2026-11-09T01:00:00Z", { basis: "observed" }),
        answer("2", "2026-11-09T02:00:00Z", { basis: "inferred" })
      ],
      DAY,
      "UTC"
    );
    expect(result.comparisons.map((c) => c.weight)).toEqual([1, 0.5]);
  });

  it("drops an answer with a basis it does not know", () => {
    const result = usableComparisons(ITEMS, [answer("1", "2026-11-09T01:00:00Z", { basis: "guess" })], DAY, "UTC");
    expect(result.comparisons).toEqual([]);
    expect(result.dropped).toEqual([{ id: "1", reason: "bad_row" }]);
  });
});

describe("usable comparisons: the inferred ceiling", () => {
  const inferred = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      answer(`g${String(i).padStart(3, "0")}`, `2026-11-09T0${i % 9}:00:00Z`, { basis: "inferred" })
    );

  it("lets one item collect no more than the per-day ceiling from answers given on one day", () => {
    const result = usableComparisons(ITEMS, inferred(8), DAY, "UTC");
    const total = result.comparisons.reduce((sum, c) => sum + c.weight, 0);
    expect(total).toBeCloseTo(INFERRED_ITEM_DAY_CEILING, 9);
    expect(result.dropped.every((d) => d.reason === "inferred_ceiling")).toBe(true);
    expect(result.dropped).toHaveLength(7);
  });

  it("caps an item's total across days, so a daily habit of guessing cannot build up", () => {
    const days = Array.from({ length: 10 }, (_, i) =>
      answer(`g${i}`, `2026-11-${String(i + 1).padStart(2, "0")}T01:00:00Z`, { basis: "inferred" })
    );
    const result = usableComparisons(ITEMS, days, DAY, "UTC");
    const total = result.comparisons.reduce((sum, c) => sum + c.weight, 0);
    expect(total).toBeLessThanOrEqual(INFERRED_ITEM_TOTAL_CEILING + 1e-9);
    expect(total).toBeGreaterThan(0.9);
  });

  it("keeps the fit well inside the bound however many identical guesses arrive", () => {
    const result = usableComparisons(ITEMS, inferred(200), DAY, "UTC");
    const fit = fitConsequence(ITEMS, result.comparisons);
    for (const r of fit) {
      expect(r.pressedAgainstBound).toBe(false);
      expect(Math.abs(r.value - 3)).toBeLessThan(0.8);
    }
  });

  it("does not let inferred answers use up the room a stated answer needs", () => {
    const result = usableComparisons(ITEMS, [...inferred(8), answer("stated", "2026-11-09T09:30:00Z")], DAY, "UTC");
    expect(result.comparisons.find((c) => c.id === "stated")!.weight).toBe(1);
  });

  it("is deterministic however the log arrives", () => {
    const log = inferred(8);
    const a = usableComparisons(ITEMS, log, DAY, "UTC");
    const b = usableComparisons(ITEMS, [...log].reverse(), DAY, "UTC");
    expect(b.comparisons).toEqual(a.comparisons);
  });
});

describe("usable comparisons: staleness", () => {
  it("drops an answer whose item's stars changed since it was given", () => {
    const items = [item("a", 4), item("b"), item("c"), item("d")];
    const result = usableComparisons(items, [answer("1", "2026-11-09T01:00:00Z")], DAY, "UTC");
    expect(result.comparisons).toEqual([]);
    expect(result.dropped).toEqual([{ id: "1", reason: "stale" }]);
    expect(result.touchedIds.size).toBe(0);
  });

  it("drops an answer whose item's material fields changed", () => {
    const items = [item("a", 3, "active", "other-hash"), item("b"), item("c"), item("d")];
    const result = usableComparisons(items, [answer("1", "2026-11-09T01:00:00Z")], DAY, "UTC");
    expect(result.dropped).toEqual([{ id: "1", reason: "stale" }]);
  });

  it("drops the whole answer, not just the changed item, so staleness cannot compound", () => {
    const items = [item("a"), item("b", 5), item("c"), item("d")];
    const other = answer(
      "2",
      "2026-11-09T02:00:00Z",
      { itemIds: ["a", "c"], itemStars: [3, 3], itemHashes: ["h-a", "h-c"] },
      ["a", "c"]
    );
    const result = usableComparisons(items, [answer("1", "2026-11-09T01:00:00Z"), other], DAY, "UTC");
    expect(result.comparisons.map((c) => c.id)).toEqual(["2"]);
    expect([...result.touchedIds].sort()).toEqual(["a", "c"]);
  });

  it("lets a finished, cancelled, archived or missing item leave an answer that stays for the rest", () => {
    const items = [item("a"), item("b", 3, "done"), item("c", 3, "archived"), item("d", 3, "cancelled")];
    expect(usableComparisons(items, [answer("1", "2026-11-09T01:00:00Z")], DAY, "UTC").dropped).toEqual([
      { id: "1", reason: "too_few_items" }
    ]);
    const live = [item("a"), item("b"), item("c", 3, "done")];
    const result = usableComparisons(live, [answer("1", "2026-11-09T01:00:00Z")], DAY, "UTC");
    expect(result.comparisons[0]!.rankedIds).toEqual(["a", "b"]);
    expect(result.touchedIds.has("c")).toBe(false);
  });

  it("does not hold an answer against an inactive item whose stars or fields changed", () => {
    const items = [item("a"), item("b"), item("c", 5, "done", "changed"), item("d")];
    const result = usableComparisons(items, [answer("1", "2026-11-09T01:00:00Z")], DAY, "UTC");
    expect(result.comparisons[0]!.rankedIds).toEqual(["a", "b", "d"]);
  });

  it("ignores a tie, which carries nothing, and a row whose parallel arrays disagree", () => {
    const result = usableComparisons(
      ITEMS,
      [
        answer("1", "2026-11-09T01:00:00Z", { tie: true, ranking: null }),
        answer("2", "2026-11-09T02:00:00Z", { itemStars: [3, 3] })
      ],
      DAY,
      "UTC"
    );
    expect(result.dropped).toEqual([
      { id: "1", reason: "tie" },
      { id: "2", reason: "bad_row" }
    ]);
  });
});
