import { describe, expect, it } from "vitest";
import { END_STATES, parseReplayCase, replayCaseSchema } from "./replay-case.js";
import { goldenCases } from "./replay-suite.js";

describe("replay case format", () => {
  it("parses every golden case, with unique ids", () => {
    expect(goldenCases.length).toBeGreaterThanOrEqual(30);
    expect(new Set(goldenCases.map((c) => c.id)).size).toBe(goldenCases.length);
  });

  it("covers all five end states and the planned tags", () => {
    expect(new Set(goldenCases.map((c) => c.gold.endState))).toEqual(new Set(END_STATES));
    const tags = new Set(goldenCases.flatMap((c) => c.tags));
    for (const tag of [
      "tie-twins",
      "moved-deadline",
      "ask-no-date",
      "sender-contact",
      "reminder-of-confirmation",
      "cancel",
      "reschedule",
      "recurring-neighbour",
      "numbered-sibling",
      "non-english",
      "no-plan-effect"
    ]) {
      expect(tags.has(tag), tag).toBe(true);
    }
  });

  it("gives every no-effect and unresolved gold a reason", () => {
    for (const c of goldenCases) {
      if (c.gold.endState === "no_effect" || c.gold.endState === "unresolved") expect(c.gold.reason, c.id).toBeTruthy();
    }
  });

  it("rejects unknown keys, a second fact and a foreign source", () => {
    const base = structuredClone(goldenCases[0]!);
    expect(replayCaseSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    const twoFacts = structuredClone(base);
    twoFacts.input.message.facts = [base.input.message.facts[0]!, base.input.message.facts[0]!];
    expect(replayCaseSchema.safeParse(twoFacts).success).toBe(false);
    const foreign = structuredClone(base) as unknown as { input: { message: { source: string } } };
    foreign.input.message.source = "other";
    expect(() => parseReplayCase(foreign)).toThrow();
  });
});
