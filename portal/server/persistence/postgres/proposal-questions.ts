import { openQuestionSchema, resolveQuestion, type OpenQuestion } from "@openrhen/contracts";
import { z } from "zod";
import { InvalidCommandError } from "./command-errors";

/**
 * The open questions on a proposal that is not an email change (those travel on the change itself and
 * are answered by the extension that owns them), applied at confirm. Every question must have a non-empty
 * answer; the answer then fills the field of the same name in the draft, so what is validated and
 * applied is what the person answered. Returns the draft and the questions with their answers kept.
 */
export function applyProposalAnswers(
  stored: unknown,
  rawAnswers: unknown,
  draft: Record<string, unknown>
): { draft: Record<string, unknown>; questions: OpenQuestion[] } {
  const parsed = z.array(openQuestionSchema).safeParse(stored ?? []);
  const questions = parsed.success ? parsed.data : [];
  if (!questions.length) return { draft, questions: [] };
  const answers: Record<string, string> = {};
  if (rawAnswers && typeof rawAnswers === "object")
    for (const [key, value] of Object.entries(rawAnswers as Record<string, unknown>))
      if (typeof value === "string" && value.trim()) answers[key] = value.trim();
  const next = { ...draft };
  const answered = questions.map((question) => {
    const answer = answers[question.field] ?? question.answer?.trim();
    if (!answer)
      throw new InvalidCommandError(
        `Open question "${question.question}" has no answer, so nothing was confirmed. Repeat rhen_inbox_act {"room":"captured","action":"confirm","id":"<proposal id>","answer":["${question.field}=<your answer>"]}; ask the person if you do not know it.`
      );
    let value = answer;
    if (resolveQuestion(question).input === "datetime") {
      const date = new Date(answer);
      if (Number.isNaN(date.getTime())) throw new InvalidCommandError(`"${answer}" is not a date and time.`);
      value = date.toISOString();
    }
    next[question.field.replace(/^fields\./, "")] = value;
    return { ...question, answer };
  });
  return { draft: next, questions: answered };
}

/** The questions a new capture arrives with: the shared shape, anything malformed dropped. */
export function captureQuestions(raw: unknown): OpenQuestion[] {
  const parsed = z.array(openQuestionSchema).safeParse(raw ?? []);
  return parsed.success ? parsed.data : [];
}
