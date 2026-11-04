import { describe, expect, it } from "vitest";
import { codesIn, compilePlanCodePattern, planCodePatternProblem } from "./plan-code-pattern.js";

// The pattern migration 0135 stores for the existing owner.
const BACKFILL = String.raw`\b(?![A-Z]{3}[5-9]\d{4}\b)(?:[A-Z]{3,7}\d{3,4}[A-Z]?|[A-Z]{3}\d{5})\b`;

describe("plan code pattern", () => {
  it("accepts the backfilled pattern and finds the codes it should", () => {
    expect(planCodePatternProblem(BACKFILL)).toBeNull();
    expect(codesIn("QRSTUV272 XYZWVU2001 ABC20001 ABC10001", BACKFILL)).toEqual([
      "QRSTUV272",
      "XYZWVU2001",
      "ABC20001",
      "ABC10001"
    ]);
    expect(codesIn("ABC50222 ref12345 Order123456", BACKFILL)).toEqual([]);
  });

  it.each([
    ["(a+)+", "cannot repeat a group"],
    [String.raw`(\d{3})*`, "cannot repeat a group"],
    [String.raw`(x)\1`, "cannot repeat a group"],
    [".*", "must not match empty text"],
    ["[", "JavaScript regular expression"],
    ["", "JavaScript regular expression"],
    ["a".repeat(201), "JavaScript regular expression"]
  ])("refuses %s", (source, sentence) => {
    expect(planCodePatternProblem(source)).toContain(sentence);
  });

  it("does not mistake a bracketed or escaped parenthesis for a group", () => {
    expect(planCodePatternProblem(String.raw`[)+]x\)+`)).toBeNull();
  });

  it("compiles to null for none or a bad pattern", () => {
    expect(compilePlanCodePattern(null)).toBeNull();
    expect(compilePlanCodePattern("  ")).toBeNull();
    expect(compilePlanCodePattern("(a+)+")).toBeNull();
    expect(compilePlanCodePattern("[A-Z]{2}\\d+")).toBeInstanceOf(RegExp);
  });

  it("reads only the first 2,000 characters", () => {
    const text = `${"x".repeat(1_995)} AB12 CD34`;
    expect(codesIn(text, "[A-Z]{2}\\d{2}")).toEqual(["AB12"]);
    expect(codesIn("AB12", null)).toEqual([]);
  });
});
