import type { ProposalDraft } from "@/features/capture/proposals";
import type { CaptureItem, PortalState } from "@/state/portal-state";

/**
 * The one-tap answers for a pending capture: Task, At a time, Later (Ignore is a decision, not a type).
 * A chip is a ProposalType the draft takes; the full form behind Change still offers all of them.
 */
export type CaptureChip = "task" | "time" | "later";

export const chipType: Record<CaptureChip, ProposalDraft["proposalType"]> = {
  task: "action",
  time: "fixed_commitment",
  later: "someday"
};

/** The chip a draft is on, or null when it is some other type (an outcome, a reference, unsorted). */
export function chipOfDraft(proposalType: ProposalDraft["proposalType"]): CaptureChip | null {
  if (proposalType === "action") return "task";
  if (proposalType === "fixed_commitment") return "time";
  if (proposalType === "someday") return "later";
  return null;
}

// "3:30", "9am", "noon", "5 o'clock", "at 3", "tomorrow 9", "monday at 2".
const clockTime = /\b(?:\d{1,2}:\d{2}|\d{1,2}\s?(?:am|pm)|noon|midnight|\d{1,2}\s?o'?clock)\b/i;
const atNumber = /(?:\bat|@)\s?\d{1,2}\b(?!\s?(?:%|\/))(?!(?:st|nd|rd|th)\b)/i;
const dayThenHour =
  /\b(?:today|tonight|tomorrow|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\s+(?:at\s+)?\d{1,2}\b(?!\s?(?:%|\/))(?!(?:st|nd|rd|th)\b)/i;

/** Whether the text names a clock time, so the thought is probably something to be at, not to do. */
export function mentionsClockTime(text: string): boolean {
  return clockTime.test(text) || atNumber.test(text) || dayThenHour.test(text);
}

/** The chip to start on: a clock time in the text gives At a time, anything else a Task. */
export function guessChip(text: string): CaptureChip {
  return mentionsClockTime(text) ? "time" : "task";
}

/**
 * The project a task lands in when nobody picked one: the placement suggestion, else the one last
 * used for a confirmed capture, else the most recently worked-on active project (a project has no
 * updated-at, so last worked, then created, then list order stand in). Null only with no project.
 */
export function defaultProjectId(
  state: Pick<PortalState, "projects" | "captures">,
  suggestedId: string | null = null
): string | null {
  const exists = (id: unknown): id is string =>
    typeof id === "string" && state.projects.some((p) => p.id === id && p.status === "active");
  if (exists(suggestedId)) return suggestedId;
  const lastUsed = state.captures
    .filter(
      (item) =>
        item.status === "confirmed" &&
        (item.proposalType === "action" || item.proposalType === "deliverable") &&
        exists(item.proposedFields?.projectId)
    )
    .sort((a, b) => (b.reviewedAt ?? b.createdAt).localeCompare(a.reviewedAt ?? a.createdAt))[0];
  const last = lastUsed?.proposedFields?.projectId;
  if (exists(last)) return last;
  const stamp = (project: PortalState["projects"][number]) => project.lastWorkedAt ?? project.createdAt ?? "";
  const recent = state.projects
    .filter((project) => project.status === "active")
    .map((project, at) => ({ project, at }))
    .sort((a, b) => stamp(b.project).localeCompare(stamp(a.project)) || a.at - b.at)[0];
  return recent?.project.id ?? null;
}

/**
 * The draft a pending capture opens on. A capture that already carries a type (an AI proposal, an
 * email change) is left alone; an unsorted one gets the guessed chip, and a task gets its project.
 */
export function preselectCaptureDraft(
  draft: ProposalDraft,
  item: Pick<CaptureItem, "text">,
  state: Pick<PortalState, "projects" | "captures">,
  suggestedId: string | null = null
): ProposalDraft {
  if (draft.proposalType !== "unclassified") return draft;
  // An imported proposal that already has its start and end (an email's event) is a commitment whatever its title says.
  const chip = draft.startsAt && draft.endsAt ? "time" : guessChip(draft.title || item.text);
  return applyChip(draft, chip, state, suggestedId);
}

/** A chip tapped on a draft: its type, and for a task a project if none is chosen yet. */
export function applyChip(
  draft: ProposalDraft,
  chip: CaptureChip,
  state: Pick<PortalState, "projects" | "captures">,
  suggestedId: string | null = null
): ProposalDraft {
  const next = { ...draft, proposalType: chipType[chip] };
  if (chip === "task" && !next.projectId) next.projectId = defaultProjectId(state, suggestedId) ?? "";
  // Only a task has a project; a Later capture must not read as the last project used.
  if (chip === "later") next.projectId = "";
  return next;
}
