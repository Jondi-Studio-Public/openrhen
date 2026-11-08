import { describe, expect, it } from "vitest";
import {
  NORMALISER_VERSION,
  canonicalInstant,
  factId,
  normaliseText,
  readerEventKey,
  statusEventKey
} from "./fact-id.js";

const F = "f".repeat(40);

describe("the frozen normaliser", () => {
  it("is named n1", () => {
    expect(NORMALISER_VERSION).toBe("n1");
  });

  it("folds case, width, zero-width characters and whitespace", () => {
    expect(normaliseText("  Can you\tSEND\n the​ report?  ")).toBe("can you send the report?");
    expect(normaliseText("ＦＵＬＬ　ｗｉｄｔｈ")).toBe("full width");
  });

  it("keeps emoji as they are", () => {
    expect(normaliseText("Lunch \u{1F600}")).toBe("lunch \u{1F600}");
  });
});

describe("factId golden vectors (changing one means a new normaliser version)", () => {
  it("matches the frozen vector for an ask", () => {
    expect(
      factId({ factType: "ask", conversationKey: "thread-1", evidence: "Can you send the report by Friday?" })
    ).toBe("3aff1d16581bd6db1a309992bf4910c5262e8402");
  });

  it("matches the frozen vector for an event with an ICS uid", () => {
    expect(
      factId({
        factType: "event",
        conversationKey: "thread-2",
        evidence: "Lunch  at noon",
        icsUid: "uid-123@example.test"
      })
    ).toBe("5a807d5f3b210dd9848648d2876edd4bae6d294f");
  });

  it("is the same for evidence that differs only in case and whitespace", () => {
    const a = factId({ factType: "ask", conversationKey: "t", evidence: "Send  it" });
    expect(factId({ factType: "ask", conversationKey: "t", evidence: " send\nit " })).toBe(a);
  });

  it("differs by type, conversation, evidence and uid", () => {
    const base = { factType: "ask", conversationKey: "t", evidence: "send it" };
    const ids = new Set([
      factId(base),
      factId({ ...base, factType: "deadline" }),
      factId({ ...base, conversationKey: "u" }),
      factId({ ...base, evidence: "send it now" }),
      factId({ ...base, icsUid: "u1" })
    ]);
    expect(ids.size).toBe(5);
  });

  it("cannot be forged by moving text across fields", () => {
    expect(factId({ factType: "ask", conversationKey: "a", evidence: "b c" })).not.toBe(
      factId({ factType: "ask", conversationKey: "a b", evidence: "c" })
    );
  });
});

describe("eventKey rules", () => {
  it("reader output keys follow the evidence, not the output order", () => {
    const key = readerEventKey({
      extractor: "msg_class-t0",
      version: "1",
      sourceEventId: "gm-1",
      inputHash: "in-abc",
      evidence: "Can  you send the report"
    });
    expect(key).toBe("f81a5722d83f4842e6d7d0f309dfc0e19c8e3ed9");
    expect(key).toHaveLength(40);
  });

  it("changes with the extractor version", () => {
    const args = { extractor: "e", version: "1", sourceEventId: "s", inputHash: "i", evidence: "x" };
    expect(readerEventKey(args)).not.toBe(readerEventKey({ ...args, version: "2" }));
  });

  it("status, override and label keys cover kind, fact, field, value, valid_from and actor", () => {
    expect(
      statusEventKey({
        kind: "fact_status",
        factId: F,
        field: "status",
        newValue: "done",
        validFrom: "2026-11-08T01:00:00Z",
        by: null
      })
    ).toBe("c75a74676785fe49c021694edff5e21c490c3c6f");
    expect(
      statusEventKey({
        kind: "override",
        factId: F,
        field: "when",
        newValue: { b: 2, a: 1 },
        validFrom: "2026-11-08T01:00:00Z",
        by: "mark"
      })
    ).toBe("68afc99b1ed1e0c5567e0bbbb18f96cd37f4a9c6");
  });

  it("hashes the instant, not its spelling: equivalent RFC 3339 forms give one key, different instants differ", () => {
    const key = (validFrom: string) =>
      statusEventKey({ kind: "fact_status", factId: F, field: "status", newValue: "done", validFrom, by: null });
    const golden = "c75a74676785fe49c021694edff5e21c490c3c6f";
    expect(key("2026-11-08T01:00:00Z")).toBe(golden);
    for (const same of [
      "2026-11-08T01:00:00.000Z",
      "2026-11-08T01:00:00+00:00",
      "2026-11-08T12:00:00+11:00",
      "2026-11-07T20:00:00-05:00",
      "2026-11-08T01:00:00.0Z",
      "2026-11-08t01:00:00z"
    ])
      expect(key(same), same).toBe(golden);
    expect(key("2026-11-08T01:00:00.001Z")).not.toBe(golden);
    expect(key("2026-11-08T01:00:01Z")).not.toBe(golden);
  });

  it("canonicalises to UTC ISO with milliseconds", () => {
    expect(canonicalInstant("2026-11-08T12:00:00+11:00")).toBe("2026-11-08T01:00:00.000Z");
    expect(canonicalInstant("2026-11-08T01:00:00.5Z")).toBe("2026-11-08T01:00:00.500Z");
  });

  it("leaves a value that is not a valid RFC 3339 instant unchanged, so the validator (not the hash) rejects it", () => {
    expect(canonicalInstant("tomorrow")).toBe("tomorrow");
    expect(canonicalInstant("2026-02-30T01:00:00Z")).toBe("2026-02-30T01:00:00Z");
  });

  it("tells the person (null) from an agent, and one agent from another", () => {
    const args = { kind: "label", factId: F, field: "answer", newValue: "ask", validFrom: "2026-11-08T01:00:00Z" };
    const keys = new Set([
      statusEventKey({ ...args, kind: "label", by: null }),
      statusEventKey({ ...args, kind: "label", by: "mark" }),
      statusEventKey({ ...args, kind: "label", by: "extractor" })
    ]);
    expect(keys.size).toBe(3);
  });
});
