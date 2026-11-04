import { describe, expect, it } from "vitest";
import { JEV_PROPOSER, decideSubject, jevQuestionsLeft, parseJevChoice, scoreJevAgainstRules } from "./plan-map-jev.js";

const choice = (chosen: string, probabilities: Record<string, number>) => ({ chosen, probabilities, confidence: null });

const OPTIONS = ["maths", "none"];

describe("parseJevChoice", () => {
  it("reads an answer keyed by question id, under answers or at the top level", () => {
    const answer = { chosen: "maths", probabilities: { maths: 0.8, none: 0.2 }, confidence: 0.9 };
    expect(parseJevChoice({ answers: { subject: answer } }, "subject", OPTIONS)?.chosen).toBe("maths");
    expect(parseJevChoice({ subject: answer }, "subject", OPTIONS)?.confidence).toBe(0.9);
  });
  it("rejects anything malformed rather than guessing", () => {
    expect(parseJevChoice(null, "subject", OPTIONS)).toBeNull();
    expect(parseJevChoice({ subject: { chosen: "x", probabilities: { y: 1 } } }, "subject", OPTIONS)).toBeNull();
    expect(
      parseJevChoice({ subject: { chosen: "maths", probabilities: { maths: 2, none: 0 } } }, "subject", OPTIONS)
    ).toBeNull();
    expect(parseJevChoice({ subject: { probabilities: { maths: 1, none: 0 } } }, "subject", OPTIONS)).toBeNull();
  });
  it("requires the probabilities to cover exactly our options and the chosen one to lead", () => {
    const parse = (chosen: string, probabilities: Record<string, number>) =>
      parseJevChoice({ subject: { chosen, probabilities } }, "subject", OPTIONS);
    expect(parse("money", { money: 0.9 })).toBeNull();
    expect(parse("maths", { maths: 0.9 })).toBeNull();
    expect(parse("maths", { maths: 0.9, none: 0.05, money: 0.05 })).toBeNull();
    expect(parse("none", { maths: 0.9, none: 0.1 })).toBeNull();
  });
});

describe("decideSubject", () => {
  const subjects = ["maths", "meals"];
  it("suggests a clear leader", () => {
    expect(decideSubject(choice("maths", { maths: 0.85, meals: 0.1, none: 0.05 }), subjects)).toMatchObject({
      kind: "assign",
      subject: "maths"
    });
  });
  it("escalates none, an unknown option, low confidence and a spread", () => {
    expect(decideSubject(choice("none", { none: 0.9, maths: 0.1 }), subjects)).toMatchObject({ reason: "none" });
    expect(decideSubject(choice("gym", { gym: 0.9, none: 0.1 }), subjects)).toMatchObject({ reason: "none" });
    expect(decideSubject(choice("maths", { maths: 0.5, meals: 0.1, none: 0.4 }), subjects)).toMatchObject({
      reason: "low_confidence"
    });
    expect(decideSubject(choice("maths", { maths: 0.62, meals: 0.55, none: 0 }), subjects)).toMatchObject({
      reason: "spread"
    });
  });
});

describe("jevQuestionsLeft", () => {
  it("never goes below zero", () => {
    expect(jevQuestionsLeft(2, 5)).toBe(3);
    expect(jevQuestionsLeft(9, 5)).toBe(0);
  });
});

describe("scoreJevAgainstRules", () => {
  const links = (proposer: string, accepted: number, rejected: number) => [
    ...Array.from({ length: accepted }, () => ({ proposer, kind: "about" as const, status: "confirmed" as const })),
    ...Array.from({ length: rejected }, () => ({ proposer, kind: "about" as const, status: "rejected" as const }))
  ];
  it("clears the bar only with 80% over 30 decisions and a rate above the rules", () => {
    const score = scoreJevAgainstRules([...links(JEV_PROPOSER, 27, 5), ...links("rule:subject-words", 8, 2)]);
    expect(score).toMatchObject({ meetsAcceptBar: true, beatsRules: true, clearsBar: true });
    expect(scoreJevAgainstRules([...links(JEV_PROPOSER, 27, 5), ...links("rule:subject-words", 19, 1)]).clearsBar).toBe(
      false
    );
  });
  it("is not cleared on too few decisions, or with no rules baseline", () => {
    expect(scoreJevAgainstRules([...links(JEV_PROPOSER, 10, 0), ...links("rule:subject-words", 1, 1)]).clearsBar).toBe(
      false
    );
    expect(scoreJevAgainstRules(links(JEV_PROPOSER, 40, 0))).toMatchObject({ meetsAcceptBar: true, beatsRules: false });
  });
  it("ignores other link kinds", () => {
    expect(scoreJevAgainstRules([{ proposer: JEV_PROPOSER, kind: "prepares", status: "confirmed" }]).jev).toBeNull();
  });
});
