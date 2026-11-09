import { describe, expect, it } from "vitest";
import { fixtureProblems } from "./replay-guard.js";
import { goldenCases, lexicon } from "./replay-suite.js";
import baseline from "../../../test/replay/baseline.json" with { type: "json" };

const lex = { words: ["team", "sync"] };

describe("replay fixture privacy guard", () => {
  it("passes every committed fixture", () => {
    expect(fixtureProblems(goldenCases, lexicon, "golden")).toEqual([]);
    expect(fixtureProblems(baseline, lexicon, "baseline")).toEqual([]);
  });

  it("flags a word outside the lexicon in a title, quote or name only", () => {
    expect(fixtureProblems({ title: "Team sync" }, lex)).toEqual([]);
    expect(fixtureProblems({ facts: [{ quote: "Team sync with Zed" }] }, lex)).toEqual([
      'fixture.facts[0].quote: word "with" is not in the lexicon',
      'fixture.facts[0].quote: word "zed" is not in the lexicon'
    ]);
    expect(fixtureProblems({ id: "anything-goes-here" }, lex)).toEqual([]);
  });

  it("flags an address outside example.test", () => {
    expect(fixtureProblems({ from: "sam@example.test" }, lex)).toEqual([]);
    expect(fixtureProblems({ from: "Sam <sam@elsewhere.invalid>" }, lex)).toEqual([
      "fixture.from: address outside example.test"
    ]);
  });

  it("flags key- and token-shaped text, built at run time", () => {
    const shapes = [
      ["sk", "-", "a".repeat(24)].join(""),
      ["gh", "p_", "B".repeat(30)].join(""),
      ["AK", "IA", "A".repeat(16)].join(""),
      ["Bearer ", "c".repeat(24)].join(""),
      ["-----BEGIN ", "PRIVATE KEY-----"].join(""),
      "0123456789abcdef".repeat(2),
      ["ey", "J", "a".repeat(12), ".", "b".repeat(12)].join("")
    ];
    for (const text of shapes)
      expect(fixtureProblems({ note: text }, lex), text).toContain("fixture.note: secret-shaped text");
    expect(fixtureProblems({ note: "2026-11-12T10:00:00Z" }, lex)).toEqual([]);
  });
});
