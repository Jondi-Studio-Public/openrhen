import { describe, expect, it } from "vitest";
import {
  type AutoWrite,
  type EvalLabel,
  type EvalPrediction,
  type PersonCorrection,
  fieldMetrics,
  t0Share,
  wilsonInterval,
  wrongAutoActions
} from "./eval-stats.js";

const close = (actual: number, expected: number) => expect(actual).toBeCloseTo(expected, 3);

describe("wilsonInterval", () => {
  it("matches the textbook 95% values", () => {
    const eight = wilsonInterval(8, 10)!;
    close(eight.low, 0.4902);
    close(eight.high, 0.9433);
    const half = wilsonInterval(50, 100)!;
    close(half.low, 0.4038);
    close(half.high, 0.5962);
  });

  it("keeps the all-right and all-wrong cases inside 0 to 1 and not degenerate", () => {
    const none = wilsonInterval(0, 10)!;
    expect(none.low).toBe(0);
    close(none.high, 0.2775);
    const all = wilsonInterval(10, 10)!;
    expect(all.high).toBe(1);
    close(all.low, 0.7225);
  });

  it("is null with no trials, and refuses impossible counts with the fix", () => {
    expect(wilsonInterval(0, 0)).toBeNull();
    expect(() => wilsonInterval(3, 2)).toThrow(/successes \(3\) cannot exceed trials \(2\)/);
    expect(() => wilsonInterval(-1, 2)).toThrow(/whole numbers/);
    expect(() => wilsonInterval(1.5, 2)).toThrow(/whole numbers/);
  });
});

const message = (id: string) => ({ kind: "message" as const, id });
const fact = (id: string) => ({ kind: "fact" as const, id });
const label = (id: string, answer: unknown, extra: Partial<EvalLabel> = {}): EvalLabel => ({
  subject: message(id),
  field: "class",
  answer,
  at: "2026-11-08T01:00:00Z",
  slice: "stratified",
  ...extra
});
const pred = (id: string, value: unknown, field = "class"): EvalPrediction => ({
  subject: message(id),
  field,
  value
});

describe("fieldMetrics", () => {
  it("scores precision on every labelled prediction and recall on the random slice only", () => {
    const labels = [
      label("a", "bulk"),
      label("b", "bulk"),
      label("c", "person"),
      label("d", "person", { slice: "random" }),
      label("e", "bulk", { slice: "random" }),
      label("f", "person", { slice: "random" })
    ];
    const predictions = [
      pred("a", "bulk"),
      pred("b", "person"),
      pred("c", "person"),
      pred("d", "person"),
      pred("e", "person")
    ];
    const [m] = fieldMetrics(labels, predictions);
    expect(m).toMatchObject({
      field: "class",
      labelled: 6,
      predicted: 5,
      correct: 3,
      randomLabelled: 3,
      randomPresent: 3,
      randomCorrect: 1
    });
    expect(m!.precision!.value).toBeCloseTo(3 / 5, 10);
    expect(m!.recall!.value).toBeCloseTo(1 / 3, 10);
    expect(m!.precision!.interval).toEqual(wilsonInterval(3, 5));
    expect(m!.recall!.interval).toEqual(wilsonInterval(1, 3));
  });

  it("counts a wrong value as both a false positive and a miss, an abstention as a miss, and a prediction against 'no value' as a false positive", () => {
    const labels = [
      label("a", "ask", { field: "fact_type", slice: "random" }),
      label("b", "ask", { field: "fact_type", slice: "random" }),
      label("c", null, { field: "fact_type", slice: "random" }),
      label("d", null, { field: "fact_type", slice: "random" })
    ];
    const predictions = [
      pred("a", "ask", "fact_type"),
      pred("b", "deadline", "fact_type"),
      pred("c", "ask", "fact_type")
    ];
    const [m] = fieldMetrics(labels, predictions);
    expect(m).toMatchObject({ predicted: 3, correct: 1, randomPresent: 2, randomCorrect: 1 });
  });

  it("has no precision with no predictions and no recall without a random label, never a made-up zero", () => {
    const [m] = fieldMetrics([label("a", "bulk")], []);
    expect(m).toMatchObject({ labelled: 1, predicted: 0 });
    expect(m!.precision).toBeNull();
    expect(m!.recall).toBeNull();
  });

  it("uses the latest label for a subject and field, and compares objects whatever their key order", () => {
    const labels = [
      label("a", { x: 1, y: 2 }, { at: "2026-11-08T01:00:00Z" }),
      label("a", { y: 3, x: 1 }, { at: "2026-11-08T02:00:00Z" })
    ];
    expect(fieldMetrics(labels, [pred("a", { x: 1, y: 3 })])[0]).toMatchObject({ labelled: 1, correct: 1 });
    expect(fieldMetrics([...labels].reverse(), [pred("a", { x: 1, y: 3 })])[0]).toMatchObject({ correct: 1 });
  });

  it("keeps the subject's earliest slice when it is labelled again without one", () => {
    const labels = [
      label("a", "bulk", { slice: "random", at: "2026-11-08T01:00:00Z" }),
      label("a", "bulk", { slice: null, at: "2026-11-08T02:00:00Z" }),
      label("b", "bulk", { slice: undefined, at: "2026-11-08T01:00:00Z" }),
      label("b", "person", { slice: "random", at: "2026-11-08T02:00:00Z" })
    ];
    const [m] = fieldMetrics(labels, [pred("a", "bulk"), pred("b", "person")]);
    expect(m).toMatchObject({ labelled: 2, randomLabelled: 2, randomCorrect: 2 });
    expect(fieldMetrics([...labels].reverse(), [pred("a", "bulk"), pred("b", "person")])[0]).toMatchObject({
      randomLabelled: 2
    });
  });

  it("compares lists of plain values as sets, so reason codes in another order still agree", () => {
    const labels = [label("a", ["unsubscribe_header", "list_id"], { field: "reasons" })];
    expect(fieldMetrics(labels, [pred("a", ["list_id", "unsubscribe_header"], "reasons")])[0]).toMatchObject({
      correct: 1
    });
    expect(fieldMetrics(labels, [pred("a", ["list_id"], "reasons")])[0]).toMatchObject({ correct: 0 });
    // Lists of objects keep their order.
    const objects = [label("b", [{ x: 1 }, { x: 2 }], { field: "when" })];
    expect(fieldMetrics(objects, [pred("b", [{ x: 2 }, { x: 1 }], "when")])[0]).toMatchObject({ correct: 0 });
  });

  it("reports one entry per field, sorted by name, and skips unfielded labels", () => {
    const labels = [
      label("a", "x", { field: "when" }),
      label("b", "y", { field: "class" }),
      label("c", "z", { field: null })
    ];
    expect(fieldMetrics(labels, []).map((entry) => entry.field)).toEqual(["class", "when"]);
  });

  it("keeps a message and a fact with the same id apart", () => {
    const labels: EvalLabel[] = [{ ...label("x", "ask"), subject: fact("x") }];
    expect(fieldMetrics(labels, [pred("x", "ask")])[0]).toMatchObject({ predicted: 0 });
  });
});

describe("wrongAutoActions", () => {
  const write = (id: string, field: string, value: unknown, at: string): AutoWrite => ({
    subject: fact(id),
    field,
    value,
    at
  });
  const fix = (id: string, field: string, value: unknown, at: string): PersonCorrection => ({
    subject: fact(id),
    field,
    value,
    at
  });

  it("counts a value the person later changed, once per fact and field, and lists it", () => {
    const result = wrongAutoActions(
      [
        write("f1", "status", "confirmed", "2026-11-08T01:00:00Z"),
        write("f2", "status", "done", "2026-11-08T01:00:00Z"),
        write("f3", "when", "friday", "2026-11-08T01:00:00Z")
      ],
      [
        fix("f1", "status", "cancelled", "2026-11-08T02:00:00Z"),
        fix("f1", "status", "cancelled", "2026-11-08T03:00:00Z"),
        fix("f2", "status", "done", "2026-11-08T02:00:00Z")
      ]
    );
    expect(result.count).toBe(1);
    expect(result.items).toEqual([
      { subject: fact("f1"), field: "status", written: "confirmed", corrected: "cancelled" }
    ]);
  });

  it("ignores a correction that came before the write, and a different field", () => {
    const result = wrongAutoActions(
      [write("f1", "status", "confirmed", "2026-11-08T05:00:00Z")],
      [fix("f1", "status", "cancelled", "2026-11-08T02:00:00Z"), fix("f1", "when", "x", "2026-11-08T06:00:00Z")]
    );
    expect(result).toEqual({ count: 0, items: [], truncated: false });
  });

  it("uses the person's latest word: changed and then agreed is not wrong", () => {
    const result = wrongAutoActions(
      [write("f1", "status", "confirmed", "2026-11-08T01:00:00Z")],
      [
        fix("f1", "status", "cancelled", "2026-11-08T02:00:00Z"),
        fix("f1", "status", "confirmed", "2026-11-08T03:00:00Z")
      ]
    );
    expect(result.count).toBe(0);
  });

  it("judges the write that was current when the person spoke", () => {
    const result = wrongAutoActions(
      [
        write("f1", "status", "confirmed", "2026-11-08T01:00:00Z"),
        write("f1", "status", "done", "2026-11-08T02:00:00Z")
      ],
      [fix("f1", "status", "done", "2026-11-08T03:00:00Z")]
    );
    expect(result.count).toBe(0);
  });

  it("reports the whole count but only the first items, in a stable order", () => {
    const many = Array.from({ length: 7 }, (_, index) => `f${index}`);
    const writes = many.map((id) => write(id, "status", "a", "2026-11-08T01:00:00Z"));
    const fixes = many.map((id) => fix(id, "status", "b", "2026-11-08T02:00:00Z"));
    const result = wrongAutoActions(writes, fixes, 3);
    expect(result.count).toBe(7);
    expect(result.items.map((item) => item.subject.id)).toEqual(["f0", "f1", "f2"]);
    expect(result.truncated).toBe(true);
    expect(wrongAutoActions(writes, fixes).truncated).toBe(false);
    expect(wrongAutoActions(writes, fixes).items).toHaveLength(7);
  });

  it("does not depend on input order", () => {
    const writes = [
      write("f1", "status", "a", "2026-11-08T01:00:00Z"),
      write("f2", "status", "a", "2026-11-08T01:00:00Z")
    ];
    const fixes = [fix("f2", "status", "b", "2026-11-08T02:00:00Z"), fix("f1", "status", "b", "2026-11-08T02:00:00Z")];
    expect(wrongAutoActions(writes, fixes)).toEqual(wrongAutoActions([...writes].reverse(), [...fixes].reverse()));
    expect(wrongAutoActions(writes, fixes).items.map((item) => item.subject.id)).toEqual(["f1", "f2"]);
  });
});

describe("t0Share", () => {
  it("is the fraction of messages resolved by headers alone, with a Wilson interval", () => {
    const share = t0Share({ messages: 200, resolvedByT0: 120 });
    expect(share.share).toBeCloseTo(0.6, 10);
    expect(share.interval).toEqual(wilsonInterval(120, 200));
  });

  it("has no share for no messages, and refuses more resolved than messages", () => {
    expect(t0Share({ messages: 0, resolvedByT0: 0 })).toEqual({
      messages: 0,
      resolvedByT0: 0,
      share: null,
      interval: null
    });
    expect(() => t0Share({ messages: 5, resolvedByT0: 6 })).toThrow(/resolvedByT0 \(6\) cannot exceed messages \(5\)/);
  });
});
