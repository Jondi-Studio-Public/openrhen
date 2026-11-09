import { describe, expect, it } from "vitest";
import { coolingPairs, nextConsequenceGroup, type GroupCandidate } from "./next-group.js";

const NOW = new Date("2026-11-09T00:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const candidate = (id: string, value: number, variance = 0.64, cohort = "projects", priv = false): GroupCandidate => ({
  id,
  value,
  variance,
  cohort,
  private: priv
});

describe("next consequence group", () => {
  it("builds the group around the highest-variance item and its three nearest neighbours by value", () => {
    const group = nextConsequenceGroup(
      [
        candidate("a", 3, 0.1),
        candidate("b", 3.1, 0.2),
        candidate("c", 4.5, 0.64),
        candidate("d", 4.0, 0.3),
        candidate("e", 2.0, 0.3),
        candidate("f", 4.9, 0.3)
      ],
      { now: NOW, recentGroups: [] }
    );
    expect(group!.anchorId).toBe("c");
    expect(group!.itemIds).toEqual(["c", "f", "d", "b"]);
  });

  it("breaks ties on the item id, whatever order the candidates arrive in", () => {
    const items = ["d", "c", "b", "a", "e"].map((id) => candidate(id, 3));
    const first = nextConsequenceGroup(items, { now: NOW, recentGroups: [] });
    const second = nextConsequenceGroup([...items].reverse(), { now: NOW, recentGroups: [] });
    expect(first).toEqual(second);
    expect(first!.itemIds).toEqual(["a", "b", "c", "d"]);
  });

  it("never repeats a pair asked in the last 30 days, and forgets it after", () => {
    const items = ["a", "b", "c", "d", "e"].map((id, i) => candidate(id, 3 + i * 0.01));
    const recent = [{ itemIds: ["a", "b", "c", "d"], askedAt: daysAgo(10) }];
    const group = nextConsequenceGroup(items, { now: NOW, recentGroups: recent });
    for (const x of group!.itemIds)
      for (const y of group!.itemIds) if (x < y) expect(coolingPairs(recent, NOW).has(`${x}\u0000${y}`)).toBe(false);
    expect(group!.itemIds).toHaveLength(2);
    const later = nextConsequenceGroup(items, {
      now: NOW,
      recentGroups: [{ itemIds: ["a", "b", "c", "d"], askedAt: daysAgo(31) }]
    });
    expect(later!.itemIds).toEqual(["a", "b", "c", "d"]);
  });

  it("moves to the next anchor when the first cannot gather a neighbour, and returns null when none can", () => {
    const items = [candidate("a", 3, 0.9), candidate("b", 3, 0.5), candidate("c", 3, 0.4)];
    const recent = [
      { itemIds: ["a", "b"], askedAt: daysAgo(1) },
      { itemIds: ["a", "c"], askedAt: daysAgo(1) }
    ];
    expect(nextConsequenceGroup(items, { now: NOW, recentGroups: recent })!.itemIds).toEqual(["b", "c"]);
    expect(
      nextConsequenceGroup(items, { now: NOW, recentGroups: [...recent, { itemIds: ["b", "c"], askedAt: daysAgo(1) }] })
    ).toBeNull();
    expect(nextConsequenceGroup([candidate("a", 3)], { now: NOW, recentGroups: [] })).toBeNull();
  });

  it("compares actions only with siblings of the same project", () => {
    const items = [
      candidate("a1", 3, 0.9, "p1"),
      candidate("a2", 3, 0.5, "p1"),
      candidate("b1", 3, 0.7, "p2"),
      candidate("b2", 3, 0.6, "p2"),
      candidate("b3", 3, 0.1, "p2")
    ];
    const group = nextConsequenceGroup(items, { now: NOW, recentGroups: [] });
    expect(group!.itemIds).toEqual(["a1", "a2"]);
    const next = nextConsequenceGroup(items, {
      now: NOW,
      recentGroups: [{ itemIds: ["a1", "a2"], askedAt: daysAgo(2) }]
    });
    expect(next!.itemIds).toEqual(["b1", "b2", "b3"]);
  });

  it("skips private items for agent-facing use and flags them otherwise", () => {
    const items = [candidate("a", 3, 0.9, "projects", true), candidate("b", 3, 0.5), candidate("c", 3, 0.4)];
    const forPerson = nextConsequenceGroup(items, { now: NOW, recentGroups: [] });
    expect(forPerson!.itemIds).toContain("a");
    expect(forPerson!.containsPrivate).toBe(true);
    const forAgent = nextConsequenceGroup(items, { now: NOW, recentGroups: [], agentFacing: true });
    expect(forAgent!.itemIds).toEqual(["b", "c"]);
    expect(forAgent!.containsPrivate).toBe(false);
  });

  it("ignores candidates that are not finite and duplicate ids", () => {
    const items = [candidate("a", NaN), candidate("b", 3), candidate("b", 4), candidate("c", 3)];
    expect(nextConsequenceGroup(items, { now: NOW, recentGroups: [] })!.itemIds).toEqual(["b", "c"]);
  });

  it("is a pure function: the same inputs give the same group", () => {
    const items = ["a", "b", "c", "d", "e", "f"].map((id, i) => candidate(id, 3 + (i % 3) * 0.2, 0.5));
    expect(nextConsequenceGroup(items, { now: NOW, recentGroups: [] })).toEqual(
      nextConsequenceGroup(items, { now: NOW, recentGroups: [] })
    );
  });
});
