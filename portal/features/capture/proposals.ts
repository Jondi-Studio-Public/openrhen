import { captureDraftIssue, type CaptureDraftIssue } from "@openrhen/contracts";
import type {
  PortalState,
  ProposalType,
  StoredAction,
  StoredCommitment,
  StoredDeliverable,
  StoredOutcome,
  StoredProject
} from "@/state/portal-state";
import { createClientId } from "@/shared/client-id";

export interface ProposalDraft {
  proposalType: ProposalType;
  title: string;
  areaId: string;
  outcomeId: string;
  projectId: string;
  definitionOfDone: string;
  value: number;
  internalDeadlineAt: string;
  externalDeadlineAt: string;
  expectedMinutes: number;
  pessimisticMinutes: number;
  energy: StoredAction["energy"];
  startsAt: string;
  endsAt: string;
  location: string;
  /** The location context the commitment happens at; `location` stays the free-text label. */
  locationId: string;
  /** Deliverable notes/details; optional because no other proposal type's draft sets it. */
  notes?: string;
}

const PROPOSAL_ISSUE_MESSAGES: Record<CaptureDraftIssue, string> = {
  unclassified: "Choose what this item should become.",
  title_missing: "A corrected title is required.",
  value_out_of_range: "Value must be between 1 and 5.",
  outcome_needs_area_and_done: "Choose an area and define what done means.",
  project_needs_outcome: "Choose the outcome this project supports.",
  action_needs_project: "Choose the project this action belongs to.",
  deliverable_needs_project: "Choose the project this deliverable belongs to.",
  commitment_needs_times: "A commitment needs start and end times.",
  commitment_ends_before_start: "The commitment must end after it starts.",
  internal_after_external: "The internal deadline cannot be after the external deadline.",
  action_estimates_invalid: "Action effort estimates are invalid.",
  area_missing: "The selected area no longer exists.",
  outcome_missing: "The selected outcome no longer exists.",
  project_missing: "The selected project no longer exists."
};

export function validateProposal(state: PortalState, draft: ProposalDraft): string | null {
  const issue = captureDraftIssue(state, { ...draft });
  return issue ? PROPOSAL_ISSUE_MESSAGES[issue] : null;
}

export function confirmProposal(
  state: PortalState,
  captureId: string,
  draft: ProposalDraft,
  reviewedAt = new Date().toISOString()
): PortalState {
  if (!state.captures.some((capture) => capture.id === captureId && capture.status === "pending"))
    throw new Error("This proposal is no longer awaiting review.");
  const validation = validateProposal(state, draft);
  if (validation) throw new Error(validation);
  const id = createClientId();
  const proposedFields = { ...draft };
  const captures = state.captures.map((capture) =>
    capture.id === captureId
      ? { ...capture, status: "confirmed" as const, proposalType: draft.proposalType, proposedFields, reviewedAt }
      : capture
  );

  if (draft.proposalType === "outcome") {
    const outcome: StoredOutcome = {
      id,
      areaId: draft.areaId,
      title: draft.title.trim(),
      definitionOfDone: draft.definitionOfDone.trim(),
      value: draft.value,
      status: "active",
      ...(draft.externalDeadlineAt ? { deadlineAt: draft.externalDeadlineAt } : {})
    };
    return { ...state, captures, outcomes: [...state.outcomes, outcome] };
  }
  if (draft.proposalType === "project") {
    const parent = state.outcomes.find((outcome) => outcome.id === draft.outcomeId)!;
    const area = state.areas.find((item) => item.id === parent.areaId)!;
    const project: StoredProject = {
      id,
      outcomeId: parent.id,
      title: draft.title.trim(),
      area: area.name,
      status: "active",
      uncertainty: "some",
      value: parent.value,
      consequence: 3,
      ...(draft.internalDeadlineAt ? { internalDeadlineAt: draft.internalDeadlineAt } : {}),
      ...(draft.externalDeadlineAt ? { externalDeadlineAt: draft.externalDeadlineAt } : {})
    };
    return { ...state, captures, projects: [...state.projects, project] };
  }
  if (draft.proposalType === "action") {
    const action: StoredAction = {
      schedulingMode: "one_off",
      id,
      projectId: draft.projectId,
      title: draft.title.trim(),
      status: "active",
      optimisticMinutes: Math.max(1, Math.round(draft.expectedMinutes * 0.75)),
      expectedMinutes: draft.expectedMinutes,
      pessimisticMinutes: draft.pessimisticMinutes,
      remainingMinutes: draft.expectedMinutes,
      energy: draft.energy,
      minimumSessionMinutes: Math.min(15, draft.expectedMinutes),
      maximumSessionMinutes: Math.min(60, draft.expectedMinutes),
      splittable: true,
      setupMinutes: 0,
      importance: 3,
      consequence: 3,
      contexts: ["home"],
      dependencyIds: [],
      requirementPathways: [],
      preferences: [],
      ...(draft.externalDeadlineAt ? { deadlineAt: draft.externalDeadlineAt } : {})
    };
    return { ...state, captures, actions: [...state.actions, action] };
  }
  if (draft.proposalType === "deliverable") {
    const deliverable: StoredDeliverable = {
      id,
      projectId: draft.projectId,
      title: draft.title.trim(),
      status: "needs_breakdown",
      uncertainty: "some",
      importance: 3,
      consequence: 3,
      contractVersion: 0,
      planVersion: 0,
      sortOrder: 0,
      dependencyIds: [],
      sourceIds: [],
      sourceFiles: [],
      criteria: [],
      steps: [],
      blockers: [],
      contractProposals: [],
      ...(draft.externalDeadlineAt ? { externalDeadlineAt: draft.externalDeadlineAt } : {}),
      ...(draft.internalDeadlineAt ? { internalDeadlineAt: draft.internalDeadlineAt } : {}),
      ...(draft.notes?.trim() ? { details: draft.notes.trim() } : {})
    };
    return { ...state, captures, deliverables: [...state.deliverables, deliverable] };
  }
  if (draft.proposalType === "fixed_commitment") {
    const commitment: StoredCommitment = {
      id,
      title: draft.title.trim(),
      startsAt: draft.startsAt,
      endsAt: draft.endsAt,
      status: "confirmed",
      setupBeforeMinutes: 0,
      transitionAfterMinutes: 0,
      ...(draft.location.trim() ? { location: draft.location.trim() } : {}),
      ...(draft.locationId ? { locationId: draft.locationId } : {})
    };
    return {
      ...state,
      captures,
      commitments: [...state.commitments, commitment].sort((a, b) => a.startsAt.localeCompare(b.startsAt))
    };
  }
  return { ...state, captures };
}

export function ignoreProposal(
  state: PortalState,
  captureId: string,
  reviewedAt = new Date().toISOString()
): PortalState {
  return {
    ...state,
    captures: state.captures.map((capture) =>
      capture.id === captureId ? { ...capture, status: "ignored" as const, reviewedAt } : capture
    )
  };
}
