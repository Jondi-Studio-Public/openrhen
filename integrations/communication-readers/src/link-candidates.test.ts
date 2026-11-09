import { describe, expect, it } from "vitest";
import { MAX_LINK_CANDIDATES, linkCandidates, linkFromChoice, type LinkPoolFact } from "./link-candidates.js";

const id = (n: number) => n.toString(16).padStart(40, "0");
const fact = (n: number, over: Partial<LinkPoolFact> = {}): LinkPoolFact => ({
  factId: id(n),
  conversationKey: "gmail:t1",
  factType: "event",
  tsStart: 1000 + n,
  quote: `quote ${n}`,
  ...over
});
const target = { conversationKey: "gmail:t1", tsStart: 5000, factId: id(99) };

describe("linkCandidates", () => {
  it("lists at most 5, newest first, labelled c1 to c5", () => {
    const pool = Array.from({ length: 9 }, (_, n) => fact(n + 1));
    const got = linkCandidates(target, pool);
    expect(got).toHaveLength(MAX_LINK_CANDIDATES);
    expect(got.map((c) => c.label)).toEqual(["c1", "c2", "c3", "c4", "c5"]);
    expect(got.map((c) => c.factId)).toEqual([9, 8, 7, 6, 5].map(id));
  });

  it("offers only the same conversation, strictly earlier messages, and never the fact itself", () => {
    const pool = [
      fact(1, { conversationKey: "gmail:other" }),
      fact(2, { tsStart: 5000 }),
      fact(3, { tsStart: 6000 }),
      fact(99, { tsStart: 10 }),
      fact(4)
    ];
    expect(linkCandidates(target, pool).map((c) => c.factId)).toEqual([id(4)]);
  });

  it("skips link rows and facts already closed", () => {
    expect(
      linkCandidates(target, [fact(1, { isLink: true }), fact(2, { closed: true }), fact(3)]).map((c) => c.factId)
    ).toEqual([id(3)]);
  });

  it("lists a fact id once, by its latest row", () => {
    const got = linkCandidates(target, [
      fact(1, { tsStart: 10, quote: "old" }),
      fact(1, { tsStart: 20, quote: "new" })
    ]);
    expect(got).toHaveLength(1);
    expect(got[0]?.quote).toBe("new");
  });

  it("lets the latest row decide: an older open row does not revive a fact whose newest row is closed", () => {
    const pool = [
      fact(1, { tsStart: 10 }),
      fact(1, { tsStart: 20, closed: true }),
      fact(2, { tsStart: 10, closed: true }),
      fact(2, { tsStart: 20 })
    ];
    expect(linkCandidates(target, pool).map((c) => c.factId)).toEqual([id(2)]);
  });

  it("puts the same calendar uid first, even if older", () => {
    const got = linkCandidates({ ...target, icsUid: "uid-1" }, [
      fact(1, { icsUid: "uid-1", tsStart: 5 }),
      fact(2),
      fact(3)
    ]);
    expect(got.map((c) => c.factId)).toEqual([id(1), id(3), id(2)]);
  });

  it("is deterministic and empty for an empty pool or non-finite times", () => {
    expect(linkCandidates(target, [])).toEqual([]);
    expect(linkCandidates(target, [fact(1, { tsStart: Number.NaN })])).toEqual([]);
    const pool = [fact(1, { tsStart: 7 }), fact(2, { tsStart: 7 })];
    expect(linkCandidates(target, pool)).toEqual(linkCandidates(target, [...pool].reverse()));
  });
});

describe("linkFromChoice", () => {
  const candidates = linkCandidates(target, [fact(1), fact(2)]);
  it("turns a relation and an offered label into a link", () => {
    expect(linkFromChoice(candidates, "cancel", "c1")).toEqual({ relation: "cancel", target_fact_id: id(2) });
  });
  it("refuses a label that was not offered, an id, or an unknown relation", () => {
    expect(linkFromChoice(candidates, "cancel", "c3")).toBeNull();
    expect(linkFromChoice(candidates, "cancel", id(2))).toBeNull();
    expect(linkFromChoice(candidates, "delete", "c1")).toBeNull();
    expect(linkFromChoice(candidates, 5, null)).toBeNull();
  });
});
