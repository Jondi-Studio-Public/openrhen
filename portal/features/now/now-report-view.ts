import type { CurrentDirective } from "@openrhen/contracts";
import type { NowViewInput } from "@/features/diagnostics/now-view";
import type { PortalState } from "@/state/portal-state";
import type { NowModel, NowRecommendation } from "./now-model";

/**
 * What a report records about the Now page.
 *
 * Deliberately without a `mode`: each branch of the page supplies its own, so the record says which
 * panel was actually rendered rather than a second guess at the same decision.
 */
export function buildNowViewBase({
  state,
  recommendation,
  currentDirective,
  model
}: {
  state: PortalState;
  recommendation: NowRecommendation;
  currentDirective: CurrentDirective | null;
  model: NowModel;
}): Omit<NowViewInput, "mode"> {
  const { session, primary, protectedCommitment, sleepDue, routineDue } = model;
  return {
    headline: recommendation.headline,
    planningStatus: state.planning?.status ?? null,
    planningDecisionCurrent: model.planningDecisionCurrent,
    currentEnergy: state.currentEnergy,
    assertedConditions: state.assertedConditions,
    countdownSeconds: session ? model.secondsRemaining : null,
    session: session
      ? {
          id: session.id,
          status: session.status,
          targetType: session.targetType ?? "action",
          targetId: session.targetId ?? session.actionId,
          targetTitle: session.targetTitle ?? null,
          plannedMinutes: session.plannedMinutes,
          plannedEndAt: session.plannedEndAt
        }
      : null,
    primary: primary
      ? { actionId: primary.action.id, title: primary.action.title, recommendedMinutes: primary.recommendedMinutes }
      : null,
    currentDirective,
    protectedCommitmentId: protectedCommitment?.id ?? null,
    sleepPlanId: sleepDue?.id ?? null,
    routineStepId: routineDue?.id ?? null,
    alternativeActionIds: recommendation.alternatives.map((item) => item.action.id),
    evidence: recommendation.evidence
  };
}
