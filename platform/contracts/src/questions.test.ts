import { describe, expect, it } from "vitest";
import { isAnswered, resolveQuestion, unansweredQuestions, withQuestionsKey } from "./questions.js";

describe("open questions", () => {
  it("settles suggestions and the input kind, guessing a date from the field name", () => {
    expect(resolveQuestion({ field: "title", question: "Title?" })).toEqual({
      field: "title",
      question: "Title?",
      suggestions: [],
      input: "text"
    });
    expect(resolveQuestion({ field: "placement.deadlineAt", question: "By?", suggestions: ["Fri"] }).input).toBe(
      "datetime"
    );
    expect(resolveQuestion({ field: "x", question: "?", input: "datetime", answer: "y" })).toMatchObject({
      input: "datetime",
      answer: "y"
    });
  });

  it("counts a stored answer or a typed one, and ignores blanks", () => {
    const questions = [
      { field: "a", question: "A?" },
      { field: "b", question: "B?", answer: "kept" },
      { field: "c", question: "C?" }
    ];
    expect(unansweredQuestions(questions).map((q) => q.field)).toEqual(["a", "c"]);
    expect(unansweredQuestions(questions, { a: "yes", c: "  " }).map((q) => q.field)).toEqual(["c"]);
    expect(isAnswered(questions[1]!)).toBe(true);
  });

  it("reads the legacy openQuestions key as questions, and never overrides questions", () => {
    expect(withQuestionsKey({ ref: "r", openQuestions: [1] })).toEqual({ ref: "r", questions: [1] });
    expect(withQuestionsKey({ ref: "r", questions: [2], openQuestions: [1] })).toEqual({ ref: "r", questions: [2] });
    expect(withQuestionsKey("text")).toBe("text");
  });
});
