import { describe, expect, it } from "vitest";
import { EVAL_CAVEAT, buildEvalReport } from "./eval-report.js";

const msg = (id: string) => ({ kind: "message" as const, id });

describe("buildEvalReport", () => {
  it("assembles fields, wrong auto actions and the T0 share, counting unfielded labels apart", () => {
    const report = buildEvalReport({
      labels: [
        { subject: msg("a"), field: "class", answer: "bulk", at: "2026-11-08T02:00:00Z", slice: "random" },
        { subject: msg("b"), field: "class", answer: "person", at: "2026-11-08T02:00:00Z", slice: "stratified" },
        { subject: msg("c"), field: null, answer: "x", at: "2026-11-08T02:00:00Z" }
      ],
      predictions: [
        { subject: msg("a"), field: "class", value: "bulk" },
        { subject: msg("b"), field: "class", value: "bulk" }
      ],
      writes: [{ subject: msg("b"), field: "class", value: "bulk", at: "2026-11-08T01:00:00Z" }],
      corrections: [{ subject: msg("b"), field: "class", value: "person", at: "2026-11-08T02:00:00Z" }],
      t0: { messages: 10, resolvedByT0: 4 }
    });
    expect(report.labels).toEqual({ total: 3, unfielded: 1 });
    expect(report.fields).toHaveLength(1);
    expect(report.fields[0]).toMatchObject({ field: "class", labelled: 2, predicted: 2, correct: 1 });
    expect(report.wrongAutoActions.count).toBe(1);
    expect(report.t0).toMatchObject({ messages: 10, resolvedByT0: 4, share: 0.4 });
    expect(report.caveat).toBe(EVAL_CAVEAT);
    expect(EVAL_CAVEAT).toMatch(/gross failure only/);
  });

  it("is an honest empty report with nothing labelled", () => {
    const report = buildEvalReport({
      labels: [],
      predictions: [],
      writes: [],
      corrections: [],
      t0: { messages: 0, resolvedByT0: 0 }
    });
    expect(report.fields).toEqual([]);
    expect(report.t0!.share).toBeNull();
    expect(report.wrongAutoActions).toEqual({ count: 0, items: [], truncated: false });
  });

  it("leaves the T0 share out when the extractor's input is not known", () => {
    const report = buildEvalReport({ labels: [], predictions: [], writes: [], corrections: [], t0: null });
    expect(report.t0).toBeNull();
  });
});
