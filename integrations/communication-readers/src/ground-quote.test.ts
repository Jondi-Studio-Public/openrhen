import { describe, expect, it } from "vitest";
import { locateEvidence } from "./evidence-span.js";
import {
  GROUNDING_FAILURES,
  MAX_CONTENT_CODE_POINTS,
  MAX_QUOTE_CODE_POINTS,
  groundQuote,
  tallyGrounding,
  type GroundingResult
} from "./ground-quote.js";

const KEY = "gmail:abc123";
const CONTENT = "Hi Sam. Can you send the report by Friday? I will bring the report too. Thanks";
const ground = (quote: unknown, content: string | null = CONTENT) =>
  groundQuote({ content, quote, conversationKey: KEY });

describe("the grounding gate", () => {
  it("grounds a quote found exactly once and returns its span, its sentence and the n2 id", () => {
    const result = ground("by Friday");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.span).toEqual(locateEvidence(CONTENT, "by Friday"));
    expect(result.sentence.text).toBe("Can you send the report by Friday?");
    expect(result.factId).toMatch(/^[0-9a-f]{40}$/);
  });

  it("matches after folding whitespace, and takes the sentence the quote starts in when it spans a boundary", () => {
    const result = ground("by  Friday?\nI will");
    expect(result.ok && result.sentence.text).toBe("Can you send the report by Friday?");
  });

  it("does not write a quote that is missing, saying so", () => {
    expect(ground("by Monday")).toEqual({ ok: false, reason: "not_found" });
    expect(ground("by friday")).toEqual({ ok: false, reason: "not_found" });
  });

  it("does not write a quote that occurs more than once, and never guesses which was meant", () => {
    expect(ground("the report")).toEqual({ ok: false, reason: "ambiguous" });
  });

  it("does not write an empty quote or one that is not text", () => {
    for (const quote of ["", "  \n ", undefined, null, 5, ["x"]])
      expect(ground(quote), String(quote)).toEqual({ ok: false, reason: "empty_quote" });
  });

  it("does not write a quote whose span is longer than a span may be", () => {
    const long = "word ".repeat(80).trim();
    expect(ground(long, `${long} end`)).toEqual({ ok: false, reason: "too_long" });
    const exact = "a".repeat(MAX_QUOTE_CODE_POINTS);
    expect(ground(exact, `x ${exact} y`).ok).toBe(true);
    expect(ground(`${exact}a`, `x ${exact}a y`)).toEqual({ ok: false, reason: "too_long" });
    // A short quote over a huge run of whitespace in the content has a span wider than the quote.
    expect(ground("a b", `a${" ".repeat(300)}b`)).toEqual({ ok: false, reason: "too_long" });
  });

  it("does not write when the message has no stored text", () => {
    expect(ground("by Friday", null)).toEqual({ ok: false, reason: "no_content" });
  });

  it("counts an emoji as one code point, in the span and in the cap", () => {
    const content = "Dinner \u{1F600}\u{1F600} at 7? Yes";
    const result = ground("\u{1F600} at 7", content);
    expect(result.ok && result.span.start).toBe(8);
    expect(result.ok && result.sentence.text).toBe("Dinner \u{1F600}\u{1F600} at 7?");
  });

  it("is deterministic", () => {
    expect(ground("by Friday")).toEqual(ground("by Friday"));
  });

  it("refuses a span that starts inside a quoted line, so an old quoted ask cannot ground a new fact", () => {
    const reply =
      "Will do.\n\nOn Mon, Sam wrote:\n> Can you send the report by Friday?\n>> older ask: call me\n  > indented quote\n\nThanks";
    expect(ground("send the report", reply)).toEqual({ ok: false, reason: "quoted_text" });
    expect(ground("older ask", reply)).toEqual({ ok: false, reason: "quoted_text" });
    expect(ground("indented quote", reply)).toEqual({ ok: false, reason: "quoted_text" });
    expect(ground("> Can you", reply)).toEqual({ ok: false, reason: "quoted_text" });
    expect(ground("Will do", reply).ok).toBe(true);
    expect(ground("Thanks", reply).ok).toBe(true);
  });

  it("refuses a span when any line it touches is quoted, not only the first", () => {
    expect(ground("Will do.\n> Can you", "Will do.\n> Can you send it?")).toEqual({ ok: false, reason: "quoted_text" });
    expect(ground("Thanks.\nBy Friday\n> old ask", "Hi\n\nThanks.\nBy Friday\n> old ask\n")).toEqual({
      ok: false,
      reason: "quoted_text"
    });
    expect(ground("Thanks.\nBy Friday", "Hi\n\nThanks.\nBy Friday\n> old ask\n").ok).toBe(true);
  });

  it("refuses a sentence with no letter or digit, such as emoji or punctuation alone", () => {
    expect(ground("\u{1F44D}", "ok\n\n\u{1F44D}\n\nThanks")).toEqual({ ok: false, reason: "no_text" });
    expect(ground("---", "Hi\n\n---\n\nbye")).toEqual({ ok: false, reason: "no_text" });
    expect(ground("7", "Room 7?").ok).toBe(true);
  });

  it("does not read message text longer than the content cap", () => {
    const big = `${"x ".repeat(MAX_CONTENT_CODE_POINTS / 2)}needle`;
    expect(ground("needle", big)).toEqual({ ok: false, reason: "content_too_long" });
    const edge = `${"x ".repeat((MAX_CONTENT_CODE_POINTS - 6) / 2)}needle`;
    expect(Array.from(edge).length).toBe(MAX_CONTENT_CODE_POINTS);
    expect(ground("needle", edge).ok).toBe(true);
  });
});

const ZERO = {
  empty_quote: 0,
  too_long: 0,
  no_content: 0,
  content_too_long: 0,
  quoted_text: 0,
  no_text: 0,
  not_found: 0,
  ambiguous: 0
};

describe("tallyGrounding", () => {
  it("counts grounded and each failure so the runner can report them", () => {
    const results: GroundingResult[] = [
      ground("by Friday"),
      ground("by Friday"),
      ground("by Monday"),
      ground("the report"),
      ground(""),
      ground("x", null)
    ];
    expect(tallyGrounding(results)).toEqual({
      total: 6,
      grounded: 2,
      rejected: 4,
      failures: { ...ZERO, empty_quote: 1, no_content: 1, not_found: 1, ambiguous: 1 }
    });
  });

  it("has a zero for every failure on an empty run, and lists the failures it knows", () => {
    expect(tallyGrounding([])).toEqual({
      total: 0,
      grounded: 0,
      rejected: 0,
      failures: ZERO
    });
    expect(GROUNDING_FAILURES).toEqual([
      "empty_quote",
      "too_long",
      "no_content",
      "content_too_long",
      "quoted_text",
      "no_text",
      "not_found",
      "ambiguous"
    ]);
  });
});
