import { describe, expect, it } from "vitest";
import { buildEvalReport } from "./eval-report.js";
import { factMetrics, fallbackFactPredictions, type FactRow } from "./eval-facts.js";
import type { EvalLabel } from "./eval-stats.js";

const msg = (id: string) => ({ kind: "message" as const, id });
const T = "2026-11-08T02:00:00Z";
const typesLabel = (id: string, answer: unknown, slice: "random" | "stratified" | null = "random"): EvalLabel => ({
  subject: msg(id),
  field: "fact_types",
  answer,
  at: T,
  slice
});
const fact = (
  messageId: string,
  factType: string,
  factId = `${messageId}-${factType}`,
  span?: [number, number]
): FactRow => ({
  messageId,
  factId,
  factType,
  span: span === undefined ? null : { start: span[0], end: span[1] },
  attrs: {
    fact_type: factType,
    ...(span === undefined ? {} : { span: { start: span[0], end: span[1], hash: "0".repeat(12) } })
  }
});
const type = (metrics: ReturnType<typeof factMetrics>, name: string) => metrics.types.find((t) => t.type === name)!;

describe("factMetrics", () => {
  it("scores a version whose every fact type is right: full recall and precision with positive counts", () => {
    const labels = [
      typesLabel("m1", ["ask"]),
      typesLabel("m2", ["deadline", "event"]),
      typesLabel("m3", ["commitment"]),
      typesLabel("m4", [])
    ];
    const rows = [fact("m1", "ask"), fact("m2", "deadline"), fact("m2", "event"), fact("m3", "commitment")];
    const metrics = factMetrics({ labels, rows, reached: ["m1", "m2", "m3", "m4"] });
    for (const name of ["ask", "commitment", "event", "deadline"])
      expect(type(metrics, name)).toMatchObject({ randomPositives: 1, hits: 1, predicted: 1, correct: 1 });
    expect(type(metrics, "ask").recall).toMatchObject({ value: 1 });
    expect(type(metrics, "ask").recall!.interval.low).toBeLessThan(0.5);
    expect(type(metrics, "ask").precision).toMatchObject({ value: 1 });
    expect(metrics.falseAlarms).toMatchObject({ labelledEmpty: 1, flagged: 0 });
    expect(metrics.falseAlarms.rate).toMatchObject({ value: 0 });
    expect(metrics).toMatchObject({ labelledMessages: 4, scored: 4, notReached: 0, unreadable: 0 });
  });

  it("scores recall by membership: {ask, deadline} predicted {ask} is a hit for ask and a miss for deadline", () => {
    const metrics = factMetrics({
      labels: [typesLabel("m1", ["ask", "deadline"])],
      rows: [fact("m1", "ask")],
      reached: ["m1"]
    });
    expect(type(metrics, "ask")).toMatchObject({ randomPositives: 1, hits: 1 });
    expect(type(metrics, "deadline")).toMatchObject({ randomPositives: 1, hits: 0 });
    expect(type(metrics, "deadline").recall).toMatchObject({ value: 0 });
    // Never one exact-set-equality figure: the message is not a miss for ask.
    expect(type(metrics, "ask").recall).toMatchObject({ value: 1 });
  });

  it("counts a wrong fact as a precision miss and a false alarm only for messages labelled empty", () => {
    const metrics = factMetrics({
      labels: [typesLabel("m1", ["ask"]), typesLabel("m2", []), typesLabel("m3", [])],
      rows: [fact("m1", "event"), fact("m2", "ask")],
      reached: ["m1", "m2", "m3"]
    });
    expect(type(metrics, "event")).toMatchObject({ predicted: 1, correct: 0 });
    expect(type(metrics, "ask")).toMatchObject({ predicted: 1, correct: 0, randomPositives: 1, hits: 0 });
    expect(metrics.falseAlarms).toMatchObject({ labelledEmpty: 2, flagged: 1 });
    expect(metrics.falseAlarms.rate).toMatchObject({ value: 0.5 });
    // Labelled-empty messages are never in a recall denominator.
    expect(type(metrics, "ask").randomPositives).toBe(1);
    expect(type(metrics, "ask").recall).toMatchObject({ value: 0 });
  });

  it("does not take a message the extractor never reached as a correct negative", () => {
    const metrics = factMetrics({
      labels: [typesLabel("in", []), typesLabel("out", []), typesLabel("outPositive", ["ask"])],
      rows: [],
      reached: ["in"]
    });
    expect(metrics.falseAlarms).toMatchObject({ labelledEmpty: 1, flagged: 0 });
    expect(metrics.notReached).toBe(2);
    expect(metrics.scored).toBe(1);
    // The unreached positive is neither a hit nor a miss.
    expect(type(metrics, "ask")).toMatchObject({ randomPositives: 0 });
    expect(type(metrics, "ask").recall).toBeNull();
  });

  it("treats a message with a fact row as reached even outside the stated range", () => {
    const metrics = factMetrics({ labels: [typesLabel("m1", ["ask"])], rows: [fact("m1", "ask")], reached: [] });
    expect(metrics.notReached).toBe(0);
    expect(type(metrics, "ask")).toMatchObject({ hits: 1 });
  });

  it("keeps stratified labels out of recall and the false-alarm rate, but in precision and the all-slice count", () => {
    const metrics = factMetrics({
      labels: [typesLabel("m1", ["ask"], "stratified"), typesLabel("m2", [], "stratified"), typesLabel("m3", [], null)],
      rows: [fact("m1", "ask"), fact("m2", "ask")],
      reached: ["m1", "m2", "m3"]
    });
    expect(type(metrics, "ask")).toMatchObject({ randomPositives: 0, labelledPositives: 1, predicted: 2, correct: 1 });
    expect(type(metrics, "ask").recall).toBeNull();
    expect(metrics.falseAlarms).toMatchObject({ labelledEmpty: 0, rate: null });
    expect(metrics.falseAlarms.allSlices).toEqual({ labelledEmpty: 2, flagged: 1 });
  });

  it("reads [] as a real answer and null or a non-list as unreadable, never as none", () => {
    const metrics = factMetrics({
      labels: [typesLabel("m1", null), typesLabel("m2", "ask"), typesLabel("m3", [])],
      rows: [],
      reached: ["m1", "m2", "m3"]
    });
    expect(metrics.unreadable).toBe(2);
    expect(metrics.falseAlarms.labelledEmpty).toBe(1);
  });

  it("uses the latest label and keeps the earliest slice, as the field scores do", () => {
    const metrics = factMetrics({
      labels: [
        { ...typesLabel("m1", [], "random"), at: "2026-11-08T01:00:00Z" },
        { ...typesLabel("m1", ["ask"], null), at: "2026-11-08T03:00:00Z" }
      ],
      rows: [fact("m1", "ask")],
      reached: ["m1"]
    });
    expect(type(metrics, "ask")).toMatchObject({ randomPositives: 1, hits: 1 });
  });

  it("lists the four fact types even with nothing labelled, and reports intervals that are wide with few positives", () => {
    const empty = factMetrics({ labels: [], rows: [], reached: [] });
    expect(empty.types.map((t) => t.type)).toEqual(["ask", "commitment", "deadline", "event"]);
    expect(empty.falseAlarms.rate).toBeNull();
    const three = factMetrics({
      labels: [typesLabel("a", ["event"]), typesLabel("b", ["event"]), typesLabel("c", ["event"])],
      rows: [fact("a", "event"), fact("b", "event"), fact("c", "event")],
      reached: ["a", "b", "c"]
    });
    expect(type(three, "event").recall!.interval.low).toBeLessThan(0.45);
  });

  it("is independent of input order", () => {
    const labels = [typesLabel("m1", ["ask"]), typesLabel("m2", [])];
    const rows = [fact("m1", "ask"), fact("m2", "event")];
    const a = factMetrics({ labels, rows, reached: ["m1", "m2"] });
    const b = factMetrics({ labels: [...labels].reverse(), rows: [...rows].reverse(), reached: ["m2", "m1"] });
    expect(b).toEqual(a);
  });
});

describe("fallbackFactPredictions", () => {
  const reference = (factId: string, messageId: string, span?: [number, number]) => ({
    factId,
    messageId,
    span: span === undefined ? null : { start: span[0], end: span[1] }
  });

  it("matches a candidate under a new id to the labelled fact by message and span overlap", () => {
    const result = fallbackFactPredictions(
      [fact("m1", "deadline", "new1", [100, 150])],
      [reference("old1", "m1", [110, 160])]
    );
    expect(result.matched).toBe(1);
    expect(result.predictions).toContainEqual({
      subject: { kind: "fact", id: "old1" },
      field: "fact_type",
      value: "deadline"
    });
    // Bookkeeping attrs are not predictions.
    expect(result.predictions.some((p) => p.field === "fact_id" || p.field === "source_event_id")).toBe(false);
  });

  it("does not match across messages, without overlap, or when a span is missing", () => {
    const result = fallbackFactPredictions(
      [fact("m2", "ask", "n1", [0, 10]), fact("m1", "ask", "n2", [200, 210]), fact("m1", "ask", "n3")],
      [reference("old1", "m1", [0, 10]), reference("old2", "m1")]
    );
    expect(result).toMatchObject({ matched: 0, predictions: [], unmatched: 2 });
  });

  it("does not take a row that already answers a labelled fact by its own id, and matches one-to-one", () => {
    const result = fallbackFactPredictions(
      [fact("m1", "ask", "keep", [0, 40]), fact("m1", "event", "new", [10, 50])],
      [reference("keep", "m1", [0, 40]), reference("old", "m1", [0, 40])]
    );
    expect(result.matched).toBe(1);
    expect(result.predictions.filter((p) => p.subject.id === "old" && p.field === "fact_type")).toEqual([
      { subject: { kind: "fact", id: "old" }, field: "fact_type", value: "event" }
    ]);
    expect(result.predictions.some((p) => p.subject.id === "keep")).toBe(false);
  });

  it("gives the larger overlap the match", () => {
    const result = fallbackFactPredictions(
      [fact("m1", "ask", "a", [0, 20]), fact("m1", "event", "b", [18, 60])],
      [reference("old", "m1", [10, 60])]
    );
    expect(result.predictions.find((p) => p.field === "fact_type")!.value).toBe("event");
  });
});

describe("buildEvalReport with facts", () => {
  it("scores fact_types labels as fact metrics, not as a field, and a promoted version against labels made for the old one", () => {
    const labels: EvalLabel[] = [
      typesLabel("m1", ["ask"]),
      { subject: { kind: "fact", id: "old1" }, field: "fact_type", answer: "ask", at: T, slice: "stratified" }
    ];
    const report = buildEvalReport({
      labels,
      predictions: [],
      writes: [],
      corrections: [],
      t0: null,
      facts: {
        rows: [fact("m1", "ask", "new1", [5, 30])],
        reached: ["m1"],
        references: [{ factId: "old1", messageId: "m1", span: { start: 0, end: 25 } }]
      }
    });
    expect(report.fields.map((f) => f.field)).toEqual(["fact_type"]);
    expect(report.fields[0]).toMatchObject({ labelled: 1, predicted: 1, correct: 1 });
    expect(report.facts.fallback).toEqual({ matched: 1, unmatched: 0 });
    expect(report.facts.types.find((t) => t.type === "ask")).toMatchObject({ hits: 1 });
    expect(report.labels).toEqual({ total: 2, unfielded: 0 });
  });
});
