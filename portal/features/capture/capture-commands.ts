import { isNotRestorableSourceType } from "@/state/extensions";
import type { PlanningEntityCommand } from "@openrhen/contracts";
import type { CaptureItem, PortalState } from "@/state/portal-state";
import { createClientId } from "@/shared/client-id";
import type { ProposalDraft } from "@/features/capture/proposals";

/**
 * The authoring module for `capture`'s single-command sites — see
 * The command authoring design note, decision 1. Each sends exactly one command with no branch,
 * so each is a builder rather than an orchestrator.
 */

/**
 * Confirms a proposal, sending a `capture_review` entity. Returns `null` when the capture is no
 * longer in state — the caller checks and provides its own sentence ("This proposal is no longer
 * available."), keeping non-command tail (convention rule 1) at the call site. The builder does
 * the lookup to match the `routineStepStatusCommand` precedent. `tentative` confirms a commitment
 * as "maybe": it lands as a tentative commitment, and whoever asked is told so.
 */
export function captureReviewCommand(
  captureId: string,
  normalized: ProposalDraft,
  state: PortalState,
  tentative = false,
  answers: Record<string, string> = {}
): PlanningEntityCommand | null {
  const capture = state.captures.find((item) => item.id === captureId);
  if (!capture) return null;
  return {
    commandId: createClientId(),
    expectedVersion: capture.version ?? null,
    type: "save_entity",
    entityType: "capture_review",
    entity: {
      id: capture.id,
      proposalType: normalized.proposalType,
      draft: normalized,
      ...(Object.keys(answers).length ? { answers } : {}),
      ...(tentative ? { commitmentStatus: "tentative" } : {})
    }
  };
}

/**
 * Confirms one reasoning-run change (`email_change`) with the person's answers to its open questions,
 * keyed by the question's field. Built from the item in hand rather than looked up, so a Confirm all
 * that runs several of these in a row does not read a state older than its own earlier confirms.
 */
export function emailChangeConfirmCommand(
  item: Pick<CaptureItem, "id" | "version">,
  answers: Record<string, string>
): PlanningEntityCommand {
  return {
    commandId: createClientId(),
    expectedVersion: item.version ?? null,
    type: "save_entity",
    entityType: "capture_review",
    entity: { id: item.id, proposalType: "email_change", answers }
  };
}

/**
 * Ignores a proposal, sending a `capture` entity with `status: "ignored"`. Returns `null` when
 * the capture is no longer in state — the caller checks and silently returns, keeping non-command
 * tail (convention rule 1) at the call site.
 *
 * `reviewedAt` is passed in, not generated here, so a test can name the value without freezing
 * time — matching the reference's `dayKey` call where the page provides the clock read and the
 * builder uses it (decision 2, conventions rule 1).
 */
export function captureIgnoreCommand(
  captureId: string,
  reviewedAt: string,
  state: PortalState
): PlanningEntityCommand | null {
  const capture = state.captures.find((item) => item.id === captureId);
  if (!capture) return null;
  return {
    commandId: createClientId(),
    expectedVersion: capture.version ?? null,
    type: "save_entity",
    entityType: "capture",
    entity: {
      id: capture.id,
      status: "ignored",
      proposalType: capture.proposalType,
      proposedFields: capture.proposedFields,
      reviewedAt
    }
  };
}

/**
 * Whether an ignore can be undone exactly: the proposal goes back to waiting and nothing else changed.
 * Ignoring a proposal that came from another person also declines their submission, and ignoring an older per-message
 * mail suggestion can link the email to a commitment, so neither is put back from the Inbox's toast (a source
 * that cannot be put back says so in `notRestorableSourceTypes`).
 */
export function canUndoIgnore(capture: PortalState["captures"][number] | undefined): boolean {
  return Boolean(capture) && !isNotRestorableSourceType(capture!.sourceType);
}

/** The Undo for an ignore: an ignored proposal back to pending, its decision time cleared. */
export function captureUnignoreCommand(captureId: string, state: PortalState): PlanningEntityCommand | null {
  const capture = state.captures.find((item) => item.id === captureId);
  if (!capture || capture.status !== "ignored" || !canUndoIgnore(capture)) return null;
  return {
    commandId: createClientId(),
    expectedVersion: capture.version ?? null,
    type: "save_entity",
    entityType: "capture",
    entity: {
      id: capture.id,
      status: "pending",
      proposalType: capture.proposalType,
      proposedFields: capture.proposedFields
    }
  };
}

/** Whether a capture was filed as Someday / maybe or Reference: confirmed, but no record was made. */
export function isKeptForLater(capture: PortalState["captures"][number]): boolean {
  return capture.status === "confirmed" && (capture.proposalType === "someday" || capture.proposalType === "reference");
}

/**
 * Sends a Someday or Reference item back to Needs review, so it can be classified as real work.
 * Only a kept item can go back: any other confirmed proposal already created a record under the
 * proposal's id, and confirming it a second time would try to create that record again. Returns
 * `null` when the capture is gone or is not a kept item.
 */
export function captureReopenCommand(captureId: string, state: PortalState): PlanningEntityCommand | null {
  const capture = state.captures.find((item) => item.id === captureId);
  if (!capture || !isKeptForLater(capture)) return null;
  return {
    commandId: createClientId(),
    expectedVersion: capture.version ?? null,
    type: "save_entity",
    entityType: "capture",
    entity: {
      id: capture.id,
      status: "pending",
      proposalType: capture.proposalType,
      proposedFields: capture.proposedFields
    }
  };
}

/**
 * The Undo for "Drop" or "Review again" on a Someday or Reference item: files it again exactly as it
 * was kept, with its type and filing time. `kept` is the item as it was before the move; the version
 * is read from `state` as it is now. Returns `null` when the item is gone or is still kept.
 */
export function captureKeepAgainCommand(kept: CaptureItem, state: PortalState): PlanningEntityCommand | null {
  const capture = state.captures.find((item) => item.id === kept.id);
  if (!capture || isKeptForLater(capture)) return null;
  return {
    commandId: createClientId(),
    expectedVersion: capture.version ?? null,
    type: "save_entity",
    entityType: "capture",
    entity: {
      id: capture.id,
      status: "confirmed",
      proposalType: kept.proposalType,
      proposedFields: kept.proposedFields,
      reviewedAt: kept.reviewedAt ?? null
    }
  };
}

/** Whether a proposal was replaced (superseded) by a later reading of its mail, and can be restored. */
export function isReplaced(capture: PortalState["captures"][number]): boolean {
  return capture.status === "superseded";
}

/**
 * Brings a replaced proposal back to Needs review ("Restore" under Replaced in the Emails room).
 * Only a superseded one can come back: a confirmed or ignored proposal is a decision, and the server
 * refuses it too. The server keeps the stored fields, so none are sent for it to trust. Returns
 * `null` when the capture is gone or is not replaced.
 */
export function captureRestoreCommand(captureId: string, state: PortalState): PlanningEntityCommand | null {
  const capture = state.captures.find((item) => item.id === captureId);
  if (!capture || !isReplaced(capture)) return null;
  return {
    commandId: createClientId(),
    expectedVersion: capture.version ?? null,
    type: "save_entity",
    entityType: "capture",
    entity: {
      id: capture.id,
      status: "pending",
      proposalType: capture.proposalType,
      proposedFields: capture.proposedFields,
      restore: true
    }
  };
}
