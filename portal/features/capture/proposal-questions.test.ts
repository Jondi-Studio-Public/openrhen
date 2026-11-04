import { describe, expect, it } from "vitest";
import { emptyProposalDraft, normalizeProposalDraft } from "@/features/capture/proposal-draft";
import { allAnswered, applyProposalAnswers, proposalQuestions } from "./proposal-questions";

const lookup = {
  areas: [{ id: "a1", name: "Home" }],
  outcomes: [{ id: "o1", title: "Move house" }],
  projects: [{ id: "p1", title: "Packing" }]
} as never;

const item = (questions: unknown, proposalType = "unclassified") =>
  ({ questions, proposalType }) as Parameters<typeof proposalQuestions>[0];

describe("proposalQuestions", () => {
  it("settles a captured proposal's questions and leaves an email change to its own reader", () => {
    const questions = [{ field: "projectId", question: "Which project?", suggestions: ["Packing"] }];
    expect(proposalQuestions(item(questions))).toEqual([
      { field: "projectId", question: "Which project?", suggestions: ["Packing"], input: "text" }
    ]);
    expect(proposalQuestions(item(questions, "email_change"))).toEqual([]);
    expect(proposalQuestions(item(undefined))).toEqual([]);
  });
});

describe("applyProposalAnswers", () => {
  const questions = proposalQuestions(
    item([
      { field: "projectId", question: "Which project?" },
      { field: "externalDeadlineAt", question: "Due when?" }
    ])
  );

  it("turns a chosen title into the record's id and a date into an instant, and fills the draft", () => {
    const result = applyProposalAnswers(
      { ...emptyProposalDraft(), proposalType: "action" },
      questions,
      { projectId: "packing", externalDeadlineAt: "2026-10-09T15:00" },
      lookup
    );
    expect(result.answers.projectId).toBe("p1");
    expect(result.answers.externalDeadlineAt).toBe(new Date("2026-10-09T15:00").toISOString());
    expect(result.draft.projectId).toBe("p1");
    expect(normalizeProposalDraft(result.draft).externalDeadlineAt).toBe(result.answers.externalDeadlineAt);
  });

  it("sends nothing for an unanswered question and reports it as unanswered", () => {
    const result = applyProposalAnswers(emptyProposalDraft(), questions, { projectId: " " }, lookup);
    expect(result.answers).toEqual({});
    expect(allAnswered(questions, { projectId: "p1" })).toBe(false);
    expect(allAnswered(questions, { projectId: "p1", externalDeadlineAt: "x" })).toBe(true);
  });
});
