import { evaluateConditions, type ConditionMatch, type EnergyType, type ResolvedSituation } from "@openrhen/contracts";
import { calculateActionEffort } from "../scheduling/effort.js";
import { currentCompatibleWindow } from "../scheduling/slots.js";
import { energyCompatible } from "../scheduling/time.js";
import type { analyzeDependencies } from "../scheduling/dependencies.js";
import type {
  Action,
  CriticalRank,
  CriticalTier,
  FixedCommitment,
  PlanningConfig,
  PlanningResult,
  Project,
  ProjectForecast,
  RecommendationCandidate
} from "../model/types.js";
import {
  ARRIVAL_MARGIN_MINUTES,
  commitmentProtection,
  defaultPlanningConfig,
  SESSION_BREAK_MINUTES
} from "../model/types.js";
import { formatDate, formatMinutes, formatTime, localiseTimes } from "./format.js";
import { cadenceDueRatio, cadencePeriodPressure, cadencePressure } from "../recurrence/cadence.js";
import { evaluateTrip, nextAnchorAfter, travelCostOf, type TripContext } from "./travel.js";

export type { CriticalRank, CriticalTier } from "../model/types.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * Weighted ranking answers "what is the best use of a moment that is not deadline-critical".
 * Genuine deadline risk is carried by the critical tier below, not by out-scoring everything else.
 */
export const scoreWeights = {
  capacityPressure: 30,
  consequence: 15,
  outcomeValue: 15,
  /**
   * The action's own rating, discriminating siblings inside one project. Centred on the default of 3
   * so an unrated action contributes exactly zero regardless of what else is rated. Bounded
   * by the smallest adjacent gap in the rounded outcomeValue ladder (0,4,8,11,15 — gap 3) so no
   * spread of importance can reorder two actions in different-value projects: see the cross-project
   * non-interference test in test/replay/rating-ranking.test.ts, which also demonstrates the weight
   * one higher breaking that bound.
   */
  importance: 2,
  neglect: 12,
  momentum: 10,
  conditionEnergyFit: 8,
  completionBonus: 10,
  switchingCost: 10,
  /**
   * A cadence's own pressure: how far past its interval it is, scaled by the action's
   * importance. Sized so a due high-importance cadence wins free time from ordinary backlog while
   * a low-importance one merely competes with it — never so large it reaches the deadline tiers.
   */
  cadenceDue: 40
} as const;

/** Deadline proximity stops discriminating past this many days. */
const PROXIMITY_HORIZON_DAYS = 30;
/** Latest-safe-start pressure ramps over this many hours. */
const START_PRESSURE_HOURS = 72;
/** Days of inactivity that count as fully neglected. */
const NEGLECT_THRESHOLD_DAYS = 7;
/** A latest safe start inside this window makes an action deadline-critical. */
export const CRITICAL_START_LOOKAHEAD_MS = DAY_MS;
/** Deadlines inside the exact planning horizon are treated as committed work. */
const CRITICAL_DEADLINE_DAYS = 7;

/**
 * How badly the deadline is being missed, before the external/internal split is applied. The split
 * lives in RANK_BY_SEVERITY so the two dimensions stay independently readable.
 */
type CriticalSeverity = "overdue" | "behind" | "at_risk" | "committed";

/**
 * The deadline ladder, in order. Every tier is named; the number only fixes the order. See
 * CriticalRank for the reasoning behind where overdue work sits.
 */
export const CRITICAL_TIERS: readonly CriticalTier[] = [
  "overdue_external",
  "behind_external",
  "at_risk_external",
  "behind_internal",
  "at_risk_internal",
  "due_this_week_external",
  "ordinary"
];
export const CRITICAL_TIER_LABELS: Record<CriticalTier, string> = {
  overdue_external: "Overdue external deadline",
  behind_external: "Behind an external deadline",
  at_risk_external: "Losing margin against an external deadline",
  behind_internal: "Behind a self-set deadline",
  at_risk_internal: "Losing margin against a self-set deadline",
  due_this_week_external: "External deadline this week",
  stale_date: "Self-set date lapsed; still wanted?",
  ordinary: "Ordinary weighted ranking"
};
export function rankOf(tier: CriticalTier): CriticalRank {
  // A stale date is off the ladder: it ranks with ordinary work and is told apart by its tier name.
  if (tier === "stale_date") return ORDINARY_RANK;
  return CRITICAL_TIERS.indexOf(tier) as CriticalRank;
}
export function tierOf(rank: CriticalRank): CriticalTier {
  return CRITICAL_TIERS[rank] ?? "ordinary";
}

/** Which tier each severity lands in, by who owns the deadline. Internal "committed" is ordinary: see selfSetDeadlineBonus. */
const TIER_BY_SEVERITY: Record<CriticalSeverity, { external: CriticalTier; internal: CriticalTier }> = {
  overdue: { external: "overdue_external", internal: "stale_date" },
  behind: { external: "behind_external", internal: "behind_internal" },
  at_risk: { external: "at_risk_external", internal: "at_risk_internal" },
  committed: { external: "due_this_week_external", internal: "ordinary" }
};
/** Nothing deadline-driven applies; the weighted score decides. */
export const ORDINARY_RANK: CriticalRank = rankOf("ordinary");

export interface CriticalAssessment {
  rank: CriticalRank;
  tier: CriticalTier;
  reason: string | null;
  /**
   * Present only when this candidate is a self-set deadline due this week that ranks ordinary rather
   * than pre-empting the weighted ranking: 45 when the forecast measures the project, 30 when its
   * health is unknown. Absent for a cadence action, which never gets it (zeroed, as `importance` is).
   */
  selfSetDeadlineBonus?: number;
}

/** The `selfSetDeadline` score component, by whether the project's forecast measures it. */
const SELF_SET_DEADLINE_BONUS_MEASURED = 45;
const SELF_SET_DEADLINE_BONUS_UNMEASURED = 30;

/**
 * The effective consequence of working an action, combining the action's own rating with its
 * project's — weighted mean, project-leaning — rather than taking the harsher of the two: a
 * fragile action inside a high-stakes project must outrank a safe one there, and a safe action in a
 * low-stakes project must score as safe rather than inheriting a default floor from an unrated
 * action. The 0.6/0.4 split keeps the project dominant while letting the action's own
 * rating discriminate; both terms are already 1–5, so the result needs no wider normaliser than
 * `normalizeFive`. Mirrors the consequence score component so ranking and scoring cannot disagree.
 */
export function effectiveConsequence(action: Action, project: Project | undefined): number {
  const p = project?.consequence ?? 1;
  return 0.6 * p + 0.4 * action.consequence;
}

export interface ScoreActionInput {
  now: Date;
  horizonEnd: Date;
  action: Action;
  project: Project | undefined;
  forecast: ProjectForecast | undefined;
  planning: PlanningResult;
  resolved: ResolvedSituation;
  currentEnergy?: EnergyType;
  /**
   * Actions whose declared-energy check is waived, and only that check: the person accepted a
   * stretch offer for them (low-energy deadlines design). Every other rule, tier and weight applies
   * unchanged, and every other action is still held to the declared energy. Absent means none.
   */
  energyWaivedActionIds?: readonly string[];
  activeActionId?: string;
  lastAction?: Action | undefined;
  dailyHorizonEnd?: Date | undefined;
  dependencyAnalysis: ReturnType<typeof analyzeDependencies>;
  config?: PlanningConfig;
  /** The travel policy resolved for this instant. Absent when the request knows of no places. */
  trip?: TripContext;
  /** Minutes owed after a full-length session before the action is eligible again. Defaults to
   * `SESSION_BREAK_MINUTES` when absent. */
  sessionBreakMinutes?: number;
  /** Minutes before a commitment you aim to arrive; `ARRIVAL_MARGIN_MINUTES` when absent. */
  arrivalMarginMinutes?: number;
  /** The commitments in force (`protectedCommitments` when supplied), and the anchors declared open.
   * A resting deadline candidate is kept only while none of them is protected inside its break. */
  commitments?: FixedCommitment[];
  protectedCommitments?: FixedCommitment[];
  freeAnchorIds?: string[];
  /** IANA zone the person reads times in; UTC when absent. */
  timezone?: string;
  locale?: string;
  /** The latest ended session per target (action id, or deliverable id). Defaults to none. */
  lastEndedSessions?: { targetId: string; endedAt: Date; focusedMinutes: number }[];
}

export function scoreAction(input: ScoreActionInput): RecommendationCandidate {
  // A waived action is scored as if no energy had been declared (production windows are
  // "unconfirmed", which any action fits). Dropping the declaration here, once, keeps the cut, the
  // fit term and the reason text agreeing with each other. An action the declared energy already
  // fits is left alone, so a waiver never changes the score of work that was never blocked.
  const args: ScoreActionInput =
    input.currentEnergy !== undefined &&
    input.energyWaivedActionIds?.includes(input.action.id) &&
    !energyCompatible(input.action.energy, input.currentEnergy)
      ? (({ currentEnergy: _waived, ...rest }) => rest)(input)
      : input;
  const config = args.config ?? defaultPlanningConfig;
  const { action, project, forecast } = args;
  const conditionMatch = matchContexts(args);
  // Assessed up front, for ineligible candidates too (see below): the break rule depends on the tier.
  const critical: CriticalAssessment = assessCritical(args, config);
  // Deadline-tier work is not rested out of the ranking, since a short break must not hand Now to a
  // low-stakes chore; it keeps its place and the break is said alongside its reason instead.
  // Starting it now runs across the break, so a protected commitment inside the break would be
  // overrun by a session sized from the break's end; then it rests like ordinary work instead.
  const deadlineRest = critical.rank < ORDINARY_RANK ? restingUntil(args) : undefined;
  const restUntil = deadlineRest && !commitmentDuringBreak(args, deadlineRest) ? deadlineRest : undefined;
  const exclusionReasons = eligibilityFailures(args, conditionMatch, restUntil !== undefined);
  // It starts when the break ends, so a latest useful start that falls inside the break has passed.
  if (restUntil && action.latestStartAt && args.now <= action.latestStartAt && restUntil > action.latestStartAt)
    exclusionReasons.push(
      `Latest useful start, ${formatTime(action.latestStartAt, args.timezone, args.locale)}, falls inside the break.`
    );
  // Blocked by being somewhere else and nothing else: the one case a journey could answer.
  const elsewhere =
    exclusionReasons.length === 1 &&
    conditionMatch.status === "no" &&
    conditionMatch.unknowns.length === 0 &&
    conditionMatch.missing.length === 1 &&
    args.resolved.definitionOf(conditionMatch.missing[0]!)?.kind === "location";

  const boundedHorizon =
    args.dailyHorizonEnd && args.dailyHorizonEnd < args.horizonEnd ? args.dailyHorizonEnd : args.horizonEnd;
  // A resting deadline candidate starts when the break ends, so its session is sized from there.
  const startAt = restUntil ?? args.now;
  const currentWindow = currentCompatibleWindow({
    now: startAt,
    horizonEnd: boundedHorizon,
    action,
    slots: args.planning.slots
  });
  const riskRemaining = project
    ? calculateActionEffort(action, project, config).riskAdjustedRemainingMinutes
    : action.remainingMinutes;
  const journey =
    args.trip && elsewhere
      ? evaluateTrip({
          // The break comes first, then the journey, so the trip is measured from when the break ends.
          now: startAt,
          action,
          slots: args.planning.slots,
          boundedHorizon,
          horizonEnd: args.horizonEnd,
          riskRemaining,
          originLocationId: args.resolved.locationId,
          reach: conditionMatch.reachableVia,
          slackUntil: slackUntil(args),
          context: restUntil ? delayedTripContext(args.trip, startAt, args.arrivalMarginMinutes) : args.trip
        })
      : {};
  const trip = journey.trip;
  // A trip candidate's session is measured where the work happens; its wall clock carries the leg.
  const window = journey.window ?? currentWindow;
  const recommendedMinutes = Math.min(riskRemaining, action.maximumSessionMinutes, window.minutes);
  const otherFailures = exclusionReasons.length;
  // A location blocker (`elsewhere`) is refused for being somewhere else, not for the window it
  // would occupy once there — a trip candidate is evaluated at the destination, and a refused trip
  // (no `journey`/`trip` because none was reachable, or none was offered) must not also carry a
  // stray "Only N compatible minutes"/indivisible-window exclusion measured against the window here,
  // which was never the constraint.
  if (!trip && !elsewhere && recommendedMinutes < action.minimumSessionMinutes)
    exclusionReasons.push(
      `Only ${recommendedMinutes} compatible minutes are available; ${action.minimumSessionMinutes} are required.`
    );
  if (!trip && !elsewhere && action.splittable === false && currentWindow.minutes < riskRemaining)
    exclusionReasons.push(
      `This indivisible action needs ${riskRemaining} continuous minutes; only ${currentWindow.minutes} fit.`
    );
  // Travelling answers the one exclusion there was, so the candidate stands on ordinary eligibility.
  const exclusions = trip ? [] : exclusionReasons;
  // Focused minutes are wall-clock minutes discounted by the window's usable fraction. Both are
  // reported so a session can be stated honestly: "45 focused minutes in the 60 before X".
  const wallClockBeforeBoundary = Math.max(
    0,
    Math.round((window.boundary.getTime() - startAt.getTime()) / 60_000) - (trip ? trip.travelMinutes : 0)
  );
  const usableFraction =
    wallClockBeforeBoundary > 0 && window.minutes > 0 ? Math.min(1, window.minutes / wallClockBeforeBoundary) : null;
  const recommendedWallClockMinutes =
    usableFraction === null
      ? 0
      : Math.min(wallClockBeforeBoundary, Math.ceil(recommendedMinutes / usableFraction)) +
        (trip ? trip.travelMinutes : 0);
  // a candidate with no session at all — zero focused or zero wall-clock minutes — is excluded
  // rather than offered a phantom session. Pushed after `otherFailures` was measured, so a candidate
  // excluded only by this stays `windowBound` and still gets a next fit; applied to a trip candidate
  // too, since a trip's session is measured at the destination and can be just as empty.
  if (recommendedMinutes === 0 || recommendedWallClockMinutes === 0) exclusions.push("No compatible time is open now.");
  const windowBound = !trip && otherFailures === 0 && exclusions.length > 0;

  const availableEnergy = args.currentEnergy ?? window.energy;
  const energyFit =
    restingInRecoveryWindow(args) || availableEnergy === action.energy
      ? 1
      : availableEnergy && energyCompatible(action.energy, availableEnergy)
        ? 0.6
        : 0;
  // Preferences shade the existing weight rather than adding one, so the tuned ranking stays stable.
  // An action stating no preference scores as fully suited, not as indifferent.
  const stated = (action.preferences ?? []).length;
  const preferenceFit = stated === 0 ? 1 : (stated - conditionMatch.unmetPreferences.length) / stated;
  const fit = 0.6 * energyFit + 0.4 * preferenceFit;
  const eligible = exclusions.length === 0;
  // The tier is assessed for ineligible candidates too: eligibility sorts first, so the rank cannot
  // promote a blocked candidate, but erasing the tier hid *what* was being blocked — an overdue
  // assessment excluded by low energy read as ordinary work, and the page could not say what was at stake.

  const scoreComponents = {
    // A stale date applies no deadline pressure: every term of urgency() derives from the lapsed date.
    capacityPressure: Math.round((critical.tier === "stale_date" ? 0 : urgency(args)) * scoreWeights.capacityPressure),
    consequence: Math.round(normalizeFive(effectiveConsequence(action, project)) * scoreWeights.consequence),
    outcomeValue: Math.round(normalizeFive(project?.value ?? action.importance) * scoreWeights.outcomeValue),
    importance: action.cadence ? 0 : (normalizeFive(action.importance) - 0.5) * scoreWeights.importance,
    neglect: Math.round(neglect(action, project, args.now) * scoreWeights.neglect),
    momentum: momentum(args),
    conditionEnergyFit: Math.round(fit * scoreWeights.conditionEnergyFit),
    completionBonus: recommendedMinutes >= riskRemaining ? scoreWeights.completionBonus : 0,
    switchingCost: -switchingCost(action, args.lastAction, args.activeActionId),
    travelCost: travelCostOf(trip),
    cadenceDue: Math.round(cadenceDue(action, args.now) * scoreWeights.cadenceDue),
    selfSetDeadline: critical.selfSetDeadlineBonus ?? 0
  };

  return {
    action,
    eligible,
    exclusionReasons: exclusions.map((reason) => localiseTimes(reason, args.timezone, args.locale)),
    windowBound,
    recommendedMinutes: eligible ? recommendedMinutes : null,
    recommendedWallClockMinutes: eligible ? recommendedWallClockMinutes : null,
    usableFraction: eligible && usableFraction !== null ? Math.round(usableFraction * 100) / 100 : null,
    sessionBoundary: window.boundary,
    totalScore: Object.values(scoreComponents).reduce((sum, value) => sum + value, 0),
    scoreComponents,
    criticalRank: critical.rank,
    criticalTier: critical.tier,
    conditionMatch,
    ...(args.dependencyAnalysis.downstreamMinutesByAction[action.id]
      ? { downstreamMinutes: args.dependencyAnalysis.downstreamMinutesByAction[action.id] }
      : {}),
    ...(restUntil ? { restUntil } : {}),
    ...(critical.reason || restUntil
      ? {
          criticalReason: [
            critical.reason ? localiseTimes(critical.reason, args.timezone, args.locale) : null,
            restUntil
              ? `Take a break until ${formatTime(restUntil, args.timezone, args.locale)} first, then start this.`
              : null
          ]
            .filter(Boolean)
            .join(" ")
        }
      : {}),
    ...(eligible && forecast?.overdue && forecast.proposal
      ? {
          proposal: {
            ...forecast.proposal,
            reason: localiseTimes(forecast.proposal.reason, args.timezone, args.locale)
          }
        }
      : {}),
    ...(trip ? { trip } : {}),
    ...(journey.tripReason ? { tripReason: journey.tripReason } : {})
  };
}

/**
 * How long this work can wait before deferring it costs something: the earliest of its latest safe
 * start, its own latest useful start, and its deadline. A later opportunity beyond that point is no
 * opportunity at all, so the journey to it now is unavoidable.
 */
function slackUntil(args: ScoreActionInput): Date | undefined {
  const latestSafeStart = resolvedLatestSafeStart(
    args.forecast,
    args.action.forecastUnitId ?? args.action.id,
    args.now
  );
  const times = [args.action.latestStartAt, latestSafeStart, effectiveDeadline(args)].flatMap((date) =>
    date ? [date.getTime()] : []
  );
  return times.length ? new Date(Math.min(...times)) : undefined;
}

/**
 * A unit's latest safe start as every reader should see it: a unit the forecaster could not place
 * (`unplacedUnitIds`) presses at maximum, as if its latest safe start were `now`, even though
 * `latestSafeStarts` itself may still hold `null` (held back, unforecast) or a placed date (short only
 * of its risk buffer — see `forecast-reservation`) for that same id. Absent `unplacedUnitIds` (results
 * stored before this field existed), this is exactly `forecast.latestSafeStarts[unitId] ?? undefined`,
 * so every caller's behaviour before the field existed is unchanged.
 */
export function resolvedLatestSafeStart(
  forecast: ProjectForecast | undefined,
  unitId: string,
  now: Date
): Date | undefined {
  if (forecast?.unplacedUnitIds?.includes(unitId)) return now;
  return forecast?.latestSafeStarts[unitId] ?? undefined;
}

/**
 * Requirements come from the pathways, which are AND within a pathway and OR across them. The legacy
 * flat tags stand in as a single pathway while the portal still writes both, so an action that has
 * not been migrated keeps behaving exactly as it did.
 */
function matchContexts(args: ScoreActionInput): ConditionMatch {
  const { action } = args;
  const pathways =
    action.requirementPathways ??
    (action.contexts.length ? [{ id: `${action.id}:legacy`, contextIds: action.contexts }] : []);
  return evaluateConditions({ pathways, preferences: action.preferences ?? [], resolved: args.resolved });
}

/**
 * Rest needs no energy: inside an open protected recovery window a recovery action is not held to the
 * person's current energy. Anywhere else the ordinary energy rule stands.
 */
function restingInRecoveryWindow(args: ScoreActionInput): boolean {
  if (args.action.energy !== "recovery") return false;
  const now = args.now.getTime();
  return args.planning.slots.some(
    (slot) => slot.availability === "protected" && slot.startsAt.getTime() <= now && slot.endsAt.getTime() > now
  );
}

/** Whether a protected commitment (other than an open anchor) is in force at any point of the break,
 * its end included: started now, a session sized from the break's end would run across it. */
function commitmentDuringBreak(args: ScoreActionInput, restUntil: Date): boolean {
  const margin = args.arrivalMarginMinutes ?? ARRIVAL_MARGIN_MINUTES;
  const free = new Set(args.freeAnchorIds ?? []);
  return (args.protectedCommitments ?? args.commitments ?? []).some((commitment) => {
    if (free.has(commitment.id)) return false;
    const protection = commitmentProtection(commitment, margin);
    return protection.startsAt <= restUntil && protection.endsAt > args.now;
  });
}

/**
 * The trip context for a journey that leaves when the break ends: bounded by the next commitment after
 * the departure. Nothing is protected inside the break, or the candidate would be resting instead.
 */
function delayedTripContext(trip: TripContext, departAt: Date, arrivalMarginMinutes?: number): TripContext {
  return {
    ...trip,
    nextAnchor: nextAnchorAfter(departAt, trip.anchors, arrivalMarginMinutes ?? ARRIVAL_MARGIN_MINUTES)
  };
}

/**
 * When the maximum-session break ends, if one is owed: not eligible again until `endedAt +
 * sessionBreakMinutes` once a session reaching at least the action's own maximum has ended. Never
 * applies to the running action — that is how an approved continuation overrides it, since the break
 * starts only once the extended session itself ends. A session that stopped short owes nothing.
 */
function restingUntil(args: ScoreActionInput): Date | undefined {
  const { action } = args;
  if (args.activeActionId === action.id) return undefined;
  const key = action.deliverableId ?? action.id;
  const lastEnded = args.lastEndedSessions?.find((session) => session.targetId === key);
  if (!lastEnded || lastEnded.focusedMinutes < action.maximumSessionMinutes) return undefined;
  const restUntil = new Date(
    lastEnded.endedAt.getTime() + (args.sessionBreakMinutes ?? SESSION_BREAK_MINUTES) * 60_000
  );
  return args.now < restUntil ? restUntil : undefined;
}

function eligibilityFailures(args: ScoreActionInput, conditionMatch: ConditionMatch, restKept: boolean): string[] {
  const reasons: string[] = [];
  const { action, project } = args;
  if (!project || project.status !== "active") reasons.push("Parent project is not active.");
  if (project?.outcomeActive === false) reasons.push("Parent outcome is not active.");
  if (action.status !== "planned" && action.status !== "active" && action.status !== "doing")
    reasons.push("Action is not ready to work on.");
  if (args.activeActionId && args.activeActionId !== action.id) reasons.push("Another work session is already active.");
  if (action.availableFrom && action.availableFrom > args.now)
    reasons.push(`Action becomes available at ${formatDate(action.availableFrom, args.timezone, args.locale)}.`);
  if (action.latestStartAt && args.now > action.latestStartAt)
    reasons.push(`Latest useful start passed at ${formatDate(action.latestStartAt, args.timezone, args.locale)}.`);
  // a paused session can leave remaining_minutes at 0 on a live action. That is a different
  // problem from no compatible time being open (below, in scoreAction), so it gets its own reason.
  if (action.remainingMinutes === 0) reasons.push("Nothing remains; mark it done or re-estimate it.");
  // The maximum-session break rests ordinary work, and deadline-tier work whose break holds a
  // protected commitment; other deadline-tier work stays eligible (see scoreAction).
  const restUntil = restKept ? undefined : restingUntil(args);
  if (restUntil)
    reasons.push(`Resting after a full session until ${formatTime(restUntil, args.timezone, args.locale)}.`);
  // A deliverable supplies its own sentence so the prerequisite can be named. "A dependency is
  // incomplete" is true but useless when the person needs to know which one.
  if (!action.dependenciesComplete) reasons.push(action.blockedReason ?? "A dependency is incomplete.");
  // Work that exists but cannot be started by anything the person could do right now. Stated as its
  // own exclusion so the reason names the obstacle instead of leaving a silent absence.
  if (action.unavailableReason) reasons.push(action.unavailableReason);
  if (args.dependencyAnalysis.unresolvedByAction[action.id]?.length)
    reasons.push(`Missing dependency records: ${args.dependencyAnalysis.unresolvedByAction[action.id]!.join(", ")}.`);
  if (args.dependencyAnalysis.errors.some((error) => error.startsWith("Dependency cycle") && error.includes(action.id)))
    reasons.push("Action is part of a dependency cycle.");
  // Known-absent and unanswered are different problems: one needs a change of situation, the other
  // needs a question answered. Both block, but callers tier them apart through conditionMatch.status
  // rather than by reading these strings.
  if (conditionMatch.status === "no") reasons.push(`Missing context: ${conditionMatch.missing.join(", ")}.`);
  else if (conditionMatch.status === "unknown")
    reasons.push(`Unanswered context: ${conditionMatch.unknowns.join(", ")}.`);
  if (args.currentEnergy && !restingInRecoveryWindow(args) && !energyCompatible(action.energy, args.currentEnergy))
    reasons.push(`Current energy is ${args.currentEnergy}; this action requires ${action.energy}.`);
  return reasons;
}

const byTime = (a: Date, b: Date) => a.getTime() - b.getTime();

/**
 * Deferring a deadline-critical action costs safety margin that cannot be recovered, so these
 * candidates are ordered ahead of the weighted ranking rather than competing inside it.
 */
export function assessCritical(
  args: Pick<ScoreActionInput, "now" | "action" | "project" | "forecast" | "timezone" | "locale">,
  config: PlanningConfig = defaultPlanningConfig
): CriticalAssessment {
  const { forecast, action, project, now } = args;
  const deadline = effectiveDeadline(args);
  // Who owns the deadline being measured is one derived value, not "some external date exists": a
  // self-set target on a unit whose external date is much later is a self-set deadline. Every branch
  // below takes this as its owner unless it measures a different deadline and says so.
  const deadlineExternal = deadlineIsExternal({ action, project });
  // The project's forecast health measures the project's own deadline, so its owner is the project's:
  // a deliverable's own external date does not make a self-set project "behind an external deadline".
  const projectExternal = projectDeadlineIsExternal(project);
  const at = (severity: CriticalSeverity, reason: string | null, isExternal = deadlineExternal): CriticalAssessment => {
    const tier = TIER_BY_SEVERITY[severity][isExternal ? "external" : "internal"];
    return { rank: rankOf(tier), tier, reason };
  };
  // Wording carries the distinction through to the Now page, since it is why one action beat another.
  const ownerOf = (isExternal: boolean) => (isExternal ? "an externally committed" : "a self-set");

  // A passed date is not a severity of "cannot fit": nothing done now recovers it. The proposal on
  // the forecast says what would. The forecast only flags this for projects it could measure, so a
  // passed effective deadline counts on its own — an overdue assessment whose deliverables are not
  // broken down must not rank as merely "due this week" while its date recedes into the past.
  //
  // The external date is tested separately from the effective one because the effective deadline
  // prefers the internal date, and an internal date written later than the external one would
  // otherwise mask a passed commitment as ordinary work. The scheduler clamps that date at source,
  // so this only catches assessments made against a forecast built elsewhere or none at all.
  // The external dates in play: the project's and, for a deliverable unit, its own.
  const externalDates = [project?.externalDeadlineAt, action.externalDeadlineAt].filter(
    (date): date is Date => date !== undefined && date !== null
  );
  const externalPassedAt = externalDates.filter((date) => date.getTime() < now.getTime()).sort(byTime)[0];
  const externalAheadAt = externalDates.filter((date) => date.getTime() >= now.getTime()).sort(byTime)[0];
  if (externalPassedAt) {
    // The proposal was built from the project's own external date and the whole project's remaining
    // work, so its reason is only honest when that is the date that passed first. When the earliest
    // passed date is a deliverable's own, name that date and make no claim about whether work fits.
    const proposalIsForThisDate =
      forecast?.proposal?.deadlineOwner === "external" &&
      project?.externalDeadlineAt?.getTime() === externalPassedAt.getTime();
    return at(
      "overdue",
      (proposalIsForThisDate ? forecast!.proposal!.reason : undefined) ??
        (project?.externalDeadlineAt?.getTime() === externalPassedAt.getTime()
          ? `The externally committed date has passed; renegotiate it or record the outcome.`
          : `The externally committed date ${formatDate(externalPassedAt, args.timezone, args.locale)} has passed; renegotiate it or record the outcome.`),
      true
    );
  }
  if (forecast?.overdue || (deadline && deadline.getTime() < now.getTime())) {
    // The effective deadline is the project's own target (or the submission buffer before the
    // external date), so it passing while the external date is still ahead is not a missed
    // commitment. Rank it with the live external deadline it still serves, not at the top.
    if (externalAheadAt) {
      // The proposal's reason, and its `earliestFeasibleAt`, were computed for the whole project against
      // the project's own external date. They are only honest for that date. When this candidate's
      // earliest ahead date is its own, sooner one (the one the Now headline names), say only that
      // the target passed and that date is ahead, with no claim about whether the work fits.
      const proposal = forecast?.proposal;
      const namesOwnDate =
        proposal?.deadlineOwner === "internal" && project?.externalDeadlineAt?.getTime() !== externalAheadAt.getTime();
      return at(
        "at_risk",
        namesOwnDate
          ? `Your own target passed at ${formatDate(proposal.missedDeadlineAt, args.timezone, args.locale)}, but the external date ${formatDate(externalAheadAt, args.timezone, args.locale)} is still ahead.`
          : (proposal?.reason ??
              `Your own target date has passed, but the external date ${formatDate(externalAheadAt, args.timezone, args.locale)} is still ahead.`),
        true
      );
    }
    return at(
      "overdue",
      forecast?.proposal?.reason ?? `The self-set date has lapsed; move it, or mark the project done or paused.`
    );
  }
  // The project's own date, the one its forecast health was measured against.
  const projectDeadline = projectExternal
    ? project?.externalDeadlineAt
    : (forecast?.internalDeadlineAt ?? project?.internalDeadlineAt ?? project?.externalDeadlineAt);
  // The capacity was measured to the forecast's own cutoff: for an external date with a submission
  // buffer that is the buffer's start, earlier than the date itself, and the sizes must say so.
  const cutoff = forecast?.internalDeadlineAt ?? projectDeadline;
  const buffered = projectExternal && cutoff !== undefined && projectDeadline !== undefined && cutoff < projectDeadline;
  if (forecast?.health === "behind") {
    return at(
      "behind",
      `The project is behind ${ownerOf(projectExternal)} deadline and cannot fit its remaining work.${sizeOfGap(forecast, cutoff, args.timezone, true, buffered, args.locale)}${leverFor(forecast, projectExternal, args.timezone, args.locale)}`,
      projectExternal
    );
  }
  if (forecast?.health === "at_risk") {
    const percent = typeof forecast.marginRatio === "number" ? Math.round(forecast.marginRatio * 100) : undefined;
    const needed = Math.round(config.riskMarginRatio * 100);
    const margin =
      percent === undefined
        ? ""
        : forecast.marginRatio! < config.riskMarginRatio
          ? ` Only ${percent}% margin remains, under the ${needed}% it needs.`
          : ` Margin is ${percent}% against the ${needed}% it needs.`;
    return at(
      "at_risk",
      `The project is at risk against ${ownerOf(projectExternal)} deadline and loses safety margin while this waits.${margin}${sizeOfGap(forecast, cutoff, args.timezone, false, buffered, args.locale)}${leverFor(forecast, projectExternal, args.timezone, args.locale)}`,
      projectExternal
    );
  }
  const latestSafeStart = resolvedLatestSafeStart(forecast, action.forecastUnitId ?? action.id, now);
  if (latestSafeStart && latestSafeStart.getTime() <= now.getTime() + CRITICAL_START_LOOKAHEAD_MS) {
    // The latest safe start comes from the deadline being measured, so it takes that deadline's owner.
    return at(
      "at_risk",
      `The latest safe start is ${formatDate(latestSafeStart, args.timezone, args.locale)}.`,
      deadlineExternal
    );
  }
  if (typeof forecast?.marginRatio === "number" && forecast.marginRatio < config.riskMarginRatio) {
    return at(
      "at_risk",
      `Only ${Math.round(forecast.marginRatio * 100)}% margin remains against ${ownerOf(projectExternal)} deadline.`,
      projectExternal
    );
  }
  // An external date inside the window is committed work whichever deadline is being measured, even a
  // deliverable's own far-off target on a project whose external date is near, so the proximity rule
  // lives here and nowhere else (it is not part of who owns the deadline) and it is tested before the
  // "nothing due this week" return below.
  const externalDueThisWeek =
    externalAheadAt !== undefined && daysUntil(externalAheadAt, now) <= CRITICAL_DEADLINE_DAYS;
  if ((!deadline || daysUntil(deadline, now) > CRITICAL_DEADLINE_DAYS) && !externalDueThisWeek)
    return { rank: ORDINARY_RANK, tier: "ordinary", reason: null };
  // A self-set deadline this week competes rather than pre-empting: it ranks ordinary and picks up a
  // score bonus instead of a tier, so a due cadence action or other backlog can still outweigh it.
  if (!deadlineExternal && !externalDueThisWeek) {
    const measured = Boolean(forecast) && forecast!.health !== "unknown";
    return {
      rank: ORDINARY_RANK,
      tier: "ordinary",
      reason: null,
      ...(action.cadence
        ? {}
        : { selfSetDeadlineBonus: measured ? SELF_SET_DEADLINE_BONUS_MEASURED : SELF_SET_DEADLINE_BONUS_UNMEASURED })
    };
  }
  // An external deadline inside the exact horizon is committed work even when capacity is ample.
  if (forecast?.health === "unknown")
    return at(
      "committed",
      "An externally committed deadline is close but the forecast is incomplete; clarify the estimate or dependency.",
      true
    );
  return at(
    "committed",
    `${capitalise(ownerOf(true))} deadline falls within the next ${CRITICAL_DEADLINE_DAYS} days.`,
    true
  );
}

/** "Short by 4h 20m: 12h 40m of work against 8h 20m of time before Tue, 3 Nov." Empty when the forecast has no sizes. */
function sizeOfGap(
  forecast: ProjectForecast,
  deadline: Date | undefined,
  timezone: string | undefined,
  leadWithShortfall = true,
  buffered = false,
  locale?: string
): string {
  const work = forecast.protectedRemainingMinutes;
  const time = forecast.compatibleCapacityMinutes;
  if (work === null || time === null) return "";
  const before = deadline
    ? ` before ${buffered ? "your submission buffer starts on " : ""}${formatDate(deadline, timezone, locale)}`
    : "";
  const sizes = `${formatMinutes(work)} of work against ${formatMinutes(time)} of time${before}`;
  return leadWithShortfall && work > time
    ? ` Short by ${formatMinutes(work - time)}: ${sizes}.`
    : ` ${sizes.charAt(0).toUpperCase()}${sizes.slice(1)}.`;
}

/** The smallest fix the forecast found, in a short phrase; the forecast's own wording carries raw dates. */
function leverFor(forecast: ProjectForecast, external: boolean, timezone: string | undefined, locale?: string): string {
  const lever = forecast.interventions?.[0];
  if (!lever) return "";
  const date = lever.proposedDeadlineAt ? ` to ${formatDate(lever.proposedDeadlineAt, timezone, locale)}` : "";
  switch (lever.kind) {
    case "clarify_estimate":
      return " Narrowing the estimate would settle it.";
    case "split_work":
      return lever.shape === "minimum_session"
        ? " Shortening the minimum session would let it fit."
        : " Allowing the work to be split would let it fit.";
    case "add_time":
      return ` Adding ${formatMinutes(lever.minutes)} or pausing other work would fit it.`;
    case "request_extension":
    case "move_deadline":
      return date
        ? ` ${external ? "Ask for an extension" : "Moving the date"}${date} would fit it.`
        : ` Nothing fits inside the forecast horizon; ${external ? "ask for an extension" : "move the date"} or reduce the scope.`;
  }
}

function urgency(args: ScoreActionInput): number {
  const deadline = effectiveDeadline(args);
  const proximity = deadline
    ? clamp(1 - Math.log1p(daysUntil(deadline, args.now)) / Math.log1p(PROXIMITY_HORIZON_DAYS))
    : 0;
  const forecast = args.forecast;
  // An incomplete forecast must never out-pressure a project the engine actually understands.
  if (!forecast || forecast.marginRatio === null) return Math.min(0.5, proximity);
  const slackPressure = clamp(1 - forecast.marginRatio);
  const latestSafeStart = resolvedLatestSafeStart(forecast, args.action.forecastUnitId ?? args.action.id, args.now);
  const startPressure = latestSafeStart
    ? clamp(1 - Math.max(0, latestSafeStart.getTime() - args.now.getTime()) / (START_PRESSURE_HOURS * HOUR_MS))
    : 0;
  return clamp(0.5 * slackPressure + 0.3 * startPressure + 0.2 * proximity);
}

/**
 * A cadence presses by how overdue it is and how much it matters: nothing the day after it was
 * done, half its weight on the due day, all of it one interval late. Importance is the action's own
 * rating — the one knob that says daily maths outranks a run when both are due. Zero for every
 * other scheduling mode, so the term is invisible where it does not apply.
 */
function cadenceDue(action: Action, now: Date): number {
  if (!action.cadence) return 0;
  const pressure = action.cadence.period
    ? cadencePeriodPressure(action.cadence, now)
    : cadencePressure(cadenceDueRatio(action.cadence, now));
  return pressure * (Math.min(5, Math.max(1, action.importance)) / 5);
}

/** Neglect measures a stalled commitment, so a newly captured action starts at zero. */
function neglect(action: Action, project: Project | undefined, now: Date): number {
  const since = project?.lastWorkedAt ?? action.lastWorkedAt ?? project?.createdAt ?? action.createdAt;
  if (!since) return 0;
  return clamp((now.getTime() - since.getTime()) / (NEGLECT_THRESHOLD_DAYS * DAY_MS));
}

function momentum(args: ScoreActionInput): number {
  if (args.action.id === args.activeActionId) return scoreWeights.momentum;
  const advanced = args.project?.lastWorkedAt ?? args.action.lastWorkedAt;
  return advanced && now(args) - advanced.getTime() < DAY_MS ? Math.round(scoreWeights.momentum * 0.6) : 0;
}

/** Reads the previous action's own project rather than guessing it from the allocation ledger. */
function switchingCost(action: Action, lastAction: Action | undefined, activeActionId: string | undefined): number {
  if (!lastAction || lastAction.id === action.id || activeActionId === action.id) return 0;
  return lastAction.projectId === action.projectId ? 5 : scoreWeights.switchingCost;
}

/**
 * Whether the date `effectiveDeadline` selects stands for an external commitment, the one derivation
 * every branch of `assessCritical` and the Now headline share. It is the pure owner of the deadline
 * being measured, with no proximity rule: a unit's own date is external only when it is its external
 * date (a unit with no internal date carries the external one as its deadline), and a project's date
 * is external when it has no explicit internal date before its external one (the derived target before
 * the external date, or an internal date capped at it, still serves it). A near external date does not
 * make a measurement against an earlier self-set target external; only the due-this-week branch of
 * `assessCritical` also treats an external date inside its window as committed.
 */
export function deadlineIsExternal(args: Pick<ScoreActionInput, "action" | "project">): boolean {
  return ownerIsExternal(args.action, args.project);
}

/** The same derivation for the project's own deadline, which is what its forecast health measures. */
export function projectDeadlineIsExternal(project: Project | undefined): boolean {
  return ownerIsExternal({}, project);
}

function ownerIsExternal(
  own: Pick<Action, "deadlineAt" | "externalDeadlineAt">,
  project: Project | undefined
): boolean {
  if (own.deadlineAt)
    return [project?.externalDeadlineAt, own.externalDeadlineAt].some(
      (date) => date?.getTime() === own.deadlineAt?.getTime()
    );
  const external = project?.externalDeadlineAt;
  if (!external) return false;
  return !project?.internalDeadlineAt || project.internalDeadlineAt.getTime() >= external.getTime();
}

export function effectiveDeadline(args: Pick<ScoreActionInput, "action" | "project" | "forecast">): Date | undefined {
  return (
    args.action.deadlineAt ??
    args.forecast?.internalDeadlineAt ??
    args.project?.internalDeadlineAt ??
    args.project?.externalDeadlineAt
  );
}

function now(args: ScoreActionInput) {
  return args.now.getTime();
}
function capitalise(value: string) {
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}
function daysUntil(date: Date, from: Date) {
  return Math.max(0, (date.getTime() - from.getTime()) / DAY_MS);
}
function normalizeFive(value: number) {
  return (Math.min(5, Math.max(1, value)) - 1) / 4;
}
function clamp(value: number) {
  return Math.min(1, Math.max(0, value));
}
