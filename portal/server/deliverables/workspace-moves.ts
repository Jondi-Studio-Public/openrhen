/**
 * Workspace-changing moves shared by the built-in chat route and (soon) an external-coordination
 * workspace route. The `requireSession` option exists because the chat route enforces that an
 * active session owns the deliverable before allowing edits, while the external route does not.
 */

import { phaseOf, type Phase } from "@/features/deliverables/deliverable-model";
import { assessDeliverable } from "@openrhen/contracts/readiness";
import { mergeBreakdownAddition } from "@/features/deliverables/merge-breakdown-addition";
import {
  markStepsComplete,
  recordBlocker,
  recordCriterionReview,
  resolveBlocker,
  submitForResult
} from "@/features/deliverables/workspace-chat-tools";
import { withDeliverableProposalStore } from "@/server/persistence/postgres/deliverable-proposal-store";
import { getStateStore } from "@/server/persistence/state-store";
import type { PortalState } from "@/state/portal-state";
import { notFoundRefusal, refusalText } from "@openrhen/contracts";
import { sha256Hex } from "@/shared/sha256";
import { type WorkspaceToolCall } from "@/server/imports/openai-deliverable-chat";

/** The rhen_deliverable subcommand that makes each workspace move (the names differ from the chat tools'). */
export const WORKSPACE_SUBCOMMANDS: Record<string, string> = {
  add_to_breakdown: "add-to-breakdown",
  extend_plan: "extend-plan",
  start_carry_out: "approve",
  mark_steps_complete: "complete-steps",
  begin_review: "begin-review",
  record_review: "record-review",
  record_blocker: "record-blocker",
  resolve_blocker: "resolve-blocker",
  submit_for_result: "submit"
};

/**
 * Applies an agreed addition through the same aggregate save the workspace uses, against the
 * deliverable's *current* version — re-read here, not the one the conversation started from — so a
 * concurrent edit still conflicts loudly instead of being overwritten.
 */
export async function applyWorkspaceTool(
  deliverableId: string,
  call: WorkspaceToolCall,
  options: { requireSession: boolean; commandId?: string | undefined; requestHash?: string | undefined }
): Promise<{ summary: string; applied: boolean; state: unknown }> {
  const current = (await getStateStore().get()) as PortalState | null;
  if (!current) throw new Error("the workspace state is unavailable.");
  // The chat route (requireSession) runs in the app, where the model has no rhen_* tools; the
  // workspace route serves agents, who do.
  const agent = !options.requireSession;
  const readWith = agent
    ? `with rhen_show {"entity":"deliverable","id":"${deliverableId}"}`
    : "from the workspace as it stands now";
  const subcommand = WORKSPACE_SUBCOMMANDS[call.name] ?? call.name;
  const deliverable = current.deliverables.find((item) => item.id === deliverableId);
  if (!deliverable) throw new Error(refusalText(notFoundRefusal("deliverable", deliverableId)));
  if (
    options.requireSession &&
    (current.activeSession?.targetType !== "deliverable" || current.activeSession.targetId !== deliverableId)
  )
    throw new Error(
      `The work session on deliverable "${deliverableId}" has ended, so nothing was changed. Ask the person to start the work session on this deliverable again, then repeat this call.`
    );
  const phase = phaseOf(deliverable);
  // Blockers can appear or clear in any phase, so only the phase-specific tools are staleness-checked.
  // extend_plan amends steps mid-flight and is offered in both Breakdown and Carry out, so it checks
  // against a small set of allowed phases rather than one expected phase like everything else here.
  const phaseless = call.name === "record_blocker" || call.name === "resolve_blocker";
  const allowedPhases: Phase[] =
    call.name === "add_to_breakdown" || call.name === "start_carry_out"
      ? ["Breakdown"]
      : call.name === "record_review"
        ? ["Review"]
        : call.name === "extend_plan"
          ? ["Breakdown", "Carry out"]
          : call.name === "submit_for_result"
            ? ["Carry out", "Review"]
            : ["Carry out"];
  if (!phaseless && !allowedPhases.includes(phase))
    throw new Error(
      `Deliverable "${deliverableId}" is in the ${phase} phase now, but ${agent ? `rhen_deliverable ${subcommand}` : call.name} needs ${allowedPhases.join(" or ")}, so nothing was changed. Read it ${readWith} and make the move that fits its phase.`
    );

  if (call.name === "record_blocker") {
    const update = recordBlocker(deliverable, call.report);
    const requested = new Set(call.report.stepTitles.map(normalized));
    const matched = new Set(update.matchedTitles.map(normalized));
    const missing = [...requested].filter((title) => !matched.has(title));
    if (missing.length)
      throw new Error(
        `These are not current step titles: ${missing.join(", ")}. Nothing was changed. Read the exact titles ${readWith}, then repeat with them.`
      );
    if (!update.changed)
      return { summary: "An open blocker with that description is already recorded.", applied: false, state: current };
    const state = await saveDeliverable(options, deliverable, update.deliverable);
    const gated = update.matchedTitles.map((title) => `“${title}”`).join(", ");
    return {
      summary: gated
        ? `Recorded the blocker and linked it to ${gated}; those steps stay excluded until it clears.`
        : "Recorded the blocker on the whole deliverable.",
      applied: true,
      state
    };
  }

  if (call.name === "resolve_blocker") {
    const update = resolveBlocker(deliverable, call.resolution);
    if (!update.matchedTitles.length)
      throw new Error(
        `No recorded blocker is described as: ${call.resolution.blockerDescription}. Nothing was changed. Read the blockers ${readWith}, then repeat with a description exactly as recorded.`
      );
    let state: PortalState = current;
    if (update.changed) state = await saveDeliverable(options, deliverable, update.deliverable);
    let retainedFeedback = false;
    // Distinct from `retainedFeedback === false` (nothing to retain, feedback was null): this means
    // retaining did fail. The blocker resolution above is a separate write against a separate
    // aggregate (the proposal store's retained sources, not the deliverable) that already committed
    // if `update.changed`, so a failure here must never be thrown — the caller wraps every tool call
    // in a try/catch that turns an uncaught error into "the edit was not applied", which would tell
    // the model the whole call failed when the blocker really was resolved (finding 22).
    let retainFailed = false;
    const feedback = call.resolution.feedback;
    if (feedback) {
      const date = new Date().toISOString().slice(0, 10);
      const sourceTitle = `Feedback — ${update.matchedTitles[0]} (${date})`.slice(0, 255);
      // Keyed on the blocker and its wording, not the date, so retrying the same resolve_blocker
      // call within a day updates the same retained source instead of piling up near-duplicates.
      const contentHash = await sha256Hex(
        new TextEncoder().encode(`deliverable-blocker-feedback:${deliverableId}:${update.matchedTitles[0]}:${feedback}`)
      );
      try {
        state = await withDeliverableProposalStore((store) =>
          store.retain({
            deliverableId,
            sourceTitle,
            sourceType: "deliverable_text",
            capturedText: feedback,
            contentHash,
            files: []
          })
        );
        retainedFeedback = true;
      } catch {
        retainFailed = true;
      }
    }
    if (!update.changed && !retainedFeedback && !retainFailed)
      return { summary: "That blocker is already resolved.", applied: false, state: current };
    const feedbackNote = retainedFeedback
      ? " Retained the feedback as a source for this conversation."
      : retainFailed
        ? " The feedback could not be retained as a source; ask the person to paste it again if it matters later."
        : "";
    return {
      summary: update.changed
        ? `Marked the blocker “${update.matchedTitles[0]}” resolved.${feedbackNote}`
        : `That blocker was already resolved.${feedbackNote}`,
      applied: update.changed || retainedFeedback,
      state
    };
  }

  if (call.name === "add_to_breakdown") {
    const merge = mergeBreakdownAddition(deliverable, call.addition);
    if (merge.unresolvedDependencyTitles.length)
      throw new Error(
        `these are not step titles a new step can depend on (existing, or earlier in this same call): ${merge.unresolvedDependencyTitles.join(", ")}.`
      );
    if (merge.cyclePath) throw new Error(cycleMessage(merge.cyclePath));
    if (!merge.changed)
      return { summary: "Those criteria and steps are already in the breakdown.", applied: false, state: current };
    const state = await saveDeliverable(options, deliverable, merge.deliverable);
    const criteriaCount = merge.addedCriteria === 1 ? "1 criterion" : `${merge.addedCriteria} criteria`;
    const stepCount = merge.addedSteps === 1 ? "1 step" : `${merge.addedSteps} steps`;
    return { summary: `Added ${criteriaCount} and ${stepCount} to the breakdown.`, applied: true, state };
  }

  if (call.name === "extend_plan") {
    const merge = mergeBreakdownAddition(deliverable, { criteria: [], steps: call.addition.steps });
    if (merge.unresolvedDependencyTitles.length)
      throw new Error(
        `these are not step titles this step can depend on (existing, or earlier in this same call): ${merge.unresolvedDependencyTitles.join(", ")}.`
      );
    if (merge.cyclePath) throw new Error(cycleMessage(merge.cyclePath));
    if (!merge.changed)
      return { summary: "Those steps and dependencies are already in the plan.", applied: false, state: current };
    const state = await saveDeliverable(options, deliverable, merge.deliverable);
    const stepCount = merge.addedSteps === 1 ? "1 step" : `${merge.addedSteps} steps`;
    const dependencyNote = merge.addedDependencies
      ? ` and ${merge.addedDependencies === 1 ? "1 new dependency link" : `${merge.addedDependencies} new dependency links`}`
      : "";
    return {
      summary: `Added ${stepCount}${dependencyNote} to the plan without re-approving it.`,
      applied: true,
      state
    };
  }

  if (call.name === "start_carry_out") {
    const readiness = assessDeliverable({
      deliverable,
      situation: current.currentSituation,
      conditionDefinitions: current.conditionDefinitions,
      now: new Date(),
      commitments: current.commitments
    });
    if (!deliverable.criteria.length) throw new Error("the breakdown needs at least one completion criterion.");
    if (readiness.coverageFailures.length)
      throw new Error("the completion contract and required steps still have coverage gaps; resolve Readiness first.");
    const approvedAt = new Date().toISOString();
    const state = await saveDeliverable(options, deliverable, {
      ...deliverable,
      contractVersion: deliverable.contractVersion + 1,
      planVersion: deliverable.planVersion + 1,
      contractApprovedAt: approvedAt,
      planApprovedAt: approvedAt,
      ...(call.approvalNote ? { approvalNote: call.approvalNote } : {}),
      status: deliverable.status === "needs_breakdown" ? "ready" : deliverable.status
    });
    return { summary: "The breakdown is approved and the work can start.", applied: true, state };
  }

  if (call.name === "mark_steps_complete") {
    const update = markStepsComplete(deliverable, call.completion);
    const requested = new Set(call.completion.stepTitles.map(normalized));
    const matched = new Set(update.matchedTitles.map(normalized));
    const missing = [...requested].filter((title) => !matched.has(title));
    if (missing.length)
      throw new Error(
        `These are not current step titles: ${missing.join(", ")}. Nothing was changed. Read the exact titles ${readWith}, then repeat with them.`
      );
    if (!update.changed)
      return {
        summary: "Those steps were already recorded as done with that evidence.",
        applied: false,
        state: current
      };
    const updated = {
      ...update.deliverable,
      status: update.deliverable.status === "ready" ? ("in_progress" as const) : update.deliverable.status
    };
    // The step the session was timing, before the save below may roll it onto whatever comes next.
    const trackedBefore =
      current.activeSession?.targetType === "deliverable" && current.activeSession.targetId === deliverable.id
        ? current.activeSession.stepId
        : undefined;
    const matchedStepIds = new Set(
      deliverable.steps.filter((step) => matched.has(normalized(step.title))).map((step) => step.id)
    );
    const state = await saveDeliverable(options, deliverable, updated);
    const names = update.matchedTitles.map((title) => `“${title}”`).join(", ");
    const reblockNote = update.reblocked.length
      ? ` This reopens: ${update.reblocked.map((item) => `“${item.description}”`).join(", ")}.`
      : "";
    return {
      summary: `Marked ${names} done and recorded the completion evidence.${rolloverNote(state, deliverable.id, trackedBefore, matchedStepIds)}${reblockNote}`,
      applied: true,
      state
    };
  }

  if (call.name === "begin_review") {
    const open = deliverable.steps.filter(
      (step) => step.required && step.status !== "done" && step.status !== "cancelled" && step.status !== "archived"
    );
    if (open.length) throw new Error(`required steps are still open: ${open.map((step) => step.title).join(", ")}.`);
    const state = await saveDeliverable(options, deliverable, { ...deliverable, status: "under_review" });
    return {
      summary: `Review has started. Audit every required criterion before calling it complete.${unsubmittedCriteriaWarning(deliverable)}`,
      applied: true,
      state
    };
  }

  if (call.name === "submit_for_result") {
    const open = deliverable.steps.filter(
      (step) => step.required && step.status !== "done" && step.status !== "cancelled" && step.status !== "archived"
    );
    if (open.length) throw new Error(`required steps are still open: ${open.map((step) => step.title).join(", ")}.`);
    const updated = submitForResult(deliverable, call.submission);
    const state = await saveDeliverable(options, deliverable, updated);
    return {
      summary:
        `Submitted and waiting on ${call.submission.waitingFor}. The deliverable will stop being ` +
        "recommended until the result comes back and the open blocker is resolved.",
      applied: true,
      state
    };
  }

  const requested = new Set(call.review.criteria.map((item) => normalized(item.title)));
  const known = new Set(deliverable.criteria.map((item) => normalized(item.title)));
  const unknown = [...requested].filter((title) => !known.has(title));
  if (unknown.length)
    throw new Error(
      `These are not current criterion titles: ${unknown.join(", ")}. Nothing was changed. Read the exact titles ${readWith}, then repeat with them.`
    );
  const omitted = deliverable.criteria
    .filter((criterion) => criterion.required && !requested.has(normalized(criterion.title)))
    .map((criterion) => criterion.title);
  if (omitted.length) throw new Error(`the review omitted required criteria: ${omitted.join(", ")}.`);
  const update = recordCriterionReview(deliverable, call.review);
  if (!update.changed) return { summary: "That criterion review is already recorded.", applied: false, state: current };
  const state = await saveDeliverable(options, deliverable, update.deliverable);
  const ready = update.deliverable.status === "ready_to_complete";
  return {
    summary: ready
      ? "The full review is recorded and every required criterion passes. It is ready for the person's final completion action."
      : "The full review is recorded. The workspace remains in Review because at least one required criterion has a gap or uncertain evidence.",
    applied: true,
    state
  };
}

const normalized = (value: string) => value.trim().toLocaleLowerCase();

const RESULT_DEPENDENT_METHODS = new Set(["submission_receipt", "external_result"]);

/**
 * `begin_review` warns rather than refuses: a required criterion whose evidence can only arrive from
 * outside (`submission_receipt`, `external_result`) and that is still `unsatisfied`, on a deliverable
 * that has never been submitted, is a criterion the reviewer is about to record as `uncertain` when
 * `submit_for_result` would let them record the wait instead. Silent once `submittedAt` is set, since
 * the wait is already on record.
 */
function unsubmittedCriteriaWarning(deliverable: PortalState["deliverables"][number]): string {
  if (deliverable.submittedAt) return "";
  const names = deliverable.criteria
    .filter(
      (criterion) =>
        criterion.required &&
        criterion.state === "unsatisfied" &&
        criterion.verificationMethod &&
        RESULT_DEPENDENT_METHODS.has(criterion.verificationMethod)
    )
    .map((criterion) => `“${criterion.title}”`);
  if (!names.length) return "";
  return (
    ` ${names.join(", ")} can only be settled once a result comes back from outside — consider ` +
    "submit_for_result instead of recording it uncertain."
  );
}

/**
 * Turns a detected dependency cycle into the kind of message the model can act on — name the step that
 * would depend on itself and the chain that closes the loop — rather than a generic rejection.
 */
function cycleMessage(cyclePath: string[]): string {
  const [first, ...rest] = cyclePath;
  // rest always has at least two entries (the shortest possible cycle is A -> B -> A), so dropping the
  // trailing repeat of `first` always leaves at least one title to name.
  const via = rest.slice(0, -1).map((title) => `"${title}"`);
  return `that would make step "${first}" depend on itself through ${via.join(" → ")}; remove one of those dependencies.`;
}

/**
 * Says what happened to time tracking, if anything, so the reply the person reads matches what the
 * server just did rather than leaving them to notice a step change on their own. `mark_steps_complete`
 * can complete the exact step a session was timing; the save that just ran already rolled that
 * session onto the next executable step, or ended it, atomically (see rollDeliverableSessionForward in
 * the postgres persistence layer) — this only describes the outcome, it never causes it.
 */
function rolloverNote(
  state: PortalState,
  deliverableId: string,
  trackedBefore: string | undefined,
  matchedStepIds: Set<string>
): string {
  if (!trackedBefore || !matchedStepIds.has(trackedBefore)) return "";
  const after = state.activeSession;
  const stillTracking = after?.targetType === "deliverable" && after.targetId === deliverableId;
  if (!stillTracking) return " That was the last step, so tracking has stopped.";
  if (!after.stepId || after.stepId === trackedBefore) return "";
  const nextTitle = state.deliverables
    .find((item) => item.id === deliverableId)
    ?.steps.find((step) => step.id === after.stepId)?.title;
  return ` Tracking has moved on to “${nextTitle ?? "the next step"}”.`;
}

async function saveDeliverable(
  options: { commandId?: string | undefined; requestHash?: string | undefined },
  current: PortalState["deliverables"][number],
  updated: PortalState["deliverables"][number]
) {
  const state = await getStateStore().saveEntity({
    commandId: options.commandId ?? crypto.randomUUID(),
    expectedVersion: current.version ?? null,
    type: "save_entity",
    entityType: "deliverable",
    entity: updated as unknown as Record<string, unknown>,
    requestHash: options.requestHash
  });
  return state;
}

/**
 * Restores a deliverable to exactly the content it held before a chat turn started. Called only when
 * that turn fails after at least one workspace tool already wrote to it: since the turn's assistant
 * reply is never appended to the transcript on failure, its earlier tool writes must not survive
 * either, or the next turn would reason from stored state the conversation never actually recorded
 * agreeing to (finding 22).
 *
 * There is no single database transaction spanning the deliverable aggregate and the chat transcript
 * here — they are different stores — so this is a compensating write, not a true rollback: it re-reads
 * whatever the deliverable holds right now (which may include one or more of this turn's writes) and
 * saves the pre-turn snapshot's content back over it. The row's version number still advances; only its
 * content is restored. A no-op when nothing actually changed the stored version, and a best-effort no-op
 * (logged by the caller, never thrown further) if this itself races a genuine concurrent edit — the
 * original turn failure is what the person needs to see, not a second one about the cleanup.
 */
export async function revertDeliverableToPreTurnSnapshot(
  deliverableId: string,
  preTurnSnapshot: PortalState["deliverables"][number]
): Promise<void> {
  const state = (await getStateStore().get()) as PortalState | null;
  const current = state?.deliverables.find((item) => item.id === deliverableId);
  if (!current || current.version === preTurnSnapshot.version) return;
  await getStateStore().saveEntity({
    commandId: crypto.randomUUID(),
    expectedVersion: current.version ?? null,
    type: "save_entity",
    entityType: "deliverable",
    entity: { ...preTurnSnapshot, id: deliverableId } as unknown as Record<string, unknown>
  });
}
