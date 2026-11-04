import { describe, expect, it } from "vitest";
import { deferPairPartners, splitFeedMovePair } from "./feed-move-pairs";

const rec = (id: string, feedMove?: string, feedMoveSize?: string) => ({
  id,
  relationships: { ...(feedMove ? { feedMove } : {}), ...(feedMoveSize ? { feedMoveSize } : {}) }
});

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
  it("rejects a lone half of a pair that names its size, however it is ticked, and accepts it left out", () => {
    const lone = [rec("a", "p1", "2")];
    expect(splitFeedMovePair(lone, () => true)).toMatch(/go together/);
    expect(splitFeedMovePair(lone, () => false)).toBeNull();
    expect(splitFeedMovePair([rec("a", "p1", "2"), rec("b", "p1", "2")], () => true)).toBeNull();
  });
  it("names the cause and the next call in its refusal", () => {
    const message = splitFeedMovePair([rec("a", "p1"), rec("b", "p1")], (r) => r.id === "a")!;
    expect(message).toContain("loses the meeting");
    expect(message).toContain("doubles it");
    expect(message).toContain("PUT /api/imports/{batchId}");
    expect(message).toContain("POST /api/imports/{batchId}/commit-ready");
  });
  it("is inert for records without relationships", () => {
    expect(splitFeedMovePair([{ id: "x", relationships: undefined as never }], () => false)).toBeNull();
  });
});

describe("deferPairPartners", () => {
  const full = (id: string, feedMove?: string, removed = false) => ({
    id,
    removed,
    relationships: feedMove ? { feedMove } : {}
  });

  it("takes the other half of a deferred pair along, and nothing else", () => {
    const records = [full("a", "p1"), full("b", "p1"), full("c", "p2"), full("d")];
    expect(deferPairPartners(records, [records[0]!]).map((r) => r.id)).toEqual(["a", "b"]);
    expect(deferPairPartners(records, [records[3]!]).map((r) => r.id)).toEqual(["d"]);
    expect(deferPairPartners(records, []).map((r) => r.id)).toEqual([]);
  });

  it("leaves a partner the person unselected where it is, and does not repeat one already deferred", () => {
    const records = [full("a", "p1"), full("b", "p1", true)];
    expect(deferPairPartners(records, [records[0]!]).map((r) => r.id)).toEqual(["a"]);
    const both = [full("a", "p1"), full("b", "p1")];
    expect(deferPairPartners(both, both).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("makes a split pair whole for the commit check: no half is left ready", () => {
    const records = [full("a", "p1"), full("b", "p1")];
    const deferred = new Set(deferPairPartners(records, [records[0]!]).map((r) => r.id));
    expect(splitFeedMovePair(records, (r) => !deferred.has(r.id))).toBeNull();
  });
});
