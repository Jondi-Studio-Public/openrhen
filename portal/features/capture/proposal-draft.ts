import { captureDraftFromSaved } from "@openrhen/contracts";
import type { ProposalDraft } from "@/features/capture/proposals";
import type { CaptureItem } from "@/state/portal-state";

/** The editor's starting values: unclassified, a sensible action shape, nothing dated. */
export const emptyProposalDraft = (): ProposalDraft => ({
  proposalType: "unclassified",
  title: "",
  areaId: "",
  outcomeId: "",
  projectId: "",
  definitionOfDone: "",
  value: 3,
  internalDeadlineAt: "",
  externalDeadlineAt: "",
  expectedMinutes: 30,
  pessimisticMinutes: 45,
  energy: "medium",
  startsAt: "",
  endsAt: "",
  location: "",
  locationId: "",
  notes: ""
});

/**
 * What the editor opens with for a capture: whatever an earlier review or an AI proposal already
 * filled in, otherwise the capture's own text as the title. Dates are cut to the minute because
 * that is what a `datetime-local` input can hold.
 */
export function proposalDraftFromCapture(item: CaptureItem): ProposalDraft {
  const saved = item.proposedFields;
  return {
    ...emptyProposalDraft(),
    // A mail deliverable-shaped item stays `proposalType: "unclassified"` until confirmed (the hint
    // lives only in `proposedFields.suggestedShape`) — pre-select "deliverable" in that case so the
    // editor opens on the right type without auto-confirming anything.
    proposalType:
      item.proposalType === "unclassified" && saved.suggestedShape === "deliverable"
        ? "deliverable"
        : item.proposalType,
    ...captureDraftFromSaved(saved, item.text, (value) => value.slice(0, 16))
  };
}

const iso = (value: string) => (value ? new Date(value).toISOString() : "");

/** The draft as the server stores it: every local date-time turned into an instant. */
export function normalizeProposalDraft(draft: ProposalDraft): ProposalDraft {
  return {
    ...draft,
    internalDeadlineAt: iso(draft.internalDeadlineAt),
    externalDeadlineAt: iso(draft.externalDeadlineAt),
    startsAt: iso(draft.startsAt),
    endsAt: iso(draft.endsAt)
  };
}
