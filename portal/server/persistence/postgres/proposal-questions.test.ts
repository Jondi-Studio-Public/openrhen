import { describe, expect, it } from "vitest";
import { InvalidCommandError } from "./command-errors";
import { applyProposalAnswers } from "./proposal-questions";

const stored = [
  { field: "projectId", question: "Which project?", suggestions: ["Roof", "Garden"] },
  { field: "externalDeadlineAt", question: "By when?" }
];

describe("applyProposalAnswers", () => {
  it("passes a proposal with no questions through untouched", () => {
    const draft = { title: "x" };
    expect(applyProposalAnswers([], undefined, draft)).toEqual({ draft, questions: [] });
    expect(applyProposalAnswers(undefined, undefined, draft).draft).toBe(draft);
  });

  it("refuses while any question is unanswered or blank", () => {
    expect(() => applyProposalAnswers(stored, { projectId: "Roof" }, {})).toThrow(InvalidCommandError);
    expect(() => applyProposalAnswers(stored, { projectId: "Roof", externalDeadlineAt: "  " }, {})).toThrow(/By when/);
  });

  it("writes each answer into the draft and keeps it on the question; a date becomes an instant", () => {
    const result = applyProposalAnswers(
      stored,
      { projectId: " Roof ", externalDeadlineAt: "2026-10-09T15:00:00.000Z" },
      { title: "Fix it" }
    );
    expect(result.draft).toEqual({
      title: "Fix it",
      projectId: "Roof",
      externalDeadlineAt: "2026-10-09T15:00:00.000Z"
    });
    expect(result.questions.map((q) => q.answer)).toEqual(["Roof", "2026-10-09T15:00:00.000Z"]);
  });

  it("rejects a date answer that is not a date", () => {
    expect(() => applyProposalAnswers(stored, { projectId: "Roof", externalDeadlineAt: "soon" }, {})).toThrow(
      /not a date/
    );
  });
});
