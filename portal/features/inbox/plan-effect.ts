import type { ImportRecord } from "@openrhen/contracts";
import type { ProposalDraft } from "@/features/capture/proposals";
import { isBlockingImportRecord } from "@/features/imports/import-batch-edits";
import { importRecordWeekday } from "@/features/imports/import-record-weekday";
import type { PortalState } from "@/state/portal-state";

/**
 * What deciding an Inbox item does to the plan, said before the form that would change it: the
 * detail leads with this sentence and keeps the fields behind "Change first". Pure, so each sentence
 * can be tested as a table. An email change's sentence is the contract's `effectOf`
 * (`EmailChangeRow.effect`).
 */

const quoted = (title: string) => `“${title}”`;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** One sentence for a held batch: what committing it adds, changes and removes. */
export function batchEffect(records: readonly ImportRecord[]): string {
  const kept = records.filter((record) => !record.removed);
  if (!kept.length) return "Nothing is selected, so committing it changes nothing.";
  // Commitments are calendar events, whichever calendar or file they came from.
  const calendar = kept.every(
    (record) => record.entityType === "fixed_commitment" || record.entityType === "fixed_commitment_recurrence"
  );
  const noun = calendar ? "event" : "item";
  // What the commit would write: a record that is invalid or conflicting stops it, and is said apart.
  const blocking = kept.filter(isBlockingImportRecord).length;
  const writable = kept.filter((record) => !isBlockingImportRecord(record));
  const count = (operation: ImportRecord["operation"]) =>
    writable.filter((record) => record.operation === operation).length;
  const parts = [
    count("create") && `adds ${plural(count("create"), noun)}${calendar ? " to your calendar" : " to your plan"}`,
    count("update") && `updates ${plural(count("update"), noun)}`,
    count("link") && `links ${plural(count("link"), noun)} to ones already in your plan`,
    count("unlink") && `unlinks ${plural(count("unlink"), noun)}`,
    count("delete") && `removes ${plural(count("delete"), noun)}`
  ].filter((part): part is string => Boolean(part));
  const fix = blocking ? ` ${blocking} need${blocking === 1 ? "s" : ""} a fix first.` : "";
  // Conflicts and rejected records write nothing until they are resolved in the full review.
  if (!parts.length) return `Nothing here can be added yet.${fix || " Choose Change first to resolve it."}`;
  const said = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0]!;
  return `${said.charAt(0).toUpperCase()}${said.slice(1)}.${fix || " Nothing is written until you add it."}`;
}

/** The batch's records as short lines (title and day), for the summary under the sentence. */
export function batchLines(records: readonly ImportRecord[], timezone?: string): string[] {
  return records
    .filter((record) => !record.removed)
    .map((record) => {
      const title = String(record.fields.title?.value ?? "").trim() || "Untitled";
      const day = importRecordWeekday(record, timezone);
      return day ? `${title} · ${day}` : title;
    });
}

const typeNoun: Partial<Record<ProposalDraft["proposalType"], string>> = {
  action: "the action",
  deliverable: "the deliverable",
  outcome: "the outcome"
};

/** One sentence for a capture as its draft now stands, or null while it has not been sorted. */
export function captureEffect(
  draft: ProposalDraft,
  state: Pick<PortalState, "projects" | "outcomes" | "areas">
): string | null {
  const title = quoted(draft.title.trim() || "this");
  const project = state.projects.find((item) => item.id === draft.projectId)?.title;
  switch (draft.proposalType) {
    case "action":
    case "deliverable":
      return project
        ? `Adds ${typeNoun[draft.proposalType]} ${title} under ${project}.`
        : `Adds ${typeNoun[draft.proposalType]} ${title} once you say which project it belongs to.`;
    case "outcome": {
      const area = state.areas.find((item) => item.id === draft.areaId)?.name;
      return `Adds the outcome ${title}${area ? ` in ${area}` : ""}.`;
    }
    case "project": {
      const outcome = state.outcomes.find((item) => item.id === draft.outcomeId)?.title;
      return `Starts the project ${title}${outcome ? ` under ${outcome}` : ""}.`;
    }
    case "fixed_commitment":
      return `Adds ${title} to your calendar.`;
    case "someday":
    case "reference":
      return `Files ${title} under Kept for later. It is not offered as work.`;
    default:
      return null;
  }
}

/**
 * The projects offered as one-tap chips for a capture that needs one: the one already chosen, the one
 * the placement add-on suggested, then active projects, up to three. "Other…" opens the full form.
 */
export function projectChoices(
  draft: Pick<ProposalDraft, "projectId">,
  suggestedId: string | null,
  projects: PortalState["projects"],
  limit = 3
): { id: string; title: string }[] {
  const ids = [draft.projectId, suggestedId, ...projects.filter((item) => item.status === "active").map((p) => p.id)];
  const seen = new Set<string>();
  const choices: { id: string; title: string }[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const project = projects.find((item) => item.id === id);
    if (project) choices.push({ id: project.id, title: project.title });
    if (choices.length === limit) break;
  }
  return choices;
}
