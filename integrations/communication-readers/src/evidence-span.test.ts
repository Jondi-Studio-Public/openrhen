import { describe, expect, it } from "vitest";
import { EVIDENCE_HASH_HEX_CHARS, locateEvidence, resolveEvidence, searchEvidence } from "./evidence-span.js";

describe("locateEvidence", () => {
  it("finds a unique quote and returns code-point offsets", () => {
    const span = locateEvidence("Hi Sam, can you send the report by Friday? Thanks", "can you send the report");
    expect(span).toMatchObject({ start: 8, end: 31 });
    expect(span?.hash).toMatch(/^[0-9a-f]+$/);
    expect(span?.hash).toHaveLength(EVIDENCE_HASH_HEX_CHARS);
  });

  it("truncates the hash, so it is shorter than a sha256", () => {
    expect(EVIDENCE_HASH_HEX_CHARS).toBeLessThan(64);
  });

  it("counts an emoji as one code point, not two UTF-16 units", () => {
    const content = "\u{1F600}\u{1F600} please call me";
    const span = locateEvidence(content, "please call me");
    expect(span).toMatchObject({ start: 3, end: 17 });
    expect(Array.from(content).slice(span!.start, span!.end).join("")).toBe("please call me");
  });

  it("finds a quote that itself holds an emoji", () => {
    const span = locateEvidence("lunch \u{1F355} at noon?", "\u{1F355} at noon");
    expect(span).toMatchObject({ start: 6, end: 15 });
  });

  it("matches across differing whitespace and maps back to the original text", () => {
    const content = "Can you\n   send   the report";
    const span = locateEvidence(content, "send the report");
    expect(span).not.toBeNull();
    expect(Array.from(content).slice(span!.start, span!.end).join("")).toBe("send   the report");
  });

  it("ignores whitespace at the edges of the quote", () => {
    expect(locateEvidence("call me", "  call me \n")).toMatchObject({ start: 0, end: 7 });
  });

  it("returns null when the quote is absent, empty, or not unique", () => {
    expect(locateEvidence("call me later", "call you")).toBeNull();
    expect(locateEvidence("call me later", "   ")).toBeNull();
    expect(locateEvidence("call me, then call me again", "call me")).toBeNull();
  });

  it("treats overlapping repeats as not unique", () => {
    expect(locateEvidence("aaa", "aa")).toBeNull();
  });

  it("is case sensitive, because the quote is verbatim", () => {
    expect(locateEvidence("Call me", "call me")).toBeNull();
  });

  it("hashes the whole content, so a changed message changes the hash", () => {
    const a = locateEvidence("call me now", "call me");
    const b = locateEvidence("call me now!", "call me");
    expect(a?.hash).not.toBe(b?.hash);
  });
});

describe("resolveEvidence", () => {
  const content = "Hi \u{1F600} can you send it?";
  const span = locateEvidence(content, "can you send it")!;

  it("returns the span text when the content still matches", () => {
    expect(resolveEvidence(content, span)).toEqual({ state: "ok", text: "can you send it" });
  });

  it("says the source was removed when the content is null", () => {
    expect(resolveEvidence(null, span)).toEqual({ state: "source_removed" });
  });

  it("says the source changed when the hash no longer matches", () => {
    expect(resolveEvidence(content + " edited", span)).toEqual({ state: "source_changed" });
  });
});

describe("searchEvidence", () => {
  it("says why nothing was found, and agrees with locateEvidence when something was", () => {
    expect(searchEvidence("a b a", "")).toEqual({ state: "empty" });
    expect(searchEvidence("a b a", "  ")).toEqual({ state: "empty" });
    expect(searchEvidence("a b a", "c")).toEqual({ state: "absent" });
    expect(searchEvidence("a b a", "a")).toEqual({ state: "ambiguous" });
    expect(searchEvidence("aaa", "aa")).toEqual({ state: "ambiguous" });
    expect(searchEvidence("a b a", "b")).toEqual({ state: "found", span: locateEvidence("a b a", "b") });
  });
});
