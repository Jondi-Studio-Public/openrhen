import type { DayPlan, PrepPace, StayUpOffer } from "./plan-forecast.js";
import type { PortalStateContract } from "../portal/state-schema.js";
import { localDateOf } from "./cadence-due.js";
import { resolveNowActivity, type NowActivityState } from "./now-activity.js";

/**
 * The rest of the engine's answer, beside `buildNowAnswer`'s directive: why this and not the nearer
 * thing, what would change it, when it ends, what comes second, what gates the step on the clock,
 * tonight's sleep errors and stay-up offer, what is at risk, and the shape of the day.
 *
 * Now showed all of this and MCP `status` showed none of it, so an agent asking "why" fell back to
 * `rhen_state` (1.4 MB) and read the engine's raw result itself (trust review 2026-10-27, lane B).
 * Every field is read from the stored planning result, never recomputed: the Now page and `status`
 * both call this, so the two cannot disagree about the same planning run.
 */

type StoredCommitment = PortalStateContract["commitments"][number];

interface WireCandidate {
  /** A deliverable is ranked as a synthetic action `deliverable:<id>`; `deliverableId` names the real one. */
  action: { id: string; title: string; projectId?: string | null; deliverableId?: string };
  recommendedMinutes: number | null;
  recommendedWallClockMinutes?: number | null;
  criticalTier?: string;
  criticalReason?: string;
}

interface WireChoice {
  targetId: string;
  title: string;
  tier: string;
  tierLabel: string;
  reason: string;
}

interface WireCounterfactual {
  condition: string;
  description: string;
  thenPrimary: { targetId: string; title: string; recommendedMinutes: number } | null;
}

interface WireProtected {
  id: string;
  title: string;
  phase: string;
  late?: boolean;
}

/** The engine's stored recommendation, as much of it as this module reads. Opaque JSON on the wire. */
export interface WireRecommendation {
  primary: WireCandidate | null;
  alternatives?: WireCandidate[];
  headline?: string;
  explanation?: string;
  evidence?: string[];
  why?: {
    because: WireChoice | null;
    whyNot: (WireChoice & { decidingFactor: string }) | null;
    wouldChangeIf: WireCounterfactual[];
  };
  protectedCommitment?: WireProtected;
  openAnchor?: WireProtected;
}

/** One project forecast, as much of it as this module reads. Dates arrive as ISO strings or `Date`s. */
export interface WireForecast {
  projectId: string;
  health: string;
  overdue?: boolean;
  healthBasis?: string;
  adherence?: { health: string };
  proposal?: { deadlineOwner?: string };
  interventions?: { kind: string; minutes: number; reason: string }[];
  expectedMarginMinutes: number | null;
  pessimisticMarginMinutes?: number | null;
  requiredPaceMinutesPerWeek: number | null;
  forecastBand?: string | null;
  confidence?: string | null;
  internalDeadlineAt?: unknown;
  reasons: string[];
}

export interface RecommendationChoice {
  targetId: string;
  title: string;
  tier: string;
  reason: string;
}

export interface RecommendationAnswer {
  headline: string | null;
  explanation: string | null;
  evidence: string[];
  /** The engine's primary piece of work, with the critical tier that put it first. */
  primary: {
    /** What `activity start` takes: an action, or the deliverable a deliverable candidate stands for. */
    kind: "action" | "deliverable";
    targetId: string;
    title: string;
    projectId?: string;
    recommendedMinutes: number;
    wallClockMinutes: number;
    tier?: string;
    tierReason?: string;
  } | null;
  /**
   * When the suggestion ends: a running session's own planned end, else now plus the primary's
   * wall-clock minutes (the focused figure for a result stored before the engine told them apart).
   * Null with neither a session nor a primary, or when something else (a step, a journey, a held
   * commitment, sleep) is what Now shows.
   */
  plannedEnd: string | null;
  because: RecommendationChoice | null;
  whyNot: (RecommendationChoice & { decidingFactor: string }) | null;
  wouldChangeIf: WireCounterfactual[];
  /** The next commitment the suggestion fits before, and the minutes to spare (negative: it does not). */
  fitsBefore: { commitmentId: string; title: string; startsAt: string; spareMinutes: number } | null;
  /** The primary's project forecast; null when the project has none yet. */
  projectHealth: { projectId: string; health: string; overdue: boolean; marginMinutes: number | null } | null;
  /** What comes second: the engine's first alternative. */
  runnerUp: {
    kind: "action" | "deliverable";
    targetId: string;
    title: string;
    recommendedMinutes: number;
    tier?: string;
  } | null;
  gates: RecommendationGates;
  /** Tonight's night as the Now sleep panel shows it; null when no night is due or upcoming. */
  sleep: { nightId: string; hardErrors: string[]; minimumShortfallMinutes?: number } | null;
  /** The engine's stay-up-for-work offer, exactly as sent; null when none stands. */
  stayUpOffer: StayUpOffer | null;
}

/** What decides the thing on the clock beyond the ranking itself. */
export interface RecommendationGates {
  /** Which rule put a routine step on the clock: the engine named it, it was found in window, or it gates that one. */
  stepSource?: "directive" | "fallback" | "prerequisite";
  /** A late commitment is letting its own unfinished preparation run ahead of it. */
  lateCommitmentStepsRun: boolean;
  /** The commitment holding the clock, its phase, and whether it is running late. */
  protectedCommitment?: { id: string; title: string; phase: string; late: boolean };
  /** A running anchor whose hour is open to other work. */
  openAnchor?: { id: string; title: string };
  /** A location was asserted but is too old to trust, so work tied to a place is not assumed. */
  locationStale: boolean;
}

export type RiskSummary =
  | {
      kind: "project";
      projectId: string;
      title: string;
      health: string;
      overdue: boolean;
      /** A self-set date that passed: stale, not overdue. */
      lapsed: boolean;
      marginMinutes: number | null;
      requiredPaceMinutesPerWeek: number | null;
      reason?: string;
      /** The smallest useful change the engine found, when the work does not fit. */
      smallestFix?: { kind: string; minutes: number; reason: string };
    }
  | { kind: "step_start_by"; stepId: string; title: string; anchorTitle: string; startBy: string; status: string }
  | {
      kind: "prep_pace";
      commitmentId: string;
      title: string;
      startsAt: string;
      status: string;
      minutesBehind: number;
      projectedLateMinutes?: number;
    };

export interface DayEntry {
  startsAt: string;
  endsAt: string;
  kind: string;
  title: string;
  targetId: string | null;
  minutes: number;
  /** `firm` is decided; `projected` is the engine's replay of what would follow. */
  confidence: string;
}

export interface RecommendationAnswerInput {
  state: NowActivityState & {
    projects: ReadonlyArray<{ id: string; title: string }>;
    settings: { timezone: string };
  };
  /** The stored planning result, or undefined before the engine's first run. */
  result:
    | {
        recommendation?: unknown;
        schedule?: unknown;
        currentDirective?: unknown;
        dayPlan?: DayPlan | undefined;
        prepPace?: PrepPace | undefined;
        stayUpOffer?: StayUpOffer | undefined;
        startByWarnings?:
          | readonly { stepId: string; anchorTitle: string; title: string; startBy: string; status: string }[]
          | undefined;
      }
    | undefined;
  now: Date;
  /** True while an early bedtime has been chosen by hand on this page; the device and the CLI cannot set it. */
  manualBedtime?: boolean;
}

const RISKY_HEALTH = new Set(["behind", "at_risk"]);
const HEALTH_ORDER: Record<string, number> = { behind: 0, at_risk: 1 };

/** Overdue first, then behind before at risk before the rest, then the thinnest margin. */
export function worstFirst(a: WireForecast, b: WireForecast): number {
  return (
    Number(b.overdue === true) - Number(a.overdue === true) ||
    (HEALTH_ORDER[displayHealth(a)] ?? 2) - (HEALTH_ORDER[displayHealth(b)] ?? 2) ||
    (a.expectedMarginMinutes ?? 0) - (b.expectedMarginMinutes ?? 0)
  );
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function target(candidate: WireCandidate): { kind: "action" | "deliverable"; targetId: string } {
  return candidate.action.deliverableId
    ? { kind: "deliverable", targetId: candidate.action.deliverableId }
    : { kind: "action", targetId: candidate.action.id };
}

function choice(value: WireChoice): RecommendationChoice {
  return { targetId: value.targetId, title: value.title, tier: value.tier, reason: value.reason };
}

/** A maintenance project's real health is its adherence; `health` itself stays "unknown" for those. */
export function displayHealth(forecast: WireForecast): string {
  return forecast.healthBasis === "adherence" && forecast.adherence ? forecast.adherence.health : forecast.health;
}

export function forecastsOf(schedule: unknown): WireForecast[] {
  const forecasts = (schedule as { forecasts?: unknown } | null | undefined)?.forecasts;
  return Array.isArray(forecasts) ? (forecasts as WireForecast[]) : [];
}

export function recommendationOf(result: RecommendationAnswerInput["result"]): WireRecommendation | null {
  const value = result?.recommendation as WireRecommendation | null | undefined;
  return value && typeof value === "object" ? value : null;
}

export function buildRecommendationAnswer(input: RecommendationAnswerInput): RecommendationAnswer {
  const { state, result, now } = input;
  const recommendation = recommendationOf(result);
  const primary = recommendation?.primary ?? null;
  const commitments = state.commitments as StoredCommitment[];
  const brain = resolveNowActivity({
    state,
    now,
    currentDirective: (result?.currentDirective as never) ?? null,
    protectedCommitment: recommendation?.protectedCommitment ?? null,
    primary,
    manualBedtime: input.manualBedtime ?? false
  });

  const session = state.activeSession;
  // Only while the ranked primary is what is on the clock, as the Now kicker shows it: a routine
  // step, a journey, a held commitment or a due sleep is Now instead, and the primary's end is no one's.
  const primaryIsNow = brain.resolution.kind === "recommended" && !brain.currentWakeStep;
  // A pick still inside its break starts when the break ends, so its planned end counts from there.
  const notBefore = (result?.currentDirective as { notBefore?: string } | null | undefined)?.notBefore;
  const startsAt = notBefore && new Date(notBefore) > now ? new Date(notBefore) : now;
  const plannedEnd = session
    ? session.plannedEndAt
    : primary && primaryIsNow
      ? new Date(
          startsAt.getTime() + (primary.recommendedWallClockMinutes ?? primary.recommendedMinutes ?? 0) * 60_000
        ).toISOString()
      : null;

  const nextCommitment = commitments
    .filter((item) => item.status !== "cancelled" && new Date(item.startsAt) > now)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0];
  const fitsBefore =
    nextCommitment && plannedEnd
      ? {
          commitmentId: nextCommitment.id,
          title: nextCommitment.title,
          startsAt: nextCommitment.startsAt,
          spareMinutes: Math.round(
            (new Date(nextCommitment.startsAt).getTime() - new Date(plannedEnd).getTime()) / 60_000
          )
        }
      : null;

  const forecasts = forecastsOf(result?.schedule);
  const primaryProjectId = primary?.action.projectId ?? undefined;
  const primaryForecast = primaryProjectId ? forecasts.find((item) => item.projectId === primaryProjectId) : undefined;

  const runnerUpCandidate = recommendation?.alternatives?.[0];
  const protectedInfo = brain.protectedInfo?.protectedCommitment as WireProtected | undefined;
  const openAnchor =
    recommendation?.openAnchor &&
    commitments.some((item) => item.id === recommendation.openAnchor?.id && item.status === "confirmed")
      ? recommendation.openAnchor
      : undefined;
  const night = brain.sleepDue ?? brain.upcomingSleep;

  return {
    headline: recommendation?.headline ?? null,
    explanation: recommendation?.explanation ?? null,
    evidence: recommendation?.evidence ?? [],
    primary: primary
      ? {
          ...target(primary),
          title: primary.action.title,
          ...(primaryProjectId !== undefined ? { projectId: primaryProjectId } : {}),
          recommendedMinutes: primary.recommendedMinutes ?? 0,
          wallClockMinutes: primary.recommendedWallClockMinutes ?? primary.recommendedMinutes ?? 0,
          ...(primary.criticalTier !== undefined ? { tier: primary.criticalTier } : {}),
          ...(primary.criticalReason !== undefined ? { tierReason: primary.criticalReason } : {})
        }
      : null,
    plannedEnd,
    because: recommendation?.why?.because ? choice(recommendation.why.because) : null,
    whyNot: recommendation?.why?.whyNot
      ? { ...choice(recommendation.why.whyNot), decidingFactor: recommendation.why.whyNot.decidingFactor }
      : null,
    wouldChangeIf: recommendation?.why?.wouldChangeIf ?? [],
    fitsBefore,
    projectHealth: primaryForecast
      ? {
          projectId: primaryForecast.projectId,
          health: displayHealth(primaryForecast),
          overdue: primaryForecast.overdue === true,
          marginMinutes: primaryForecast.expectedMarginMinutes
        }
      : null,
    runnerUp: runnerUpCandidate
      ? {
          ...target(runnerUpCandidate),
          title: runnerUpCandidate.action.title,
          recommendedMinutes: runnerUpCandidate.recommendedMinutes ?? 0,
          ...(runnerUpCandidate.criticalTier !== undefined ? { tier: runnerUpCandidate.criticalTier } : {})
        }
      : null,
    gates: {
      ...(brain.routineDueSource !== undefined ? { stepSource: brain.routineDueSource } : {}),
      // `routineStepsRunDespiteCommitment` is also true with no commitment at all; only the late case is a gate.
      lateCommitmentStepsRun: Boolean(protectedInfo && brain.routineStepsRunDespiteCommitment),
      ...(protectedInfo
        ? {
            protectedCommitment: {
              id: protectedInfo.id,
              title: protectedInfo.title,
              phase: protectedInfo.phase,
              late: protectedInfo.late === true
            }
          }
        : {}),
      ...(openAnchor ? { openAnchor: { id: openAnchor.id, title: openAnchor.title } } : {}),
      locationStale: brain.situation.locationStale
    },
    sleep: night
      ? {
          nightId: night.id,
          hardErrors: night.hardErrors,
          ...(night.minimumShortfallMinutes !== undefined
            ? { minimumShortfallMinutes: night.minimumShortfallMinutes }
            : {})
        }
      : null,
    stayUpOffer: result?.stayUpOffer ?? null
  };
}

/**
 * What is at risk, worst first: projects past an outside date, preparation behind, steps whose latest
 * start has gone, projects behind, preparation tight, projects at risk, lapsed own dates, then steps
 * due to start soon.
 */
export function buildRisks(input: Pick<RecommendationAnswerInput, "state" | "result">): RiskSummary[] {
  const titleById = new Map(input.state.projects.map((project) => [project.id, project.title]));
  const projects = forecastsOf(input.result?.schedule)
    .filter((forecast) => RISKY_HEALTH.has(displayHealth(forecast)) || forecast.overdue === true)
    .sort(worstFirst)
    .map((forecast): RiskSummary => {
      const fix = forecast.interventions?.[0];
      return {
        kind: "project",
        projectId: forecast.projectId,
        title: titleById.get(forecast.projectId) ?? forecast.projectId,
        health: displayHealth(forecast),
        overdue: forecast.overdue === true,
        lapsed: forecast.overdue === true && forecast.proposal?.deadlineOwner === "internal",
        marginMinutes: forecast.expectedMarginMinutes,
        requiredPaceMinutesPerWeek: forecast.requiredPaceMinutesPerWeek,
        ...(forecast.reasons[0] !== undefined ? { reason: forecast.reasons[0] } : {}),
        ...(fix ? { smallestFix: { kind: fix.kind, minutes: fix.minutes, reason: fix.reason } } : {})
      };
    });
  const steps = [...(input.result?.startByWarnings ?? [])]
    .sort((a, b) => Number(b.status === "missed") - Number(a.status === "missed"))
    .map((warning): RiskSummary => ({
      kind: "step_start_by",
      stepId: warning.stepId,
      title: warning.title,
      anchorTitle: warning.anchorTitle,
      startBy: iso(warning.startBy),
      status: warning.status
    }));
  const pace = input.result?.prepPace;
  const prep: RiskSummary[] =
    pace && pace.status !== "on_track"
      ? [
          {
            kind: "prep_pace",
            commitmentId: pace.commitmentId,
            title: pace.commitmentTitle,
            startsAt: iso(pace.commitmentStartsAt),
            status: pace.status,
            minutesBehind: pace.minutesBehind,
            ...(pace.projectedLateMinutes !== undefined ? { projectedLateMinutes: pace.projectedLateMinutes } : {})
          }
        ]
      : [];
  // Worst first across kinds, so a cap keeps the worst: an overdue project outranks a step that is
  // merely due soon. Stable within a rank, which keeps each kind's own order.
  return [...prep, ...steps, ...projects]
    .map((risk, index) => ({ risk, index, rank: riskRank(risk) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.risk);
}

function riskRank(risk: RiskSummary): number {
  switch (risk.kind) {
    case "project":
      if (risk.overdue && !risk.lapsed) return 0;
      if (risk.health === "behind") return 3;
      if (risk.health === "at_risk") return 5;
      return 6;
    case "prep_pace":
      return risk.status === "behind" ? 1 : 4;
    case "step_start_by":
      return risk.status === "missed" ? 2 : 7;
  }
}

/** The day plan through local midnight: what is running now and every block that starts today. */
export function buildDay(input: Pick<RecommendationAnswerInput, "state" | "result" | "now">): DayEntry[] {
  const blocks = input.result?.dayPlan?.blocks ?? [];
  const timezone = input.state.settings.timezone;
  const today = localDateOf(input.now, timezone);
  return blocks
    .filter((block) => {
      const startsAt = new Date(block.startsAt);
      return localDateOf(startsAt, timezone) <= today && new Date(block.endsAt) > input.now;
    })
    .map((block) => ({
      startsAt: iso(block.startsAt),
      endsAt: iso(block.endsAt),
      kind: block.kind,
      title: block.title,
      targetId: block.targetId,
      minutes: block.wallClockMinutes,
      confidence: block.confidence
    }));
}
