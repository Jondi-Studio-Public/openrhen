import { describe, expect, it } from "vitest";
import { MAX_SENTENCE_CODE_POINTS, SPLITTER_VERSION, sentenceAt, splitSentences } from "./sentence-split.js";

const texts = (content: string) => splitSentences(content).map((unit) => unit.text);

describe("the s1 sentence splitter", () => {
  it("is named s1 and caps a unit at 400 code points", () => {
    expect(SPLITTER_VERSION).toBe("s1");
    expect(MAX_SENTENCE_CODE_POINTS).toBe(400);
  });

  it("splits on . ! ? and an ellipsis followed by whitespace or the end", () => {
    expect(texts("Can you send it? Thanks! See you Friday. Fine… Bye")).toEqual([
      "Can you send it?",
      "Thanks!",
      "See you Friday.",
      "Fine…",
      "Bye"
    ]);
  });

  it("keeps a run of terminators and closing quotes or brackets with its sentence", () => {
    expect(texts('He said "go now." Then left (quickly!) Really?! Yes')).toEqual([
      'He said "go now."',
      "Then left (quickly!)",
      "Really?!",
      "Yes"
    ]);
  });

  it("does not split inside a number, an address, a time or a link", () => {
    expect(texts("Pay 3.5 to bob@example.test by 9.30 at https://example.test/a.b today.")).toEqual([
      "Pay 3.5 to bob@example.test by 9.30 at https://example.test/a.b today."
    ]);
  });

  it("does not split after an abbreviation, an initial or a list number", () => {
    expect(texts("Dr. Smith will call. e.g. on Monday. Mrs. Lee agrees.")).toEqual([
      "Dr. Smith will call.",
      "e.g. on Monday.",
      "Mrs. Lee agrees."
    ]);
    expect(texts("1. Send the form. 2. Pay the fee.")).toEqual(["1. Send the form.", "2. Pay the fee."]);
  });

  it("splits real sentences that end in 'no', 'B', 'C', 'Co', 'St' or 'Inc' (the fix for merged asks)", () => {
    expect(texts("Can you confirm, yes or no. Also please send the invoice by Friday.")).toEqual([
      "Can you confirm, yes or no.",
      "Also please send the invoice by Friday."
    ]);
    expect(texts("We chose Plan B. Please book the venue.")).toEqual(["We chose Plan B.", "Please book the venue."]);
    expect(texts("Do you want vitamin C. Send the form.")).toEqual(["Do you want vitamin C.", "Send the form."]);
    expect(texts("Send it to Acme Inc. Please confirm.")).toEqual(["Send it to Acme Inc.", "Please confirm."]);
    expect(texts("Meet me on Main St. Bring the form.")).toEqual(["Meet me on Main St.", "Bring the form."]);
  });

  it("treats a stop after etc., approx, cf, fig, inc, ltd or co as not ending a sentence only before a lower-case word or a digit", () => {
    expect(texts("Bring pens, paper etc. and a laptop. Thanks")).toEqual([
      "Bring pens, paper etc. and a laptop.",
      "Thanks"
    ]);
    expect(texts("Bring pens, paper etc. Then leave.")).toEqual(["Bring pens, paper etc.", "Then leave."]);
    expect(texts("See fig. 3 for it. Ok")).toEqual(["See fig. 3 for it.", "Ok"]);
    expect(texts("Acme Ltd. is happy. Ok")).toEqual(["Acme Ltd. is happy.", "Ok"]);
  });

  it("splits after a single capital letter always: a name with an initial is split (known limit), a sentence is never merged", () => {
    expect(texts("John F. Kennedy spoke. J. Smith agreed.")).toEqual([
      "John F.",
      "Kennedy spoke.",
      "J.",
      "Smith agreed."
    ]);
  });

  it("keeps a dotted initialism such as U.S.A. inside a sentence only before a lower-case word or a digit", () => {
    expect(texts("Ship to the U.S.A. by Friday. Thanks")).toEqual(["Ship to the U.S.A. by Friday.", "Thanks"]);
    expect(texts("Ship to the U.S.A. Please confirm.")).toEqual(["Ship to the U.S.A.", "Please confirm."]);
  });

  it("splits CJK full stops without whitespace", () => {
    expect(texts("明日までに送ってください。ありがとう！")).toEqual(["明日までに送ってください。", "ありがとう！"]);
  });

  it("treats a hard-wrapped line as one sentence and a blank line as a break", () => {
    expect(texts("Can you send the\nreport by\r\nFriday\n\nThanks")).toEqual([
      "Can you send the\nreport by\r\nFriday",
      "Thanks"
    ]);
  });

  it("breaks before a bullet or numbered line, and where quoting starts or stops", () => {
    expect(texts("Todo\n- send quote\n* call Sam\n• book room\n2) pay")).toEqual([
      "Todo",
      "- send quote",
      "* call Sam",
      "• book room",
      "2) pay"
    ]);
    expect(texts("Sure\n> can you confirm\n> by Friday\nThanks")).toEqual([
      "Sure",
      "> can you confirm\n> by Friday",
      "Thanks"
    ]);
  });

  it("returns units with code-point offsets that slice back to the text, emoji included", () => {
    const content = "  Hi \u{1F600}\u{1F600} there. Can you send it?  \n\n Thanks \u{1F44D}";
    const points = Array.from(content);
    const units = splitSentences(content);
    expect(units.map((u) => u.text)).toEqual(["Hi \u{1F600}\u{1F600} there.", "Can you send it?", "Thanks \u{1F44D}"]);
    for (const unit of units) expect(points.slice(unit.start, unit.end).join("")).toBe(unit.text);
    expect(units[0]!.start).toBe(2);
  });

  it("returns nothing for empty or whitespace-only content", () => {
    expect(splitSentences("")).toEqual([]);
    expect(splitSentences(" \n\t ")).toEqual([]);
  });

  it("cuts a unit with no punctuation at the nearest whitespace at or before 400, and never past it", () => {
    const content = Array.from({ length: 200 }, (_, i) => `w${i}`).join(" ");
    const units = splitSentences(content);
    expect(units.length).toBeGreaterThan(2);
    for (const unit of units) {
      expect(Array.from(unit.text).length).toBeLessThanOrEqual(MAX_SENTENCE_CODE_POINTS);
      expect(unit.text).toBe(unit.text.trim());
    }
    expect(units.map((u) => u.text).join(" ")).toBe(content);
  });

  it("hard-cuts at 400 code points when there is no whitespace to cut at, without splitting an emoji", () => {
    const units = splitSentences("\u{1F600}".repeat(1000));
    expect(units.map((u) => Array.from(u.text).length)).toEqual([400, 400, 200]);
    expect(units.every((u) => !u.text.includes("�"))).toBe(true);
  });

  it("is deterministic and total on odd input", () => {
    for (const odd of ["...", "?!", ". . .", "\u0000\u0001", ".\n.\n.", ">", "\u{1F600}"])
      expect(splitSentences(odd)).toEqual(splitSentences(odd));
    expect(texts("...")).toEqual(["..."]);
  });
});

describe("sentenceAt", () => {
  const content = "Thanks. Can you send the report by Friday? Cheers";
  it("returns the sentence containing the offset, so a quote that spans a boundary takes the one it starts in", () => {
    expect(sentenceAt(content, 8)?.text).toBe("Can you send the report by Friday?");
    expect(sentenceAt(content, 0)?.text).toBe("Thanks.");
    expect(sentenceAt(content, content.length - 1)?.text).toBe("Cheers");
  });
  it("is null in the gap between units and outside the content", () => {
    expect(sentenceAt(content, 7)).toBeNull();
    expect(sentenceAt(content, 500)).toBeNull();
    expect(sentenceAt(content, -1)).toBeNull();
  });
});
