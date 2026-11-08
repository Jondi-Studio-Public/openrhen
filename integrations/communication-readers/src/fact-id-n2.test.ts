import { describe, expect, it } from "vitest";
import { FACT_ID_NORMALISER_VERSION, factIdN2 } from "./fact-id-n2.js";
import { factId } from "./fact-id.js";
import { groundQuote } from "./ground-quote.js";

const KEY = "gmail:18c0ffee12345678";
const MESSAGE = "Hi Sam. Can you send the report by Friday? Thanks, Alex";

describe("the frozen n2 fact id", () => {
  it("is named n2", () => {
    expect(FACT_ID_NORMALISER_VERSION).toBe("n2");
  });

  it("matches the frozen vectors (changing one means a new normaliser version, never an edit of n2)", () => {
    expect(factIdN2({ conversationKey: KEY, sentence: "Can you send the report by Friday?" })).toBe(
      "c33c6218c647b104b143b0a77e89cc0f5548ab78"
    );
    expect(factIdN2({ conversationKey: "gmail:t2", sentence: "Lunch  at noon", icsUid: "uid-123@example.test" })).toBe(
      "3f2b91c988887d39e07a9ae04867706547305467"
    );
    expect(factIdN2({ conversationKey: KEY, sentence: "Lunch \u{1F600} at noon \u{1F44D}\u{1F3FD}" })).toBe(
      "2fa82d4d14a79af1cc9b5a75f2d3f09d0deff93a"
    );
  });

  it("has no fact type to hash and differs from the n1 id of the same text", () => {
    const n1 = factId({ factType: "ask", conversationKey: KEY, evidence: "Can you send the report by Friday?" });
    expect(factIdN2({ conversationKey: KEY, sentence: "Can you send the report by Friday?" })).not.toBe(n1);
  });

  it("is the same for a sentence that differs only in case, whitespace, width and zero-width characters", () => {
    const a = factIdN2({ conversationKey: KEY, sentence: "Can you send the report by Friday?" });
    for (const variant of [
      "  can YOU send   the report\tby Friday? ",
      "Can you send the\nreport by Friday?",
      "Can you send the report by Friday？",
      "Can you send the re​port by Friday?"
    ])
      expect(factIdN2({ conversationKey: KEY, sentence: variant }), JSON.stringify(variant)).toBe(a);
  });

  it("ignores quote markers: a quoted line has the id of the same text unquoted, nested and hard-wrapped included", () => {
    const id = (sentence: string) => factIdN2({ conversationKey: KEY, sentence });
    const plain = id("Can you send the report by Friday?");
    for (const quoted of [
      "> Can you send the report by Friday?",
      ">Can you send the report by Friday?",
      ">> Can you send the report by Friday?",
      "> > > Can you send the report by Friday?",
      "  > Can you send the\n> report by\n>> Friday?"
    ])
      expect(id(quoted), JSON.stringify(quoted)).toBe(plain);
    expect(id("a > b")).not.toBe(id("a b"));
  });

  it("keeps emoji distinct from each other and from nothing", () => {
    const id = (sentence: string) => factIdN2({ conversationKey: KEY, sentence });
    expect(new Set([id("ok \u{1F600}"), id("ok \u{1F44D}"), id("ok")]).size).toBe(3);
  });

  it("differs by conversation, sentence and uid, and treats a missing uid as null", () => {
    const base = { conversationKey: KEY, sentence: "send it" };
    const ids = new Set([
      factIdN2(base),
      factIdN2({ ...base, conversationKey: "gmail:other" }),
      factIdN2({ ...base, sentence: "send it now" }),
      factIdN2({ ...base, icsUid: "u1" })
    ]);
    expect(ids.size).toBe(4);
    expect(factIdN2({ ...base, icsUid: null })).toBe(factIdN2(base));
    expect(factIdN2({ ...base, icsUid: undefined })).toBe(factIdN2(base));
  });

  it("is a 40-character lowercase hex id, which the fact validator accepts", () => {
    expect(factIdN2({ conversationKey: KEY, sentence: "x" })).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("n2 across two model readings of the same message", () => {
  const ground = (quote: string) => {
    const result = groundQuote({ content: MESSAGE, quote, conversationKey: KEY });
    if (!result.ok) throw new Error(`not grounded: ${result.reason}`);
    return result;
  };

  it("gives one id to a short quote and a long quote inside the same sentence", () => {
    const short = ground("by Friday");
    const long = ground("Can you send the report by Friday?");
    expect(short.span).not.toEqual(long.span);
    expect(short.factId).toBe(long.factId);
    expect(short.factId).toBe(factIdN2({ conversationKey: KEY, sentence: "Can you send the report by Friday?" }));
  });

  it("does not depend on the fact type the model chose (ask versus deadline)", () => {
    // The id has no type input at all: a model that reads this as a deadline instead of an ask keeps the id.
    expect(ground("send the report").factId).toBe(ground("report by Friday").factId);
  });

  it("gives a different id to a different sentence of the same message", () => {
    expect(ground("Thanks, Alex").factId).not.toBe(ground("by Friday").factId);
  });

  it("is the same id when the message arrives with different line wrapping or case", () => {
    const wrapped = groundQuote({
      content: "Hi Sam. CAN you send the\nreport by   Friday?   Thanks, Alex",
      quote: "by Friday",
      conversationKey: KEY
    });
    expect(wrapped.ok && wrapped.factId).toBe(ground("by Friday").factId);
  });
});
