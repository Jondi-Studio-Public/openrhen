import { analyzeDependencies } from "../scheduling/dependencies.js";
import { calculateActionEffort } from "../scheduling/effort.js";
import { planSchedule } from "../scheduling/schedule.js";
import {
  CRITICAL_TIER_LABELS,
  CRITICAL_START_LOOKAHEAD_MS,
  ORDINARY_RANK,
  effectiveConsequence,
  effectiveDeadline,
  deadlineIsExternal,
  projectDeadlineIsExternal,
  scoreAction,
  type ScoreActionInput
} from "./score.js";
import { formatDate, formatTime } from "./format.js";
import { deriveEnergyCost } from "./energy-cost.js";
import { deriveStretchOffer, type StretchContext } from "./stretch.js";
import { currentCompatibleWindow, slotFitsAction } from "../scheduling/slots.js";
import { zonedDateTime } from "@openrhen/contracts";
import { addLocalDays, localDate } from "../recurrence/recurrence.js";
import {
  DEFAULT_TIMEZONE,
  DEFAULT_LOCALE,
  currentSituationSchema,
  resolveSituation,
  type ConditionDefinition,
  type CurrentSituation,
  type EnergyType,
  type JourneyIndex,
  type ResolvedSituation
} from "@openrhen/contracts";
import {
  ARRIVAL_MARGIN_MINUTES,
  commitmentProtection,
  defaultPlanningConfig,
  effectiveCommitmentEnd
} from "../model/types.js";
import { commitmentTimeline } from "../model/commitment-timeline.js";
import {
  TRIP_BUNDLE_LIMIT,
  avoidableMinutes,
  nextAnchorAfter,
  travelCostOf,
  type TravelPolicy,
  type TripContext
} from "./travel.js";
import { earliestRoutineWindowStart, routineStepMootness } from "./routine-step-mootness.js";
import { beforeStepsComplete, hasArrivedAtCommitment, isRunningLate } from "../model/types.js";
import type {
  Action,
  CapacityWindow,
  Counterfactual,
  DecidingFactor,
  EarlyStepCandidate,
  FixedCommitment,
  NextFit,
  NoFit,
  PlanningConfig,
  PlanningResult,
  PlanningSlot,
  Project,
  ProjectForecast,
  ProtectedCommitment,
  Recommendation,
  RecommendationCandidate,
  RecommendationChoice,
  RecommendationWhy,
  RoutineStepStatus
} from "../model/types.js";

const MINUTE_MS = 60_000;
/** One planning slot: how much longer the "longer session" counterfactual lets the day run. */
const SLOT_MS = 15 * MINUTE_MS;
/** How many window-bound candidates the next-fit search tries per slot before moving on. */
const NEXT_FIT_CANDIDATES = 5;

export interface RecommendArguments {
  now: Date;
  horizonEnd: Date;
  actions: Action[];
  projects: Project[];
  forecasts?: ProjectForecast[];
  planning?: PlanningResult;
  capacityWindows: CapacityWindow[];
  commitments: FixedCommitment[];
  protectedCommitments?: FixedCommitment[];
  /**
   * The `anchor` commitment that is happening right now with nothing recorded as engaging in it, so
   * its own window is open for other work at this instant.
   *
   * Set by the live call only, and only after the caller has handed the same window back in
   * `planning.slots` — the two go together, since ranking against slots that still call the hour
   * fixed would offer nothing. Every forward replay leaves it unset, which is what keeps an anchor
   * exactly as blocking as a `blocking` commitment in capacity, the day plan and the projected day:
   * a plan cannot know in advance which obligations will leave gaps, and a plan that assumed they
   * would is a plan that books work into a swimming carnival.
   */
  freeAnchorIds?: string[];
  /**
   * The before/after routine steps behind every commitment, so `resolveProtectedCommitment` can tell
   * a commitment whose clock says "active" is actually still getting ready. Defaults to none, which
   * means every commitment's before-phase is vacuously complete and lateness never triggers —
   * exactly the old behaviour for every caller that has not been taught about routine steps yet.
   */
  routineSteps?: RoutineStepStatus[];
  /**
   * Placed, pending, flexible commitment before-steps a run's placement produced — the candidates
   * `recommend()` may offer early (the routine step timing design note, "Flexible steps offered
   * early"). Defaults to none, which means no step is ever offered early — the old behaviour for
   * every caller that has not been taught about placement yet. Static placement data: the day plan
   * re-supplies the same list, unchanged, to every replay step, since only which of these are
   * currently eligible moves, never the placement itself.
   */
  offerableSteps?: EarlyStepCandidate[];
  currentSituation?: CurrentSituation;
  conditionDefinitions?: ConditionDefinition[];
  currentEnergy?: EnergyType;
  /**
   * Actions the person has accepted a stretch for: the declared-energy check is waived for these
   * alone (see `ScoreActionInput`). The day-plan replay receives it through the same arguments, so
   * the plan agrees with Now. Absent means none, the old behaviour.
   */
  energyWaivedActionIds?: readonly string[];
  /**
   * When each waiver above ends. The day-plan replay waives an id only at instants before its end;
   * an id with no entry is waived throughout. Absent means every waiver is open-ended.
   */
  energyWaivedUntil?: Record<string, Date>;
  /**
   * What earlier answers to stretch offers say (declined actions, "no stretches tonight", next
   * wake). Absent means nothing declined and no sleep-first check. See `deriveStretchOffer`.
   */
  stretch?: StretchContext;
  timezone?: string;
  locale?: string;
  /** The one journey lookup's per-request index, for the matcher's own `travelTo` resolution. */
  journeys?: JourneyIndex;
  homeLocationId?: string;
  activeActionId?: string;
  lastActionId?: string;
  dailyHorizonEnd?: Date;
  config?: PlanningConfig;
  /** Minutes to be at a place before a commitment starts, on top of travel time. Defaults to
   * `ARRIVAL_MARGIN_MINUTES` when absent — production always supplies `state.settings.arrivalMarginMinutes`. */
  arrivalMarginMinutes?: number;
  /**
   * Minutes owed after an action or deliverable ends a session that reached at least its own
   * maximum session length, before it is eligible again. Defaults to `SESSION_BREAK_MINUTES` when
   * absent — production always supplies `state.settings.sessionBreakMinutes`.
   */
  sessionBreakMinutes?: number;
  /**
   * The latest *ended* session per target (an action id, or a deliverable id), for the maximum-
   * session break. Defaults to none, which is exactly how every snapshot from before this field
   * existed replays: no live break.
   */
  lastEndedSessions?: { targetId: string; endedAt: Date; focusedMinutes: number }[];
  /**
   * What the projected day knows about places: how long each journey takes, and where you will be
   * later. Without it no trip is ever directed — which is exactly what an unknown location should
   * mean.
   */
  travel?: TravelPolicy;
  /**
   * Whether to compute the contrastive explanation and the "what would lead if" answers, each of
   * which re-runs this function under a counterfactual. Off inside those re-runs so they stay cheap
   * and finite.
   */
  explain?: boolean;
}

export function recommend(args: RecommendArguments): Recommendation {
  const arrivalMarginMinutes = args.arrivalMarginMinutes ?? ARRIVAL_MARGIN_MINUTES;
  const planning = args.planning ?? planSchedule(args);
  const forecasts = args.forecasts ?? planning.forecasts;
  const explain = args.explain ?? true;
  const projectById = new Map(args.projects.map((project) => [project.id, project]));
  const forecastById = new Map(forecasts.map((forecast) => [forecast.projectId, forecast]));
  const dependencyAnalysis = analyzeDependencies(args.actions);
  const lastAction = args.actions.find((action) => action.id === (args.lastActionId ?? args.activeActionId));
  const situation = args.currentSituation ?? currentSituationSchema.parse({});
  const definitions = args.conditionDefinitions ?? [];
  // `protectedCommitments` when supplied is the same real-commitment set `resolveProtectedCommitment`
  // reads below (synthetic routine/sleep entries filtered out); either way it is the full commitment
  // list a `commitment` context needs to tell "is a live occurrence of this rule happening now".
  const resolved = resolveSituation({
    situation,
    definitions,
    now: args.now,
    commitments: args.protectedCommitments ?? args.commitments,
    ...(args.journeys ? { journeys: args.journeys } : {}),
    ...(args.timezone ? { timeZone: args.timezone } : {}),
    ...(args.homeLocationId ? { homeLocationId: args.homeLocationId } : {})
  });
  // Arrival, for lateness purposes, is the asserted/confirmed location alone — the same resolution
  // used everywhere else a "where are you" answer is needed, never a projected one.
  const protectedCommitment = resolveProtectedCommitment(
    args.now,
    args.protectedCommitments ?? args.commitments,
    arrivalMarginMinutes,
    args.routineSteps ?? [],
    resolved.locationId
  );

  // The travel policy resolved for this instant: the same journeys, plus the anchor that bounds a trip
  // from here. Re-derived per call because `now` moves — the day plan replays this function forward.
  const trip: TripContext | undefined = args.travel
    ? { ...args.travel, nextAnchor: nextAnchorAfter(args.now, args.travel.anchors, arrivalMarginMinutes) }
    : undefined;
  const scoreOne = (action: Action, extra: Partial<ScoreActionInput> = {}) =>
    scoreAction({
      ...args,
      resolved,
      action,
      project: projectById.get(action.projectId),
      forecast: forecastById.get(action.projectId),
      planning,
      lastAction,
      dependencyAnalysis,
      ...(trip ? { trip } : {}),
      ...extra
    });
  const candidates = bundleTrips(
    args.actions
      .map((action) => scoreOne(action))
      .sort((a, b) => candidateSort(a, b, projectById, forecastById, args.now))
  ).sort((a, b) => candidateSort(a, b, projectById, forecastById, args.now));

  // A protected commitment normally answers the question by itself: nothing is offered against it.
  // The exception is the anchor the caller has declared open — you are there, and nothing says the
  // hour is taken up — where the ordinary ranking runs and the commitment rides along on the result
  // under `openAnchor`. It is deliberately *not* reported as `protectedCommitment`: everything
  // downstream reads that field as "the clock is held", and an open anchor is the one case where it
  // is not.
  if (protectedCommitment) {
    const freeIds = new Set(args.freeAnchorIds ?? []);
    // An open anchor never hides a commitment that really does hold the clock: with the open anchors
    // set aside, whatever is left over (an appointment inside the class, in any phase) is what to name.
    const blocker = freeIds.has(protectedCommitment.id)
      ? resolveProtectedCommitment(
          args.now,
          (args.protectedCommitments ?? args.commitments).filter((item) => !freeIds.has(item.id)),
          arrivalMarginMinutes,
          args.routineSteps ?? [],
          resolved.locationId
        )
      : protectedCommitment;
    if (blocker) {
      return commitmentRecommendation(blocker, candidates, args.timezone, args.locale);
    }
  }
  // Reached only once a protected commitment is ruled out (the branch above), so this is exactly
  // "nothing while a protected commitment is in force" — an open anchor's own ordinary ranking is the
  // one case a protected commitment does not gate work, and it does not gate this either.
  const earlyStep = selectEarlyStep({
    args,
    resolved,
    planning,
    lastAction,
    dependencyAnalysis
  });
  // Derived after ranking and never feeding back into it: the offer reads eligibility, tiers and a
  // rescore with one action's energy check waived, and changes none of them.
  const stretchOffer = deriveStretchOffer({
    now: args.now,
    currentEnergy: args.currentEnergy,
    candidates,
    projectOf: (action) => projectById.get(action.projectId),
    forecastOf: (action) => forecastById.get(action.projectId),
    rescoreWaived: (action) => scoreOne(action, { energyWaivedActionIds: [action.id] }),
    ...(args.stretch ? { context: args.stretch } : {})
  });
  // Same rule: a description of what the energy cut holds back, derived after ranking, changing nothing.
  const energyCost = deriveEnergyCost({
    now: args.now,
    currentEnergy: args.currentEnergy,
    candidates,
    projectOf: (action) => projectById.get(action.projectId),
    rescoreWaived: (action) => scoreOne(action, { energyWaivedActionIds: [action.id] })
  });
  const alongside: Pick<Recommendation, "openAnchor" | "earlyStep" | "stretchOffer" | "energyCost"> = {
    ...(protectedCommitment ? { openAnchor: protectedCommitment } : {}),
    ...(earlyStep ? { earlyStep } : {}),
    ...(stretchOffer ? { stretchOffer } : {}),
    ...(energyCost ? { energyCost } : {})
  };

  // Several execution options of one deliverable are several ways to spend the same time, not several
  // things to do. Ranking already ordered them, so the first survivor is the suggested next work and
  // the rest would only repeat the deliverable's name down the list.
  const eligible = bestPerDeliverable(candidates.filter((candidate) => candidate.eligible));
  const primary = eligible[0] ?? null;
  const alternatives = eligible.slice(1, 4);
  // scoreAction contributes at most one exclusion reason for context, so a single reason alongside an
  // unsatisfied match means context is the only thing in the way. Reading status beats matching the
  // reason text, which is what coupled these two files together before.
  const conditionOnly = (candidate: RecommendationCandidate) =>
    candidate.exclusionReasons.length === 1 && candidate.conditionMatch.status !== "yes";
  const needsAnswer = candidates.filter(
    (candidate) => conditionOnly(candidate) && candidate.conditionMatch.status === "unknown"
  );
  // Blocked only by being elsewhere. A candidate carrying a `tripReason` is here for the same reason
  // and says which way the journey failed — no way to travel, or nothing that fits once you arrive.
  const reachable = candidates.filter(
    (candidate) =>
      conditionOnly(candidate) &&
      (candidate.conditionMatch.reachableVia !== undefined || candidate.tripReason !== undefined)
  );
  const rerun = (overrides: Partial<RecommendArguments>) =>
    recommend({ ...args, planning, forecasts, explain: false, ...overrides });
  const wouldChangeIf = explain
    ? counterfactuals({ args, situation, definitions, candidates, primary, planning, rerun })
    : [];

  if (!primary) {
    const noFit = resolveNoFit({ args, candidates, needsAnswer, situation, definitions, planning, explain, rerun });
    const why: RecommendationWhy = { because: null, whyNot: null, wouldChangeIf };
    const conditionBlocked = candidates.find(conditionOnly);
    if (conditionBlocked) {
      const match = conditionBlocked.conditionMatch;
      const asking = match.status === "unknown";
      const blockers = asking ? match.unknowns : match.missing;
      const contexts = formatList(
        blockers.map((id) => conditionName(definitions, id)),
        args.locale
      );
      const one = blockers.length === 1;
      // What the action needs, said as the person would: places are somewhere to be, anything else is named.
      const isPlace = (id: string) => definitions.find((item) => item.id === id)?.kind === "location";
      const places = blockers.filter(isPlace).map((id) => conditionName(definitions, id));
      const others = blockers.filter((id) => !isPlace(id)).map((id) => conditionName(definitions, id));
      const needs = [
        ...(places.length ? [`you at ${formatList(places, args.locale)}`] : []),
        ...(others.length ? [formatList(others, args.locale)] : [])
      ].join(", plus ");
      // Only said when the re-run at that place actually leads with something; being there is useless if
      // the work still would not fit (a session minimum longer than the gap, say).
      const atPlace =
        places.length && !others.length ? wouldChangeIf.find((item) => item.condition === "at_location") : undefined;
      const clears = atPlace?.thenPrimary
        ? `If you are at ${formatList(places, args.locale)}, ${atPlace.thenPrimary.title} would lead for ${atPlace.thenPrimary.recommendedMinutes} minutes: get there, or say you are there.`
        : places.length && !others.length
          ? `Being at ${formatList(places, args.locale)} would not change that before then, so there is nothing to do about it yet.`
          : "Once that is sorted, or you say it is, it can be recommended.";
      // Blocked by place while a boundary also leaves no room: the answer to "what do I do?" is that nothing
      // can be started until the first thing that fits, not the blocked action, so lead with that.
      const boundaryHeadline =
        !asking && noFit.kind === "boundary"
          ? noFit.nextFit && noFit.boundaryKind !== "daily_horizon"
            ? `Nothing to start until after ${
                noFit.boundaryTitle ?? (noFit.boundaryKind === "sleep" ? "sleep" : "the next commitment")
              }`
            : boundaryWording(noFit, args.now, args.timezone, args.locale).headline
          : null;
      const ifYes =
        noFit.kind === "answer" && noFit.candidate
          ? ` If yes, ${noFit.candidate.title} would lead for ${noFit.candidate.recommendedMinutes} minutes.`
          : "";
      return {
        primary: null,
        alternatives: [],
        candidates,
        needsAnswer,
        reachable,
        headline: asking
          ? `${conditionBlocked.action.title} needs an answer: ${blockers.map((id) => conditionQuestion(definitions, id)).join(" ")}`
          : (boundaryHeadline ?? `${conditionBlocked.action.title} needs ${needs}`),
        explanation: asking
          ? `${conditionBlocked.action.title} is the closest suitable action, but nothing has said whether ${contexts} ${one ? "is" : "are"} available. Answer that and it can be recommended.${ifYes}`
          : `${conditionBlocked.action.title} is the closest suitable action, but it needs ${needs}, so it is not suggested from here. ${clears}`,
        evidence: conditionBlocked.exclusionReasons,
        why,
        noFit,
        ...alongside
      };
    }
    const evidence = noCandidateEvidence(candidates);
    if (noFit.kind === "boundary") {
      const wording = boundaryWording(noFit, args.now, args.timezone, args.locale);
      return {
        primary: null,
        alternatives: [],
        candidates,
        needsAnswer,
        reachable,
        headline: wording.headline,
        explanation: wording.explanation,
        evidence,
        why,
        noFit,
        ...alongside
      };
    }
    return {
      primary: null,
      alternatives: [],
      candidates,
      needsAnswer,
      reachable,
      headline: "No suitable action fits right now",
      explanation: evidence[0] ?? "Capture or clarify the next useful action.",
      evidence,
      why,
      noFit,
      ...alongside
    };
  }

  const forecast = forecastById.get(primary.action.projectId);
  const project = projectById.get(primary.action.projectId)!;
  const boundary = primary.sessionBoundary;
  const strongest = strongestComponents(primary.scoreComponents);
  const deadline = effectiveDeadline({ action: primary.action, project, forecast });
  const effort = calculateActionEffort(primary.action, project, args.config);
  const nearerExcluded = candidates
    .filter(
      (candidate) =>
        !candidate.eligible &&
        deadlineFor(candidate, projectById, forecastById) < (deadline?.getTime() ?? Number.MAX_SAFE_INTEGER)
    )
    .sort((a, b) => deadlineFor(a, projectById, forecastById) - deadlineFor(b, projectById, forecastById))[0];
  const evidence = [
    forecast
      ? `${forecast.protectedRemainingMinutes ?? "Unknown"} protected minutes versus ${forecast.grossCompatibleCapacityMinutes ?? forecast.compatibleCapacityMinutes ?? "unknown"} gross compatible minutes; ${forecast.reservedByEarlierDeadlinesMinutes} minutes are reserved earlier.`
      : "Project forecast is incomplete.",
    `Session boundary is ${formatDate(boundary, args.timezone, args.locale)}.`,
    `${effort.mostLikelyMinutes} expected minutes become ${effort.riskAdjustedRemainingMinutes} protected minutes (${effort.method === "pert" ? "PERT uncertainty" : "project uncertainty"}${calibrationPhrase(project)}${primary.action.setupMinutes ? ` plus ${primary.action.setupMinutes} setup minutes` : ""}).`,
    ...(effort.remainingExceedsBaseline
      ? ["Remaining effort was re-estimated above the original baseline, so the revised figure is authoritative."]
      : []),
    ...(primary.criticalReason ? [`Deadline-critical: ${primary.criticalReason}`] : []),
    ...(nearerExcluded
      ? [`A nearer deadline was excluded: ${nearerExcluded.action.title} — ${nearerExcluded.exclusionReasons[0]}`]
      : []),
    ...strongest.map(([name, value]) => `${componentLabel(name)} contributed ${formatScore(value)} points.`)
  ];
  const status = (forecast?.health ?? "unknown").replace("_", " ");
  // The date that actually passed is the external one (the action's own, for a deliverable, or its
  // project's), never the effective deadline, which sits earlier than it by the submission buffer
  // or the owner's own target.
  const externalDates = [project?.externalDeadlineAt, primary.action.externalDeadlineAt].filter(
    (date): date is Date => date !== undefined && date !== null
  );
  const externalPassedAt = externalDates
    .filter((date) => date.getTime() < args.now.getTime())
    .sort((a, b) => a.getTime() - b.getTime())[0];
  const externalAheadAt = externalDates
    .filter((date) => date.getTime() >= args.now.getTime())
    .sort((a, b) => a.getTime() - b.getTime())[0];
  // Health tiers (behind, at risk by forecast health or margin) were measured against the project's own
  // forecast deadline, owned as `assessCritical` owns it (`projectDeadlineIsExternal`), never the minimum
  // with the selected deliverable's date, so those name the project's date. Every other case (a self-set
  // deadline this week, a latest safe start) was measured against the candidate's effective deadline, so it
  // names that: an action's own date first, then the project's. `forecast.internalDeadlineAt` is only the
  // forecast's end for a focused project with no stored date, which is not a deadline anyone set.
  const projectHasDate = Boolean(project?.internalDeadlineAt || project?.externalDeadlineAt);
  const healthMeasured =
    forecast?.health === "behind" ||
    forecast?.health === "at_risk" ||
    (typeof forecast?.marginRatio === "number" &&
      forecast.marginRatio < (args.config ?? defaultPlanningConfig).riskMarginRatio);
  const projectExternal = projectDeadlineIsExternal(project);
  const projectDate = projectExternal
    ? project?.externalDeadlineAt
    : projectHasDate
      ? (forecast?.internalDeadlineAt ?? project?.internalDeadlineAt)
      : undefined;
  const unitExternal = deadlineIsExternal({ action: primary.action, project });
  const unitDate = unitExternal
    ? (primary.action.deadlineAt ?? project?.externalDeadlineAt)
    : (primary.action.deadlineAt ?? (projectHasDate ? deadline : undefined));
  // `due_this_week_external` is decided by an external date inside the window, whichever self-set target
  // or project date came before it, so that tier names the earliest external date still ahead.
  const due =
    primary.criticalTier === "due_this_week_external" && externalAheadAt
      ? ` due externally ${formatDate(externalAheadAt, args.timezone, args.locale)}`
      : healthMeasured && projectDate
        ? ` due ${projectExternal ? "externally" : "internally"} ${formatDate(projectDate, args.timezone, args.locale)}`
        : unitDate
          ? ` due ${unitExternal ? "externally" : "internally"} ${formatDate(unitDate, args.timezone, args.locale)}`
          : projectDate
            ? ` due ${projectExternal ? "externally" : "internally"} ${formatDate(projectDate, args.timezone, args.locale)}`
            : "";
  // "Unknown" is a state of the forecast, not a description of the project: leading with
  // "Unknown project" read as if the engine did not know which project this was. An unmeasured
  // forecast is said as what it is, and a passed date is said to have passed rather than as
  // "due" on a date already gone.
  const measured = Boolean(forecast) && forecast!.health !== "unknown";
  const effortNote = measured ? "" : " and the remaining effort is not yet measured";
  // The own target the forecast reported missing is the one to name. The effective deadline prefers an
  // action's own later date, so it can sit in the future while the project's own target has passed.
  const ownMissedAt =
    forecast?.overdue && forecast.proposal?.deadlineOwner === "internal"
      ? forecast.proposal.missedDeadlineAt
      : undefined;
  const passedAt = ownMissedAt ?? (deadline && deadline.getTime() < args.now.getTime() ? deadline : undefined);
  const passedDate = (at: Date | undefined) => (at ? ` (${formatDate(at, args.timezone, args.locale)})` : "");
  const lead =
    primary.criticalTier === "overdue_external"
      ? `The external deadline${passedDate(externalPassedAt ?? passedAt ?? deadline)} has passed${effortNote};`
      : passedAt && externalAheadAt
        ? `Your own target${passedDate(passedAt)} has passed but the external deadline${passedDate(externalAheadAt)} is still ahead${effortNote};`
        : primary.criticalTier === "stale_date"
          ? `The self-set date${passedDate(passedAt ?? deadline)} has lapsed${effortNote};`
          : measured
            ? `${capitalise(status)} project${due};`
            : `Project${due}, remaining effort not yet measured;`;
  const runnerUp = alternatives[0] ?? null;
  const why: RecommendationWhy = {
    because: choice(primary, runnerUp),
    whyNot: runnerUp
      ? {
          ...choice(runnerUp, primary),
          decidingFactor: compareCandidates(primary, runnerUp, projectById, forecastById, args.now).factor
        }
      : null,
    wouldChangeIf
  };
  const closing = why.whyNot
    ? decidingSentence(primary, runnerUp!, why.whyNot.decidingFactor)
    : primary.criticalRank === ORDINARY_RANK
      ? `${componentLabel(strongest[0]?.[0] ?? "capacityPressure")} is the strongest ranking factor.`
      : "Nothing else is eligible right now.";
  const minutes =
    primary.recommendedWallClockMinutes !== null &&
    primary.recommendedWallClockMinutes > (primary.recommendedMinutes ?? 0)
      ? `${primary.recommendedMinutes} focused minutes (${primary.recommendedWallClockMinutes} by the clock) fit before the next protected boundary.`
      : `${primary.recommendedMinutes} minutes fit before the next protected boundary.`;
  return {
    primary,
    alternatives,
    candidates,
    needsAnswer,
    reachable,
    headline: primary.action.title,
    explanation: `${lead} ${minutes} ${closing}`,
    evidence,
    why,
    ...alongside
  };
}

/** `prepDue`'s weight. Not a config knob. */
const PREP_DUE_WEIGHT = 25;

/**
 * The best offerable flexible commitment before-step, scored beside ordinary work through the same
 * `scoreAction` every ordinary candidate uses, plus `prepDue` (the routine step timing design note,
 * "Flexible steps offered early"/"Early score"). Never enters a critical tier: the throwaway `Action`
 * carries no project and no deadline, so `assessCritical` always answers `ordinary`.
 */
function selectEarlyStep(input: {
  args: RecommendArguments;
  resolved: ResolvedSituation;
  planning: PlanningResult;
  lastAction: Action | undefined;
  dependencyAnalysis: ReturnType<typeof analyzeDependencies>;
}): { stepId: string; totalScore: number } | undefined {
  const { args, resolved, planning, lastAction, dependencyAnalysis } = input;
  const routineSteps = args.routineSteps ?? [];
  const commitments = args.protectedCommitments ?? args.commitments;
  const scored = (args.offerableSteps ?? []).flatMap((step) => {
    if (!isStepOfferableNow(step, args.now, routineSteps, resolved.locationId, commitments)) return [];
    const candidate = scoreAction({
      now: args.now,
      horizonEnd: args.horizonEnd,
      action: earlyStepAction(step),
      project: undefined,
      forecast: undefined,
      planning,
      resolved,
      dependencyAnalysis,
      ...(args.currentEnergy !== undefined ? { currentEnergy: args.currentEnergy } : {}),
      ...(args.activeActionId !== undefined ? { activeActionId: args.activeActionId } : {}),
      ...(lastAction !== undefined ? { lastAction } : {}),
      ...(args.dailyHorizonEnd !== undefined ? { dailyHorizonEnd: args.dailyHorizonEnd } : {}),
      ...(args.config !== undefined ? { config: args.config } : {})
    });
    return [{ stepId: step.stepId, totalScore: candidate.totalScore + prepDueBonus(step, args.now) }];
  });
  return scored.sort((a, b) => b.totalScore - a.totalScore || a.stepId.localeCompare(b.stepId))[0];
}

/**
 * The throwaway `Action` a flexible before-step is scored as: hands-on minutes, energy, contexts, no
 * project, no deadline.
 */
function earlyStepAction(step: EarlyStepCandidate): Action {
  return {
    id: `routine-step:${step.stepId}`,
    projectId: `routine-step:${step.commitmentId}`,
    title: step.title,
    status: "planned",
    expectedMinutes: step.durationMinutes,
    remainingMinutes: step.durationMinutes,
    pessimisticMinutes: step.durationMinutes,
    energy: step.energy,
    minimumSessionMinutes: step.durationMinutes,
    maximumSessionMinutes: step.durationMinutes,
    importance: 3,
    consequence: 3,
    contexts: step.contexts,
    dependenciesComplete: true,
    splittable: false
  };
}

/**
 * `prepDue`: 0 at `earliestAt`, ramping linearly to `PREP_DUE_WEIGHT` at `placedStartAt`
 * `placedStartAt <= earliestAt` never ramps —
 * such a step is never offerable in the first place (`isStepOfferableNow`'s own window check), so this
 * only guards the division.
 */
function prepDueBonus(step: EarlyStepCandidate, now: Date): number {
  const span = step.placedStartAt.getTime() - step.earliestAt.getTime();
  if (span <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, (now.getTime() - step.earliestAt.getTime()) / span));
  return ratio * PREP_DUE_WEIGHT;
}

/**
 * Whether a flexible commitment before-step is offerable right now: `now` is in
 * `[earliestAt, placedStartAt)`, every immediate prerequisite is done (completed or skipped) with its
 * own wait ended, and it is not moot on arrival — the same read-time rule `directive.ts`'s
 * `stepMootOnArrival` applies, shared here through `routineStepMootness`/`earliestRoutineWindowStart`
 * rather than duplicated.
 * Exported so `engine.ts` can filter the identical list for `canDoNow` without re-deriving the rule.
 */
export function isStepOfferableNow(
  step: EarlyStepCandidate,
  now: Date,
  routineSteps: readonly RoutineStepStatus[],
  arrivedLocationId: string | null,
  commitments: readonly FixedCommitment[]
): boolean {
  if (!(step.earliestAt.getTime() <= now.getTime() && now.getTime() < step.placedStartAt.getTime())) return false;
  const byId = new Map(routineSteps.flatMap((item) => (item.id !== undefined ? ([[item.id, item]] as const) : [])));
  // The candidate list is static placement data (see `EarlyStepCandidate`'s own comment); the step's
  // own current status is not, and must be re-read here on every call — otherwise a step the day plan
  // has already directed and completed keeps reading as offerable for the rest of its own window, and
  // gets directed a second time right behind itself.
  const self = byId.get(step.stepId);
  if (self && self.status !== "pending") return false;
  const prerequisitesDone = step.dependencyIds.every((id) => {
    const prerequisite = byId.get(id);
    return Boolean(prerequisite && (prerequisite.status === "completed" || prerequisite.status === "skipped"));
  });
  if (!prerequisitesDone) return false;
  const runningWait = step.dependencyIds.some((id) => {
    const prerequisite = byId.get(id);
    if (!prerequisite || prerequisite.status !== "completed" || !prerequisite.completedAt) return false;
    const waitMinutes = prerequisite.waitAfterMinutes ?? 0;
    if (waitMinutes <= 0) return false;
    return new Date(prerequisite.completedAt).getTime() + waitMinutes * MINUTE_MS > now.getTime();
  });
  if (runningWait) return false;
  const commitment = commitments.find((item) => item.id === step.commitmentId);
  if (!commitment) return true;
  const routineWindowStart = earliestRoutineWindowStart([...routineSteps], step.commitmentId);
  if (!routineWindowStart) return true;
  const moot = routineStepMootness({
    step: { phase: "before" },
    commitment: { locationId: commitment.locationId ?? null, endsAt: effectiveCommitmentEnd(commitment) },
    routineWindowStart,
    currentLocation: arrivedLocationId ? { locationId: arrivedLocationId, locationSetAt: now } : null,
    now,
    staleAfterMinutes: Number.POSITIVE_INFINITY
  });
  return !moot.moot;
}

/**
 * Which commitment is protecting this instant, and which of its phases it is in.
 *
 * The phases run in clock order — setup, travel, arrival margin, the commitment, transition, the
 * journey on — and travel is additive rather than folded into the buffers: getting ready to leave and
 * the leaving itself are different minutes, and both are protected (§9 hard precedence). A commitment
 * with no journey has no travel or arrival phase and no arrival margin, so nothing about a place-less
 * commitment changes.
 *
 * The clock alone decides `active` only once the commitment is actually ready to be in progress: a
 * commitment `isRunningLate` — its before-phase steps unfinished, or (for a located one) arrival
 * unasserted — is reported back in whichever phase reflects what is actually still outstanding
 * (`setup` while steps are pending, `travel` once they are done but the journey has not landed) with
 * `late: true` set, rather than `active`. This is what stops an anchor's window opening for ordinary
 * work (`openAnchorsNow`, engine.ts) and what keeps the live directive naming the overdue prerequisite
 * instead of falling through to unrelated work (`selectCurrentDirective`, directive.ts) — a class 56 minutes in with three untouched getting-ready steps still read as
 * plain "active" and freed itself for a deliverable to be recommended in its place.
 *
 * The same unfinished-steps check applies before the commitment even starts, across all three
 * pre-start phases (setup, travel, arrival): a before-phase step still pending and the person not yet
 * arrived reports `setup`/`late` in place of whichever pre-start phase the clock alone would have
 * picked, so the live directive still names the overdue step instead of `plannedLeg` (directive.ts)
 * routing straight to the travel leg. `isRunningLate` itself only judges the commitment's own active
 * window, so this pre-start case is checked directly here rather than through it — a step scheduled to finish before `travelStartsAt` was still pending at that time
 * and the directive read "Drive to Work" instead of naming it.
 */
export function resolveProtectedCommitment(
  now: Date,
  commitments: FixedCommitment[],
  arrivalMarginMinutes: number,
  routineSteps: RoutineStepStatus[] = [],
  arrivedLocationId: string | null = null
): ProtectedCommitment | null {
  const matches = commitments.flatMap((commitment): ProtectedCommitment[] => {
    const timeline = commitmentTimeline(commitment, arrivalMarginMinutes);
    const protectedStartAt = timeline.setupStartsAt;
    const protectedEndAt = timeline.protectedUntil;
    // Setup, then travel (with a journey), then the arrival margin, then the commitment runs to its
    // effective end — tracked overtime included — then transition, then the journey on. Matches
    // `resolveProtectedCommitment`'s own phase ordering before this timeline existed exactly, except
    // that every "after" edge now reads `effectiveEndsAt`/`freeAt` instead of the bare `endsAt`, so a
    // shift running over reads as still active, not as the transition (see the plan's Risks).
    const travelStartsAt = timeline.leaveBy ?? timeline.arriveBy;
    const arrivalStartsAt = timeline.arriveBy;
    const activeEndsAt = timeline.effectiveEndsAt;
    const returnStartsAt = timeline.freeAt;
    const base = {
      ...commitment,
      title: commitment.title ?? "Current commitment",
      protectedStartAt,
      protectedEndAt,
      timeline
    };
    if (commitment.startsAt <= now && activeEndsAt > now) {
      if (isRunningLate({ commitment, now, routineSteps, arrivedLocationId })) {
        // Steps still pending: still getting ready, whatever the clock says. Steps done but not
        // arrived: on the way, provided a journey actually exists — a located commitment with no
        // measured journey has nothing to be "travelling" through, so it is reported as active same
        // as ever rather than inventing a travel phase with nothing behind it.
        if (!beforeStepsComplete(commitment.id, routineSteps))
          return [{ ...base, phase: "setup", late: true, phaseStartsAt: protectedStartAt, phaseEndsAt: activeEndsAt }];
        if (timeline.leaveBy !== undefined)
          return [{ ...base, phase: "travel", late: true, phaseStartsAt: travelStartsAt, phaseEndsAt: activeEndsAt }];
      }
      return [{ ...base, phase: "active", phaseStartsAt: commitment.startsAt, phaseEndsAt: activeEndsAt }];
    }
    if (
      protectedStartAt <= now &&
      commitment.startsAt > now &&
      !hasArrivedAtCommitment(commitment, arrivedLocationId) &&
      !beforeStepsComplete(commitment.id, routineSteps)
    ) {
      // Pending before-phase step, not yet arrived, somewhere in the setup/travel/arrival run-up:
      // report it the same way the post-start branch above does, so `plannedLeg` (directive.ts)
      // does not route straight to the travel leg while the step is still outstanding.
      return [{ ...base, phase: "setup", late: true, phaseStartsAt: protectedStartAt, phaseEndsAt: activeEndsAt }];
    }
    if (arrivalStartsAt <= now && commitment.startsAt > now)
      return [{ ...base, phase: "arrival", phaseStartsAt: arrivalStartsAt, phaseEndsAt: commitment.startsAt }];
    if (travelStartsAt <= now && arrivalStartsAt > now)
      return [{ ...base, phase: "travel", phaseStartsAt: travelStartsAt, phaseEndsAt: arrivalStartsAt }];
    if (protectedStartAt <= now && travelStartsAt > now)
      return [{ ...base, phase: "setup", phaseStartsAt: protectedStartAt, phaseEndsAt: travelStartsAt }];
    if (activeEndsAt <= now && returnStartsAt > now)
      return [{ ...base, phase: "transition", phaseStartsAt: activeEndsAt, phaseEndsAt: returnStartsAt }];
    if (returnStartsAt <= now && protectedEndAt > now)
      return [{ ...base, phase: "return", phaseStartsAt: returnStartsAt, phaseEndsAt: protectedEndAt }];
    return [];
  });
  const phaseRank = { active: 0, arrival: 1, setup: 2, travel: 3, transition: 4, return: 5 } as const;
  const after = new Set<ProtectedCommitment["phase"]>(["transition", "return"]);
  return (
    matches.sort((a, b) => {
      const phaseDifference = phaseRank[a.phase] - phaseRank[b.phase];
      if (phaseDifference) return phaseDifference;
      const timeDifference =
        a.phase === "active"
          ? b.startsAt.getTime() - a.startsAt.getTime()
          : after.has(a.phase)
            ? b.endsAt.getTime() - a.endsAt.getTime()
            : a.startsAt.getTime() - b.startsAt.getTime();
      return timeDifference || a.id.localeCompare(b.id);
    })[0] ?? null
  );
}

function commitmentRecommendation(
  commitment: ProtectedCommitment,
  candidates: RecommendationCandidate[],
  timezone = DEFAULT_TIMEZONE,
  locale?: string
): Recommendation {
  const eventTime = formatTime(commitment.startsAt, timezone, locale);
  const until = formatTime(commitment.protectedEndAt, timezone, locale);
  const wording: Record<ProtectedCommitment["phase"], { headline: string; explanation: string }> = {
    setup: {
      headline: `Preparing for ${commitment.title}`,
      explanation: `${commitment.title} starts at ${eventTime}. Its setup buffer is protected until the commitment begins.`
    },
    travel: {
      headline: `Travelling to ${commitment.title}`,
      explanation: `${commitment.title} starts at ${eventTime}, and the journey there is kept clear${
        commitment.timeline.travelUnknown ? " (travel time is a guess)" : ""
      }.`
    },
    arrival: {
      headline: `Arriving for ${commitment.title}`,
      explanation: `${commitment.title} starts at ${eventTime}; the last few minutes before it are protected.`
    },
    active: {
      headline: `${commitment.title} is in progress`,
      // Name the same end the "Protected until" card shows: with a transition buffer that is after the event.
      explanation:
        commitment.protectedEndAt.getTime() > commitment.endsAt.getTime()
          ? `Runs until ${formatTime(commitment.endsAt, timezone, locale)}, then the transition after it keeps the time protected until ${until}.`
          : `Protected until ${until} while this commitment is in progress.`
    },
    transition: {
      headline: `Transitioning back after ${commitment.title}`,
      explanation: `The commitment has ended; transition time remains protected until ${until}.`
    },
    return: {
      headline: `Travelling on from ${commitment.title}`,
      explanation: `The commitment has ended; the journey back is protected until ${until}.`
    }
  };
  const { headline, explanation } = wording[commitment.phase];
  // `late` only ever changes the headline — the explanation still says what phase the person is
  // effectively in, so it's a fixed setup buffer or fixed journey narrated as running behind.
  const lateHeadline = commitment.late ? `Running late for ${commitment.title}` : headline;
  return {
    primary: null,
    alternatives: [],
    candidates,
    // A protected commitment overrides the ranking entirely, so offering things to ask about or
    // travel to would be inviting the person out of something they chose to protect.
    needsAnswer: [],
    reachable: [],
    headline: lateHeadline,
    explanation,
    evidence: [
      `Commitment ${commitment.id} is in its ${commitment.phase} phase.`,
      `Protected interval: ${formatDate(commitment.protectedStartAt, timezone, locale)} to ${formatDate(commitment.protectedEndAt, timezone, locale)}.`
    ],
    protectedCommitment: commitment,
    why: { because: null, whyNot: null, wouldChangeIf: [] }
  };
}

function sessionHorizon(args: { horizonEnd: Date; dailyHorizonEnd?: Date }) {
  return args.dailyHorizonEnd && args.dailyHorizonEnd < args.horizonEnd ? args.dailyHorizonEnd : args.horizonEnd;
}

/**
 * Why nothing fits, as the thing that would resolve it. A question comes first: one answer can make
 * work available now, whereas a boundary means waiting. Both are read from structure the candidates
 * already carry — `conditionMatch.status` and `windowBound` — never from exclusion text.
 */
function resolveNoFit(input: {
  args: RecommendArguments;
  candidates: RecommendationCandidate[];
  needsAnswer: RecommendationCandidate[];
  situation: CurrentSituation;
  definitions: ConditionDefinition[];
  planning: PlanningResult;
  explain: boolean;
  rerun: (overrides: Partial<RecommendArguments>) => Recommendation;
}): NoFit {
  const { args, candidates, needsAnswer, definitions, planning } = input;
  const asked = needsAnswer[0];
  if (asked) {
    const contextIds = [...asked.conditionMatch.unknowns];
    const answered = input.explain
      ? input.rerun({ currentSituation: answeredSituation(input.situation, contextIds, definitions, args.now) })
      : null;
    const lead = answered?.primary ?? null;
    return {
      kind: "answer",
      question: contextIds.map((id) => conditionQuestion(definitions, id)).join(" "),
      contextIds,
      candidate: lead
        ? {
            targetId: targetIdOf(lead),
            title: lead.action.title,
            recommendedMinutes: lead.recommendedMinutes ?? 0,
            ...(lead.action.deliverableId ? { deliverableId: lead.action.deliverableId } : {})
          }
        : null
    };
  }
  const windowBound = candidates.filter((candidate) => candidate.windowBound);
  const first = windowBound[0];
  if (!first) return { kind: "none" };
  const horizon = sessionHorizon(args);
  const boundary = describeBoundary({
    args,
    first,
    candidates: windowBound.slice(0, NEXT_FIT_CANDIDATES),
    horizon,
    planning
  });
  if (!boundary) return { kind: "none" };
  // The daily horizon closes the whole day, not just the next slot: capacity between the horizon and
  // bedtime is real but not plannable, so the search resumes at the next local day.
  const searchFrom =
    boundary.boundaryKind === "daily_horizon"
      ? zonedDateTime(
          addLocalDays(localDate(boundary.boundaryAt, args.timezone ?? DEFAULT_TIMEZONE), 1),
          "00:00",
          args.timezone ?? DEFAULT_TIMEZONE
        )
      : boundary.boundaryAt;
  return {
    kind: "boundary",
    ...boundary,
    nextFit: nextFitAfter(searchFrom, windowBound.slice(0, NEXT_FIT_CANDIDATES), args, planning)
  };
}

function describeBoundary(input: {
  args: RecommendArguments;
  first: RecommendationCandidate;
  /** The candidates `nextFitAfter` searches, so the boundary ends where its search could begin. */
  candidates: RecommendationCandidate[];
  horizon: Date;
  planning: PlanningResult;
}): {
  boundaryAt: Date;
  boundaryKind: "daily_horizon" | "commitment" | "sleep" | "capacity";
  boundaryTitle?: string;
  boundaryEdge?: "start" | "end";
} | null {
  const { args, first, candidates, horizon, planning } = input;
  // A horizon already behind us is the whole story: work is not planned past it today.
  if (horizon <= args.now) return { boundaryAt: horizon, boundaryKind: "daily_horizon" };
  const window = currentCompatibleWindow({
    now: args.now,
    horizonEnd: horizon,
    action: first.action,
    slots: planning.slots
  });
  const inWindow = planning.slots.some(
    (slot) => slot.startsAt <= args.now && slot.endsAt > args.now && slotFitsAction(slot, first.action)
  );
  if (inWindow) {
    if (window.boundary.getTime() === horizon.getTime()) return { boundaryAt: horizon, boundaryKind: "daily_horizon" };
    const named = commitmentAtEdge(
      args.commitments,
      window.boundary,
      "start",
      args.arrivalMarginMinutes ?? ARRIVAL_MARGIN_MINUTES
    );
    return named
      ? { boundaryAt: window.boundary, ...named, boundaryEdge: "start" }
      : { boundaryAt: window.boundary, boundaryKind: "capacity" };
  }
  // Nothing compatible is open right now; the boundary is when something opens. If nothing opens, or
  // the first opening is at or after the daily horizon, the horizon ends planning for the day.
  // An opening shorter than every candidate's minimum session is a gap between two protected windows
  // (the few minutes between one class's tail ending and the next one's starting), not somewhere work
  // fits, so it is not where the boundary ends. Any candidate `nextFitAfter` could offer counts, so
  // a lower-ranked action with a shorter minimum still ends the boundary at its earlier gap.
  const opens = planning.slots.find((slot) =>
    candidates.some((candidate) => fitAtSlot(slot, candidate, args, planning) !== null)
  );

  if (!opens || opens.startsAt >= horizon) return { boundaryAt: horizon, boundaryKind: "daily_horizon" };
  const named = commitmentAtEdge(
    args.commitments,
    opens.startsAt,
    "end",
    args.arrivalMarginMinutes ?? ARRIVAL_MARGIN_MINUTES
  );
  return named
    ? { boundaryAt: opens.startsAt, ...named, boundaryEdge: "end" }
    : { boundaryAt: opens.startsAt, boundaryKind: "capacity" };
}

function commitmentAtEdge(
  commitments: FixedCommitment[],
  at: Date,
  edge: "start" | "end",
  arrivalMarginMinutes: number
): { boundaryKind: "commitment" | "sleep"; boundaryTitle?: string } | null {
  const match = commitments
    .filter((commitment) => {
      const range = commitmentProtection(commitment, arrivalMarginMinutes);
      return (edge === "start" ? range.startsAt : range.endsAt).getTime() === at.getTime();
    })
    .sort((a, b) => a.id.localeCompare(b.id))[0];
  if (!match) return null;
  const sleep = match.id.startsWith("sleep:") || match.id.startsWith("assumed-sleep:");
  return {
    boundaryKind: sleep ? "sleep" : "commitment",
    ...(match.title ? { boundaryTitle: match.title } : sleep ? { boundaryTitle: "Sleep" } : {})
  };
}

/**
 * The first moment after the boundary at which one of the window-bound candidates gets at least its
 * minimum session, in ranking order. Bounded by capacity and protected boundaries only — the next
 * day's own planning horizon is not re-derived here.
 */
function nextFitAfter(
  boundaryAt: Date,
  candidates: RecommendationCandidate[],
  args: RecommendArguments,
  planning: PlanningResult
): NextFit | null {
  for (const slot of planning.slots) {
    if (slot.startsAt < boundaryAt) continue;
    for (const candidate of candidates) {
      const fit = fitAtSlot(slot, candidate, args, planning);
      if (fit) return fit;
    }
  }
  return null;
}

/**
 * What one candidate would get if it started at the top of `slot`, or null when it does not fit there.
 * The single definition of "fits" for next-fit and for where a boundary ends, so the boundary never
 * names an opening that `nextFitAfter` would then refuse.
 */
function fitAtSlot(
  slot: PlanningSlot,
  candidate: RecommendationCandidate,
  args: RecommendArguments,
  planning: PlanningResult
): NextFit | null {
  if (slot.startsAt <= args.now || slot.capacityMinutes <= 0) return null;
  const action = candidate.action;
  if (!slotFitsAction(slot, action)) return null;
  // Next-fit doesn't project the situation past a candidate's own latest useful start; that
  // exclusion is a fact about the candidate, not about energy or context, so it is re-checked here.
  if (action.latestStartAt && action.latestStartAt < slot.startsAt) return null;
  const window = currentCompatibleWindow({
    now: slot.startsAt,
    horizonEnd: args.horizonEnd,
    action,
    slots: planning.slots
  });
  const project = args.projects.find((item) => item.id === action.projectId);
  const remaining = project
    ? calculateActionEffort(action, project, args.config).riskAdjustedRemainingMinutes
    : action.remainingMinutes;
  const minutes = Math.min(remaining, action.maximumSessionMinutes, window.minutes);
  if (minutes < action.minimumSessionMinutes) return null;
  if (action.splittable === false && window.minutes < remaining) return null;
  return {
    at: slot.startsAt,
    targetId: targetIdOf(candidate),
    title: action.title,
    recommendedMinutes: minutes,
    ...(action.deliverableId ? { deliverableId: action.deliverableId } : {})
  };
}

function boundaryWording(noFit: Extract<NoFit, { kind: "boundary" }>, now: Date, timezone?: string, locale?: string) {
  const at = formatTime(noFit.boundaryAt, timezone, locale);
  const next = noFit.nextFit
    ? ` The next thing that fits is ${noFit.nextFit.title} at ${formatDate(noFit.nextFit.at, timezone, locale)} for ${noFit.nextFit.recommendedMinutes} minutes.`
    : " Nothing fits inside the exact planning week after it either.";
  switch (noFit.boundaryKind) {
    case "daily_horizon":
      return noFit.boundaryAt <= now
        ? {
            headline: `The planning day ended at ${at}`,
            explanation: `Work is not planned past the daily horizon; Today's horizon override is the way to work later deliberately.${next}`
          }
        : {
            headline: `Nothing fits before the day ends at ${at}`,
            explanation: `The planning day ends at ${at}, and no eligible action gets its minimum session before then; work is not planned past the daily horizon.${next}`
          };
    case "sleep":
    case "commitment": {
      const title = noFit.boundaryTitle ?? (noFit.boundaryKind === "sleep" ? "sleep" : "the next commitment");
      // `at` is where protection starts when the window ahead is too short, and where it ends when
      // nothing is open now: the second reads "protected until", not "protected from".
      if (noFit.boundaryEdge === "end")
        return {
          headline: `Nothing fits until ${title}'s protection ends at ${at}`,
          explanation: `${capitalise(title)} is protected until ${at}, and no eligible action gets its minimum session before then.${next}`
        };
      return {
        headline: `Nothing fits before ${title} at ${at}`,
        explanation: `${capitalise(title)} is protected from ${at}, and no eligible action gets its minimum session before then.${next}`
      };
    }
    default:
      return {
        headline: `Nothing fits until ${at}`,
        explanation: `No compatible capacity is open until ${at}.${next}`
      };
  }
}

/**
 * Three cheap counterfactuals, each a re-run of the ranking over the same schedule: being at the
 * location the nearest blocked work is waiting on, having high energy, and a session that could run
 * one slot past its boundary. Only the ones that would change the primary are reported.
 */
function counterfactuals(input: {
  args: RecommendArguments;
  situation: CurrentSituation;
  definitions: ConditionDefinition[];
  candidates: RecommendationCandidate[];
  primary: RecommendationCandidate | null;
  planning: PlanningResult;
  rerun: (overrides: Partial<RecommendArguments>) => Recommendation;
}): Counterfactual[] {
  const { args, situation, definitions, candidates, primary, rerun } = input;
  const results: Counterfactual[] = [];
  const currentId = primary ? targetIdOf(primary) : null;
  const record = (condition: Counterfactual["condition"], description: string, outcome: Recommendation) => {
    const lead = outcome.primary;
    const leadId = lead ? targetIdOf(lead) : null;
    if (leadId === currentId) return;
    results.push({
      condition,
      description,
      thenPrimary: lead
        ? { targetId: leadId!, title: lead.action.title, recommendedMinutes: lead.recommendedMinutes ?? 0 }
        : null
    });
  };

  const locationId = counterfactualLocation(candidates, definitions);
  if (locationId) {
    const name = conditionName(definitions, locationId);
    record(
      "at_location",
      `if you were at ${name}`,
      rerun({
        currentSituation: { ...situation, locationId, locationSetAt: args.now.toISOString(), overrides: {} }
      })
    );
  }
  if (args.currentEnergy && args.currentEnergy !== "high") {
    record("energy_high", "if your energy were high", rerun({ currentEnergy: "high" }));
  }
  const boundary = primary ? primary.sessionBoundary : sessionHorizon(args);
  const extended = new Date(Math.max(sessionHorizon(args).getTime(), boundary.getTime()) + SLOT_MS);
  if (extended <= args.horizonEnd) {
    record(
      "longer_session",
      `if the session could run to ${formatTime(extended, args.timezone, args.locale)}`,
      rerun({ dailyHorizonEnd: extended })
    );
  }
  return results;
}

/**
 * The location worth asking about: the first one the nearest context-blocked candidate is missing
 * or has not had answered, else a definition simply called "home".
 */
function counterfactualLocation(candidates: RecommendationCandidate[], definitions: ConditionDefinition[]) {
  const isLocation = (id: string) => definitions.find((item) => item.id === id)?.kind === "location";
  for (const candidate of candidates) {
    if (candidate.eligible || candidate.conditionMatch.status === "yes") continue;
    const blocked = [...candidate.conditionMatch.unknowns, ...candidate.conditionMatch.missing].find(isLocation);
    if (blocked) return blocked;
  }
  return definitions.find((item) => item.kind === "location" && /^home$/i.test(item.name))?.id;
}

/** The situation as it would be if every named context were answered yes. */
function answeredSituation(
  situation: CurrentSituation,
  contextIds: string[],
  definitions: ConditionDefinition[],
  now: Date
): CurrentSituation {
  const location = contextIds.find((id) => definitions.find((item) => item.id === id)?.kind === "location");
  const overrides = { ...situation.overrides };
  for (const id of contextIds) if (id !== location) overrides[id] = "available";
  return {
    ...situation,
    ...(location ? { locationId: location, locationSetAt: now.toISOString() } : {}),
    overrides
  };
}

function conditionName(definitions: ConditionDefinition[], id: string) {
  return definitions.find((item) => item.id === id)?.name ?? id;
}
function conditionQuestion(definitions: ConditionDefinition[], id: string) {
  const definition = definitions.find((item) => item.id === id);
  const name = definition?.name ?? id;
  switch (definition?.kind) {
    case "location":
      return `Are you at ${name}?`;
    case "capability":
      return `Do you have ${name}?`;
    case "contact":
      return `Can you reach ${name}?`;
    default:
      return `Is ${name} available?`;
  }
}

/** The chosen candidate as the portal names it: target, tier and the one-line reason. */
export function choice(
  candidate: RecommendationCandidate,
  versus?: RecommendationCandidate | null
): RecommendationChoice {
  return {
    targetId: targetIdOf(candidate),
    title: candidate.action.title,
    tier: candidate.criticalTier,
    tierLabel: CRITICAL_TIER_LABELS[candidate.criticalTier],
    reason:
      candidate.criticalReason ??
      (versus ? componentComparison(candidate, versus) : undefined) ??
      `${componentLabel(strongestComponents(candidate.scoreComponents)[0]?.[0] ?? "capacityPressure")} is the strongest ranking factor.`
  };
}

/** A deliverable candidate names its deliverable; every other candidate names its action. */
export function targetIdOf(candidate: RecommendationCandidate) {
  return candidate.action.deliverableId ?? candidate.action.id;
}

/** A score component as "+14" or "−6". */
function signedScore(value: number) {
  return `${value < 0 ? "−" : "+"}${formatScore(Math.abs(value))}`;
}

/**
 * Where two candidates' weighted scores actually differ, penalties included: "Leads X mainly on
 * Neglect (+14 vs +3), offset by Travel cost (−6 vs 0)". A different tier is said as the tier, since it
 * decides first. Undefined when no component differs or the scores are level.
 */
function componentComparison(candidate: RecommendationCandidate, other: RecommendationCandidate): string | undefined {
  const names = new Set([...Object.keys(candidate.scoreComponents), ...Object.keys(other.scoreComponents)]);
  const gaps = [...names]
    .map((name) => {
      const mine = candidate.scoreComponents[name] ?? 0;
      const theirs = other.scoreComponents[name] ?? 0;
      return { name, mine, theirs, gap: mine - theirs };
    })
    .filter((item) => Math.abs(item.gap) >= 1)
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap) || a.name.localeCompare(b.name));
  // The tier decides before any score, so a candidate in a lower tier trails whatever its score says.
  if (candidate.criticalRank !== other.criticalRank) {
    const leadingOnTier = candidate.criticalRank < other.criticalRank;
    return `${leadingOnTier ? "Leads" : "Trails"} ${other.action.title} on tier: ${CRITICAL_TIER_LABELS[candidate.criticalTier].toLowerCase()} against ${CRITICAL_TIER_LABELS[other.criticalTier].toLowerCase()}.`;
  }
  if (!gaps.length || candidate.totalScore === other.totalScore) return undefined;
  const leading = candidate.totalScore > other.totalScore;
  const main = gaps.find((item) => (leading ? item.gap > 0 : item.gap < 0));
  if (!main) return undefined;
  const against = gaps.find((item) => (leading ? item.gap < 0 : item.gap > 0));
  const show = (item: { name: string; mine: number; theirs: number }) =>
    `${componentLabel(item.name)} (${signedScore(item.mine)} vs ${signedScore(item.theirs)})`;
  const lead = `${leading ? "Leads" : "Trails"} ${other.action.title} mainly on ${show(main)}`;
  return against ? `${lead}, ${"offset"} by ${show(against)}.` : `${lead}.`;
}

function decidingSentence(primary: RecommendationCandidate, runnerUp: RecommendationCandidate, factor: DecidingFactor) {
  const other = runnerUp.action.title;
  switch (factor) {
    case "tier":
      return `It leads ${other} because ${CRITICAL_TIER_LABELS[primary.criticalTier].toLowerCase()} outranks ${CRITICAL_TIER_LABELS[runnerUp.criticalTier].toLowerCase()}.`;
    case "consequence":
      return `It leads ${other} because missing it costs more.`;
    case "latest_safe_start":
      return `It leads ${other} because its latest safe start is earlier.`;
    case "deadline":
      return `It leads ${other} because its deadline is earlier.`;
    case "critical_path":
      return `It leads ${other} because more work is waiting on it.`;
    case "completion":
      return `It leads ${other} because it can be finished in this session.`;
    case "neglect":
      return `It leads ${other} because it has waited longer.`;
    case "score": {
      const score = `It leads ${other} ${formatScore(primary.totalScore)} to ${formatScore(runnerUp.totalScore)} on the weighted ranking`;
      const detail = componentComparison(primary, runnerUp)?.replace(/^Leads .*? mainly on /, "mainly on ");
      return detail ? `${score}, ${detail}` : `${score}.`;
    }
    case "margin":
      return `It leads ${other} because it has less margin left.`;
    case "travel":
      return `It leads ${other} because it can be started here, without travelling first.`;
    case "eligibility":
      return `It leads ${other} because ${other} is not eligible right now.`;
    case "rest":
      return `It leads ${other} because ${other} is still in its break after a full session.`;
    case "momentum":
      return `It leads ${other} because it is already underway.`;
    default:
      // Equal on every ranking factor — common for sibling deliverables sharing a deadline. Said
      // as a tie rather than as a lead "by identifier", which read as jargon and implied an order
      // that is not really there.
      return `It ties with ${other} on every ranking factor; either could go first.`;
  }
}

/** How recently a project or action must have been worked to still count as already underway. */
const RECENT_WORK_WINDOW_MS = 86_400_000;

function candidateSort(
  a: RecommendationCandidate,
  b: RecommendationCandidate,
  projects: Map<string, Project>,
  forecasts: Map<string, ProjectForecast>,
  now: Date
): number {
  return compareCandidates(a, b, projects, forecasts, now).order;
}

/**
 * The ranking order between two candidates, and the one comparison that decided it — the same chain
 * whether it is sorting the list or explaining why the winner beat the runner-up.
 */
export function compareCandidates(
  a: RecommendationCandidate,
  b: RecommendationCandidate,
  projects: Map<string, Project>,
  forecasts: Map<string, ProjectForecast>,
  now: Date
): { order: number; factor: DecidingFactor } {
  if (a.eligible !== b.eligible) return { order: a.eligible ? -1 : 1, factor: "eligibility" };
  if (a.criticalRank !== b.criticalRank) return { order: a.criticalRank - b.criticalRank, factor: "tier" };
  if (a.criticalRank < ORDINARY_RANK) {
    // Deadline work stays eligible through the break, but yields to equally urgent work that is not resting.
    if (!a.restUntil !== !b.restUntil) return { order: a.restUntil ? 1 : -1, factor: "rest" };
    // Within a tier every candidate is equally committed, but one whose latest safe start has passed
    // or falls inside the lookahead cannot wait, so it goes before a higher-stakes one that can.
    // Beyond that, the stakes of missing decide before the exact start time does.
    const imminence = imminentRank(a, forecasts, now) - imminentRank(b, forecasts, now);
    if (imminence) return { order: imminence, factor: "latest_safe_start" };
    const consequenceDifference = consequenceFor(b, projects) - consequenceFor(a, projects);
    if (consequenceDifference) return { order: consequenceDifference, factor: "consequence" };
    const startDifference = latestSafeStartFor(a, forecasts, now) - latestSafeStartFor(b, forecasts, now);
    if (startDifference) return { order: startDifference, factor: "latest_safe_start" };
    const deadlineDifference = deadlineFor(a, projects, forecasts) - deadlineFor(b, projects, forecasts);
    if (deadlineDifference) return { order: deadlineDifference, factor: "deadline" };
    const waiting = downstreamFor(b) - downstreamFor(a);
    if (waiting) return { order: waiting, factor: "critical_path" };
    const completes = completionRank(b) - completionRank(a);
    if (completes) return { order: completes, factor: "completion" };
    if (a.scoreComponents.neglect !== b.scoreComponents.neglect)
      return { order: (b.scoreComponents.neglect ?? 0) - (a.scoreComponents.neglect ?? 0), factor: "neglect" };
    // Deadline tiers ignore the weighted score, so the travel cost cannot speak there. Work you can
    // start where you stand still beats equally endangered work that needs a journey first.
    const inPlace = tripRank(a) - tripRank(b);
    if (inPlace) return { order: inPlace, factor: "travel" };
    // A true tie on stakes and timing goes to whichever project was touched most recently, so an
    // equally deadline-critical sibling does not pull you off work you have already started. (The
    // ordinary tier never needs this: its weighted score already prices in recent work via momentum,
    // so an ordinary-tier tie on score is already a tie on recency.)
    const started = startedRank(b, projects, now) - startedRank(a, projects, now);
    if (started) return { order: started, factor: "momentum" };
    return { order: a.action.id.localeCompare(b.action.id), factor: "identifier" };
  }
  if (a.totalScore !== b.totalScore) return { order: b.totalScore - a.totalScore, factor: "score" };
  const deadlineDifference = deadlineFor(a, projects, forecasts) - deadlineFor(b, projects, forecasts);
  if (deadlineDifference) return { order: deadlineDifference, factor: "deadline" };
  const waiting = downstreamFor(b) - downstreamFor(a);
  if (waiting) return { order: waiting, factor: "critical_path" };
  const aSlack = forecasts.get(a.action.projectId)?.marginRatio ?? Number.MAX_SAFE_INTEGER;
  const bSlack = forecasts.get(b.action.projectId)?.marginRatio ?? Number.MAX_SAFE_INTEGER;
  if (aSlack !== bSlack) return { order: aSlack - bSlack, factor: "margin" };
  const consequenceDifference = consequenceFor(b, projects) - consequenceFor(a, projects);
  if (consequenceDifference) return { order: consequenceDifference, factor: "consequence" };
  const completes = completionRank(b) - completionRank(a);
  if (completes) return { order: completes, factor: "completion" };
  const inPlace = tripRank(a) - tripRank(b);
  if (inPlace) return { order: inPlace, factor: "travel" };
  return { order: a.action.id.localeCompare(b.action.id), factor: "identifier" };
}

/** 1 when the candidate's project was worked on within the last day, 0 otherwise. */
function startedRank(candidate: RecommendationCandidate, projects: Map<string, Project>, now: Date): number {
  const workedAt = projects.get(candidate.action.projectId)?.lastWorkedAt ?? candidate.action.lastWorkedAt;
  return workedAt && now.getTime() - workedAt.getTime() < RECENT_WORK_WINDOW_MS ? 1 : 0;
}

/** In place before via a trip, whenever nothing above has separated them. */
function tripRank(candidate: RecommendationCandidate) {
  return candidate.trip ? 1 : 0;
}

/**
 * Errands at the same destination share one journey (§9 bundling).
 *
 * Up to three trip candidates for a destination, taken in ranking order, are charged a share of the
 * round trip each — but only as many as actually fit inside the destination's window one after
 * another, since a bundle nobody could complete is not a bundle. Sharing only ever lowers a cost, so
 * the ranking order this reads is the order before any sharing, which keeps it deterministic.
 */
function bundleTrips(candidates: RecommendationCandidate[]): RecommendationCandidate[] {
  const byDestination = new Map<string, RecommendationCandidate[]>();
  for (const candidate of candidates) {
    if (!candidate.eligible || !candidate.trip) continue;
    const found = byDestination.get(candidate.trip.toLocationId);
    if (found) found.push(candidate);
    else byDestination.set(candidate.trip.toLocationId, [candidate]);
  }
  const shared = new Map<RecommendationCandidate, number>();
  for (const group of byDestination.values()) {
    if (group.length < 2) continue;
    const capacity = group[0]!.trip!.windowMinutes;
    let used = 0;
    let size = 0;
    for (const candidate of group.slice(0, TRIP_BUNDLE_LIMIT)) {
      const minutes = candidate.recommendedMinutes ?? 0;
      if (used + minutes > capacity) break;
      used += minutes;
      size += 1;
    }
    if (size < 2) continue;
    for (const candidate of group.slice(0, size)) shared.set(candidate, size);
  }
  if (!shared.size) return candidates;
  return candidates.map((candidate) => {
    const size = shared.get(candidate);
    if (!size || !candidate.trip) return candidate;
    const trip = {
      ...candidate.trip,
      bundleSize: size,
      avoidableMinutes: avoidableMinutes(candidate.trip.costMinutes, size, candidate.trip.opportunityMinutes)
    };
    const scoreComponents = { ...candidate.scoreComponents, travelCost: travelCostOf(trip) };
    return {
      ...candidate,
      trip,
      scoreComponents,
      totalScore: Object.values(scoreComponents).reduce((sum, value) => sum + value, 0)
    };
  });
}

/** Keeps the highest-ranked candidate for each deliverable; ordinary actions all pass through. */
function bestPerDeliverable(candidates: RecommendationCandidate[]): RecommendationCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const deliverableId = candidate.action.deliverableId;
    if (!deliverableId) return true;
    if (seen.has(deliverableId)) return false;
    seen.add(deliverableId);
    return true;
  });
}

/** Minutes of dependent work waiting on the candidate: the critical path it heads, less itself. */
function downstreamFor(candidate: RecommendationCandidate) {
  return candidate.downstreamMinutes ?? 0;
}
function completionRank(candidate: RecommendationCandidate) {
  return (candidate.scoreComponents.completionBonus ?? 0) > 0 ? 1 : 0;
}
function latestSafeStartFor(candidate: RecommendationCandidate, forecasts: Map<string, ProjectForecast>, now: Date) {
  const forecast = forecasts.get(candidate.action.projectId);
  const unitId = candidate.action.forecastUnitId ?? candidate.action.id;
  // An unplaced unit sorts first: its latest safe start has already passed, as `now`. See
  // `ProjectForecast.unplacedUnitIds` — absent, this reads exactly as it did before.
  if (forecast?.unplacedUnitIds?.includes(unitId)) return now.getTime();
  return forecast?.latestSafeStarts[unitId]?.getTime() ?? Number.MAX_SAFE_INTEGER;
}
/** 0 when the latest safe start has passed or falls inside the critical lookahead, 1 otherwise. */
function imminentRank(candidate: RecommendationCandidate, forecasts: Map<string, ProjectForecast>, now: Date) {
  return latestSafeStartFor(candidate, forecasts, now) <= now.getTime() + CRITICAL_START_LOOKAHEAD_MS ? 0 : 1;
}
function consequenceFor(candidate: RecommendationCandidate, projects: Map<string, Project>) {
  return effectiveConsequence(candidate.action, projects.get(candidate.action.projectId));
}
function deadlineFor(
  candidate: RecommendationCandidate,
  projects: Map<string, Project>,
  forecasts: Map<string, ProjectForecast>
) {
  const project = projects.get(candidate.action.projectId);
  const forecast = forecasts.get(candidate.action.projectId);
  return effectiveDeadline({ action: candidate.action, project, forecast })?.getTime() ?? Number.MAX_SAFE_INTEGER;
}

function strongestComponents(components: Record<string, number>) {
  return Object.entries(components)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3);
}
function noCandidateEvidence(candidates: RecommendationCandidate[]) {
  const structurallyAvailable = candidates.filter(
    (candidate) =>
      !candidate.exclusionReasons.some(
        (reason) =>
          reason === "Parent project is not active." ||
          reason === "Parent outcome is not active." ||
          reason === "Action is not ready to work on."
      )
  );
  const nearest = [...structurallyAvailable].sort(
    (a, b) =>
      a.exclusionReasons.length - b.exclusionReasons.length ||
      b.totalScore - a.totalScore ||
      a.action.id.localeCompare(b.action.id)
  );
  const reasons = [...new Set(nearest.flatMap((candidate) => candidate.exclusionReasons))];
  if (reasons.length) return reasons.slice(0, 3);
  return candidates.length
    ? ["No active, dependency-ready action is available."]
    : ["Capture or clarify the next useful action."];
}
function componentLabel(name: string) {
  return (
    (
      {
        capacityPressure: "Capacity pressure",
        consequence: "Consequence",
        outcomeValue: "Outcome value",
        importance: "Own importance",
        neglect: "Neglect",
        momentum: "Momentum",
        conditionEnergyFit: "Energy and context fit",
        completionBonus: "Completion potential",
        switchingCost: "Switching cost",
        travelCost: "Travel cost",
        cadenceDue: "Cadence due",
        selfSetDeadline: "Self-set deadline this week"
      } as Record<string, string>
    )[name] ?? name
  );
}
function capitalise(value: string) {
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}
/** A whole number when the value is whole, one decimal otherwise — the score can now carry halves. */
export function formatScore(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
function formatList(values: string[], locale = DEFAULT_LOCALE) {
  return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(values);
}
/** Names the learned estimate factor so a changed forecast says where the change came from. */
function calibrationPhrase(project: Project): string {
  const calibration = project.estimateCalibration;
  if (!calibration) return "";
  const where = calibration.scope === "area" ? "in this area" : "across areas";
  const what =
    calibration.factor === 1 && calibration.spread !== undefined
      ? `padded ×${calibration.spread}`
      : `scaled ×${calibration.factor}`;
  return `, ${what} learned from ${calibration.samples} finished actions ${where}`;
}
