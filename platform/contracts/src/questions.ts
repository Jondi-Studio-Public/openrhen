import { z } from "zod";

/**
 * The one open-question shape every Inbox item shares (design: the design notes, "Questions
 * on any item"). An email change, a captured proposal and a plan-map "ask the owner" finding all carry
 * `questions: OpenQuestion[]`; the Inbox renders them with the same chips, and an item with an
 * unanswered question cannot be confirmed. Answers travel with the confirm.
 *
 * `suggestions` and `input` are optional on the wire: a model emits neither, and the reader fills them
 * in (`resolveQuestion`). `answer` is set once the person has answered and the item was decided.
 */
export const openQuestionSchema = z.object({
  /** What the answer fills in: a field path on the item (`deadlineAt`, `placement.projectId`) or a topic key. */
  field: z.string().min(1),
  question: z.string().min(1),
  suggestions: z.array(z.string()).optional(),
  /** A date field is answered with a date and time picker; everything else with text or a chip. */
  input: z.enum(["text", "datetime"]).optional(),
  answer: z.string().optional()
});
export type OpenQuestion = z.infer<typeof openQuestionSchema>;

/** An open question with its optional parts settled, as the card lays it out. */
export interface ResolvedQuestion {
  field: string;
  question: string;
  suggestions: string[];
  input: "text" | "datetime";
  answer?: string;
}

/** A field whose name ends in `At` or `Date` holds a moment, so its answer is a date and time. */
export function isDateField(field: string): boolean {
  const leaf = field.split(".").pop() ?? field;
  return /(At|Date)$/.test(leaf);
}

export function resolveQuestion(question: OpenQuestion): ResolvedQuestion {
  return {
    field: question.field,
    question: question.question,
    suggestions: question.suggestions ?? [],
    input: question.input ?? (isDateField(question.field) ? "datetime" : "text"),
    ...(question.answer === undefined ? {} : { answer: question.answer })
  };
}

/** Whether `answers` gives a non-empty answer to the question (a stored answer counts). */
export function isAnswered(
  question: Pick<OpenQuestion, "field" | "answer">,
  answers?: Record<string, string>
): boolean {
  return Boolean((answers?.[question.field] ?? question.answer ?? "").trim());
}

/** The questions with no answer yet, in order. */
export function unansweredQuestions<T extends Pick<OpenQuestion, "field" | "answer">>(
  questions: readonly T[] | undefined,
  answers?: Record<string, string>
): T[] {
  return (questions ?? []).filter((question) => !isAnswered(question, answers));
}

/**
 * Before the shared shape the email change format called its questions `openQuestions`. Rows stored
 * under that key (a pending proposal not yet reached by the migration, a regenerable reasoning run)
 * must still block a confirm, so every reader of a stored change goes through this first.
 */
export function withQuestionsKey<T>(raw: T): T {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  if (!("openQuestions" in record)) return raw;
  const { openQuestions, ...rest } = record;
  return (rest.questions === undefined ? { ...rest, questions: openQuestions } : rest) as T;
}
