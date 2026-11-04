import type { CurrentDirective, NowPanelMode, NowPanelView } from "@openrhen/contracts";

const EVIDENCE_LIMIT = 40;
const ALTERNATIVE_LIMIT = 20;
const TEXT_LIMIT = 600;

/**
 * The loose shape the Now page can hand over from the values it has already computed.
 *
 * Deliberately not derived here: which panel is showing. That choice is made inline by the page's
 * own branches, so each branch reports its own `mode` and this module never has a second opinion
 * that could drift from what was actually rendered.
 */
export interface NowViewInput {
  mode: NowPanelMode;
  headline?: string | null;
  planningStatus?: string | null;
  planningDecisionCurrent?: boolean;
  currentEnergy?: string | null;
  assertedConditions?: readonly string[];
  countdownSeconds?: number | null;
  session?: {
    id: string;
    status: string;
    targetType: string;
    targetId: string;
    targetTitle?: string | null;
    plannedMinutes: number;
    plannedEndAt: string;
  } | null;
  primary?: { actionId: string; title: string; recommendedMinutes?: number | null } | null;
  currentDirective?: CurrentDirective | null;
  protectedCommitmentId?: string | null;
  sleepPlanId?: string | null;
  routineStepId?: string | null;
  alternativeActionIds?: readonly string[];
  evidence?: readonly string[];
  bannerText?: string | null;
}

const text = (value: string | null | undefined, limit = TEXT_LIMIT) => (value ?? "").slice(0, limit);
const finite = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;

/**
 * Normalises what the page was showing into the recorded shape: missing values become explicit
 * nulls and unbounded lists are capped, so a capture cannot fail validation or balloon because a
 * recommendation happened to carry a hundred pieces of evidence.
 */
export function buildNowPanelView(input: NowViewInput): NowPanelView {
  const directive = input.currentDirective ?? null;
  return {
    mode: input.mode,
    headline: text(input.headline),
    planningStatus: (input.planningStatus ?? null) as NowPanelView["planningStatus"],
    planningDecisionCurrent: Boolean(input.planningDecisionCurrent),
    currentEnergy: text(input.currentEnergy, 40),
    assertedConditions: [...(input.assertedConditions ?? [])].map((value) => text(value, 80)),
    countdownSeconds: finite(input.countdownSeconds),
    session: input.session
      ? {
          id: input.session.id,
          status: input.session.status,
          targetType: input.session.targetType,
          targetId: input.session.targetId,
          targetTitle: input.session.targetTitle ?? null,
          plannedMinutes: finite(input.session.plannedMinutes) ?? 0,
          plannedEndAt: input.session.plannedEndAt
        }
      : null,
    primary: input.primary
      ? {
          actionId: input.primary.actionId,
          title: text(input.primary.title),
          recommendedMinutes: finite(input.primary.recommendedMinutes)
        }
      : null,
    currentDirective: directive
      ? {
          kind: directive.kind,
          // Recovery and none directives name no target; recording that as an empty string would read as
          // a target that exists. A journey's target is the place it goes to — it has no other one, and
          // without it a captured travel directive could not be told from any other travel directive.
          targetId:
            directive.kind === "travel" ? directive.toLocationId : "targetId" in directive ? directive.targetId : null,
          title: text(directive.title),
          recommendedMinutes: finite(directive.recommendedMinutes) ?? 0
        }
      : null,
    protectedCommitmentId: input.protectedCommitmentId ?? null,
    sleepPlanId: input.sleepPlanId ?? null,
    routineStepId: input.routineStepId ?? null,
    alternativeActionIds: [...(input.alternativeActionIds ?? [])].slice(0, ALTERNATIVE_LIMIT),
    evidence: [...(input.evidence ?? [])].slice(0, EVIDENCE_LIMIT).map((value) => text(value)),
    bannerText: text(input.bannerText)
  };
}
