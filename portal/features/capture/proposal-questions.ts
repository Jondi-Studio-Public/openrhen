import { resolveQuestion, unansweredQuestions, type ResolvedQuestion } from "@openrhen/contracts";
import type { CaptureItem, PortalState } from "@/state/portal-state";
import type { ProposalDraft } from "@/features/capture/proposals";

/**
 * Open questions on a captured proposal (the shared shape, design: inbox-rooms "Questions on any
 * item"). A question's `field` names the draft field its answer fills, so answering one is the same
 * as filling that field of the editor; an unanswered one holds the confirm back. An email change keeps
 * its questions on the change and has its own reader (`email-change.ts`).
 */

/** The proposal's questions with their optional parts settled; an email change has none here. */
export function proposalQuestions(item: Pick<CaptureItem, "questions" | "proposalType">): ResolvedQuestion[] {
  if (item.proposalType === "email_change") return [];
  return (item.questions ?? []).map(resolveQuestion);
}

const DRAFT_KEYS: readonly (keyof ProposalDraft)[] = [
  "title",
  "notes",
  "areaId",
  "outcomeId",
  "projectId",
  "definitionOfDone",
  "internalDeadlineAt",
  "externalDeadlineAt",
  "startsAt",
  "endsAt",
  "location",
  "locationId"
];

type Lookup = Pick<PortalState, "areas" | "outcomes" | "projects">;

/** A chip or typed answer for a placement field is the record's title; the draft holds its id. */
function resolveRecord(field: keyof ProposalDraft, answer: string, state: Lookup): string {
  const options: { id: string; title: string }[] | null =
    field === "areaId"
      ? state.areas.map((area) => ({ id: area.id, title: area.name }))
      : field === "outcomeId"
        ? state.outcomes
        : field === "projectId"
          ? state.projects
          : null;
  if (!options) return answer;
  const wanted = answer.trim().toLowerCase();
  const match = options.find((option) => option.id === answer.trim() || option.title.trim().toLowerCase() === wanted);
  return match ? match.id : answer.trim();
}

/**
 * The answers as the server takes them (keyed by question field, dates as instants, placements as ids)
 * and the draft with them written in, so the editor validates what it is about to send.
 */
export function applyProposalAnswers(
  draft: ProposalDraft,
  questions: readonly ResolvedQuestion[],
  answers: Record<string, string>,
  state: Lookup
): { draft: ProposalDraft; answers: Record<string, string> } {
  const next: ProposalDraft = { ...draft };
  const sent: Record<string, string> = {};
  for (const question of questions) {
    const raw = answers[question.field]?.trim();
    if (!raw) continue;
    let value = raw;
    if (question.input === "datetime") {
      const parsed = new Date(raw);
      value = Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
    } else value = resolveRecord(question.field as keyof ProposalDraft, raw, state);
    sent[question.field] = value;
    if (DRAFT_KEYS.includes(question.field as keyof ProposalDraft)) {
      // The draft holds a local date-time for the editor's input; `normalizeProposalDraft` turns it into an instant.
      (next as unknown as Record<string, unknown>)[question.field] = question.input === "datetime" ? raw : value;
    }
  }
  return { draft: next, answers: sent };
}

/** Whether every question has an answer. */
export function allAnswered(questions: readonly ResolvedQuestion[], answers: Record<string, string>): boolean {
  return unansweredQuestions(questions, answers).length === 0;
}
