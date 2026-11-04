import { describe, expect, it } from "vitest";
import {
  planExecution,
  parseHandle,
  scoreAnswer,
  summariseBackends,
  type ExplorerResult
} from "./plan-map-explorer.js";

const result = (over: Partial<ExplorerResult> = {}): ExplorerResult => ({
  answer: "",
  itemIds: [],
  evidence: [],
  proposedChanges: [],
  tokens: { input: 100, output: 20 },
  calls: 2,
  ms: 1000,
  incomplete: false,
  error: null,
  ...over
});

describe("scoreAnswer", () => {
  it("is perfect for the same set in any order, ignoring duplicates", () => {
    expect(scoreAnswer(["a:1", "b:2"], ["b:2", "a:1", "a:1"])).toEqual({ recall: 1, precision: 1, f1: 1 });
  });
  it("penalises misses and extras", () => {
    const score = scoreAnswer(["a:1", "b:2"], ["a:1", "c:3"]);
    expect(score.recall).toBe(0.5);
    expect(score.precision).toBe(0.5);
    expect(score.f1).toBe(0.5);
  });
  it("scores an empty expectation met by an empty answer as correct, and a wrong one as zero", () => {
    expect(scoreAnswer([], []).f1).toBe(1);
    expect(scoreAnswer([], ["a:1"]).f1).toBe(0);
    expect(scoreAnswer(["a:1"], []).f1).toBe(0);
  });
});

describe("summariseBackends", () => {
  it("averages per backend, skips cached runs and counts incomplete and failed", () => {
    const base = { model: "m", taskId: "t", cached: false };
    const summaries = summariseBackends([
      {
        ...base,
        backend: "haiku",
        result: result({ tokens: { input: 100, output: 0 }, calls: 2 }),
        score: { recall: 1, precision: 1, f1: 1 }
      },
      {
        ...base,
        backend: "haiku",
        result: result({ tokens: { input: 300, output: 0 }, calls: 4, incomplete: true }),
        score: { recall: 0, precision: 0, f1: 0 }
      },
      { ...base, backend: "haiku", cached: true, result: result({ tokens: { input: 9999, output: 0 } }), score: null },
      { ...base, backend: "local", result: result({ error: "down" }), score: null }
    ]);
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toMatchObject({
      backend: "haiku",
      runs: 2,
      scored: 2,
      meanF1: 0.5,
      meanTokens: 200,
      meanCalls: 3,
      incomplete: 1,
      failed: 0
    });
    expect(summaries[1]).toMatchObject({ backend: "local", runs: 1, scored: 0, meanF1: null, failed: 1 });
  });
});

describe("parseHandle", () => {
  it("reads a plan item handle and refuses others", () => {
    expect(parseHandle("project:abc-1")).toEqual({ type: "project", id: "abc-1" });
    expect(parseHandle("nonsense:1")).toBeNull();
    expect(parseHandle("project")).toBeNull();
  });
});

describe("planExecution", () => {
  const link = (over: object = {}) => ({
    type: "link" as const,
    kind: "about" as const,
    from: "project:p1",
    to: "subject:maths",
    evidence: "Both mention calculus.",
    ...over
  });

  it("turns a valid link into a candidate and a finding into a finding", () => {
    const plan = planExecution(
      [
        link(),
        { type: "finding", text: "Exam has no prep.", itemIds: ["commitment:c1"], evidence: "No prepares link." }
      ],
      []
    );
    expect(plan.links).toEqual([
      {
        kind: "about",
        fromType: "project",
        fromId: "p1",
        toType: "subject",
        toId: "maths",
        evidence: ["Both mention calculus."]
      }
    ]);
    expect(plan.findings).toHaveLength(1);
    expect(plan.rejected).toEqual([]);
  });

  it("rejects links the rules forbid, self links, and unknown handles", () => {
    const plan = planExecution(
      [
        link({ to: "project:p2", kind: "about" }),
        link({ from: "project:p1", to: "project:p1", kind: "before" }),
        link({ from: "junk:1" })
      ],
      []
    );
    expect(plan.links).toEqual([]);
    expect(plan.rejected).toHaveLength(3);
  });

  it("caps findings per result", () => {
    const finding = (i: number) => ({ type: "finding" as const, text: `f${i}`, itemIds: [], evidence: "e" });
    const plan = planExecution([1, 2, 3, 4, 5].map(finding), []);
    expect(plan.findings).toHaveLength(3);
    expect(plan.rejected).toHaveLength(2);
  });

  it("skips a pair that is already stored, merges duplicates, and caps one result", () => {
    const existing = [
      {
        fromType: "project" as const,
        fromId: "p1",
        toType: "subject" as const,
        toId: "maths",
        kind: "about" as const,
        status: "rejected" as const,
        evidence: []
      }
    ];
    expect(planExecution([link()], existing).links).toEqual([]);
    expect(planExecution([link(), link()], []).links).toHaveLength(1);
    const many = Array.from({ length: 8 }, (_, i) => link({ from: `project:p${i}` }));
    const plan = planExecution(many, []);
    expect(plan.links).toHaveLength(5);
    expect(plan.rejected).toHaveLength(3);
  });
});
