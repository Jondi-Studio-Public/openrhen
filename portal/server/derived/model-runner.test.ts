import { describe, expect, it } from "vitest";
import {
  CIRCUIT_BACKOFF_MS,
  SHADOW_EVAL_KEPT,
  SHADOW_LIVE_KEPT,
  circuitBackoffMs,
  classifyFailure,
  readModelCursor,
  redactMailText,
  runModelTick,
  shadowDone
} from "./model-runner";
import { MODEL_EXTRACTORS } from "./model-extractor-registry";

describe("classifyFailure", () => {
  it("treats host-level failures as an outage that costs nothing", () => {
    for (const outcome of ["unreachable", "rate_limited", "bad_key"] as const)
      expect(classifyFailure(outcome)).toEqual({ kind: "outage" });
  });

  it("charges a timeout, bad output and a throw to the message's budget under their own codes", () => {
    expect(classifyFailure("timeout")).toEqual({ kind: "budget", code: "model_timeout" });
    expect(classifyFailure("bad_output")).toEqual({ kind: "budget", code: "bad_output" });
    expect(classifyFailure("error")).toEqual({ kind: "budget", code: "extractor_error" });
  });
});

describe("circuitBackoffMs", () => {
  it("grows 1, 2, 5, 15 minutes and stays at 15", () => {
    expect([1, 2, 3, 4, 5, 50].map(circuitBackoffMs)).toEqual([60_000, 120_000, 300_000, 900_000, 900_000, 900_000]);
    expect(circuitBackoffMs(0)).toBe(CIRCUIT_BACKOFF_MS[0]);
  });
});

describe("readModelCursor", () => {
  it("reads a JSON-null lease, an absent one and a malformed one as no lease", () => {
    expect(readModelCursor({ lease: null }).lease).toBeNull();
    expect(readModelCursor({}).lease).toBeNull();
    expect(readModelCursor({ lease: "x" }).lease).toBeNull();
    expect(readModelCursor({ lease: { token: "t" } }).lease).toBeNull();
    expect(readModelCursor({ lease: { token: "t", startedAt: "a", expiresAt: "b" } }).lease).toEqual({
      token: "t",
      startedAt: "a",
      expiresAt: "b"
    });
  });

  it("survives a cursor full of junk without throwing, and keeps what is valid", () => {
    const cursor = readModelCursor({
      forward: { at: "2026-11-08T00:00:00.000000Z", id: "i" },
      backfill: 3,
      retries: { a: { n: 2, since: "s", code: "model_timeout" }, b: null, c: { n: "x" } },
      skippedIds: [{ id: "x", key: "k", code: "c", at: "t" }, 7, null],
      circuit: { fails: 2, openUntil: "t", message: 5 },
      models: { t2: { id: "m", digest: 4 }, t3: { nope: 1 } },
      shadow: { done: ["a", 1, "b"], evalCount: 99 }
    });
    expect(cursor.forward).toBeDefined();
    expect(cursor.backfill).toBeUndefined();
    expect(Object.keys(cursor.retries)).toEqual(["a"]);
    expect(cursor.skippedIds).toHaveLength(1);
    expect(cursor.circuit).toEqual({ fails: 2, openUntil: "t", message: "" });
    expect(cursor.models).toEqual({ t2: { id: "m", digest: null }, t3: null });
    expect(cursor.shadow).toEqual({ done: ["a", "b"], evalCount: 2 });
  });
});

describe("shadowDone", () => {
  it("lists the labelled messages first and keeps only the newest live ones", () => {
    const live = Array.from({ length: SHADOW_LIVE_KEPT + 10 }, (_, i) => `l${i}`);
    const done = shadowDone({ eval: ["e1", "e2"], live });
    expect(done).toHaveLength(2 + SHADOW_LIVE_KEPT);
    expect(done.slice(0, 2)).toEqual(["e1", "e2"]);
    expect(done[2]).toBe("l10");
    expect(done[done.length - 1]).toBe(`l${SHADOW_LIVE_KEPT + 9}`);
  });

  it("is bounded in total, so the cursor the summary route returns cannot grow without limit", () => {
    const big = Array.from({ length: 100_000 }, (_, i) => `k${i}`);
    expect(shadowDone({ eval: big, live: big }).length).toBe(SHADOW_EVAL_KEPT + SHADOW_LIVE_KEPT);
  });
});

describe("the production registry", () => {
  it("holds no extractor in 2b-4: fact-llm is slice 2b-6", () => {
    expect(MODEL_EXTRACTORS).toHaveLength(0);
  });

  it("makes an empty registry a reported no-op that touches no database", async () => {
    const result = await runModelTick({} as never);
    expect(result).toMatchObject({ status: "no_extractors", more: false, extractors: [] });
    expect((result as { summary: string }).summary).toContain("No model extractor is registered");
  });
});

describe("redactMailText", () => {
  it("removes any 8-character run shared with the mail and keeps the sentence's own words", () => {
    const out = redactMailText('the reply "see you at the old cafe on friday" was refused', [
      "See you at the old cafe on Friday!"
    ]);
    expect(out).not.toContain("old cafe");
    expect(out).toContain("was refused");
  });
  it("leaves a message alone when nothing is shared or there is nothing to compare", () => {
    expect(redactMailText("timed out", ["unrelated body text"])).toBe("timed out");
    expect(redactMailText("anything at all here", [])).toBe("anything at all here");
  });
});
