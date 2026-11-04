import { describe, expect, it } from "vitest";
import {
  proposeRuleLinks,
  scoreProposers,
  selectNewSuggestions,
  unitCodesIn,
  type ExistingLink,
  type ProposerSnapshot
} from "./plan-map-proposers.js";

const CODE_PATTERN = String.raw`\b(?![A-Z]{3}[5-9]\d{4}\b)(?:[A-Z]{3,7}\d{3,4}[A-Z]?|[A-Z]{3}\d{5})\b`;

const empty: ProposerSnapshot = {
  projects: [],
  deliverables: [],
  actions: [],
  commitments: [],
  sources: [],
  subjectIds: ["maths", "meals", "exercise", "drafting", "money"],
  codePattern: CODE_PATTERN
};

const item = (type: "project" | "commitment" | "action" | "source" | "deliverable", id: string, title: string) => ({
  type,
  id,
  title
});

describe("unitCodesIn", () => {
  it("finds College style codes and nothing else", () => {
    expect(unitCodesIn("QRSTUV272 class and XYZWVU2001 prep, ISO 9001", CODE_PATTERN)).toEqual([
      "QRSTUV272",
      "XYZWVU2001"
    ]);
    expect(unitCodesIn("Meet at room 272", CODE_PATTERN)).toEqual([]);
    expect(unitCodesIn("QRSTUV272", null)).toEqual([]);
    expect(unitCodesIn("QRSTUV272", undefined)).toEqual([]);
  });
});

describe("proposeRuleLinks", () => {
  it("links a commitment to the project naming the same unit code as an occurrence, on the recurring class", () => {
    const links = proposeRuleLinks({
      ...empty,
      commitments: [item("commitment", "rule-1", "QRSTUV272 class")],
      projects: [item("project", "p1", "QRSTUV272 Sustainability"), item("project", "p2", "XYZWVU2001 Plans")]
    });
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      fromType: "commitment",
      fromId: "rule-1",
      toType: "project",
      toId: "p1",
      kind: "occurrence_of",
      proposer: "rule:unit-code-occurrence"
    });
    expect(links[0]!.evidence[0]).toContain("QRSTUV272");
  });

  it("links work to a source naming the same unit code", () => {
    const links = proposeRuleLinks({
      ...empty,
      projects: [item("project", "p1", "QRSTUV272 Sustainability")],
      sources: [item("source", "s1", "QRSTUV272 unit guide"), item("source", "s2", "Other guide")]
    });
    expect(links.map((l) => [l.kind, l.toId])).toEqual([["references", "s1"]]);
  });

  it("suggests no code links with a null or absent pattern, but still suggests subject links", () => {
    const { codePattern: _pattern, ...noPattern } = empty;
    const base: ProposerSnapshot = {
      ...noPattern,
      commitments: [item("commitment", "rule-1", "QRSTUV272 class")],
      projects: [item("project", "p1", "QRSTUV272 Sustainability")],
      sources: [item("source", "s1", "QRSTUV272 unit guide")],
      actions: [item("action", "a1", "Meal prep for the week")]
    };
    for (const extra of [{ codePattern: null }, {}]) {
      const links = proposeRuleLinks({ ...base, ...extra });
      expect(links.some((l) => l.proposer.startsWith("rule:unit-code"))).toBe(false);
      expect(links.map((l) => [l.fromId, l.toId])).toEqual([["a1", "meals"]]);
    }
  });

  it("suggests an about link by whole-word match and only to existing subjects", () => {
    const snapshot: ProposerSnapshot = {
      ...empty,
      actions: [item("action", "a1", "Meal prep for the week"), item("action", "a2", "Runway design")],
      subjectIds: ["meals"]
    };
    const links = proposeRuleLinks(snapshot);
    expect(links.map((l) => [l.fromId, l.toId])).toEqual([["a1", "meals"]]);
    expect(proposeRuleLinks({ ...snapshot, subjectIds: [] })).toEqual([]);
  });

  it("does not match a word inside another word", () => {
    expect(proposeRuleLinks({ ...empty, actions: [item("action", "a", "Brunch with Stan")] })).toEqual([]);
    expect(proposeRuleLinks({ ...empty, actions: [item("action", "a", "Fix the rental agreement")] })).toEqual([]);
  });
});

describe("selectNewSuggestions", () => {
  const candidate = proposeRuleLinks({ ...empty, actions: [item("action", "a1", "Go swimming")] });
  const stored = (status: ExistingLink["status"], evidence: string[] = []): ExistingLink => ({
    fromType: "action",
    fromId: "a1",
    toType: "subject",
    toId: "exercise",
    kind: "about",
    status,
    evidence
  });

  it("proposes a new pair", () => {
    expect(selectNewSuggestions(candidate, [])).toHaveLength(1);
  });

  it("never proposes a rejected pair, nor one already suggested or confirmed", () => {
    for (const status of ["rejected", "suggested", "confirmed"] as const) {
      expect(selectNewSuggestions(candidate, [stored(status)])).toEqual([]);
    }
  });

  it("proposes an expired pair again only with new evidence", () => {
    expect(selectNewSuggestions(candidate, [stored("expired", candidate[0]!.evidence)])).toEqual([]);
    expect(selectNewSuggestions(candidate, [stored("expired", ["old evidence"])])).toHaveLength(1);
  });

  it("merges duplicate candidates and honours the limit", () => {
    const dup = [candidate[0]!, { ...candidate[0]!, evidence: ["second"] }];
    const out = selectNewSuggestions(dup, []);
    expect(out).toHaveLength(1);
    expect(out[0]!.evidence).toHaveLength(2);
    const many = Array.from({ length: 5 }, (_, i) => ({ ...candidate[0]!, fromId: `a${i}` }));
    expect(selectNewSuggestions(many, [], 3)).toHaveLength(3);
  });
});

describe("scoreProposers", () => {
  it("scores accept rate per proposer and kind, ignores the owner's own links and applies the 80% over 30 bar", () => {
    const links = [
      ...Array.from({ length: 24 }, () => ({
        proposer: "rule:subject-words",
        kind: "about" as const,
        status: "confirmed" as const
      })),
      ...Array.from({ length: 6 }, () => ({
        proposer: "rule:subject-words",
        kind: "about" as const,
        status: "rejected" as const
      })),
      { proposer: "rule:subject-words", kind: "about" as const, status: "suggested" as const },
      { proposer: "rule:unit-code-reference", kind: "references" as const, status: "rejected" as const },
      { proposer: "owner", kind: "about" as const, status: "confirmed" as const },
      { proposer: "owner", kind: "about" as const, status: "confirmed" as const }
    ];
    const scores = scoreProposers(links);
    expect(scores).toHaveLength(2);
    const about = scores.find((s) => s.kind === "about")!;
    expect(about).toMatchObject({
      accepted: 24,
      rejected: 6,
      pending: 1,
      decisions: 30,
      acceptRate: 0.8,
      meetsBar: true
    });
    const refs = scores.find((s) => s.kind === "references")!;
    expect(refs).toMatchObject({ acceptRate: 0, meetsBar: false });
  });

  it("has no rate before the first decision", () => {
    const [score] = scoreProposers([{ proposer: "rule:x", kind: "about", status: "suggested" }]);
    expect(score).toMatchObject({ decisions: 0, acceptRate: null, meetsBar: false });
  });
});

describe("subject words", () => {
  it("leaves ordinary work verbs alone", () => {
    const links = proposeRuleLinks({
      ...empty,
      actions: [
        item("action", "a", "Run the gate"),
        item("action", "b", "Walk through the design"),
        item("action", "c", "Elevation view")
      ]
    });
    expect(links).toEqual([]);
  });
});
