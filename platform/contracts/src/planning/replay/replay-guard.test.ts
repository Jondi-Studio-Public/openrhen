import { describe, expect, it } from "vitest";
import { fixtureProblems, NOTE_MAX } from "./replay-guard.js";
import type { ReplayCase } from "./replay-case.js";
import { generatedBaseline, goldenCases, lexicon } from "./replay-suite.js";
import baseline from "../../../test/replay/baseline.json" with { type: "json" };

const lex = { words: ["team", "sync"] };

describe("replay fixture privacy guard", () => {
  it("passes every committed fixture", () => {
    expect(fixtureProblems(goldenCases, lexicon, "golden")).toEqual([]);
    expect(fixtureProblems(baseline, lexicon, "baseline")).toEqual([]);
    expect(fixtureProblems(generatedBaseline, lexicon, "baseline-generated")).toEqual([]);
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
    expect(fixtureProblems({ from: "Sam <sam@elsewhere.invalid>" }, lex)).toContain(
      "fixture.from: address outside example.test"
    );
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

  it("is fail-closed: prose in a field the guard has no rule for is flagged", () => {
    expect(fixtureProblems({ memo: "call me on the usual line" }, lex)).toEqual([
      "fixture.memo: free text in a field the guard does not read"
    ]);
    expect(fixtureProblems({ from: "Sam <sam@example.test>" }, lex)).toEqual([
      "fixture.from: free text in a field the guard does not read"
    ]);
    expect(fixtureProblems({ id: "a1", startsAt: "2026-11-12T10:00:00Z", timezone: "Pacific/Auckland" }, lex)).toEqual(
      []
    );
  });

  it("holds a note to a length cap and the address and secret checks", () => {
    expect(fixtureProblems({ note: "Two twins, told apart by who sent it." }, lex)).toEqual([]);
    expect(fixtureProblems({ note: "x ".repeat(NOTE_MAX) }, lex)).toEqual([
      `fixture.note: note longer than ${NOTE_MAX} characters`
    ]);
    expect(fixtureProblems({ note: "ask pat@elsewhere.invalid" }, lex)).toEqual([
      "fixture.note: address outside example.test"
    ]);
  });
});

/**
 * The guard's own test, inverted: a guard that passes everything also passes the suite above, so
 * these plant something real-looking into each kind of field of every committed case and demand a
 * finding. A committed fixture that stopped being read (a renamed field, an empty lexicon) fails here.
 */
describe("replay fixture privacy guard, inverted", () => {
  const plant: Array<[string, (c: ReplayCase) => void, RegExp]> = [
    [
      "plan title",
      (c) => {
        (c.input.plan.commitments[0] ??
          c.input.plan.actions[0] ??
          c.input.plan.projects[0] ??
          c.input.plan.openFacts[0])!.title = "Dinner with Zed";
      },
      /is not in the lexicon/
    ],
    [
      "message quote",
      (c) => {
        const fact = c.input.message.facts[0];
        if (fact) fact.quote = "Zed wants a call";
        else c.input.message.from = "zed@elsewhere.invalid";
      },
      /is not in the lexicon|outside example\.test/
    ],
    [
      "sender",
      (c) => {
        c.input.message.from = "zed@elsewhere.invalid";
      },
      /outside example\.test/
    ],
    [
      "recipient display name",
      (c) => {
        c.input.message.to = "Zed Real <owner@example.test>";
      },
      /free text/
    ],
    [
      "note",
      (c) => {
        c.note = "see zed@elsewhere.invalid";
      },
      /outside example\.test/
    ],
    [
      "conversation key",
      (c) => {
        const fact = c.input.message.facts[0];
        if (fact) fact.conversationKey = "Re: quarterly numbers from Zed";
        else c.input.message.to = "Re: numbers from Zed";
      },
      /free text/
    ],
    [
      "gold reason",
      (c) => {
        c.gold.reason = "because Zed said so";
      },
      /free text/
    ]
  ];

  it("has fixtures and a lexicon to read, so a pass means something", () => {
    expect(goldenCases.length).toBeGreaterThanOrEqual(40);
    expect(lexicon.words.length).toBeGreaterThan(40);
    expect(fixtureProblems(goldenCases, { words: [] }).length).toBeGreaterThan(goldenCases.length);
  });

  for (const [what, apply, expected] of plant) {
    it(`finds a real-looking ${what} planted in any committed case`, () => {
      for (const original of goldenCases) {
        const planted = structuredClone(original);
        apply(planted);
        const problems = fixtureProblems(planted, lexicon, original.id);
        expect(
          problems.some((p) => expected.test(p)),
          `${original.id}: ${what} went unflagged`
        ).toBe(true);
      }
    });
  }

  it("finds a secret-shaped note and a pasted address in the baseline file", () => {
    const planted = structuredClone(baseline) as unknown as Record<string, unknown>;
    planted.note = ["gh", "p_", "B".repeat(30)].join("");
    expect(fixtureProblems(planted, lexicon, "baseline")).toContain("baseline.note: secret-shaped text");
    const listed = (planted.knownViolations as { mustNot: string[] }).mustNot;
    listed.push("zed@elsewhere.invalid");
    expect(fixtureProblems(planted, lexicon, "baseline")).toContain(
      `baseline.knownViolations.mustNot[${listed.length - 1}]: address outside example.test`
    );
  });
});
