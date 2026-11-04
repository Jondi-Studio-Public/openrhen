import type { ActivityCommand, PlanningEntityCommand } from "@openrhen/contracts";
import type { ActiveSession, StoredDeliverable, StoredDeliverableContractProposal } from "@/state/portal-state";
import { createClientId } from "@/shared/client-id";

/**
 * The authoring module for the deliverables workspace's six sites — see
 * The command authoring design note, decision 1. All six are builders rather than orchestrators:
 * `attempt` already serves every handler on the page uniformly, so nothing here needs its own.
 */

type FinishActivityCommand = Extract<ActivityCommand, { type: "finish_activity" }>;

/**
 * The fix. `persist(deliverable)` used to close over `stored` and read `stored?.version` at
 * call time, while the body it was handed could be `working` — a draft seeded from an older `stored`
 * and never reseeded. That let a body composed against version N ship with a version M > N read live,
 * passing `verifyVersion` and silently overwriting whatever moved in between.
 *
 * The fix is that the version is a parameter: each caller states which record it claims to have read.
 * `save`, `approve`, `beginReview` and `markComplete` all spread `...working`, so they pass
 * `working.version ?? null`; `saveStepRequirementPathways` spreads `...stored`, so it passes
 * `stored?.version ?? null`. This builder only forwards what it is given — it does not, and must not,
 * read a version off `deliverable` itself.
 */
export function deliverablePersistCommand(
  deliverable: StoredDeliverable,
  expectedVersion: number | null
): PlanningEntityCommand {
  return {
    commandId: createClientId(),
    expectedVersion,
    type: "save_entity",
    entityType: "deliverable",
    entity: deliverable as unknown as Record<string, unknown>
  };
}

/**
 * Ends the running session against the deliverable it is attached to. Serves both `markComplete`'s
 * conditional close (outcome always `"completed"`, note always the fixed sentence) and `finish`'s
 * three-outcome close (note optional, `endedAt` optional for a retroactive end) — the same command
 * against the same session, so one builder covers both call sites. The two `await`s in
 * `markComplete` stay at the call site with `setDraft(null)` between them, unchanged: an orchestrator
 * owning both would change what happens when this fails after the deliverable save already landed.
 */
export function finishActivityCommand(
  session: ActiveSession,
  outcome: FinishActivityCommand["outcome"],
  note?: string,
  endedAt?: string
): ActivityCommand {
  return {
    commandId: createClientId(),
    expectedVersion: session.version ?? null,
    type: "finish_activity",
    sessionId: session.id,
    outcome,
    ...(note?.trim() ? { note: note.trim() } : {}),
    ...(endedAt ? { endedAt } : {})
  };
}

/**
 * Records a decision on one proposed contract requirement. `criterion` is whichever of
 * `proposalDrafts[proposal.id]` (a live edit) or `proposal` itself (untouched) the page is holding.
 * `proposal` itself already comes from `working.contractProposals` — the session's own draft when one
 * is open, not necessarily `stored` — so the version that names the snapshot the body was actually
 * composed from is `criterion.version`, not a version read fresh off any other collection: this is a
 * instance the same shape as `deliverablePersistCommand` faced, and it is fixed here the same
 * way, because nothing on the page reseeds or clears `proposalDrafts` when a proposal's version moves
 * underneath it — only `open()`, on switching to a different deliverable entirely.
 */
export function reviewProposalCommand(
  proposal: StoredDeliverableContractProposal,
  criterion: StoredDeliverableContractProposal,
  decision: "confirm" | "ignore"
): PlanningEntityCommand {
  return {
    commandId: createClientId(),
    expectedVersion: criterion.version,
    type: "save_entity",
    entityType: "deliverable_contract_review",
    entity: { id: proposal.id, decision, criterion }
  };
}

/** Moves a running session to another of the deliverable's steps. */
export function switchDeliverableStepCommand(session: ActiveSession, stepId: string): ActivityCommand {
  return {
    commandId: createClientId(),
    expectedVersion: session.version ?? null,
    type: "switch_deliverable_step",
    sessionId: session.id,
    stepId
  };
}

/**
 * One dispatcher, one command shape: the ternary is on the `type` field, not on which route to send,
 * so this stays a builder rather than an orchestrator.
 */
export function pauseResumeSessionCommand(session: ActiveSession): ActivityCommand {
  return {
    commandId: createClientId(),
    expectedVersion: session.version ?? null,
    type: session.status === "paused" ? "resume_activity" : "pause_activity",
    sessionId: session.id
  };
}
