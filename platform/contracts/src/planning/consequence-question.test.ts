import { describe, expect, it } from "vitest";
import {
  CONSEQUENCE_QUESTION_TEXT,
  CONSEQUENCE_WORDINGS,
  buildConsequenceGroupView,
  consequenceAnswerCall,
  consequenceWordingForDay,
  isConsequenceWording
} from "./consequence-question.js";
import { rankConsequenceGroupCommandSchema } from "./commands.js";
import { addLocalDays, localDateOf } from "./cadence-due.js";

describe("the question wording", () => {
  it("asks the two questions in the owner's words", () => {
    expect(CONSEQUENCE_QUESTION_TEXT.only_finish_one).toBe(
      "If you could only get one of these done, which would you do?"
    );
    expect(CONSEQUENCE_QUESTION_TEXT.most_regret_not_doing).toBe(
      "A year from now, which of these would you most regret never having done?"
    );
    expect(CONSEQUENCE_WORDINGS).toEqual(["only_finish_one", "most_regret_not_doing"]);
    expect(isConsequenceWording("only_finish_one")).toBe(true);
    expect(isConsequenceWording("anything else")).toBe(false);
  });

  it("alternates by local calendar day: consecutive days differ, the same day always agrees", () => {
    let day = "2026-11-01";
    let previous = consequenceWordingForDay(day);
    const seen = new Set([previous]);
    for (let i = 0; i < 60; i += 1) {
      day = addLocalDays(day, 1);
      const wording = consequenceWordingForDay(day);
      expect(wording, day).not.toBe(previous);
      expect(consequenceWordingForDay(day)).toBe(wording);
      seen.add(wording);
      previous = wording;
    }
    expect(seen.size).toBe(2);
  });

  it("pins known days, across a month and a year boundary and a leap day", () => {
    expect(consequenceWordingForDay("2026-11-09")).toBe("only_finish_one");
    expect(consequenceWordingForDay("2026-11-10")).toBe("most_regret_not_doing");
    expect(consequenceWordingForDay("2026-12-31")).not.toBe(consequenceWordingForDay("2027-01-01"));
    expect(consequenceWordingForDay("2028-02-29")).not.toBe(consequenceWordingForDay("2028-03-01"));
    expect(consequenceWordingForDay("1969-12-31")).not.toBe(consequenceWordingForDay("1970-01-01"));
  });

  it("follows the person's local date, not the UTC date: one instant, two zones, two days", () => {
    const instant = new Date("2026-11-09T20:00:00Z");
    const brisbane = localDateOf(instant, "Australia/Brisbane");
    const london = localDateOf(instant, "Europe/London");
    expect([brisbane, london]).toEqual(["2026-11-10", "2026-11-09"]);
    expect(consequenceWordingForDay(brisbane)).not.toBe(consequenceWordingForDay(london));
  });
});

describe("the group as shown", () => {
  const view = buildConsequenceGroupView({
    groupId: "g1",
    pool: "project",
    wording: "most_regret_not_doing",
    reissued: false,
    items: [
      { id: "p-b", title: "Bravo", stars: 4 },
      { id: "p-a", title: "Alpha", stars: 1 }
    ]
  });

  it("numbers the items from 1 in the order given and carries the question", () => {
    expect(view.items).toEqual([
      { n: 1, id: "p-b", title: "Bravo", stars: 4 },
      { n: 2, id: "p-a", title: "Alpha", stars: 1 }
    ]);
    expect(view.question).toBe(CONSEQUENCE_QUESTION_TEXT.most_regret_not_doing);
    expect(view.instructions).toContain(view.question);
  });

  it("carries the exact answering call, with every id and the stated-needs-words rule", () => {
    expect(view.answerCall).toEqual(consequenceAnswerCall("g1", ["p-b", "p-a"]));
    expect(view.answerCall.tool).toBe("rhen_save");
    expect(view.answerCall.arguments).toMatchObject({
      entityType: "comparison",
      fields: { groupId: "g1", rankedIds: ["p-b", "p-a"] },
      basis: "stated"
    });
  });
});

describe("rankConsequenceGroupCommandSchema", () => {
  const commandId = "6f1c7a3e-3c1b-4d56-8d7e-0a1b2c3d4e5f";
  it("takes an order or a tie, and refuses neither or both with the fix", () => {
    expect(
      rankConsequenceGroupCommandSchema.safeParse({ commandId, groupId: "g", rankedIds: ["a", "b"] }).success
    ).toBe(true);
    expect(rankConsequenceGroupCommandSchema.safeParse({ commandId, groupId: "g", tie: true }).success).toBe(true);
    const neither = rankConsequenceGroupCommandSchema.safeParse({ commandId, groupId: "g" });
    expect(neither.success ? "" : neither.error.issues[0]?.message).toContain("rankedIds");
    const both = rankConsequenceGroupCommandSchema.safeParse({ commandId, groupId: "g", tie: true, rankedIds: ["a"] });
    expect(both.success ? "" : both.error.issues[0]?.message).toContain("not both");
  });

  it("bounds the wording, the basis and the evidence", () => {
    const base = { commandId, groupId: "g", rankedIds: ["a", "b"] };
    expect(rankConsequenceGroupCommandSchema.safeParse({ ...base, wording: "nonsense" }).success).toBe(false);
    expect(rankConsequenceGroupCommandSchema.safeParse({ ...base, basis: "guess" }).success).toBe(false);
    expect(rankConsequenceGroupCommandSchema.safeParse({ ...base, evidence: "x".repeat(301) }).success).toBe(false);
    expect(
      rankConsequenceGroupCommandSchema.safeParse({ ...base, basis: "stated", evidence: "yes, that one" }).success
    ).toBe(true);
  });
});
