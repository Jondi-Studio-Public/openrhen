import { describe, expect, it } from "vitest";
import { type SampleCandidate, drawSample } from "./eval-sampling.js";

const candidates: SampleCandidate[] = Array.from({ length: 60 }, (_, index) => ({
  id: `m${String(index).padStart(2, "0")}`,
  stratum: index % 3 === 0 ? "t0_flag" : index % 3 === 1 ? "keyword" : "other"
}));

describe("drawSample", () => {
  it("draws the random slice from everything and the stratified quota from each stratum, with no overlap", () => {
    const plan = drawSample({ candidates, perStratum: 4, randomSize: 10, seed: "eval-1" });
    expect(plan.random).toHaveLength(10);
    expect(plan.stratified.map((group) => group.stratum)).toEqual(["keyword", "other", "t0_flag"]);
    for (const group of plan.stratified) expect(group.ids).toHaveLength(4);
    const all = [...plan.random, ...plan.stratified.flatMap((group) => group.ids)];
    expect(new Set(all).size).toBe(all.length);
    for (const group of plan.stratified)
      for (const id of group.ids) expect(candidates.find((item) => item.id === id)!.stratum).toBe(group.stratum);
    expect(plan.shortfalls).toEqual([]);
  });

  it("is deterministic for a seed and does not depend on the order the candidates arrive in", () => {
    const first = drawSample({ candidates, perStratum: 3, randomSize: 7, seed: "same" });
    const again = drawSample({ candidates: [...candidates].reverse(), perStratum: 3, randomSize: 7, seed: "same" });
    expect(again).toEqual(first);
    expect(drawSample({ candidates, perStratum: 3, randomSize: 7, seed: "other" })).not.toEqual(first);
  });

  it("pins the draw for a seed (golden), so a change to the sampler is a visible decision", () => {
    const plan = drawSample({ candidates, perStratum: 2, randomSize: 4, seed: "golden" });
    expect(plan).toMatchInlineSnapshot(`
      {
        "random": [
          "m06",
          "m16",
          "m48",
          "m14",
        ],
        "randomToLabel": [
          "m06",
          "m16",
          "m48",
          "m14",
        ],
        "shortfalls": [],
        "stratified": [
          {
            "ids": [
              "m40",
              "m10",
            ],
            "stratum": "keyword",
          },
          {
            "ids": [
              "m23",
              "m41",
            ],
            "stratum": "other",
          },
          {
            "ids": [
              "m36",
              "m18",
            ],
            "stratum": "t0_flag",
          },
        ],
      }
    `);
  });

  it("draws the random slice over everything, labelled or not, and asks for labels only on the unlabelled", () => {
    const labelled = candidates.slice(0, 20).map((item) => item.id);
    const plan = drawSample({ candidates, perStratum: 2, randomSize: 12, seed: "s", alreadyLabelled: labelled });
    expect(plan.random).toHaveLength(12);
    expect(plan.randomToLabel).toEqual(plan.random.filter((id) => !labelled.includes(id)));
    // The stratified draw is for unlabelled messages only, and never repeats the random slice.
    const stratified = plan.stratified.flatMap((group) => group.ids);
    for (const id of stratified) {
      expect(labelled).not.toContain(id);
      expect(plan.random).not.toContain(id);
    }
  });

  it("is uniform over all candidates: a labelled message is as likely to be in the slice as an unlabelled one", () => {
    const pool = candidates.slice(0, 20);
    const labelled = pool.slice(0, 5).map((item) => item.id);
    const hits = new Map<string, number>();
    const runs = 4000;
    for (let run = 0; run < runs; run += 1)
      for (const id of drawSample({
        candidates: pool,
        perStratum: 0,
        randomSize: 5,
        seed: `u${run}`,
        alreadyLabelled: labelled
      }).random)
        hits.set(id, (hits.get(id) ?? 0) + 1);
    // Each of 20 candidates is expected in 5/20 = 25% of the draws; 4000 runs puts 3 standard deviations near +-2.1 points.
    for (const item of pool) expect((hits.get(item.id) ?? 0) / runs, item.id).toBeGreaterThan(0.2);
    for (const item of pool) expect((hits.get(item.id) ?? 0) / runs, item.id).toBeLessThan(0.3);
  });

  it("reports a stratum that cannot fill its quota", () => {
    const labelled = candidates
      .filter((item) => item.stratum === "keyword")
      .slice(0, 18)
      .map((item) => item.id);
    const plan = drawSample({ candidates, perStratum: 5, randomSize: 0, seed: "s", alreadyLabelled: labelled });
    const keyword = plan.stratified.find((group) => group.stratum === "keyword")!;
    expect(keyword.ids.length).toBeLessThan(5);
    expect(plan.shortfalls).toContainEqual({ stratum: "keyword", wanted: 5, got: keyword.ids.length });
  });

  it("returns what exists when the random slice is larger than the pool, and says so", () => {
    const plan = drawSample({ candidates: candidates.slice(0, 3), perStratum: 0, randomSize: 10, seed: "s" });
    expect(plan.random).toHaveLength(3);
    expect(plan.shortfalls).toContainEqual({ stratum: "random", wanted: 10, got: 3 });
  });

  it("refuses bad sizes, duplicate ids and an empty seed with the fix", () => {
    expect(() => drawSample({ candidates, perStratum: -1, randomSize: 1, seed: "s" })).toThrow(/perStratum/);
    expect(() => drawSample({ candidates, perStratum: 1, randomSize: 1.5, seed: "s" })).toThrow(/randomSize/);
    expect(() => drawSample({ candidates, perStratum: 1, randomSize: 1, seed: "" })).toThrow(/seed/);
    expect(() =>
      drawSample({ candidates: [candidates[0]!, candidates[0]!], perStratum: 1, randomSize: 1, seed: "s" })
    ).toThrow(/more than once/);
  });
});
