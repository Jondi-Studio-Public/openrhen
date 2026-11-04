import { describe, expect, it } from "vitest";
import { splitFeedMovePair } from "./feed-move-pairs";

const rec = (id: string, feedMove?: string) => ({ id, relationships: feedMove ? { feedMove } : {} });

describe("splitFeedMovePair", () => {
  it("accepts a whole pair, a pair wholly left out, and records with no pair", () => {
    const records = [rec("a", "p1"), rec("b", "p1"), rec("c")];
    expect(splitFeedMovePair(records, () => true)).toBeNull();
    expect(splitFeedMovePair(records, (r) => r.id === "c")).toBeNull();
  });
  it("rejects one half of a pair", () => {
    const records = [rec("a", "p1"), rec("b", "p1")];
    expect(splitFeedMovePair(records, (r) => r.id === "a")).toMatch(/go together/);
  });
  it("judges each pair on its own", () => {
    const records = [rec("a", "p1"), rec("b", "p1"), rec("c", "p2"), rec("d", "p2")];
    expect(splitFeedMovePair(records, (r) => r.id !== "d")).not.toBeNull();
    expect(splitFeedMovePair(records, (r) => r.id === "a" || r.id === "b")).toBeNull();
  });
  it("is inert for records without relationships", () => {
    expect(splitFeedMovePair([{ id: "x", relationships: undefined as never }], () => false)).toBeNull();
  });
});
