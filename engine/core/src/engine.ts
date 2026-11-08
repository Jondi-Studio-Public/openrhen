import type {
  CanDoNowItem,
  CommitmentRoutineStepInput,
  ConditionDefinition,
  CurrentDirective,
  CurrentSituation,
  DeliverableProjection,
  ExistingRoutineStepForPlan,
  JsonValue,
  PlanForecastRequest,
  PlanForecastResponse,
  RoutineStepReconciliationPlan,
  SoftPlacementWire,
  StepPlacementWire,
  TransportMode,
  TravelSource,
  UpcomingDirective
} from "@openrhen/contracts";
import {
  DEFAULT_START_BY_WARNING_MINUTES,
  DEFAULT_TIME_BANDS,
  PLAN_FORECAST_CONTRACT_VERSION,
  buildJourneyIndex,
  calibrationFactorForArea,
  currentSituationSchema,
  dependencyPositions,
  deterministicUuid,
  evaluateConditions,
  nextStaleAt,
  openSessionTitle,
  personWait,
  planRoutineStepReconciliation,
  prerequisiteKey,
  prerequisiteNodes,
  resolveFreshness,
  resolveSituation,
  settingsLocale,
  sessionEndQuestion,
  unmetPrerequisiteReason,
  unmetPrerequisites,
  zonedDateTime,
  type Freshness,
  type JourneyIndex,
  type ResolvedSituation,
  type UnmetPrerequisite
} from "@openrhen/contracts";
import type { StartByWarning } from "@openrhen/contracts";
import {
  placeRoutineChains,
  type BlockedRange,
  type CommitmentChain,
  type PlacedStep,
  type PlacementStep,
  type PlacementStepStatus,
  type RoutineChain
} from "./scheduling/routine-placement.js";
import { resolvePlanningCapacity } from "./scheduling/capacity.js";
import { localisePlanText } from "./recommendation/format.js";
import { resolveStretchState } from "./recommendation/stretch.js";
import { planSchedule, planningSlots } from "./scheduling/schedule.js";
import { isStepOfferableNow, recommend, type RecommendArguments } from "./recommendation/recommend.js";
import {
  addLocalDays,
  localDate,
  resolveCommitmentRecurrenceRepeats,
  resolveRecurrenceOccurrences
} from "./recurrence/recurrence.js";
import { assumedWakeAt, planSleep, protectedRanges } from "./recurrence/sleep.js";
import { computeStayUpOffer } from "./recurrence/stay-up-offer.js";
import {
  cadenceDaysOverdue,
  cadenceDueLocalDate,
  cadenceEligibleFrom,
  cadenceOccurrencesPerDay,
  cadenceStepDueToday
} from "./recurrence/cadence.js";
import { simulateContinuation } from "./recommendation/continuation.js";
import { capacityTransitions, dailyHorizonEnd, selectCurrentDirective } from "./recommendation/directive.js";
import type { DirectiveTravel } from "./recommendation/directive.js";
import { simulateDayPlan } from "./recommendation/day-plan.js";
import { computePrepPace } from "./recommendation/prep-pace.js";
import {
  projectSituation,
  type PlannedLeg,
  type ProjectedDay,
  type TravelLeg
} from "./recommendation/situation-projection.js";
import type { TravelPolicy } from "./recommendation/travel.js";
import {
  deliverableCandidateUnits,
  deliverableForecastUnits,
  deliverableRequirementPathways,
  forecastUnitId,
  unknownEffortDeliverables
} from "./scheduling/deliverables.js";
import type { ScheduleArguments } from "./scheduling/schedule.js";
import {
  defaultPlanningConfig,
  effectiveCommitmentEnd,
  isFreedNow,
  isRemoteCommitment,
  isRunningLate,
  type CommitmentTravelLeg
} from "./model/types.js";
import { commitmentTimeline } from "./model/commitment-timeline.js";
import { localDateFormat } from "./model/zoned-formats.js";
import type {
  Action,
  ActionCadence,
  ActionOccurrence,
  ActionRecurrenceRule,
  CommitmentRecurrenceRule,
  ContinuationSimulation,
  EarlyStepCandidate,
  FixedCommitment,
  PlanningResult,
  Project,
  ProjectForecast,
  RoutineStepStatus,
  SleepPlan,
  WeekOutlook,
  WeekOutlookProject
} from "./model/types.js";

/**
 * Bump on any change to ranking, capacity, eligibility, or context semantics — a stored result is only
 * comparable with a later one when the version says the same rules produced both.
 */
// Bumped for `deriveRoutineInstances` became `deriveSleepRoutineSteps`, and every consumer
// of a bedtime/wake anchor now sees per-step `routine_step` rows instead of one bundled
// `routine_instance` block — a real behaviour change for anything comparing engine output shape.
// Bumped again for the sleep placement design note: sleep aggression and the pressure first pass
// are gone, night ids are keyed on the cycle instead of the calculated start, and placement now
// tries every candidate move (routine-aware, bedtime-deviation-aware) instead of the old walk-back-
// first order — a real behaviour and shape change for anything reading a night's id or explanation.
export const PLAN_FORECAST_ENGINE_VERSION = "1.8.1";
// 1.7.1: every running anchor's window is handed back to the live ranking (not only the first), and a
// boundary's end is the first opening that fits a minimum session, so live eligibility and slots moved.
// 1.8.0: a stale fact is unknown: an old wake plans tonight from
// the sleep preferences with no awake limit, undated or aged energy is the window's, a session left open past
// its end is asked about instead of directing anything, and validity ends when a fact goes stale.
// 1.8.1: effort age: on a behind or at-risk project, a remaining-effort
// estimate set 14 days or more ago is listed in the forecast as an aged input and drops its confidence one
// band. Ranking, placement and health are unchanged.
const DAY = 86_400_000;
const MINUTE = 60_000;
/** Longest a planning result may be trusted without recalculation. */
const MAX_VALIDITY_MINUTES = 60;

type WireState = PlanForecastRequest["state"];

export function calculatePlanAndForecast(input: PlanForecastRequest): PlanForecastResponse {
  const now = new Date(input.calculatedAt);
  const freshness = resolveFreshness(input.state, now);
  // A stale fact is unknown. The wake and the session are withdrawn from the state every reader below
  // sees, so none of them can act on one (a stale open commitment session stops stretching its tracked
  // end, an old wake stops arguing "sleep now"). Fresh facts leave the request untouched.
  const request = withoutStaleFacts(input, freshness);
  // The session the request carries, stale or not: while one is open nothing else can be started, so
  // the ranking keeps excluding other work (below) even though the session is no longer treated as live.
  const openSession = input.state.activeSession;
  const staleSession = freshness.session.stale ? openSession : null;
  const horizonEnd = new Date(request.horizonEnd);
  // The persisted occurrence log, read only by a maintenance project's adherence forecast
  // (scheduling/adherence.ts): unlike the occurrences this function derives below, it still carries
  // whatever history has already closed, which is what "missed its last period entirely" needs.
  const historicalOccurrences = toEngineOccurrences(request.state.occurrences);
  const capacityWindows = resolveCapacity(request.state, now, horizonEnd);
  const commitmentRepeats = deriveCommitmentRepeats(request.state, now, horizonEnd);
  // The list depends only on (state, repeats, now), none of which change below, so it is built once
  // (F1-05). Callers only read it or spread it into new arrays.
  const protectedNow = protectedCommitments(request.state, commitmentRepeats, now);
  // The one journey lookup's per-request index, built once and
  // threaded everywhere a journey figure is needed: the matcher, the projection, and the trip policy.
  const journeys: JourneyIndex = buildJourneyIndex(request.journeys);
  const places = resolvePlaces(request.state, now, request.deliverables ?? [], protectedNow, journeys);
  const arrivalMarginMinutes = request.state.settings.arrivalMarginMinutes;
  const timeBands = request.state.settings.timeBands ?? DEFAULT_TIME_BANDS;
  // Which commitment-anchored routine steps exist this run (the routine step timing design note,
  // "Which steps exist"), derived once from the same reconciliation the persist runs — row
  // existence only, no times yet. `deriveCommitmentRoutineSteps` covers every candidate commitment,
  // confirmed or tentative alike; only placement (below) restricts a tentative one's steps from ever
  // becoming protected.
  const commitmentRoutineSteps = deriveCommitmentRoutineSteps(request.state, commitmentRepeats, now);
  // Two passes over the projection, because the two things depend on each other: sleep is planned
  // around the commitments' protected windows, and a commitment's window only knows how early it
  // starts once the journey to it is worked out. The first pass answers that for the commitments
  // alone, so the wake constraint accounts for the leg; the second adds the nights it produced. Each
  // pass also places every commitment-chain step against that pass's own picture of the day
  // — no pass ever reads a stored placement.
  const projectionThrough = new Date(Math.min(horizonEnd.getTime(), now.getTime() + 2 * DAY));
  const commitmentsPass1 = withTravelLegs(
    protectedNow,
    places &&
      projectDay(
        places,
        protectedNow,
        [],
        now,
        projectionThrough,
        arrivalMarginMinutes,
        journeys,
        request.state.settings.timezone,
        request.state.settings.defaultTransportMode
      )
  );
  const placedPass1 = placedStepMap(
    placeRoutineChains({
      now,
      timezone: request.state.settings.timezone,
      bands: timeBands,
      chains: buildCommitmentChains(commitmentsPass1, commitmentRoutineSteps, arrivalMarginMinutes),
      blocked: [
        ...commitmentProtectedRanges(commitmentsPass1, arrivalMarginMinutes),
        ...doingOrBlockedIntervals(request.state.routineSteps)
      ]
    })
  );
  const commitmentIdsPass1 = new Set(commitmentsPass1.map((item) => item.id));
  const baseCommitments = [
    ...commitmentsPass1,
    ...stepRanges(
      placedPass1,
      commitmentRoutineSteps.filter((step) => step.commitmentId && commitmentIdsPass1.has(step.commitmentId))
    )
  ];
  // The sleep placement design note: sleep aggression and the preliminary-schedule "pressure" pass
  // that used to feed it are gone. A night's placement no longer depends on a first, throwaway
  // schedule pass over the day's projects/actions — only on the commitments and routine steps already
  // in view here — so `prepare()`/`planSchedule()` run exactly once, below, against the real
  // `derivedState` (post-sleep) rather than twice.
  const bedtimeRoutineMinutes = bedtimeRoutineMinutesFor(request.state, now);
  const sleepPlans = deriveSleepPlans(request.state, now, baseCommitments, bedtimeRoutineMinutes, freshness.wake.stale);
  const materializedOccurrences = deriveOccurrences(request.state, now, horizonEnd, sleepPlans);
  const sleepRoutineSteps = deriveSleepRoutineSteps(request.state, sleepPlans, now);
  const nights = sleepPlans.filter((plan) => plan.plannedWakeAt > now);
  // The night happens at home, so it moves you like any other located anchor.
  const projection =
    places &&
    projectDay(
      places,
      protectedNow,
      nights.map((plan) => ({ id: plan.id, plannedStartAt: plan.plannedStartAt, plannedWakeAt: plan.plannedWakeAt })),
      now,
      projectionThrough,
      arrivalMarginMinutes,
      journeys,
      request.state.settings.timezone,
      request.state.settings.defaultTransportMode
    );
  const allCommitmentsBase = withTravelLegs(
    [
      ...protectedNow,
      ...nights.map((plan) => ({
        id: `sleep:${plan.id}`,
        startsAt: plan.plannedStartAt,
        endsAt: plan.plannedWakeAt,
        ...(places?.homeLocationId ? { locationId: places.homeLocationId } : {})
      })),
      ...assumedNightsBeyondPlans(request.state, nights, now, horizonEnd, baseCommitments)
    ],
    projection,
    (id) => (id.startsWith("sleep:") ? id.slice("sleep:".length) : id)
  );
  const commitmentsPass2 = allCommitmentsBase.filter(
    (item) => !item.id.startsWith("sleep:") && !item.id.startsWith("assumed-sleep:")
  );
  // A tentative commitment is never protected, but its own steps are still derived and placed —
  // from a timeline with no legs, since `withTravelLegs` never runs against it.
  const tentativeCommitments = request.state.commitments
    .filter((item) => item.status === "tentative")
    .map(rawTentativeCommitment);
  const wakeCands = wakeCandidates(request.state, sleepPlans, now);
  const placedPass2 = placedStepMap(
    placeRoutineChains({
      now,
      timezone: request.state.settings.timezone,
      bands: timeBands,
      chains: [
        ...buildCommitmentChains(commitmentsPass2, commitmentRoutineSteps, arrivalMarginMinutes),
        ...buildCommitmentChains(tentativeCommitments, commitmentRoutineSteps, arrivalMarginMinutes),
        ...sleepPlans.map((plan): RoutineChain => ({
          kind: "bedtime",
          anchorId: plan.id,
          endsAt: plan.plannedStartAt,
          steps: sleepRoutineSteps
            .filter((step) => step.anchorId === plan.id && step.purpose === "bedtime")
            .map(toPlacementStep)
        })),
        ...wakeCands.map((candidate): RoutineChain => ({
          kind: "wake",
          anchorId: candidate.id,
          startsAt: candidate.startsAt,
          steps: sleepRoutineSteps
            .filter((step) => step.anchorId === candidate.id && step.purpose === "wake")
            .map(toPlacementStep)
        }))
      ],
      blocked: [
        ...commitmentProtectedRanges(commitmentsPass2, arrivalMarginMinutes),
        ...doingOrBlockedIntervals(request.state.routineSteps),
        ...nights.map((plan) => ({ startsAt: plan.plannedStartAt, endsAt: plan.plannedWakeAt }))
      ]
    })
  );
  const placedCommitmentRoutineSteps = applyPlacement(commitmentRoutineSteps, placedPass2);
  const placedSleepRoutineSteps = applyPlacement(sleepRoutineSteps, placedPass2);
  // One table: the fresh sleep-anchored rows and the freshly reconciled, freshly placed
  // commitment-anchored rows replace whatever the wire state carried in.
  const routineSteps: WireState["routineSteps"] = [...placedCommitmentRoutineSteps, ...placedSleepRoutineSteps];
  const derivedState: WireState = { ...request.state, routineSteps };
  // Every placed, pending, flexible commitment before-step — the candidates `recommend()` may offer
  // early. `PlacedStep.earliestAt`
  // is set only for exactly this shape (a flexible commitment before-step the placer actually reached),
  // so no further filtering by phase/timingRule/commitmentId is needed here.
  const offerableSteps = buildOfferableSteps(placedCommitmentRoutineSteps, placedPass2);
  const covered = routineCoverage(derivedState);
  const occurrences = materializedOccurrences.map((occurrence) =>
    covered(occurrence) ? { ...occurrence, routineCovered: true } : occurrence
  );
  const planning = prepare(derivedState, now, horizonEnd, sleepPlans, occurrences, protectedNow);
  const commitmentIdsPass2 = new Set(commitmentsPass2.map((item) => item.id));
  const allCommitments = [
    ...allCommitmentsBase,
    ...stepRanges(placedPass2, [
      ...placedCommitmentRoutineSteps.filter((step) => step.commitmentId && commitmentIdsPass2.has(step.commitmentId)),
      ...placedSleepRoutineSteps
    ])
  ];
  // Forecast units carry all remaining deliverable effort and are scheduled. Candidate units are the
  // currently executable options and are only ranked. Using both in one list would count the same
  // work twice, because an option is a slice of the remaining total rather than an addition to it.
  const projections = request.deliverables ?? [];
  const scheduledActions = [...planning.actions, ...deliverableForecastUnits(projections)];
  const activeCandidate = activeCandidateId(openSession);
  // Built once and handed to the continuation as well, so the plan it simulates against is this plan,
  // deliverables, settings and history included. Restating the list there is how it came to leave out
  // the session break and the occurrence history; now the plan itself is its baseline.
  const scheduleArguments: ScheduleArguments = {
    now,
    horizonEnd,
    projects: planning.projects,
    actions: scheduledActions,
    capacityWindows,
    commitments: allCommitments,
    submissionBufferMinutes: request.state.settings.submissionBufferMinutes,
    submissionBufferPercent: request.state.settings.submissionBufferPercent,
    projectedDailyProtectedMinutes: projectedDailyProtectionMinutes(request.state),
    focusedProjectIds: activeFocusProjectIds(request.state, now),
    arrivalMarginMinutes: request.state.settings.arrivalMarginMinutes,
    sessionBreakMinutes: request.state.settings.sessionBreakMinutes,
    occurrences: historicalOccurrences,
    unknownEffortDeliverables: unknownEffortDeliverables(projections).map((unit) => ({
      projectId: unit.projectId,
      title: unit.title
    }))
  };
  const schedule = planSchedule(scheduleArguments);
  const protectedList = allCommitments.filter(
    (item) =>
      !item.id.startsWith("routine:") &&
      !item.id.startsWith("sleep-routine:") &&
      !item.id.startsWith("sleep:") &&
      !item.id.startsWith("assumed-sleep:")
  );
  // An anchor whose hour is running with nothing recorded as engaging in it: the one case where the
  // live ranking is allowed inside a protected window. The window is handed back in `liveSchedule`
  // alone — `schedule` still subtracts it, so every forecast, envelope, allocation, day-plan block
  // and projected day is exactly as pessimistic as it is about a blocking commitment.
  const freeAnchors = openAnchorsNow(
    protectedList,
    request.state.activeSession,
    now,
    derivedState.routineSteps,
    places?.resolvedLocationId ?? null
  );
  // Overlapping anchors (a recurring class plus a disruption-created copy of it) each hold their own
  // window, so every running one must be handed back or the one left behind still blocks the interval.
  const freeAnchorIds = freeAnchors.map((item) => item.id);
  const liveSchedule = freeAnchors.length
    ? {
        ...schedule,
        slots: planningSlots({
          now,
          horizonEnd,
          capacityWindows,
          commitments: withAnchorWindowOpened(
            allCommitments,
            new Set(freeAnchorIds),
            request.state.settings.arrivalMarginMinutes
          )
        })
      }
    : schedule;
  const locale = settingsLocale(request.state.settings);
  const nextWakeAt = nights.reduce<Date | undefined>(
    (earliest, plan) => (!earliest || plan.plannedWakeAt < earliest ? plan.plannedWakeAt : earliest),
    undefined
  );
  const stretchState = resolveStretchState({
    situation: request.state.currentSituation,
    now,
    timeZone: request.state.settings.timezone,
    energyFresh: !freshness.energy.stale,
    ...(nextWakeAt ? { nextWakeAt } : {})
  });
  const recommendArguments: RecommendArguments = {
    now,
    horizonEnd,
    projects: planning.projects,
    actions: [...planning.actions, ...deliverableCandidateUnits(projections, locale)],
    forecasts: schedule.forecasts,
    planning: liveSchedule,
    capacityWindows,
    commitments: allCommitments,
    protectedCommitments: protectedList,
    routineSteps: derivedState.routineSteps,
    offerableSteps,
    ...(freeAnchorIds.length ? { freeAnchorIds } : {}),
    // Absent when the origin is assumed or travel is off (the travel time model design note, "Trips
    // from an assumed origin", "Modes and travel off"): a trip is a choice made from where you are,
    // and turning trips off must not make a commitment's own journey vanish, which is why this only
    // withholds the trip policy — `withTravelLegs` already protected every plan-required leg above.
    ...(projection && places && !places.origin.assumed && !request.state.currentSituation?.travelOff
      ? {
          travel: {
            travelBetween: projection.travelBetween,
            // Every anchor bounds a trip, whether or not it has a place: you must be free by then.
            anchors: allCommitments,
            presences: projection.segments.flatMap((segment) =>
              segment.locationId !== null && segment.startsAt > now
                ? [{ locationId: segment.locationId, startsAt: segment.startsAt, endsAt: segment.endsAt }]
                : []
            )
          } satisfies TravelPolicy
        }
      : {}),
    currentSituation: request.state.currentSituation,
    conditionDefinitions: request.state.conditionDefinitions,
    ...(freshness.energy.stale ? {} : { currentEnergy: request.state.currentEnergy }),
    ...(stretchState.energyWaivedActionIds.length
      ? {
          energyWaivedActionIds: stretchState.energyWaivedActionIds,
          energyWaivedUntil: stretchState.energyWaivedUntil
        }
      : {}),
    stretch: stretchState.context,
    timezone: request.state.settings.timezone,
    locale,
    dailyHorizonEnd: dailyHorizonEnd(request.state, now),
    arrivalMarginMinutes: request.state.settings.arrivalMarginMinutes,
    sessionBreakMinutes: request.state.settings.sessionBreakMinutes,
    lastEndedSessions: request.state.lastEndedSessions.map((session) => ({
      targetId: session.targetId,
      endedAt: new Date(session.endedAt),
      focusedMinutes: session.focusedMinutes
    })),
    journeys,
    ...(places?.homeLocationId ? { homeLocationId: places.homeLocationId } : {}),
    ...(activeCandidate ? { activeActionId: activeCandidate, lastActionId: activeCandidate } : {})
  };
  const recommendation = recommend(recommendArguments);
  const continuation = request.continuation
    ? simulateRequestedContinuation(
        {
          ...scheduleArguments,
          actionId: request.continuation.actionId,
          ...(request.continuation.requestedMinutes !== undefined
            ? { requestedMinutes: request.continuation.requestedMinutes }
            : {})
        },
        projections,
        schedule
      )
    : null;
  const directiveTravel: DirectiveTravel | undefined =
    places && projection
      ? {
          currentLocationId: places.resolvedLocationId,
          ...(places.homeLocationId ? { homeLocationId: places.homeLocationId } : {}),
          travelBetween: projection.travelBetween,
          locationName: places.locationName
        }
      : undefined;
  const currentDirective = selectCurrentDirective({
    state: derivedState,
    commitments: protectedList,
    now,
    sleepPlans,
    recommendation,
    schedule,
    ...(directiveTravel ? { travel: directiveTravel } : {}),
    ...(staleSession ? { openSessionQuestion: openSessionQuestion(staleSession, request.state.actions, now) } : {})
  });
  const upcomingDirectives = selectUpcomingDirectives(
    protectedList,
    derivedState,
    sleepPlans,
    currentDirective,
    recommendation
  );
  const canDoNow = buildCanDoNow({
    offerableSteps,
    routineSteps: derivedState.routineSteps,
    commitments: protectedList,
    arrivedLocationId: places?.resolvedLocationId ?? null,
    now,
    ...(currentDirective.kind === "routine_step" ? { excludeStepId: currentDirective.targetId } : {}),
    ...(recommendation.protectedCommitment?.late ? { lateCommitmentId: recommendation.protectedCommitment.id } : {})
  });
  const validUntil = nextValidityBoundary(
    protectedList,
    now,
    sleepPlans,
    schedule,
    dailyHorizonEnd(request.state, now),
    nextStaleAt(freshness, now),
    planning.actions
  );
  const weekOutlook = buildWeekOutlook(request.state, schedule, now);
  const tonight = nights.slice().sort((a, b) => a.plannedStartAt.getTime() - b.plannedStartAt.getTime())[0];
  const stayUpOfferResult = computeStayUpOffer({
    now,
    night: tonight,
    bedtimeRoutineMinutes,
    forecasts: (schedule.forecasts ?? []) as ProjectForecast[],
    projectTitles: new Map(request.state.projects.map((project) => [project.id, project.title])),
    actions: planning.actions,
    capacityWindows,
    commitments: allCommitments,
    minimumSleepMinutes: request.state.settings.minimumSleepMinutes,
    maxAwakeHours: request.state.settings.maxAwakeHours,
    previousWakeAt: request.state.settings.lastWokeAt
      ? new Date(request.state.settings.lastWokeAt)
      : freshness.wake.stale
        ? assumedWakeAt(now, request.state.settings.timezone, request.state.settings.preferredWakeTime)
        : now,
    arrivalMarginMinutes
  });
  const stayUpOffer = stayUpOfferResult
    ? {
        nightId: stayUpOfferResult.nightId,
        projectId: stayUpOfferResult.projectId,
        projectTitle: stayUpOfferResult.projectTitle,
        actionId: stayUpOfferResult.actionId,
        actionTitle: stayUpOfferResult.actionTitle,
        minutesBehind: stayUpOfferResult.minutesBehind,
        opensAt: stayUpOfferResult.opensAt.toISOString(),
        closesAt: stayUpOfferResult.closesAt.toISOString(),
        choices: stayUpOfferResult.choices.map((choice) => ({
          minutes: choice.minutes,
          bedtimeAt: choice.bedtimeAt.toISOString(),
          wakeAt: choice.wakeAt.toISOString(),
          sleepMinutes: choice.sleepMinutes
        }))
      }
    : undefined;
  const prepPace = computePrepPace({
    commitments: protectedList,
    routineSteps: derivedState.routineSteps,
    now,
    arrivalMarginMinutes: request.state.settings.arrivalMarginMinutes,
    currentDirective,
    ...(request.state.activeSession ? { activeSession: request.state.activeSession } : {})
  });
  const stepPlacements = buildStepPlacements(derivedState.routineSteps, placedPass2);
  const startByWarnings = buildStartByWarnings({
    routineSteps: derivedState.routineSteps,
    placed: placedPass2,
    commitmentAnchors: [...commitmentsPass2, ...tentativeCommitments],
    sleepPlans,
    wakeCandidates: wakeCands,
    arrivalMarginMinutes,
    warningMinutes: request.state.settings.startByWarningMinutes ?? DEFAULT_START_BY_WARNING_MINUTES,
    timezone: request.state.settings.timezone,
    now
  });
  const dayPlan = simulateDayPlan({
    state: derivedState,
    now,
    sleepPlans,
    schedule,
    recommendArguments,
    recommendation,
    currentDirective,
    ...(directiveTravel ? { travel: directiveTravel } : {}),
    // Where the day will be, rather than where it is now frozen forever. The loop's own location wins,
    // because a directed trip takes the simulation somewhere the projection never foresaw; everything
    // else about the situation — what is carried, how it can travel, what has been measured — is read
    // from the projection at that instant.
    ...(projection && places
      ? {
          situationAt: (t, context) => {
            const projected = projection.at(t);
            // Still where the request was made, whether that place is known or not: an unknown origin
            // keeps its overrides until the projection actually moves the person.
            const atSeed =
              context.locationId === places.resolvedLocationId &&
              (context.locationId !== null || !projected.inTransitTo);
            return {
              currentSituation: {
                ...projected,
                locationId: context.locationId,
                locationSetAt: t.toISOString(),
                overrides: atSeed ? places.situation.overrides : {},
                travel: atSeed ? places.situation.travel : {}
              },
              ...(request.state.currentEnergy && !freshness.energy.stale
                ? { currentEnergy: request.state.currentEnergy }
                : {})
            };
          }
        }
      : {})
  });

  return {
    contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
    requestId: request.requestId,
    inputVersion: request.inputVersion,
    engineVersion: PLAN_FORECAST_ENGINE_VERSION,
    calculatedAt: now.toISOString(),
    validUntil: validUntil.toISOString(),
    derivedState: {
      sleepPlans: toJsonArray([
        ...sleepPlans.map((plan) => {
          const stored = request.state.sleepPlans.find((item) => item.id === plan.id);
          // Only carry the stored outcome when it belongs to *this* night.
          //
          // Sleep plan identity is stable across recomputes, so a plan replanned into a new night
          // keeps the row — and used to keep last night's `completed` with it. The portal renders
          // only `planned` sleep, so tonight's bedtime silently became unrenderable and the Now page
          // showed "no suitable action fits" while the engine still pointed at it. A regenerated
          // window is a different sleep: it starts `planned`, with no actual times.
          //
          // A night's id is keyed on its cycle and
          // never reused across cycles, so an id match already proves this is the same night for every
          // status except `cancelled`. `sleeping` (and `planned` with a manual override) is retained
          // verbatim by `deriveSleepPlans` — same id, never recomputed. `deriveSleepPlans` substitutes
          // `actualStartAt` for `plannedStartAt` in `plan` for those two statuses so downstream
          // scheduling measures from when sleep actually began, not the stale planned instant; that
          // substituted value is why the old comparison (against the row's stored `plannedStartAt`)
          // very rarely matched, resetting an in-progress `sleeping` row to `planned` and silently
          // wiping its `actualStartAt`/`actualWakeAt` on the very next recalculation while the user was
          // still asleep. `cancelled` is the one exception: it stays the same night only while
          // `plannedStartAt` is unchanged, meaning the same abandoned attempt. When a fresh candidate's
          // start has moved, the candidate wins and goes out as `planned` — otherwise an id match echoes
          // the cancelled row forever, freezing the directive on a night the portal will never render
          // again (the night has genuinely moved on; "Did not sleep" only holds until the start moves).
          const sameNight = stored
            ? stored.status === "cancelled"
              ? stored.plannedStartAt === plan.plannedStartAt.toISOString()
              : true
            : false;
          if (!sameNight)
            return { ...plan, status: "planned" as const, ...(stored?.overridden ? { overridden: true } : {}) };
          // A night that has moved past plain `planned` — `sleeping`, `completed`, `cancelled`, or
          // manually overridden — is decided: historical or in-progress fact, not a live forecast.
          // `sleep_log_entry` (correcting a tracked night's duration) and the manual-extend override
          // both write directly to the row's own evidentiary fields (allowedMinutes, plannedWakeAt,
          // sleepDeficitMinutes, ...), same as starting/finishing a sleep session does for the actual
          // times. Returning `{ ...plan, ... }` here — as before — merges those stored fields over a
          // freshly (re)calculated candidate, but only patched `status`/`overridden`/`actualStartAt`/
          // `actualWakeAt`; every other field of `plan`, most visibly `allowedMinutes`, stayed the fresh
          // candidate's generic numbers. That candidate lands on the exact same `plannedStartAt` as the
          // stored row on essentially every recompute where nothing material changed (`planSleep` is a
          // pure function of the same inputs), so a corrected sleep's actual logged duration was
          // silently overwritten back to a generic default the next time anything triggered a
          // recalculation. So a decided plan is returned exactly as stored instead of merged with the
          // fresh candidate; only a plain, untouched `planned` night is still meant to track a live,
          // ever-updating forecast, and keeps using the freshly calculated values.
          const decided = stored!.status !== "planned" || stored!.overridden === true;
          if (decided) return { ...stored! };
          return {
            ...plan,
            status: stored?.status ?? "planned",
            ...(stored?.actualStartAt ? { actualStartAt: stored.actualStartAt } : {}),
            ...(stored?.actualWakeAt ? { actualWakeAt: stored.actualWakeAt } : {}),
            // A recorded stay-up answer or placement choice is not something `planSleep` computes —
            // both are echoed here by id, the same way `actualStartAt`/`actualWakeAt` are above.
            ...(stored?.stayUpAnswerMinutes !== undefined ? { stayUpAnswerMinutes: stored.stayUpAnswerMinutes } : {}),
            ...(stored?.placementChoice !== undefined ? { placementChoice: stored.placementChoice } : {})
          };
        }),
        // A `completed` row is deliberately never in `sleepPlans` (`deriveSleepPlans`'s `kept`
        // excludes it, so it can never seed `nights`/a blocking commitment for a corrupted or
        // otherwise stale window) and its own cycle id is deliberately left free
        // for a re-arming nap's `:after:` variant to claim (`planSleep`'s `isCompleted`, "night
        // identity") instead of colliding with it. Left out of the loop above entirely, it would have
        // no id for that loop's `stored` lookup to find, and a same-inputs recompute — nothing else
        // needing to plan a genuinely new cycle for tonight — would silently drop it from the wire
        // output, losing `sleep_log_entry`'s own correction to `allowedMinutes`/`actualStartAt`/
        // `actualWakeAt`. Echoed through here, verbatim and unconditionally (it is already decided,
        // nothing merges over it), it is present for the portal and for wake-routine anchoring
        // without ever influencing capacity or scheduling.
        ...request.state.sleepPlans.filter(
          (plan) => plan.status === "completed" && !sleepPlans.some((item) => item.id === plan.id)
        )
      ]),
      occurrences: toJsonArray(occurrences),
      // The full merged list: every commitment-anchored row passed through untouched
      // (that sync happens outside the engine, `syncInheritedRoutineSteps`/`platform/database`)
      // alongside this run's freshly derived sleep-anchored rows — one table, one field.
      routineSteps: toJsonArray(derivedState.routineSteps),
      commitmentRepeats: toJsonArray(commitmentRepeats),
      // One timeline per commitment in `protectedList` (the commitment timeline design note, "The
      // timeline on the wire"), sorted by id since the engine's output must not depend on the order
      // commitments happened to arrive in (F7). Legs are already attached (`protectedList` is filtered
      // from `allCommitments`, built by `withTravelLegs`), so `leaveBy`/`homeAt` are present exactly
      // when a journey/homeward leg is. `commitmentTimelineSchema` has no `travelBefore`/`travelAfter`
      // fields, so those two edges of `CommitmentTimeline` are left off the wire object.
      commitmentTimelines: protectedList
        .map((item) => {
          const timeline = commitmentTimeline(item, request.state.settings.arrivalMarginMinutes);
          // Unplaceable: free text with
          // no located place at all is `no_place`; a located place the projection still could not
          // resolve a journey for — no live reading, no samples, no stored minutes, no coordinates — is
          // `no_estimate`, which plans the engine's assumed journey time (its `leaveBy` is a guess). A `no_place`
          // commitment plans no travel at all and would otherwise say nothing.
          const travelGap: "no_place" | "no_estimate" | undefined = isRemoteCommitment(item)
            ? undefined // Remote: there is nowhere to travel to, so nothing to flag.
            : item.location !== undefined && item.locationId === undefined
              ? "no_place"
              : item.locationId !== undefined && projection?.noEstimateAnchorIds.has(item.id)
                ? "no_estimate"
                : undefined;
          return {
            id: item.id,
            setupStartsAt: timeline.setupStartsAt.toISOString(),
            ...(timeline.leaveBy ? { leaveBy: timeline.leaveBy.toISOString() } : {}),
            arriveBy: timeline.arriveBy.toISOString(),
            startsAt: timeline.startsAt.toISOString(),
            endsAt: timeline.endsAt.toISOString(),
            effectiveEndsAt: timeline.effectiveEndsAt.toISOString(),
            freeAt: timeline.freeAt.toISOString(),
            ...(timeline.homeAt ? { homeAt: timeline.homeAt.toISOString() } : {}),
            protectedUntil: timeline.protectedUntil.toISOString(),
            overtime: timeline.overtime,
            latenessMatters: timeline.latenessMatters,
            ...(timeline.travelBefore ? { journeyBefore: timeline.travelBefore } : {}),
            ...(timeline.travelAfter ? { journeyAfter: timeline.travelAfter } : {}),
            ...(travelGap ? { travelGap } : {})
          };
        })
        .sort((a, b) => a.id.localeCompare(b.id)),
      stepPlacements
    },
    schedule: toJson(localisePlanText(schedule, request.state.settings.timezone, locale)),
    recommendation: toJson(recommendation),
    currentDirective,
    upcomingDirectives,
    continuation: continuation ? toJson(continuation) : null,
    ...(weekOutlook ? { weekOutlook: toJson(weekOutlook) } : {}),
    dayPlan,
    ...(prepPace ? { prepPace } : {}),
    ...(stayUpOffer ? { stayUpOffer } : {}),
    canDoNow,
    startByWarnings,
    softPlacements: buildSoftPlacements(schedule, weekOutlook, request.state.actions, now)
  };
}

/**
 * What the request knows about places (the origin may be unknown).
 *
 * `resolvedLocationId` is the matcher's own answer — the live location after the staleness rule, or
 * null when it is unknown or has expired — and feeds trip origins and the day plan's hypothetical
 * situations exactly as before: an assumed origin must never satisfy a location condition or direct a
 * trip. `origin` is the separate, more optimistic answer the projection plans from: the same live
 * location, or, once it has expired, the stale-origin assumption (the travel time model design note,
 * "Stale origin") — the last asserted place, carried forward through any located commitment or home
 * night that has since ended, or home when nothing was ever asserted. With no assertion ever and no home
 * configured the origin is unknown (`origin.locationId` null) and assumed.
 */
interface Places {
  situation: CurrentSituation;
  definitions: ConditionDefinition[];
  resolvedLocationId: string | null;
  origin: { locationId: string | null; assumed: boolean };
  homeLocationId?: string;
  locationName(locationId: string): string;
  workableAt(locationId: string): boolean;
}

function resolvePlaces(
  state: WireState,
  now: Date,
  projections: DeliverableProjection[],
  commitmentsForOrigin: FixedCommitment[],
  journeys: JourneyIndex
): Places | null {
  const situation = state.currentSituation ?? currentSituationSchema.parse({});
  const definitions = state.conditionDefinitions ?? [];
  const homeLocationId = state.settings.homeLocationId;
  const resolved = resolveSituation({
    situation,
    definitions,
    now,
    journeys,
    timeZone: state.settings.timezone,
    ...(homeLocationId ? { homeLocationId } : {})
  });
  // No assertion ever and no home: the origin is simply unknown, not a reason to skip the projection —
  // a located commitment still needs its journey (the destination's stored minutes, else the assumed
  // figure). An unknown origin is assumed, so it directs no trip and satisfies no condition.
  const origin = resolveOrigin(state, now, definitions, commitmentsForOrigin, homeLocationId, resolved.locationId) ?? {
    locationId: null,
    assumed: true
  };
  const named = new Map(definitions.map((definition) => [definition.id, definition.name]));
  const workable = new Map<string, boolean>();
  // Computed once per request rather than per hypothetical location: the pathways a deliverable step
  // offers do not depend on which place is being asked about, only whether that place satisfies them.
  const deliverablePathways = deliverableRequirementPathways(projections);
  return {
    situation,
    definitions,
    resolvedLocationId: resolved.locationId,
    origin,
    ...(homeLocationId ? { homeLocationId } : {}),
    locationName: (locationId) => named.get(locationId) ?? locationId,
    // Whether being at a place is worth anything: is there work you could actually start there, with
    // what you are carrying? A place where nothing can be done is not a place worth staying at.
    //
    // Commitments are deliberately not threaded into this hypothetical resolution: this asks "if you
    // were at this location right now, is anything workable", a location question, not "is a class
    // live right now" — so a `commitment` requirement always resolves unsatisfied here, the same as
    // any other caller that has not threaded `commitments` through.
    workableAt: (locationId) => {
      const cached = workable.get(locationId);
      if (cached !== undefined) return cached;
      const there = resolveSituation({
        situation: { ...situation, locationId, locationSetAt: now.toISOString(), overrides: {} },
        definitions,
        now
      });
      const answer =
        state.actions.some((action) => {
          if (!["planned", "active", "doing"].includes(action.status)) return false;
          const pathways = action.requirementPathways?.length
            ? action.requirementPathways
            : action.contexts.length
              ? [{ id: `${action.id}:legacy`, contextIds: action.contexts }]
              : [];
          return evaluateConditions({ pathways, resolved: there }).status === "yes";
        }) ||
        // A deliverable step counts exactly like an action here: currently executable work (dependencies
        // and blockers already satisfied) that this hypothetical place would additionally unblock. See
        // `deliverableRequirementPathways` for why steps not already executable now are out of scope,
        // and why its `undefined` (nothing to evaluate) must not fall through to `evaluateConditions`,
        // which would read a genuinely empty pathway list as "no requirement" instead.
        (deliverablePathways !== undefined &&
          evaluateConditions({ pathways: deliverablePathways, resolved: there }).status === "yes");
      workable.set(locationId, answer);
      return answer;
    }
  };
}

/**
 * The stale-origin assumption: once the matcher's
 * own answer has expired (or nothing was ever asserted), start from the last asserted place — or home,
 * with no assertion ever — and walk forward through every located commitment whose journey home has
 * already finished, and every planned night that has already ended, since that assertion and up to
 * `now`, in the order they finished. Only past facts already in the request are read here (never the
 * freshly derived sleep plans this same run produces later, which would be circular); the walk is a
 * plain arithmetic fact about history, not a new plan.
 */
function resolveOrigin(
  state: WireState,
  now: Date,
  definitions: ConditionDefinition[],
  commitments: FixedCommitment[],
  homeLocationId: string | undefined,
  resolvedLocationId: string | null
): { locationId: string; assumed: boolean } | null {
  if (resolvedLocationId !== null) return { locationId: resolvedLocationId, assumed: false };
  const situation = state.currentSituation ?? currentSituationSchema.parse({});
  const since = situation.locationSetAt ? new Date(situation.locationSetAt) : new Date(0);
  let current = situation.locationId ?? homeLocationId;
  if (current === undefined) return null;
  const events: { endsAt: number; locationId: string }[] = [];
  const locatable = new Set(definitions.filter((d) => d.kind === "location").map((d) => d.id));
  for (const commitment of commitments) {
    if (!commitment.locationId || !locatable.has(commitment.locationId)) continue;
    const freeAt = commitmentTimeline(commitment, 0).freeAt.getTime();
    if (freeAt > since.getTime() && freeAt <= now.getTime())
      events.push({ endsAt: freeAt, locationId: commitment.locationId });
  }
  if (homeLocationId) {
    for (const plan of state.sleepPlans ?? []) {
      const wake = new Date(plan.plannedWakeAt).getTime();
      if (wake > since.getTime() && wake <= now.getTime()) events.push({ endsAt: wake, locationId: homeLocationId });
    }
  }
  events.sort((a, b) => a.endsAt - b.endsAt);
  for (const event of events) current = event.locationId;
  return { locationId: current, assumed: true };
}

function projectDay(
  places: Places,
  commitments: FixedCommitment[],
  sleepPlans: { id: string; plannedStartAt: Date; plannedWakeAt: Date }[],
  now: Date,
  through: Date,
  arrivalMarginMinutes: number,
  journeys: JourneyIndex,
  timeZone: string,
  userDefaultTransportMode?: TransportMode
): ProjectedDay {
  return projectSituation({
    from: {
      at: now,
      situation: places.situation,
      resolvedLocationId: places.origin.locationId,
      ...(places.origin.assumed ? { assumed: true } : {})
    },
    ...(places.homeLocationId ? { homeLocationId: places.homeLocationId } : {}),
    definitions: places.definitions,
    commitments,
    sleepPlans,
    through,
    arrivalMarginMinutes,
    workableAt: places.workableAt,
    journeys,
    timeZone,
    ...(userDefaultTransportMode ? { userDefaultTransportMode } : {})
  });
}

/**
 * Attaches the journeys the projection worked out to the commitments they belong to, so the one
 * definition of a protected window (§9) covers them and capacity is reduced by them.
 *
 * Only a leg that goes *home* is attached as a commitment's return: a leg heading for the next anchor
 * is already this list's next commitment's approach, and protecting it twice would take the same
 * minutes out of the day twice.
 */
function withTravelLegs(
  commitments: FixedCommitment[],
  projection: ProjectedDay | null | undefined,
  anchorIdOf: (commitmentId: string) => string = (id) => id
): FixedCommitment[] {
  if (!projection?.legs.length) return commitments;
  const approach = new Map(projection.legs.flatMap((leg) => (leg.anchorId ? [[leg.anchorId, leg] as const] : [])));
  const homeward = projection.legs.filter((leg) => leg.reason === "return_home");
  // Each homeward leg belongs to the one commitment whose journey home it is: the last commitment at
  // that place, by the timeline's `freeAt` (tracked overtime included), departing at or before the
  // leg's own departure — never every commitment that ever finished there, or the same leg's minutes
  // are protected twice (types.ts's "capacity counted twice" warning). Matching by exact equality to
  // `freeAt` (rather than "at or after") lost the leg the instant now passed it.
  const owner = new Map<PlannedLeg, string>();
  for (const leg of homeward) {
    let best: { id: string; freeAt: number } | undefined;
    for (const commitment of commitments) {
      if (commitment.locationId !== leg.fromLocationId) continue;
      const freeAt = commitmentTimeline(commitment, 0).freeAt.getTime();
      if (freeAt > leg.departAt.getTime()) continue;
      if (!best || freeAt > best.freeAt || (freeAt === best.freeAt && commitment.id.localeCompare(best.id) < 0))
        best = { id: commitment.id, freeAt };
    }
    if (best) owner.set(leg, best.id);
  }
  return commitments.map((commitment) => {
    const before = approach.get(anchorIdOf(commitment.id));
    const after = homeward.find((leg) => owner.get(leg) === commitment.id);
    // A located commitment whose journey the projection could not resolve still takes time to reach:
    // protect an assumed figure rather than none, and flag it so the timeline says it is a guess.
    // The projection plans that assumed figure as the leg itself, so the flag only marks it a guess.
    const unknownBefore = before !== undefined && projection.noEstimateAnchorIds.has(anchorIdOf(commitment.id));
    if (!before && !after) return commitment;
    return {
      ...commitment,
      ...(unknownBefore ? { travelBeforeUnknown: true } : {}),
      ...(before ? { travelBeforeMinutes: Math.round(before.minutes), travelBefore: asCommitmentLeg(before) } : {}),
      ...(after ? { travelAfterMinutes: Math.round(after.minutes), travelAfter: asCommitmentLeg(after) } : {})
    };
  });
}

function asCommitmentLeg(leg: TravelLeg): CommitmentTravelLeg {
  return {
    fromLocationId: leg.fromLocationId,
    toLocationId: leg.toLocationId,
    minutes: Math.round(leg.minutes),
    ...(leg.mode ? { mode: leg.mode } : {}),
    // The journey store's vocabulary (`live`/`own`/`typical`/`fallback`/`assumed`/`estimated`, plus the engine's own `default`) is a
    // strict subset of the wire's `TravelSource`, so every value passes straight through.
    source: leg.source as TravelSource,
    typicalMinutes: Math.round(leg.typicalMinutes),
    sampleCount: leg.sampleCount,
    ...(leg.originAssumed ? { originAssumed: true } : {})
  };
}

/**
 * Which ranked candidate the running session is working on, or undefined when the session is not a
 * ranked one at all.
 *
 * An action session names its action, or the occurrence standing in for one. A deliverable session
 * names the deliverable, and the engine ranks a deliverable as a single unit keyed by
 * `forecastUnitId`, so the session's own identity has to be translated into that key — without it the
 * engine cannot tell that a deliverable session is running, so every other candidate stays eligible
 * and the deliverable being worked on receives no momentum.
 *
 * Sleep, routine and commitment sessions are directives settled by hard precedence rather than
 * entries in the ranking, so they name nothing here; claiming one of them as the active candidate
 * would exclude every action while it ran.
 */
function activeCandidateId(session: WireState["activeSession"]): string | undefined {
  if (!session) return undefined;
  if (session.targetType === undefined || session.targetType === "action") return session.actionId;
  // `targetId` is the deliverable; `actionId` repeats it for sessions that have no action of their own.
  if (session.targetType === "deliverable") return forecastUnitId(session.targetId || session.actionId);
  return undefined;
}

/**
 * Resolves what a continuation request is asking about, then simulates it.
 *
 * A deliverable session names the deliverable, because that is the identity the portal holds; the
 * engine plans a deliverable as one forecast unit carrying its remaining effort, and that unit is
 * what a longer session actually consumes. Resolving to it keeps continuation bounded by the same
 * effort, session limits and window the plan itself used, so a deliverable continues under the
 * ordinary §10 rules rather than being refused for not existing.
 *
 * A deliverable with no forecast unit has no measured remaining effort — its breakdown is unapproved,
 * or nothing is left — so there is nothing to bound a longer session by. Naming it in the refusal is
 * more use than the generic "no longer exists", which is not what happened.
 */
function simulateRequestedContinuation(
  args: ScheduleArguments & { actionId: string; requestedMinutes?: number },
  projections: DeliverableProjection[],
  baseline: PlanningResult
): ContinuationSimulation {
  if (args.actions.some((action) => action.id === args.actionId)) return simulateContinuation(args, baseline);
  const unitId = forecastUnitId(args.actionId);
  if (args.actions.some((action) => action.id === unitId))
    return simulateContinuation({ ...args, actionId: unitId }, baseline);
  const projection = projections.find((item) => item.id === args.actionId);
  if (projection)
    return {
      safe: false,
      recommendedMinutes: 0,
      reason: `${projection.title} has no measured remaining effort, so there is nothing to continue against.`,
      displacedProjectIds: []
    };
  return simulateContinuation(args, baseline);
}

/**
 * Sum of a preset's `before`-phase step durations — what a commitment inheriting/resolving to this
 * preset spends on preparation. Reused for the bedtime instance's own window and, in
 * `deriveWakeInstances`, for how much lead time a `replacesWakeRoutine` commitment's own routine needs.
 */
function beforePhaseMinutes(preset: WireState["routinePresets"][number]): number {
  return preset.steps
    .filter((step) => step.phase === "before")
    .reduce((total, step) => total + step.durationMinutes, 0);
}

/**
 * Mirrors `syncInheritedRoutineSteps`'s CASE expression in
 * `platform/database/src/planning/routine-inheritance.ts` for resolving which preset governs a
 * commitment's routine ('preset' names one directly; 'inherit' — the default — takes the commitment's
 * location's default; 'custom'/'none' resolve to nothing here). Duplicated rather than imported:
 * `engine/core` may not depend on `platform/database` (`scripts/repository/check-structure.mjs`), the
 * same boundary `routine-step-mootness.ts` documents for its own engine-core/platform-database twin —
 * keep the two in lockstep by hand.
 */
function resolvedCommitmentRoutinePreset(
  commitment: WireState["commitments"][number],
  conditionDefinitions: WireState["conditionDefinitions"],
  presets: WireState["routinePresets"]
): WireState["routinePresets"][number] | undefined {
  const source = commitment.routineSource ?? "inherit";
  const id =
    source === "preset"
      ? commitment.routinePresetId
      : source === "inherit"
        ? conditionDefinitions.find((item) => item.id === commitment.locationId && item.kind === "location")
            ?.defaultRoutinePresetId
        : undefined;
  return id ? presets.find((preset) => preset.id === id && preset.status === "active") : undefined;
}

/**
 * The total length of tonight's included bedtime-routine steps: every `before`-phase step of the
 * active bedtime preset that `cadenceStepIncludedToday` keeps for `now`. Shared by
 * `deriveBedtimeSteps` (which lays the steps out) and the sleep planner (which needs the same number
 * to place the routine window ahead of bedtime) so the two can never disagree.
 */
function bedtimeRoutineMinutesFor(state: WireState, now: Date): number {
  const bedtimePresetId = state.settings.bedtimeRoutinePresetId;
  const bedtimePreset = bedtimePresetId
    ? state.routinePresets.find((item) => item.id === bedtimePresetId && item.status === "active")
    : undefined;
  if (!bedtimePreset) return 0;
  return bedtimePreset.steps
    .filter((step) => step.phase === "before" && cadenceStepIncludedToday(step, state.actions, now))
    .reduce((total, step) => total + step.durationMinutes, 0);
}

function deriveSleepRoutineSteps(state: WireState, sleepPlans: SleepPlan[], now: Date): WireState["routineSteps"] {
  const bedtimePresetId = state.settings.bedtimeRoutinePresetId;
  const bedtimePreset = bedtimePresetId
    ? state.routinePresets.find((item) => item.id === bedtimePresetId && item.status === "active")
    : undefined;
  const wakePresetId = state.settings.wakeRoutinePresetId;
  const wakePreset = wakePresetId
    ? state.routinePresets.find((item) => item.id === wakePresetId && item.status === "active")
    : undefined;
  const existingSleepSteps = state.routineSteps.filter((item) => item.anchorType === "sleep_plan");
  // Nothing configured at all: pass the stored rows through untouched, exactly as before either
  // preset existed -- there is nothing to (re)derive.
  if (!bedtimePreset && !wakePreset) return existingSleepSteps;
  const bedtimeSteps = bedtimePreset
    ? deriveBedtimeSteps(state, bedtimePreset, sleepPlans, existingSleepSteps, now)
    : [];
  const wakeSteps = wakePreset ? deriveWakeSteps(state, wakePreset, sleepPlans, existingSleepSteps, now) : [];
  return [...bedtimeSteps, ...wakeSteps];
}

type SleepRoutineStep = WireState["routineSteps"][number];
type PresetStep = WireState["routinePresets"][number]["steps"][number];

/** The persisted row for one preset step of one sleep anchor, if this run's input state carries one. */
function existingSleepStep(
  existing: SleepRoutineStep[],
  anchorId: string,
  purpose: "bedtime" | "wake",
  presetStepId: string
): SleepRoutineStep | undefined {
  return existing.find(
    (item) => item.anchorId === anchorId && item.purpose === purpose && item.presetStepId === presetStepId
  );
}

/**
 * One template step's derived row. A step whose persisted row is already past "pending"
 * (completed, doing, blocked, cancelled, skipped) is returned exactly as stored -- the engine's own
 * read of the "never rewrite a locked row" invariant `planRoutineStepReconciliation`
 * (`platform/database/src/planning/routine-inheritance.ts`) enforces at write time, so this run's own
 * directive/day-plan output already agrees with what a `start_activity` against the persisted row
 * would see, and a completed step is never relitigated as skipped or rescheduled just because the
 * night's own timing or a `replacesWakeRoutine` truncation moved this run. A brand-new or
 * still-pending step's *times* are no longer decided here at all — `routine-placement.ts`'s placer
 * runs against the whole chain and writes `scheduledStartAt`/`scheduledEndAt` onto the row afterward
 * — only which row exists, its id and its
 * `status` (`pending`, or `skipped` for a truncation drop) are decided here, using the same
 * deterministic id formula every run so a freshly-inserted row's id agrees with what
 * `platform/database`'s `reconcileSleepRoutineSteps` will persist for it (`generateId`).
 */
function buildSleepStep(args: {
  presetStep: PresetStep;
  presetId: string;
  anchorId: string;
  purpose: "bedtime" | "wake";
  droppedByTruncation: boolean;
  existing: SleepRoutineStep | undefined;
}): SleepRoutineStep {
  const { presetStep, presetId, anchorId, purpose, droppedByTruncation, existing } = args;
  if (existing && existing.status !== "pending") return existing;
  return {
    // A still-pending row already has a real persisted id, which is not necessarily this run's
    // deterministic hash — a migrated or restored row was minted by SQL (`gen_random_uuid()`)/
    // `crypto.randomUUID()`, not by this formula. Only a genuinely new step (no existing row at all)
    // needs one invented, and it must be *this* formula so `reconcileSleepRoutineSteps`'s own
    // `generateId` (fed this same computed id positionally) inserts the row under the id this
    // response already names in `currentDirective`/the day plan.
    id: existing?.id ?? deterministicUuid(`routine-step:${presetId}:${anchorId}:${purpose}:${presetStep.id}`),
    anchorType: "sleep_plan",
    anchorId,
    purpose,
    title: presetStep.title,
    durationMinutes: presetStep.durationMinutes,
    sequence: presetStep.sequence,
    timingRule: presetStep.timingRule,
    ...(presetStep.maxLeadMinutes !== undefined ? { maxLeadMinutes: presetStep.maxLeadMinutes } : {}),
    energy: presetStep.energy,
    contexts: presetStep.contexts,
    dependencyIds: [],
    phase: presetStep.phase,
    ...(presetStep.actionWindowId !== undefined ? { actionWindowId: presetStep.actionWindowId } : {}),
    ...(presetStep.cadenceActionId !== undefined ? { cadenceActionId: presetStep.cadenceActionId } : {}),
    presetStepId: presetStep.id,
    status: droppedByTruncation ? "skipped" : "pending",
    ...(presetStep.waitAfterMinutes !== undefined ? { waitAfterMinutes: presetStep.waitAfterMinutes } : {}),
    ...(presetStep.mustStartByMinutes !== undefined ? { mustStartByMinutes: presetStep.mustStartByMinutes } : {}),
    ...(presetStep.preferredBands !== undefined ? { preferredBands: presetStep.preferredBands } : {})
  };
}

/**
 * This run's bedtime rows: every "before"-phase step of `preset` that `cadenceStepIncludedToday`
 * keeps (a gated-out step reserves none of the window and is dropped from the template entirely,
 * mirroring the commitment-side sync -- a completed one survives regardless, via
 * `buildSleepStep`'s own locked-row branch, since `planRoutineStepReconciliation` keeps an
 * unmatched non-pending row rather than deleting it). Row existence only — the placer's backward
 * chain (boundary = the night's own `plannedStartAt`) decides every pending row's times.
 */
function deriveBedtimeSteps(
  state: WireState,
  preset: WireState["routinePresets"][number],
  sleepPlans: SleepPlan[],
  existingSteps: SleepRoutineStep[],
  now: Date
): WireState["routineSteps"] {
  const beforePhaseSteps = preset.steps
    .filter((step) => step.phase === "before")
    .slice()
    .sort((a, b) => a.sequence - b.sequence);
  const steps = beforePhaseSteps.filter((step) => cadenceStepIncludedToday(step, state.actions, now));
  const gatedOutSteps = beforePhaseSteps.filter((step) => !cadenceStepIncludedToday(step, state.actions, now));
  const durationMinutes = steps.reduce((total, step) => total + step.durationMinutes, 0);
  // Kept exactly in step with `bedtimeRoutineMinutesFor`, which the sleep planner uses for the same
  // preset — both filter `before`-phase steps through the same cadence gate.
  if (durationMinutes <= 0) return [];
  const results: SleepRoutineStep[] = [];
  for (const sleep of sleepPlans) {
    for (const presetStep of steps) {
      const existing = existingSleepStep(existingSteps, sleep.id, "bedtime", presetStep.id);
      results.push(
        buildSleepStep({
          presetStep,
          presetId: preset.id,
          anchorId: sleep.id,
          purpose: "bedtime",
          droppedByTruncation: false,
          existing
        })
      );
    }
    // A gated-out step reserves none of tonight's window and is never (re)created — but if it was
    // already completed on some earlier occasion (this same cadence link, before its dueness moved),
    // that fact is never dropped just because this run's gate says "not today"; `platform/database`'s
    // own reconciliation would carry the same row forward as an unmatched locked row regardless, so
    // echoing it here keeps this run's own response agreeing with what persists.
    for (const presetStep of gatedOutSteps) {
      const existing = existingSleepStep(existingSteps, sleep.id, "bedtime", presetStep.id);
      if (existing && existing.status !== "pending") results.push(existing);
    }
  }
  return results;
}

/** One candidate night's wake moment: either a forward sleep plan's planned wake, or (see below) the plan the person is currently waking from. */
type WakeCandidate = { id: string; startsAt: Date };

/**
 * Candidates a wake step can anchor to. `sleepPlans` (the forward-looking derived list) covers
 * tonight's-and-later bedtime/wake pairs, but `deriveSleepPlans`' `retained` filter
 * (`status === "sleeping" || (status === "planned" && overridden)`) drops a plan the instant "I'm
 * awake" flips it to `"completed"` -- so the plan the person is *currently* waking from needs its own
 * candidate, sourced from the raw stored list rather than the derived one.
 */
function wakeCandidates(state: WireState, sleepPlans: SleepPlan[], now: Date): WakeCandidate[] {
  const forward: WakeCandidate[] = sleepPlans.map((plan) => ({ id: plan.id, startsAt: plan.plannedWakeAt }));
  const timezone = state.settings.timezone;
  const today = localDate(now, timezone);
  const recentlyCompleted = state.sleepPlans
    .filter(
      (plan) =>
        plan.status === "completed" && plan.actualWakeAt && localDate(new Date(plan.actualWakeAt), timezone) === today
    )
    .sort((a, b) => new Date(b.actualWakeAt!).getTime() - new Date(a.actualWakeAt!).getTime())[0];
  if (!recentlyCompleted) return forward;
  const actual: WakeCandidate = { id: recentlyCompleted.id, startsAt: new Date(recentlyCompleted.actualWakeAt!) };
  // Dedupe defensively (shouldn't collide, given `retained`'s filter above) -- prefer the actual entry.
  return [...forward.filter((candidate) => candidate.id !== actual.id), actual];
}

/**
 * Whether a wake- or bedtime-preset step belongs in today's rows. An ordinary step (no
 * `cadenceActionId`) always does. A cadence-linked step is included only when the gate can evaluate
 * the link *and* that cadence is due today (`cadenceStepDueToday`) -- otherwise it is left out of the
 * window entirely (the same way a cadence-gated-out commitment routine step is dropped from its own
 * sync template, `isPresetStepEligibleToday`/`routine-inheritance.ts` -- that package can't import this
 * one, so the two stay in lockstep by hand).
 *
 * a link the gate cannot evaluate -- the action missing, no longer `schedulingMode ===
 * 'cadence'`, or with no cadence rule -- fails closed: not evaluable reads as not due, so the step is
 * left out today the same as a cadence that genuinely isn't due. Write-time validation
 * (`linkedCadenceAction`, `portal/server/persistence/postgres/entity-commands.ts`) refuses a new link
 * to a non-cadence action, so this branch should only ever catch a link that stopped being valid after
 * it was saved. Applied by both `deriveWakeSteps` (after its own phase pass-through -- phase is not
 * consulted for wake) and `deriveBedtimeSteps` (after its "before" phase filter); `cadenceCoveredActionIds`
 * reads `state.routineSteps` directly so its own notion of "materialised today" never drifts from what
 * these derive functions actually build.
 */
function cadenceStepIncludedToday(step: PresetStep, actions: WireState["actions"], now: Date): boolean {
  if (!step.cadenceActionId) return true;
  const action = actions.find((item) => item.id === step.cadenceActionId);
  if (!action) return false;
  const cadence = cadenceOf(action);
  if (!cadence) return false;
  return cadenceStepDueToday(cadence, now);
}

/**
 * This run's wake rows: every step of `preset` (`phase` is not consulted for a wake candidate, unlike
 * bedtime) that `cadenceStepIncludedToday` keeps, scheduled forward from each candidate's `startsAt`,
 * subject to the `replacesWakeRoutine` skip/truncate rule below -- unchanged from the earlier instance
 * model, just expressed as one row per step (with `status: "skipped"` for a truncation-dropped step)
 * instead of one instance's `skippedStepIds` array.
 */
function deriveWakeSteps(
  state: WireState,
  preset: WireState["routinePresets"][number],
  sleepPlans: SleepPlan[],
  existingSteps: SleepRoutineStep[],
  now: Date
): WireState["routineSteps"] {
  const allSteps = preset.steps.slice().sort((a, b) => a.sequence - b.sequence);
  const steps = allSteps.filter((step) => cadenceStepIncludedToday(step, state.actions, now));
  const gatedOutSteps = allSteps.filter((step) => !cadenceStepIncludedToday(step, state.actions, now));
  const durationMinutes = steps.reduce((total, step) => total + step.durationMinutes, 0);
  if (durationMinutes <= 0) return [];
  // Confirmed commitments whose own resolved preset opts to replace the wake routine -- a candidate's
  // own skip/truncate check below only ever looks at this pre-filtered, preset-resolved set.
  const replacingCommitments = state.commitments
    .filter((commitment) => commitment.status === "confirmed")
    .flatMap((commitment) => {
      const resolved = resolvedCommitmentRoutinePreset(commitment, state.conditionDefinitions, state.routinePresets);
      return resolved?.replacesWakeRoutine ? [{ commitment, preset: resolved }] : [];
    });

  const results: SleepRoutineStep[] = [];
  for (const candidate of wakeCandidates(state, sleepPlans, now)) {
    const startsAt = candidate.startsAt;
    const fullEndsAt = new Date(startsAt.getTime() + durationMinutes * MINUTE);

    // A gated-out step reserves none of this candidate's window and is never (re)created — but if it
    // was already completed on some earlier occasion (this same cadence link, before its dueness
    // moved), that fact is never dropped just because this run's gate says "not today"; regardless of
    // whether this candidate goes on to skip/truncate below, `platform/database`'s own reconciliation
    // would carry the same row forward as an unmatched locked row, so echoing it here keeps this run's
    // own response agreeing with what persists.
    for (const presetStep of gatedOutSteps) {
      const existing = existingSleepStep(existingSteps, candidate.id, "wake", presetStep.id);
      if (existing && existing.status !== "pending") results.push(existing);
    }

    // replacesWakeRoutine skip/truncate (Engine steps 6-7 of the wake-routine plan; see
    // The wake routine design note for the write-up). For each qualifying commitment C starting at or
    // after this candidate's startsAt, `leadMinutes(C)` is C's own before-phase preparation and
    // `prepMustStartAt` is when that preparation needs to begin to finish exactly as C starts.
    //   - No room even for the wake routine's first instant (prepMustStartAt <= startsAt): running it
    //     first serves no one, so every row for this candidate is skipped outright.
    //   - Partial room (prepMustStartAt lands inside the wake window, before its full un-truncated
    //     end): truncate to the earliest such cutoff instead of dropping the whole thing.
    //   - No overlap at all (prepMustStartAt at/after the full end): no effect.
    let skip = false;
    let truncatedEndsAt: Date | undefined;
    for (const { commitment, preset: cPreset } of replacingCommitments) {
      const commitmentStartsAt = new Date(commitment.startsAt);
      if (commitmentStartsAt.getTime() < startsAt.getTime()) continue;
      const leadMinutes = beforePhaseMinutes(cPreset);
      const prepMustStartAt = commitmentStartsAt.getTime() - leadMinutes * MINUTE;
      if (prepMustStartAt <= startsAt.getTime()) {
        skip = true;
        break;
      }
      if (prepMustStartAt < fullEndsAt.getTime()) {
        const cutoff = new Date(prepMustStartAt);
        if (!truncatedEndsAt || cutoff < truncatedEndsAt) truncatedEndsAt = cutoff;
      }
    }
    if (skip) continue;

    // Two passes, mirroring the earlier truncation walk: first decide, per step, whether it is kept
    // or dropped (a dropped step does not consume the window, so a later kept step is not pushed out
    // further by a step that never actually ran, and an already-locked step -- completed or otherwise
    // not "pending" -- is never dropped, since a completed step is a fact, not relitigated); only once
    // every step has an answer do we know whether *anything* survived for this candidate.
    let cursor = startsAt.getTime();
    let lastKeptEnd: number | undefined;
    const stepPlans: Array<{
      presetStep: PresetStep;
      dropped: boolean;
      existing: SleepRoutineStep | undefined;
    }> = [];
    for (const presetStep of steps) {
      const existing = existingSleepStep(existingSteps, candidate.id, "wake", presetStep.id);
      const locked = existing !== undefined && existing.status !== "pending";
      const stepEndsAt = cursor + presetStep.durationMinutes * MINUTE;
      const dropped = truncatedEndsAt !== undefined && stepEndsAt > truncatedEndsAt.getTime() && !locked;
      stepPlans.push({ presetStep, dropped, existing });
      if (dropped) continue;
      cursor = stepEndsAt;
      lastKeptEnd = stepEndsAt;
    }
    // Every step dropped: no zero-duration set of rows for this candidate, mirroring
    // `durationMinutes <= 0` above.
    if (truncatedEndsAt && lastKeptEnd === undefined) continue;

    for (const plan of stepPlans)
      results.push(
        buildSleepStep({
          presetStep: plan.presetStep,
          presetId: preset.id,
          anchorId: candidate.id,
          purpose: "wake",
          droppedByTruncation: plan.dropped,
          existing: plan.existing
        })
      );
  }
  return results;
}

function prepare(
  state: WireState,
  now: Date,
  horizonEnd: Date,
  sleepPlans: WireState["sleepPlans"] | SleepPlan[],
  occurrences: WireState["occurrences"] | ActionOccurrence[],
  commitments: FixedCommitment[] = []
) {
  // Who is with the owner right now, for work that needs a person. Judged against the present only.
  const resolvedNow = resolveSituation({
    situation: state.currentSituation ?? currentSituationSchema.parse({}),
    definitions: state.conditionDefinitions ?? [],
    now,
    commitments,
    timeZone: state.settings.timezone
  });
  const projects: Project[] = state.projects.map((project) => {
    const outcome = state.outcomes.find((candidate) => candidate.id === project.outcomeId);
    // Learned calibration (logic design §5): the area's own factor, else everyone's.
    const calibration = state.settings.estimateCalibrationEnabled
      ? calibrationFactorForArea(state.estimateCalibration, outcome?.areaId)
      : null;
    return {
      id: project.id,
      status: project.status,
      uncertainty: project.uncertainty,
      value: project.value,
      consequence: project.consequence,
      ...refinedConsequence(project),
      outcomeActive: outcome?.status === "active",
      ...(calibration && (calibration.factor !== 1 || (calibration.spread ?? 1) > 1)
        ? {
            estimateCalibration: {
              factor: calibration.factor,
              samples: calibration.samples,
              scope: calibration.scope,
              ...(calibration.spread === undefined ? {} : { spread: calibration.spread })
            }
          }
        : {}),
      ...(project.internalDeadlineAt ? { internalDeadlineAt: new Date(project.internalDeadlineAt) } : {}),
      ...(project.externalDeadlineAt ? { externalDeadlineAt: new Date(project.externalDeadlineAt) } : {}),
      ...(project.lastWorkedAt ? { lastWorkedAt: new Date(project.lastWorkedAt) } : {}),
      ...(project.createdAt ? { createdAt: new Date(project.createdAt) } : {}),
      ...(project.remainingEffortOverrideMinutes !== undefined
        ? { remainingEffortOverrideMinutes: project.remainingEffortOverrideMinutes }
        : {}),
      ...(project.actualCompletionRatio !== undefined ? { actualCompletionRatio: project.actualCompletionRatio } : {}),
      ...(project.requiredCompletionRatio !== undefined
        ? { requiredCompletionRatio: project.requiredCompletionRatio }
        : {})
    };
  });
  const statuses = new Map(state.actions.map((action) => [action.id, action.status]));
  const unmet = unmetPrerequisites(prerequisiteNodes(state));
  const covered = routineCoverage(state);
  const cadenceCoveredIds = cadenceCoveredActionIds(state, now);
  // A deliverable's actions are planned once, through `deliverables.ts`'s own projection — never here.
  // `portal/server/persistence/postgres/readers/actions.ts` already filters `deliverable_id IS NULL` when it builds `state.actions`, so this
  // set is normally empty; it stays as a guard for a caller that hands `prepare` the whole `actions`
  // table instead (the deliverable steps as actions design note,, Invariant 1).
  const deliverableActionIds = new Set(
    state.deliverables.flatMap((deliverable) => deliverable.steps.map((step) => step.id))
  );
  const baseActions = state.actions
    .filter((action) => action.schedulingMode !== "recurring" && !deliverableActionIds.has(action.id))
    .map((action) => hydrateAction(action, statuses, now, cadenceCoveredIds, unmet, resolvedNow));
  const recurringActions = state.actions
    .filter((action) => action.schedulingMode === "recurring" && action.recurrence)
    .flatMap((template): Action[] => {
      const pending = occurrences.filter(
        (occurrence) => occurrence.actionId === template.id && occurrence.status === "pending"
      );
      const exactEnd = new Date(now.getTime() + 7 * DAY);
      const rule = recurrenceRuleOf(template);
      const exact = pending
        .filter((occurrence) => new Date(occurrence.windowStartsAt) < exactEnd && !covered(occurrence))
        .map((occurrence): Action => ({
          ...hydrateAction(template, statuses, now, cadenceCoveredIds, unmet, resolvedNow),
          id: occurrence.id,
          title: `${template.title} · ${occurrence.windowName}`,
          remainingMinutes: template.expectedMinutes,
          availableFrom: new Date(occurrence.windowStartsAt),
          deadlineAt: new Date(occurrence.windowEndsAt),
          latestStartAt: new Date(new Date(occurrence.windowEndsAt).getTime() - template.expectedMinutes * MINUTE),
          schedulingMode: "recurring",
          occurrenceId: occurrence.id,
          occurrenceWindowName: occurrence.windowName,
          templateActionId: template.id,
          ...(rule ? { recurrenceRule: rule } : {})
        }));
      // Later occurrences: a live series reserves its expected minutes through its own end
      // date or the forecast horizon, not just the pending week — otherwise nothing represents its
      // demand past day 7 at all. Resolved straight from the rule (no materialised row exists out
      // this far, and none is needed: `resolveRecurrenceOccurrences` is pure and answers any span),
      // with no anchors — a real wake/sleep fact is inherently a near-term thing, so a window this
      // far out can only ever fall back to its own clock fallback or the preferred wake time, exactly
      // as it will when that day actually arrives and gets materialised for real. Routine-covered
      // occurrences beyond the week are not excluded one-by-one (there is no per-occurrence coverage
      // fact this far out); instead every later occurrence's demand is scaled by the covered share the
      // pending week itself already shows — all of this week's occurrences covered means none of the
      // rest reserve anything either.
      const pendingInWindow = pending.filter((occurrence) => new Date(occurrence.windowStartsAt) < exactEnd);
      const coveredShare = pendingInWindow.length
        ? pendingInWindow.filter((occurrence) => covered(occurrence)).length / pendingInWindow.length
        : 0;
      const laterMinutes = Math.round(template.expectedMinutes * (1 - coveredShare));
      // Bounded the same way `schedule.ts`'s own `forecastEnd` is (`defaultPlanningConfig.
      // forecastHorizonDays`, 180): a caller-supplied `horizonEnd` far beyond that would otherwise
      // inflate this project's counted remaining effort with demand the forecast itself never looks
      // at or reserves.
      const configuredForecastEnd = new Date(now.getTime() + defaultPlanningConfig.forecastHorizonDays * DAY);
      const laterThrough = new Date(
        Math.min(
          horizonEnd.getTime(),
          configuredForecastEnd.getTime(),
          template.recurrence!.endDate ? Date.parse(`${template.recurrence!.endDate}T23:59:59Z`) : Infinity
        )
      );
      // One aggregate action per later horizon band, not one per occurrence: a daily series run out
      // to the 180-day horizon resolves to well over a hundred individual occurrences, which is both
      // needless cost (the forecast reserves aggregate minutes in every band past the detailed one
      // anyway, per the band-ledger decision — session shape does not exist there to place an exact
      // occurrence into) and, worse, a false precision: nothing this far out actually knows this
      // series will occupy that exact quarter-hour. A band's own [start, end) window is this
      // aggregate unit's own `availableFrom`/`deadlineAt`, so it competes for capacity only within
      // that band, matching "reserved into band slots inside their windows".
      const later: Action[] = [];
      if (laterMinutes > 0 && rule && laterThrough > exactEnd)
        for (const bandConfig of defaultPlanningConfig.horizonBands) {
          if (bandConfig.kind === "detailed") continue;
          const bandStart = new Date(Math.max(exactEnd.getTime(), now.getTime() + bandConfig.startDay * DAY));
          const bandEnd = new Date(Math.min(laterThrough.getTime(), now.getTime() + bandConfig.endDay * DAY));
          if (bandStart >= bandEnd) continue;
          const occurrenceCount = resolveRecurrenceOccurrences({
            rule,
            from: bandStart,
            through: bandEnd,
            preferredWakeTime: state.settings.preferredWakeTime
          }).length;
          if (!occurrenceCount) continue;
          const bandMinutes = laterMinutes * occurrenceCount;
          later.push({
            ...hydrateAction(template, statuses, now, cadenceCoveredIds, unmet, resolvedNow),
            id: `${template.id}:${bandConfig.kind}`,
            title: `${template.title} · ${bandConfig.kind}`,
            remainingMinutes: bandMinutes,
            availableFrom: bandStart,
            deadlineAt: bandEnd,
            latestStartAt: new Date(bandEnd.getTime() - bandMinutes * MINUTE),
            schedulingMode: "recurring",
            templateActionId: template.id,
            recurrenceRule: rule
          });
        }
      return [...exact, ...later];
    });
  return { projects, actions: [...baseActions, ...recurringActions], sleepPlans, horizonEnd };
}

/**
 * A refined consequence reaches the engine only when it was fitted for the stars the record now has;
 * after a star edit the cached value is stale and the stars win until the next fit.
 */
function refinedConsequence(record: {
  consequence: number;
  consequenceRefined?: number | undefined;
  consequenceRefinedForStars?: number | undefined;
}): { consequenceRefined?: number } {
  const { consequenceRefined, consequenceRefinedForStars } = record;
  if (consequenceRefined === undefined || consequenceRefinedForStars === undefined) return {};
  if (!Number.isFinite(consequenceRefined) || consequenceRefinedForStars !== record.consequence) return {};
  return { consequenceRefined };
}

function hydrateAction(
  action: WireState["actions"][number],
  statuses: Map<string, string>,
  now: Date,
  cadenceCoveredIds: ReadonlySet<string>,
  unmet: ReadonlyMap<string, UnmetPrerequisite[]>,
  resolvedNow: ResolvedSituation
): Action {
  const personHold = personWait({
    pathways: action.requirementPathways,
    resolved: resolvedNow,
    subjectId: action.id
  });
  // Own same-kind edges are judged from `statuses` below; what is left is another kind of prerequisite
  // or one inherited from the project (`planning/prerequisites.ts`).
  const waitingOn = (unmet.get(prerequisiteKey({ kind: "action", id: action.id })) ?? []).filter(
    (ref) => !(ref.kind === "action" && action.dependencyIds.includes(ref.id))
  );
  const cadence = cadenceOf(action);
  // A cadence cycle cannot be suggested again on the day it was done, whatever the score says, and
  // never before the series starts. Derived here so every consumer of `availableFrom` agrees.
  const availableFrom = [
    ...(action.availableFrom ? [new Date(action.availableFrom)] : []),
    ...(cadence ? [cadenceEligibleFrom(cadence, now)] : [])
  ].sort((a, b) => b.getTime() - a.getTime())[0];
  const seriesEnded =
    cadence && action.recurrence?.endDate && localDate(now, cadence.timezone) > action.recurrence.endDate
      ? `The series ended on ${action.recurrence.endDate}.`
      : undefined;
  // Feature B: a cadence cycle already materialised as a routine step in today's wake/bedtime
  // instances or commitment routine steps must not also compete as an ordinary recommendation
  // candidate — the routine step is the one place it should be offered today. Mirrors `seriesEnded`
  // exactly: `unavailableReason` alone excludes the candidate from `recommend()`'s ranking
  // (`eligibilityFailures` → `exclusionReasons` → `eligible = exclusions.length === 0`,
  // `recommendation/score.ts`/`recommend.ts`) — verified by tracing that path, not assumed — so no
  // separate `prepare()`-level filtering or `availableFrom` push is needed; the covered set is
  // recomputed fresh every run, so the exclusion lifts on its own the moment the step stops being
  // materialised (completed, skipped, or the next day's instance no longer covers it).
  const cadenceCovered = cadence !== undefined && cadenceCoveredIds.has(action.id);
  const unavailableReason = seriesEnded ?? (cadenceCovered ? "Covered by today's routine step." : undefined);
  return {
    id: action.id,
    projectId: action.projectId,
    title: action.title,
    status: action.status,
    optimisticMinutes: action.optimisticMinutes,
    expectedMinutes: action.expectedMinutes,
    remainingMinutes: action.remainingMinutes,
    ...(action.remainingSetAt ? { remainingSetAt: new Date(action.remainingSetAt) } : {}),
    pessimisticMinutes: action.pessimisticMinutes,
    energy: action.energy,
    minimumSessionMinutes: action.minimumSessionMinutes,
    maximumSessionMinutes: action.maximumSessionMinutes,
    importance: action.importance,
    consequence: action.consequence,
    ...refinedConsequence(action),
    contexts: action.contexts,
    requirementPathways: action.requirementPathways,
    preferences: action.preferences,
    dependenciesComplete: action.dependencyIds.every((id) => statuses.get(id) === "done") && waitingOn.length === 0,
    dependencyIds: action.dependencyIds,
    ...(waitingOn.length
      ? {
          waitingOn: waitingOn.map((ref) => ref.title),
          blockedReason: unmetPrerequisiteReason(action.title, waitingOn)
        }
      : {}),
    splittable: action.splittable,
    setupMinutes: action.setupMinutes,
    schedulingMode: action.schedulingMode,
    ...(cadence ? { cadence } : {}),
    ...(availableFrom ? { availableFrom } : {}),
    ...(unavailableReason ? { unavailableReason } : {}),
    ...(personHold ? { waitingOnPeople: personHold.people.map((person) => person.name) } : {}),
    ...(action.deadlineAt ? { deadlineAt: new Date(action.deadlineAt) } : {}),
    ...(action.latestStartAt ? { latestStartAt: new Date(action.latestStartAt) } : {}),
    ...(action.lastWorkedAt ? { lastWorkedAt: new Date(action.lastWorkedAt) } : {}),
    ...(action.createdAt ? { createdAt: new Date(action.createdAt) } : {})
  };
}

/**
 * Cadence action ids covered by today's materialised routine steps — every `pending`/`doing`
 * `state.routineSteps` row (commitment-anchored preparation and a bedtime/wake step alike, since
 * made them one table) that carries a `cadenceActionId`. Feeds `hydrateAction`'s double-prompt
 * suppression (Feature B) — see the comment there for why `unavailableReason` alone is enough once an
 * id lands in this set. `state.routineSteps` here is always the already-derived list (`prepare` is only
 * ever called with `derivedState`, whose sleep-anchored rows came out of `deriveSleepRoutineSteps` this
 * same run), so this reflects today's actual materialisation, not stale wire input. A cadence-gated-out
 * step is never in that list at all (the sleep derivation drops it exactly as the commitment sync
 * already does), so nothing further needs reapplying here — unlike before this merge, when a sleep
 * instance's per-night inclusion lived nowhere but the derive functions' own local filtering.
 */
function cadenceCoveredActionIds(state: WireState, _now: Date): Set<string> {
  const covered = new Set<string>();
  for (const step of state.routineSteps)
    if ((step.status === "pending" || step.status === "doing") && step.cadenceActionId)
      covered.add(step.cadenceActionId);
  return covered;
}

/** The ranking facts of a cadence action, or nothing for any other scheduling mode. */
function cadenceOf(action: WireState["actions"][number]): ActionCadence | undefined {
  if (action.schedulingMode !== "cadence" || !action.recurrence) return undefined;
  const recurrence = action.recurrence;
  return {
    intervalDays: recurrence.intervalDays,
    timezone: recurrence.timezone,
    startDate: recurrence.startDate,
    ...(recurrence.lastCompletedLocalDate ? { lastCompletedLocalDate: recurrence.lastCompletedLocalDate } : {}),
    completionCount: recurrence.completionCount ?? 0,
    ...(recurrence.period ? { period: recurrence.period } : {}),
    ...(recurrence.targetOccurrences ? { targetOccurrences: recurrence.targetOccurrences } : {}),
    ...(recurrence.minSpacingDays !== undefined ? { minSpacingDays: recurrence.minSpacingDays } : {}),
    ...(recurrence.eligibleWeekdays ? { eligibleWeekdays: recurrence.eligibleWeekdays } : {}),
    ...(recurrence.completionLocalDates ? { completionLocalDates: recurrence.completionLocalDates } : {})
  };
}

/**
 * The engine-model recurrence rule carried onto a recurring action's synthesized per-occurrence
 * units, so `scheduling/adherence.ts` can measure a maintenance project's period (windows and
 * interval) without a second trip to the wire state. Mirrors the rule `deriveOccurrences` builds for
 * `resolveRecurrenceOccurrences`, plus the completion-accounting fields that function does not need.
 */
function recurrenceRuleOf(action: WireState["actions"][number]): ActionRecurrenceRule | undefined {
  if (!action.recurrence) return undefined;
  const recurrence = action.recurrence;
  return {
    id: recurrence.id,
    actionId: recurrence.actionId,
    timezone: recurrence.timezone,
    startDate: recurrence.startDate,
    ...(recurrence.endDate !== undefined ? { endDate: recurrence.endDate } : {}),
    intervalDays: recurrence.intervalDays,
    windows: recurrence.windows.map((window) => ({
      id: window.id,
      name: window.name,
      anchor: window.anchor,
      ...(window.startOffsetMinutes !== undefined ? { startOffsetMinutes: window.startOffsetMinutes } : {}),
      ...(window.endOffsetMinutes !== undefined ? { endOffsetMinutes: window.endOffsetMinutes } : {}),
      ...(window.localStartTime !== undefined ? { localStartTime: window.localStartTime } : {}),
      ...(window.localEndTime !== undefined ? { localEndTime: window.localEndTime } : {}),
      ...(window.fallback !== undefined ? { fallback: window.fallback } : {})
    })),
    ...(recurrence.completionMode !== undefined ? { completionMode: recurrence.completionMode } : {}),
    ...(recurrence.targetTotalMinutes !== undefined ? { targetTotalMinutes: recurrence.targetTotalMinutes } : {}),
    ...(recurrence.accumulatedMinutes !== undefined ? { accumulatedMinutes: recurrence.accumulatedMinutes } : {}),
    ...(recurrence.completedAt !== undefined ? { completedAt: new Date(recurrence.completedAt) } : {})
  };
}

/**
 * How long the sleep that ended at the recorded wake actually lasted, so the planner can tell a nap
 * from a night already slept. Undefined when no completed sleep lines up with that wake — and also
 * when one does but its recorded window is self-contradictory: a completed row whose start sits at
 * or after its own wake (observed live: a row rewritten mid-sleep kept `actualWakeAt` but lost
 * `actualStartAt`, leaving a `plannedStartAt` five hours *after* the wake) has an unknowable
 * duration. Clamping that negative span to 0 — as this used to — reported the night as a zero-minute
 * nap, which re-armed the missed bedtime and pinned a brand-new full sleep to the instant of
 * calculation at 4:47 am. Unknown must stay unknown.
 */
export function completedSleepMinutesEndingAt(plans: WireState["sleepPlans"], wokeAt: Date): number | undefined {
  const match = plans
    .filter(
      (plan) =>
        plan.status === "completed" &&
        plan.actualWakeAt &&
        Math.abs(new Date(plan.actualWakeAt).getTime() - wokeAt.getTime()) < 60_000
    )
    .sort((a, b) => new Date(b.actualWakeAt!).getTime() - new Date(a.actualWakeAt!).getTime())[0];
  if (!match) return undefined;
  const wake = new Date(match.actualWakeAt!).getTime();
  const start = new Date(match.actualStartAt ?? match.plannedStartAt).getTime();
  if (wake <= start) return undefined;
  return Math.round((wake - start) / 60_000);
}

function deriveSleepPlans(
  state: WireState,
  now: Date,
  commitments: FixedCommitment[],
  bedtimeRoutineMinutes: number,
  /** The recorded wake was too old to believe and has been withdrawn (`resolveFreshness`). */
  wakeStale: boolean
): SleepPlan[] {
  // Rows still live enough to gate replanning (`covering`/`keptNights`, below): sleeping, or a
  // manually overridden planned row. A `completed` row is historical fact, not something to plan
  // around — its own cycle id is deliberately left free for `planSleep`'s `isCompleted` rerouting
  // (a nap re-arming that cycle, "night identity") to claim, so it must never also appear in
  // `keptNights` (which would instead skip regenerating that cycle entirely, via `covering`).
  const kept = state.sleepPlans
    .filter((plan) => plan.status === "sleeping" || (plan.status === "planned" && plan.overridden))
    .map((plan): SleepPlan => ({
      id: plan.id,
      plannedStartAt: new Date(plan.actualStartAt ?? plan.plannedStartAt),
      plannedWakeAt: new Date(plan.plannedWakeAt),
      desiredMinutes: plan.desiredMinutes,
      allowedMinutes: plan.allowedMinutes,
      sleepDeficitMinutes: plan.sleepDeficitMinutes,
      anchorDeviationMinutes: plan.anchorDeviationMinutes,
      hardErrors: plan.hardErrors,
      explanation: plan.explanation,
      ...(plan.targetMinutes !== undefined ? { targetMinutes: plan.targetMinutes } : {}),
      ...(plan.minimumShortfallMinutes !== undefined ? { minimumShortfallMinutes: plan.minimumShortfallMinutes } : {}),
      ...(plan.replannedFromMissedStart !== undefined
        ? { replannedFromMissedStart: plan.replannedFromMissedStart }
        : {}),
      ...(plan.wakeConstraint
        ? {
            wakeConstraint: {
              commitmentId: plan.wakeConstraint.commitmentId,
              protectedStartAt: new Date(plan.wakeConstraint.protectedStartAt),
              ...(plan.wakeConstraint.title ? { title: plan.wakeConstraint.title } : {})
            }
          }
        : {})
    }));
  // A wake too old to believe is no wake: tonight is planned from the sleep preferences, from the wake they
  // would have given, with no awake limit against it. One never told
  // plans no night until it is, as before.
  if (!state.settings.lastWokeAt && !wakeStale) return kept;
  const recordedWake = state.settings.lastWokeAt ? new Date(state.settings.lastWokeAt) : undefined;
  const lastWokeAt = recordedWake ?? assumedWakeAt(now, state.settings.timezone, state.settings.preferredWakeTime);
  const lastSleepMinutes = recordedWake ? completedSleepMinutesEndingAt(state.sleepPlans, recordedWake) : undefined;
  const storedById = new Map(state.sleepPlans.map((plan) => [plan.id, plan]));
  const calculated = planSleep({
    now,
    timezone: state.settings.timezone,
    lastWokeAt,
    ...(recordedWake ? {} : { assumedWake: true }),
    preferences: state.settings,
    commitments,
    bedtimeRoutineMinutes,
    keptNights: kept.map((plan) => ({ id: plan.id, startsAt: plan.plannedStartAt, wakesAt: plan.plannedWakeAt })),
    // Both closures apply `deterministicUuid` to the raw cycle key and look up the stored row — a
    // stored id is already a uuid, so it can never be recovered from a row; only the fresh raw key
    // (built the same way `planSleep` builds it) can be hashed forward to find a match.
    answers: (rawKey) => {
      const stored = storedById.get(deterministicUuid(rawKey));
      return stored?.placementChoice ? { placementChoice: stored.placementChoice } : undefined;
    },
    isCompleted: (rawKey) => storedById.get(deterministicUuid(rawKey))?.status === "completed",
    ...(lastSleepMinutes !== undefined ? { lastSleepMinutes } : {})
  });
  return [
    ...kept,
    ...calculated
      .filter(
        (candidate) =>
          !kept.some((item) =>
            overlaps(item.plannedStartAt, item.plannedWakeAt, candidate.plannedStartAt, candidate.plannedWakeAt)
          )
      )
      .map((plan) => ({ ...plan, id: deterministicUuid(plan.id) }))
  ];
}

/** The persisted occurrence log as the engine model's own `ActionOccurrence[]` — Dates in, statuses as recorded. */
function toEngineOccurrences(occurrences: WireState["occurrences"]): ActionOccurrence[] {
  return occurrences.map((occurrence) => ({
    id: occurrence.id,
    actionId: occurrence.actionId,
    recurrenceRuleId: occurrence.recurrenceRuleId,
    windowId: occurrence.windowId,
    windowName: occurrence.windowName,
    localDate: occurrence.localDate,
    windowStartsAt: new Date(occurrence.windowStartsAt),
    windowEndsAt: new Date(occurrence.windowEndsAt),
    anchorSource: occurrence.anchorSource,
    status: occurrence.status,
    ...(occurrence.routineCovered !== undefined ? { routineCovered: occurrence.routineCovered } : {})
  }));
}

function deriveOccurrences(state: WireState, now: Date, horizonEnd: Date, sleepPlans: SleepPlan[]): ActionOccurrence[] {
  const existing = new Map(state.occurrences.map((item) => [item.id, item]));
  const timezone = state.settings.timezone;
  const localDate = (date: Date) => localDateFormat(timezone).format(date);
  const actualWakeAnchors = state.sleepPlans
    .filter((sleep) => sleep.actualWakeAt)
    .map((sleep) => {
      const actualWakeAt = new Date(sleep.actualWakeAt!);
      return {
        localDate: localDate(actualWakeAt),
        wakeLocalDate: localDate(actualWakeAt),
        sleepLocalDate: localDate(new Date(sleep.actualStartAt ?? sleep.plannedStartAt)),
        actualWakeAt,
        plannedWakeAt: new Date(sleep.plannedWakeAt),
        plannedSleepStartAt: new Date(sleep.actualStartAt ?? sleep.plannedStartAt)
      };
    });
  const anchors = [
    ...actualWakeAnchors,
    ...sleepPlans.map((sleep) => ({
      localDate: localDate(sleep.plannedWakeAt),
      wakeLocalDate: localDate(sleep.plannedWakeAt),
      sleepLocalDate: localDate(sleep.plannedStartAt),
      plannedWakeAt: sleep.plannedWakeAt,
      plannedSleepStartAt: sleep.plannedStartAt
    }))
  ];
  const covered = routineCoverage(state);
  const through = new Date(Math.min(horizonEnd.getTime(), now.getTime() + 14 * DAY));
  return state.actions
    .filter((action) => action.schedulingMode === "recurring" && action.recurrence)
    .flatMap((action) =>
      resolveRecurrenceOccurrences({
        rule: {
          id: action.recurrence!.id,
          actionId: action.recurrence!.actionId,
          timezone: action.recurrence!.timezone,
          startDate: action.recurrence!.startDate,
          ...(action.recurrence!.endDate !== undefined ? { endDate: action.recurrence!.endDate } : {}),
          intervalDays: action.recurrence!.intervalDays,
          ...(action.recurrence!.completedAt !== undefined
            ? { completedAt: new Date(action.recurrence!.completedAt) }
            : {}),
          windows: action.recurrence!.windows.map((window) => ({
            id: window.id,
            name: window.name,
            anchor: window.anchor,
            ...(window.startOffsetMinutes !== undefined ? { startOffsetMinutes: window.startOffsetMinutes } : {}),
            ...(window.endOffsetMinutes !== undefined ? { endOffsetMinutes: window.endOffsetMinutes } : {}),
            ...(window.localStartTime !== undefined ? { localStartTime: window.localStartTime } : {}),
            ...(window.localEndTime !== undefined ? { localEndTime: window.localEndTime } : {}),
            ...(window.fallback !== undefined ? { fallback: window.fallback } : {})
          }))
        },
        from: now,
        through,
        anchors,
        preferredWakeTime: state.settings.preferredWakeTime,
        statuses: Object.fromEntries([...existing].map(([id, value]) => [id, value.status]))
      }).map((occurrence) => (covered(occurrence) ? { ...occurrence, routineCovered: true } : occurrence))
    );
}

/**
 * Every recurring occurrence for the horizon, with its stored row's per-date facts folded in
 * a
 * `scheduleSource: "custom"` row's title, times, place, buffers, project, lateness, transport mode
 * and contact replace the rule's for that date, and every occurrence — custom or
 * not — resolves its own `trackedEndedAt` from the stored row and the live session, exactly as a
 * one-off commitment does.
 */
function deriveCommitmentRepeats(state: WireState, now: Date, horizonEnd: Date): FixedCommitment[] {
  const rules: CommitmentRecurrenceRule[] = (state.commitmentRecurrenceRules ?? []).map((rule) => ({
    id: rule.id,
    title: rule.title,
    timezone: rule.timezone,
    startDate: rule.startDate,
    repeat: rule.repeat,
    localStartTime: rule.localStartTime,
    localEndTime: rule.localEndTime,
    setupBeforeMinutes: rule.setupBeforeMinutes,
    transitionAfterMinutes: rule.transitionAfterMinutes,
    status: rule.status,
    ...(rule.endDate !== undefined ? { endDate: rule.endDate } : {}),
    ...(rule.location !== undefined ? { location: rule.location } : {}),
    ...(rule.locationId !== undefined ? { locationId: rule.locationId } : {}),
    ...(rule.presence !== undefined ? { presence: rule.presence } : {}),
    ...(rule.projectId !== undefined ? { projectId: rule.projectId } : {}),
    ...(rule.latenessMatters !== undefined ? { latenessMatters: rule.latenessMatters } : {}),
    ...(rule.transportMode !== undefined ? { transportMode: rule.transportMode } : {}),
    ...(rule.contactId !== undefined ? { contactId: rule.contactId } : {})
  }));
  // Keyed by the same deterministic id the persist upsert writes the row under (`plan-forecast-runtime.ts`),
  // so a generated occurrence's raw `ruleId:date` id has to be converted before the lookup.
  const storedById = new Map(state.commitments.filter((item) => item.recurrenceRuleId).map((item) => [item.id, item]));
  // Called for every generated occurrence, including the one extra local day scanned each side of the
  // horizon (`recurrence.ts`). `undefined` here means "nothing to fold in" — the generator drops an
  // extra-day occurrence in that case (so widening the scan alone can never surface an ordinary,
  // unmoved occurrence outside its usual window); an in-window occurrence with nothing to fold in is
  // kept regardless, using its plain rule-generated values.
  const overlay = (occurrence: FixedCommitment): FixedCommitment | undefined => {
    const row = storedById.get(deterministicUuid(occurrence.id));
    const custom = row?.scheduleSource === "custom";
    const trackedEndedAt = resolveTrackedEndedAt(
      row ?? { id: occurrence.id },
      custom ? new Date(row!.endsAt) : occurrence.endsAt,
      state,
      now
    );
    // "I'm free" rides on the stored row whether or not it is custom, like overtime: the rule is
    // untouched and only this date's occurrence carries the fact.
    const freedFrom = row?.freedFrom ? new Date(row.freedFrom) : undefined;
    if (!custom) {
      return trackedEndedAt || freedFrom
        ? { ...occurrence, ...(trackedEndedAt ? { trackedEndedAt } : {}), ...(freedFrom ? { freedFrom } : {}) }
        : undefined;
    }
    // Strip every overlaid field off the generated occurrence first, then re-add only what the row
    // actually carries — an omitted key (e.g. the row cleared its place) must clear the field, not
    // fall back to the rule's copy still sitting in `occurrence`.
    const {
      location: _location,
      locationId: _locationId,
      projectId: _projectId,
      latenessMatters: _latenessMatters,
      transportMode: _transportMode,
      contactId: _contactId,
      ...base
    } = occurrence;
    return {
      ...base,
      title: row!.title,
      startsAt: new Date(row!.startsAt),
      endsAt: new Date(row!.endsAt),
      setupBeforeMinutes: row!.setupBeforeMinutes,
      transitionAfterMinutes: row!.transitionAfterMinutes,
      ...(row!.location !== undefined ? { location: row!.location } : {}),
      ...(row!.locationId !== undefined ? { locationId: row!.locationId } : {}),
      ...(row!.projectId !== undefined ? { projectId: row!.projectId } : {}),
      ...(row!.latenessMatters !== undefined ? { latenessMatters: row!.latenessMatters } : {}),
      ...(row!.transportMode !== undefined ? { transportMode: row!.transportMode } : {}),
      ...(row!.contactId !== undefined ? { contactId: row!.contactId } : {}),
      ...(trackedEndedAt ? { trackedEndedAt } : {}),
      ...(freedFrom ? { freedFrom } : {})
    };
  };
  return rules
    .flatMap((rule) => resolveCommitmentRecurrenceRepeats({ rule, from: now, through: horizonEnd, overlay }))
    .map((occurrence) => ({ ...occurrence, id: deterministicUuid(occurrence.id) }));
}

/**
 * The commitments whose own hour is released to the live ranking: an `anchor` whose hour is running
 * with no engagement session against it, and any commitment the person has said they are free from
 * (`freedFrom <= now`, "I'm free"). The explicit statement wins over presence, an open session and
 * running late. It lapses by itself at the effective end, and the setup, journey and transition
 * stay protected like an anchor's.
 *
 * Only the active phase qualifies. Setup, the journey, the arrival margin and the transition are the
 * minutes of getting there and getting back, and every commitment consumes those whatever its
 * presence: an anchor frees the time spent *at* the thing, never the time spent reaching it. A
 * session targeting the commitment is the person saying the hour is taken up after all, which puts
 * the ordinary lockout back.
 *
 * An anchor `isRunningLate` does not free its window either: for a located commitment, arrival is
 * the only gate — before-phase steps being done does not put you physically at the place, so the
 * window stays shut until arrival is actually asserted (steps or no steps); for a place-less one,
 * with nowhere to arrive at, its own steps are the gate instead. The same "arrival wins" rule
 * `resolveProtectedCommitment` applies to the live directive's phase.
 */
function openAnchorsNow(
  commitments: FixedCommitment[],
  session: WireState["activeSession"],
  now: Date,
  routineSteps: RoutineStepStatus[],
  arrivedLocationId: string | null
): FixedCommitment[] {
  return commitments.filter(
    (item) =>
      item.startsAt <= now &&
      effectiveCommitmentEnd(item) > now &&
      (isFreedNow(item, now) ||
        (item.presence === "anchor" &&
          !(session?.targetType === "fixed_commitment" && session.targetId === item.id) &&
          !isRunningLate({ commitment: item, now, routineSteps, arrivedLocationId })))
  );
}

/**
 * The same commitments with the given anchors' own windows handed back, its buffers and legs still
 * protected. The surviving halves are separate zero-buffer entries rather than an edited commitment,
 * so `commitmentProtection` stays the single definition of what each one protects.
 */
function withAnchorWindowOpened(
  commitments: FixedCommitment[],
  anchorIds: ReadonlySet<string>,
  arrivalMarginMinutes: number
): FixedCommitment[] {
  return commitments.flatMap((commitment) => {
    if (!anchorIds.has(commitment.id)) return [commitment];
    // Read straight from the timeline (no arithmetic on the five buffered fields here — the
    // architecture test forbids it): `:after` starts at the effective end, mirroring `:before`'s own
    // comparison, so an anchor freed through tracked overtime is actually free for capacity and slots
    // too, not just for `recommend()`'s ranking.
    const timeline = commitmentTimeline(commitment, arrivalMarginMinutes);
    return [
      ...(timeline.setupStartsAt < timeline.startsAt
        ? [{ id: `${commitment.id}:before`, startsAt: timeline.setupStartsAt, endsAt: timeline.startsAt }]
        : []),
      ...(timeline.protectedUntil > timeline.effectiveEndsAt
        ? [{ id: `${commitment.id}:after`, startsAt: timeline.effectiveEndsAt, endsAt: timeline.protectedUntil }]
        : [])
    ];
  });
}

/**
 * A commitment's known overtime, as `FixedCommitment.trackedEndedAt` — the later of whatever the
 * portal already computed from a finished session (`state.commitments[].trackedEndedAt`, read
 * from the `sessions` table by `portal/server/persistence/postgres/readers/routine-read.ts`) and, while a session against this very
 * commitment is still open, the live instant itself. Absent when neither applies, which reproduces
 * every existing behaviour exactly.
 */
function resolveTrackedEndedAt(
  item: Pick<WireState["commitments"][number], "id" | "trackedEndedAt">,
  endsAt: Date,
  state: WireState,
  now: Date
): Date | undefined {
  const stored = item.trackedEndedAt ? new Date(item.trackedEndedAt) : undefined;
  // Only a session begun before the scheduled end is the commitment running long. One started after
  // it is the transition or the drive back being tracked ("Start tracking the transition"): counting
  // it would push the end to now, re-open a transition after it, and offer to track that again.
  const session = state.activeSession;
  const liveOvertime =
    session?.targetType === "fixed_commitment" &&
    session.targetId === item.id &&
    new Date(session.startedAt).getTime() < endsAt.getTime()
      ? now
      : undefined;
  if (stored && liveOvertime) return stored > liveOvertime ? stored : liveOvertime;
  return stored ?? liveOvertime;
}

/**
 * Commitments only — literal fixed commitments plus materialized recurring-commitment repeats. A
 * commitment's own routine steps no longer ride along here: the placer (`routine-placement.ts`)
 * places them against a timeline built from this list, and `stepRanges` turns that placement into
 * the protected ranges `withTravelLegs`/the projection/capacity read, appended by the caller once
 * placement has run.
 */
function protectedCommitments(state: WireState, commitmentRepeats: FixedCommitment[], now: Date): FixedCommitment[] {
  // A recurring commitment is represented here by a freshly regenerated occurrence (below), never by
  // its own materialised `state.commitments` row — that row exists only so a single date can carry a
  // per-occurrence override, and the rule regenerates it "confirmed" every run whether or not one was
  // cancelled. Without this, cancelling one occurrence changed nothing an engine run could see: the row's own status stayed
  // cancelled in the database (the persistence upsert never overwrites it), but every consumer of this
  // list — the day plan's commitment block, capacity, and the sleep planner's wake constraint — reads
  // only the regenerated occurrence, which knows nothing of the cancellation. A sleep window can be cut
  // to protect a commitment that no longer exists.
  const cancelledOccurrenceIds = new Set(
    state.commitments.filter((item) => item.recurrenceRuleId && item.status === "cancelled").map((item) => item.id)
  );
  return [
    ...state.commitments
      .filter((item) => item.status === "confirmed" && !item.recurrenceRuleId)
      .map((item) => ({
        id: item.id,
        title: item.title,
        status: item.status,
        startsAt: new Date(item.startsAt),
        endsAt: new Date(item.endsAt),
        ...(item.location !== undefined ? { location: item.location } : {}),
        // A remote commitment is at no place (`isRemoteCommitment`): `locationId` is dropped so
        // nothing downstream can read it as a requirement, while `preferredLocationId` rides along
        // for whatever wants the preference.
        ...(item.locationId !== undefined && item.attendance !== "remote" ? { locationId: item.locationId } : {}),
        ...(item.attendance !== undefined ? { attendance: item.attendance } : {}),
        // Read only by a `x@with` requirement: who this commitment is with.
        ...(item.contactId !== undefined ? { contactId: item.contactId } : {}),
        ...(item.preferredLocationId !== undefined ? { preferredLocationId: item.preferredLocationId } : {}),
        ...(item.presence !== undefined ? { presence: item.presence } : {}),
        ...(item.latenessMatters !== undefined ? { latenessMatters: item.latenessMatters } : {}),
        ...(item.transportMode !== undefined ? { transportMode: item.transportMode } : {}),
        setupBeforeMinutes: item.setupBeforeMinutes,
        transitionAfterMinutes: item.transitionAfterMinutes,
        ...(() => {
          const trackedEndedAt = resolveTrackedEndedAt(item, new Date(item.endsAt), state, now);
          return trackedEndedAt ? { trackedEndedAt } : {};
        })(),
        ...(item.freedFrom !== undefined ? { freedFrom: new Date(item.freedFrom) } : {})
      })),
    ...commitmentRepeats
      .filter((item) => !cancelledOccurrenceIds.has(item.id))
      .map((item) => ({ ...item, status: "confirmed" }))
  ];
}

/** `placeRoutineChains`'s flat output, keyed by step id for lookup. */
function placedStepMap(placed: PlacedStep[]): Map<string, PlacedStep> {
  return new Map(placed.map((item) => [item.stepId, item]));
}

/**
 * The `routine:<id>` / `sleep-routine:<id>` protected ranges a run's placement produces — the
 * The routine step timing design note "The placer" replacement for what `protectedCommitments` used
 * to append inline. A placed pending step protects its hands-on interval only (never its wait), and
 * carries the placer's own `earliestAt` as `flexibleLeadOpensAt` for the sleep planner; a `doing` or
 * `blocked` step protects its stored interval (a fact, not a placement); anything else (completed,
 * cancelled, skipped, or a pending step this run's chains never reached) protects nothing.
 */
function stepRanges(placed: Map<string, PlacedStep>, steps: WireState["routineSteps"]): FixedCommitment[] {
  return steps.flatMap((step): FixedCommitment[] => {
    const prefix = step.anchorType === "sleep_plan" ? "sleep-routine" : "routine";
    if (step.status === "pending") {
      const placement = placed.get(step.id);
      if (!placement?.placedStartAt || !placement.placedEndAt) return [];
      return [
        {
          id: `${prefix}:${step.id}`,
          title: step.title,
          startsAt: placement.placedStartAt,
          endsAt: placement.placedEndAt,
          ...(placement.earliestAt ? { flexibleLeadOpensAt: placement.earliestAt } : {})
        }
      ];
    }
    if ((step.status === "doing" || step.status === "blocked") && step.scheduledStartAt && step.scheduledEndAt)
      return [
        {
          id: `${prefix}:${step.id}`,
          title: step.title,
          startsAt: new Date(step.scheduledStartAt),
          endsAt: new Date(step.scheduledEndAt)
        }
      ];
    return [];
  });
}

/**
 * Every placed, pending, flexible commitment before-step, as the candidate `recommend()`'s early-step
 * ranking needs. The placer sets
 * `PlacedStep.earliestAt` only for exactly this shape, so filtering on its presence alone is exact —
 * no separate phase/timingRule check is needed on top of it.
 */
function buildOfferableSteps(steps: WireState["routineSteps"], placed: Map<string, PlacedStep>): EarlyStepCandidate[] {
  return steps.flatMap((step): EarlyStepCandidate[] => {
    if (step.status !== "pending" || !step.commitmentId) return [];
    const placement = placed.get(step.id);
    if (!placement?.earliestAt || !placement.placedStartAt) return [];
    return [
      {
        stepId: step.id,
        commitmentId: step.commitmentId,
        title: step.title,
        durationMinutes: step.durationMinutes,
        energy: step.energy,
        contexts: step.contexts,
        dependencyIds: step.dependencyIds,
        earliestAt: placement.earliestAt,
        placedStartAt: placement.placedStartAt,
        ...(placement.startBy ? { startBy: placement.startBy } : {})
      }
    ];
  });
}

/**
 * The response's `canDoNow`:
 * every offerable step (`isStepOfferableNow`, the same predicate `recommend()`'s own `earlyStep`
 * scores against, so the list and the ranking can never disagree about what counts), less the current
 * directive's own target, ordered by `placedStartAt`. While late for a commitment (`lateCommitmentId`),
 * narrowed to that commitment's own steps only.
 */
function buildCanDoNow(args: {
  offerableSteps: EarlyStepCandidate[];
  routineSteps: WireState["routineSteps"];
  commitments: readonly FixedCommitment[];
  arrivedLocationId: string | null;
  now: Date;
  excludeStepId?: string;
  lateCommitmentId?: string;
}): CanDoNowItem[] {
  const { offerableSteps, routineSteps, commitments, arrivedLocationId, now, excludeStepId, lateCommitmentId } = args;
  return offerableSteps
    .filter((step) => step.stepId !== excludeStepId)
    .filter((step) => !lateCommitmentId || step.commitmentId === lateCommitmentId)
    .filter((step) => isStepOfferableNow(step, now, routineSteps, arrivedLocationId, commitments))
    .map((step) => ({
      stepId: step.stepId,
      commitmentId: step.commitmentId,
      title: step.title,
      durationMinutes: step.durationMinutes,
      placedStartAt: step.placedStartAt.toISOString(),
      ...(step.startBy ? { startBy: step.startBy.toISOString() } : {})
    }))
    .sort((a, b) => a.placedStartAt.localeCompare(b.placedStartAt) || a.stepId.localeCompare(b.stepId));
}

/**
 * The response's `startByWarnings` (the routine step timing design note, "Warnings and arrival
 * projection"): every pending step this run placed with a `startBy`, `soon` from
 * `startBy − warningMinutes` and `missed` once `startBy` has passed, until the step leaves `pending`
 * (already excluded here, since only `pending` rows are considered) or its own anchor ends. Sorted by
 * `startBy`, tied by `stepId` so the output never depends on map iteration order (F7).
 */
function buildStartByWarnings(args: {
  routineSteps: WireState["routineSteps"];
  placed: Map<string, PlacedStep>;
  commitmentAnchors: readonly FixedCommitment[];
  sleepPlans: SleepPlan[];
  wakeCandidates: WakeCandidate[];
  arrivalMarginMinutes: number;
  warningMinutes: number;
  timezone: string;
  now: Date;
}): StartByWarning[] {
  const {
    routineSteps,
    placed,
    commitmentAnchors,
    sleepPlans,
    wakeCandidates,
    arrivalMarginMinutes,
    warningMinutes,
    timezone,
    now
  } = args;
  const commitmentAnchorById = new Map(
    commitmentAnchors.map((item) => [
      item.id,
      { title: item.title ?? "Commitment", endsAt: commitmentTimeline(item, arrivalMarginMinutes).effectiveEndsAt }
    ])
  );
  const bedtimeAnchorById = new Map(
    sleepPlans.map((plan) => [plan.id, { title: "Bedtime", endsAt: plan.plannedWakeAt }])
  );
  const wakeAnchorById = new Map(
    wakeCandidates.map((candidate) => [
      candidate.id,
      {
        title: "Wake-up",
        endsAt: zonedDateTime(addLocalDays(localDate(candidate.startsAt, timezone), 1), "00:00", timezone)
      }
    ])
  );

  const warnings: StartByWarning[] = [];
  for (const step of routineSteps) {
    if (step.status !== "pending") continue;
    const placement = placed.get(step.id);
    if (!placement?.startBy) continue;
    const startBy = placement.startBy;

    const anchor =
      step.anchorType === "sleep_plan"
        ? step.purpose === "wake"
          ? wakeAnchorById.get(placement.anchorId)
          : bedtimeAnchorById.get(placement.anchorId)
        : commitmentAnchorById.get(placement.anchorId);
    if (!anchor || now >= anchor.endsAt) continue;

    let status: "soon" | "missed" | undefined;
    if (now >= startBy) status = "missed";
    else if (now.getTime() >= startBy.getTime() - warningMinutes * MINUTE) status = "soon";
    if (!status) continue;

    warnings.push({
      stepId: step.id,
      anchorId: placement.anchorId,
      anchorTitle: anchor.title,
      title: step.title,
      startBy: startBy.toISOString(),
      status
    });
  }

  return warnings.sort((a, b) => {
    const byStartBy = a.startBy.localeCompare(b.startBy);
    return byStartBy !== 0 ? byStartBy : a.stepId.localeCompare(b.stepId);
  });
}

/**
 * The response's `stepPlacements`:
 * one entry per step this run's placer reached — a pending step's hands-on placement, or a
 * non-pending step's still-running wait — sorted by `stepId`.
 */
function buildStepPlacements(
  routineSteps: WireState["routineSteps"],
  placed: Map<string, PlacedStep>
): StepPlacementWire[] {
  const entries: StepPlacementWire[] = [];
  for (const step of routineSteps) {
    const placement = placed.get(step.id);
    if (!placement) continue;
    const anchorId = step.anchorId ?? step.commitmentId ?? placement.anchorId;
    entries.push({
      stepId: step.id,
      anchorKind: step.anchorType === "sleep_plan" ? "sleep_plan" : "commitment",
      anchorId,
      ...(placement.placedStartAt ? { placedStartAt: placement.placedStartAt.toISOString() } : {}),
      ...(placement.placedEndAt ? { placedEndAt: placement.placedEndAt.toISOString() } : {}),
      // Any step with a wait not yet over: from `placedEndAt` (pending) or `completedAt` (completed,
      // set on `placement.waitStartsAt` itself by the placer's own running-wait entry).
      ...(placement.waitStartsAt
        ? { waitStartsAt: placement.waitStartsAt.toISOString() }
        : placement.waitEndsAt && placement.placedEndAt
          ? { waitStartsAt: placement.placedEndAt.toISOString() }
          : {}),
      ...(placement.waitEndsAt ? { waitEndsAt: placement.waitEndsAt.toISOString() } : {}),
      ...(placement.startBy ? { startBy: placement.startBy.toISOString() } : {}),
      ...(placement.earliestAt ? { earliestAt: placement.earliestAt.toISOString() } : {}),
      ...(placement.bandId ? { bandId: placement.bandId } : {})
    });
  }
  return entries.sort((a, b) => a.stepId.localeCompare(b.stepId));
}

/**
 * The response's `softPlacements`: one interval per fitting
 * occurrence the cadence soft pass (`cadenceOutlook`) already counted — cosmetic room only, laid
 * into this week's own free planning slots, greedily and in the same pressure order the counts were
 * computed in, so the two can never disagree about how many occurrences a given action gets. A slot
 * already carrying scheduled work (`schedule.allocations`) offers only what capacity it has left.
 * Placement never touches `allocations`, ranking or the forecast — it only reads them.
 */
function buildSoftPlacements(
  schedule: PlanningResult,
  weekOutlook: WeekOutlook | null,
  actions: WireState["actions"],
  now: Date
): SoftPlacementWire[] {
  const cadenceActions = weekOutlook?.cadence?.actions ?? [];
  if (cadenceActions.length === 0) return [];
  const actionById = new Map(actions.map((action) => [action.id, action]));
  // A slot any allocation touched at all is left out of the merge below (its true remaining shape —
  // which end the used minutes sit at — is not recoverable from the totals alone), never merged past.
  const consumedSlotIds = new Set(schedule.allocations.map((allocation) => allocation.slotId));
  const untouchedFreeSlots = schedule.slots
    .filter(
      (slot) =>
        slot.availability === "free" && !consumedSlotIds.has(slot.id) && new Date(slot.endsAt).getTime() > now.getTime()
    )
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());

  // Merge contiguous untouched free slots (the detailed band's own quarter-hour grain) into runs of
  // open room wide enough to hold whole occurrences, clipped to start no earlier than `now`.
  const runs: { start: number; end: number }[] = [];
  for (const slot of untouchedFreeSlots) {
    const start = Math.max(new Date(slot.startsAt).getTime(), now.getTime());
    const end = new Date(slot.endsAt).getTime();
    if (end <= start) continue;
    const last = runs[runs.length - 1];
    if (last && last.end === new Date(slot.startsAt).getTime()) last.end = end;
    else runs.push({ start, end });
  }
  const cursorByRun = new Map(runs.map((run) => [run, run.start]));

  const results: SoftPlacementWire[] = [];
  for (const { actionId, fittingOccurrences } of cadenceActions) {
    const perOccurrenceMinutes = Math.max(1, actionById.get(actionId)?.expectedMinutes ?? 0);
    const durationMs = perOccurrenceMinutes * MINUTE;
    let remaining = fittingOccurrences;
    for (const run of runs) {
      if (remaining <= 0) break;
      let cursor = cursorByRun.get(run)!;
      while (remaining > 0 && cursor + durationMs <= run.end) {
        const startsAt = new Date(cursor);
        const endsAt = new Date(cursor + durationMs);
        results.push({
          actionId,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          minutes: perOccurrenceMinutes
        });
        cursor += durationMs;
        remaining -= 1;
      }
      cursorByRun.set(run, cursor);
    }
  }
  return results.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.actionId.localeCompare(b.actionId));
}

/** Every other commitment's protected window, read from the timeline (never the buffered fields
 *  directly — `test/architecture/commitment-edges.test.ts`), for the placer's band search to avoid. */
function commitmentProtectedRanges(
  commitments: readonly FixedCommitment[],
  arrivalMarginMinutes: number
): BlockedRange[] {
  return commitments.map((commitment) => {
    const timeline = commitmentTimeline(commitment, arrivalMarginMinutes);
    return { startsAt: timeline.setupStartsAt, endsAt: timeline.protectedUntil };
  });
}

/** A `doing`/`blocked` step's stored interval — a fact the placer must never place another step onto,
 *  whichever chain it belongs to. */
function doingOrBlockedIntervals(steps: WireState["routineSteps"]): BlockedRange[] {
  return steps.flatMap((step) =>
    (step.status === "doing" || step.status === "blocked") && step.scheduledStartAt && step.scheduledEndAt
      ? [{ startsAt: new Date(step.scheduledStartAt), endsAt: new Date(step.scheduledEndAt) }]
      : []
  );
}

/** One `WireState["routineSteps"]` row as the placer sees it — chain-agnostic, phase/status/timing
 *  untouched. */
function toPlacementStep(row: WireState["routineSteps"][number]): PlacementStep {
  return {
    id: row.id,
    sequence: row.sequence,
    durationMinutes: row.durationMinutes,
    status: row.status as PlacementStepStatus,
    phase: row.phase,
    timingRule: row.timingRule,
    ...(row.maxLeadMinutes !== undefined ? { maxLeadMinutes: row.maxLeadMinutes } : {}),
    ...(row.waitAfterMinutes !== undefined ? { waitAfterMinutes: row.waitAfterMinutes } : {}),
    ...(row.mustStartByMinutes !== undefined ? { mustStartByMinutes: row.mustStartByMinutes } : {}),
    ...(row.preferredBands !== undefined ? { preferredBands: row.preferredBands } : {}),
    dependencyIds: row.dependencyIds,
    contexts: row.contexts,
    ...(row.completedAt !== undefined ? { completedAt: new Date(row.completedAt) } : {}),
    ...(row.scheduledStartAt !== undefined ? { scheduledStartAt: new Date(row.scheduledStartAt) } : {}),
    ...(row.scheduledEndAt !== undefined ? { scheduledEndAt: new Date(row.scheduledEndAt) } : {}),
    ...(row.status === "skipped" ? { skip: true } : {})
  };
}

/** Every commitment's chain, built from its own timeline and its own routine steps only. */
function buildCommitmentChains(
  commitments: readonly FixedCommitment[],
  steps: WireState["routineSteps"],
  arrivalMarginMinutes: number
): CommitmentChain[] {
  const stepsByCommitment = new Map<string, WireState["routineSteps"][number][]>();
  for (const step of steps) {
    if (!step.commitmentId) continue;
    const list = stepsByCommitment.get(step.commitmentId) ?? [];
    list.push(step);
    stepsByCommitment.set(step.commitmentId, list);
  }
  return commitments.map((commitment) => ({
    kind: "commitment" as const,
    anchorId: commitment.id,
    timeline: commitmentTimeline(commitment, arrivalMarginMinutes),
    ...(commitment.locationId ? { locationId: commitment.locationId } : {}),
    steps: (stepsByCommitment.get(commitment.id) ?? []).map(toPlacementStep)
  }));
}

/** A tentative commitment as a bare timeline anchor — never travel-legged (`withTravelLegs` only
 *  ever runs against a protected, confirmed commitment), but still real enough for its own routine
 * steps to be derived and placed against (the routine step timing design note, Decisions "Row
 *  existence": "still has its steps derived and placed, from a timeline with no legs"). */
function rawTentativeCommitment(item: WireState["commitments"][number]): FixedCommitment {
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    startsAt: new Date(item.startsAt),
    endsAt: new Date(item.endsAt),
    ...(item.locationId !== undefined && item.attendance !== "remote" ? { locationId: item.locationId } : {}),
    ...(item.attendance !== undefined ? { attendance: item.attendance } : {}),
    ...(item.preferredLocationId !== undefined ? { preferredLocationId: item.preferredLocationId } : {}),
    ...(item.presence !== undefined ? { presence: item.presence } : {}),
    setupBeforeMinutes: item.setupBeforeMinutes,
    transitionAfterMinutes: item.transitionAfterMinutes
  };
}

/** Writes this run's placement onto every pending, non-skipped step; a locked or skipped row is
 *  returned exactly as derived (a locked row's stored times are a fact, and a skipped step is never
 * placed at all — the routine step timing design note, "The placer" point 1). */
function applyPlacement(rows: WireState["routineSteps"], placed: Map<string, PlacedStep>): WireState["routineSteps"] {
  return rows.map((row) => {
    if (row.status !== "pending") return row;
    const placement = placed.get(row.id);
    if (!placement?.placedStartAt || !placement.placedEndAt) return row;
    return {
      ...row,
      scheduledStartAt: placement.placedStartAt.toISOString(),
      scheduledEndAt: placement.placedEndAt.toISOString()
    };
  });
}

type RoutineSource = "inherit" | "preset" | "custom" | "none";

/** One candidate commitment for routine-step derivation — the fields `resolveRoutinePresetFor` and
 *  the candidate filter need, resolved once whether the commitment is a one-off or a repeat. */
interface RoutineCandidateCommitment {
  id: string;
  startsAt: Date;
  locationId?: string;
  routineSource: RoutineSource;
  routinePresetId?: string;
}

/**
 * Every commitment (one-off or regenerated repeat) whose routine steps this run derives —
 * The routine step timing design note "Which steps exist", conventions.md "Candidate commitments".
 * Not cancelled, starting after `now`, and not `routineSource: 'custom'`. A repeat's routine source
 * comes from its own materialised row when one exists (mirroring `deriveCommitmentRepeats`'
 * `storedById`), else its recurrence rule — the persist's `ruleRoutines` map does the same.
 */
function candidateRoutineCommitments(
  state: WireState,
  commitmentRepeats: FixedCommitment[],
  now: Date
): RoutineCandidateCommitment[] {
  const oneOffs: RoutineCandidateCommitment[] = state.commitments
    .filter((item) => !item.recurrenceRuleId && item.status !== "cancelled" && new Date(item.startsAt) > now)
    .map((item) => ({
      id: item.id,
      startsAt: new Date(item.startsAt),
      ...(item.locationId !== undefined ? { locationId: item.locationId } : {}),
      routineSource: item.routineSource ?? "inherit",
      ...(item.routinePresetId !== undefined ? { routinePresetId: item.routinePresetId } : {})
    }));
  const rulesById = new Map((state.commitmentRecurrenceRules ?? []).map((rule) => [rule.id, rule]));
  const storedById = new Map(state.commitments.filter((item) => item.recurrenceRuleId).map((item) => [item.id, item]));
  const cancelledOccurrenceIds = new Set(
    state.commitments.filter((item) => item.recurrenceRuleId && item.status === "cancelled").map((item) => item.id)
  );
  const repeats: RoutineCandidateCommitment[] = commitmentRepeats
    .filter((item) => !cancelledOccurrenceIds.has(item.id) && item.startsAt > now)
    .map((item) => {
      const rule = item.recurrenceRuleId ? rulesById.get(item.recurrenceRuleId) : undefined;
      const stored = storedById.get(item.id);
      const routineSource = stored?.routineSource ?? rule?.routineSource ?? "inherit";
      const routinePresetId = stored?.routinePresetId ?? rule?.routinePresetId;
      return {
        id: item.id,
        startsAt: item.startsAt,
        ...(item.locationId !== undefined ? { locationId: item.locationId } : {}),
        routineSource,
        ...(routinePresetId !== undefined ? { routinePresetId } : {})
      };
    });
  return [...oneOffs, ...repeats].filter((item) => item.routineSource !== "custom");
}

/** Mirrors `resolvedCommitmentRoutinePreset` above for a candidate whose routine source is already
 *  resolved to a plain value rather than read off a wire commitment row. */
function resolveRoutinePresetFor(
  candidate: RoutineCandidateCommitment,
  conditionDefinitions: WireState["conditionDefinitions"],
  presets: WireState["routinePresets"]
): WireState["routinePresets"][number] | undefined {
  const id =
    candidate.routineSource === "preset"
      ? candidate.routinePresetId
      : candidate.routineSource === "inherit"
        ? conditionDefinitions.find((item) => item.id === candidate.locationId && item.kind === "location")
            ?.defaultRoutinePresetId
        : undefined;
  return id ? presets.find((preset) => preset.id === id && preset.status === "active") : undefined;
}

/**
 * A resolved preset's steps as `planRoutineStepReconciliation`'s template — cadence-gated steps
 * dropped first (`cadenceStepIncludedToday`), then `dependencyPositions` resolves each remaining
 * step's `dependsOn` positions from the preset steps' own `dependencyIds`.
 */
function commitmentRoutineTemplate(
  preset: WireState["routinePresets"][number],
  actions: WireState["actions"],
  now: Date
): CommitmentRoutineStepInput[] {
  const steps = preset.steps
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .filter((step) => cadenceStepIncludedToday(step, actions, now));
  const orderedIds = steps.map((step) => step.id);
  const edges = steps.flatMap((step) =>
    step.dependencyIds.map((dependsOnId) => ({ step_id: step.id, depends_on_step_id: dependsOnId }))
  );
  const positions = dependencyPositions(orderedIds, edges);
  return steps.map((step, index) => ({
    title: step.title,
    durationMinutes: step.durationMinutes,
    timingRule: step.timingRule,
    maxLeadMinutes: step.maxLeadMinutes ?? null,
    energy: step.energy,
    phase: step.phase,
    contexts: step.contexts,
    actionWindowId: step.actionWindowId ?? null,
    cadenceActionId: step.cadenceActionId ?? null,
    presetStepId: step.id,
    dependsOn: positions[index] ?? [],
    waitAfterMinutes: step.waitAfterMinutes ?? 0,
    mustStartByMinutes: step.mustStartByMinutes ?? null,
    preferredBands: step.preferredBands ?? []
  }));
}

/** One commitment's stored routine steps as `planRoutineStepReconciliation`'s existing-row input. */
function commitmentExistingForPlan(rows: readonly WireState["routineSteps"][number][]): ExistingRoutineStepForPlan[] {
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    sequence: row.sequence,
    presetStepId: row.presetStepId ?? null,
    title: row.title,
    durationMinutes: row.durationMinutes,
    timingRule: row.timingRule,
    maxLeadMinutes: row.maxLeadMinutes ?? null,
    energy: row.energy,
    phase: row.phase,
    contexts: row.contexts,
    actionWindowId: row.actionWindowId ?? null,
    cadenceActionId: row.cadenceActionId ?? null,
    dependsOnIds: row.dependencyIds,
    waitAfterMinutes: row.waitAfterMinutes ?? 0,
    mustStartByMinutes: row.mustStartByMinutes ?? null,
    preferredBands: row.preferredBands ?? []
  }));
}

/** Turns a reconciliation plan's ops into the final row list, in final sequence order (the ops list
 *  already carries that order — deletes are appended last and dropped here). An `update`/`insert` row
 *  always lands `pending` (reconciliation only ever proposes those two ops for a pending template
 *  match or a brand-new step), carrying forward a matched row's own `completedAt` when it has one. */
function applyCommitmentRoutineReconciliation(
  plan: RoutineStepReconciliationPlan,
  existingRows: readonly WireState["routineSteps"][number][],
  commitmentId: string
): WireState["routineSteps"] {
  const existingById = new Map(existingRows.map((row) => [row.id, row]));
  const rows: WireState["routineSteps"] = [];
  for (const op of plan.ops) {
    if (op.kind === "delete") continue;
    if (op.kind === "keep") {
      const row = existingById.get(op.id);
      if (row) rows.push(row);
      continue;
    }
    if (op.kind === "reseq") {
      const row = existingById.get(op.id);
      if (row) rows.push({ ...row, sequence: op.sequence });
      continue;
    }
    const step = op.step;
    const existing = existingById.get(op.id);
    rows.push({
      id: op.id,
      commitmentId,
      anchorType: "commitment",
      anchorId: commitmentId,
      title: step.title,
      durationMinutes: step.durationMinutes,
      sequence: op.sequence,
      timingRule: step.timingRule,
      ...(step.maxLeadMinutes !== null && step.maxLeadMinutes !== undefined
        ? { maxLeadMinutes: step.maxLeadMinutes }
        : {}),
      energy: step.energy as WireState["routineSteps"][number]["energy"],
      contexts: step.contexts,
      dependencyIds: op.dependsOnIds,
      phase: step.phase,
      ...(step.actionWindowId ? { actionWindowId: step.actionWindowId } : {}),
      ...(step.cadenceActionId ? { cadenceActionId: step.cadenceActionId } : {}),
      ...(step.presetStepId ? { presetStepId: step.presetStepId } : {}),
      status: "pending",
      ...(existing?.completedAt ? { completedAt: existing.completedAt } : {}),
      ...(step.waitAfterMinutes !== undefined ? { waitAfterMinutes: step.waitAfterMinutes } : {}),
      ...(step.mustStartByMinutes !== null && step.mustStartByMinutes !== undefined
        ? { mustStartByMinutes: step.mustStartByMinutes }
        : {}),
      ...(step.preferredBands?.length ? { preferredBands: step.preferredBands } : {})
    });
  }
  return rows;
}

/**
 * Which commitment-anchored routine steps exist this run — the engine half of the design notes: the same reconciliation the persist runs,
 * moved unchanged into `platform/contracts` so both sides call one function. Replaces the whole
 * commitment-anchored part of `state.routineSteps`: a candidate with a resolved preset is
 * reconciled against it; a `none` candidate is reconciled against an empty template (only its
 * non-pending rows survive); a `custom` commitment, a non-candidate, or an `inherit`/`preset`
 * candidate with no resolvable preset passes its stored rows through unchanged.
 */
function deriveCommitmentRoutineSteps(
  state: WireState,
  commitmentRepeats: FixedCommitment[],
  now: Date
): WireState["routineSteps"] {
  const candidates = candidateRoutineCommitments(state, commitmentRepeats, now);
  const candidateById = new Map(candidates.map((item) => [item.id, item]));
  const existingByCommitment = new Map<string, WireState["routineSteps"][number][]>();
  for (const row of state.routineSteps) {
    if (!row.commitmentId) continue;
    const list = existingByCommitment.get(row.commitmentId) ?? [];
    list.push(row);
    existingByCommitment.set(row.commitmentId, list);
  }
  const commitmentIds = new Set([...candidateById.keys(), ...existingByCommitment.keys()]);
  const result: WireState["routineSteps"] = [];
  for (const commitmentId of commitmentIds) {
    const existingRows = existingByCommitment.get(commitmentId) ?? [];
    const candidate = candidateById.get(commitmentId);
    if (!candidate) {
      result.push(...existingRows);
      continue;
    }
    if (candidate.routineSource === "none") {
      const plan = planRoutineStepReconciliation(commitmentExistingForPlan(existingRows), [], () => "");
      result.push(...applyCommitmentRoutineReconciliation(plan, existingRows, commitmentId));
      continue;
    }
    const preset = resolveRoutinePresetFor(candidate, state.conditionDefinitions, state.routinePresets);
    if (!preset) {
      result.push(...existingRows);
      continue;
    }
    const template = commitmentRoutineTemplate(preset, state.actions, now);
    const plan = planRoutineStepReconciliation(commitmentExistingForPlan(existingRows), template, (templateIndex) =>
      deterministicUuid(`routine-step:${commitmentId}:${template[templateIndex]!.presetStepId}`)
    );
    result.push(...applyCommitmentRoutineReconciliation(plan, existingRows, commitmentId));
  }
  return result;
}

function resolveCapacity(state: WireState, now: Date, horizonEnd: Date) {
  return resolvePlanningCapacity({
    now,
    horizonEnd,
    usableFraction: state.settings.defaultUsableFraction,
    timezone: state.settings.timezone,
    // Capacity is every hour not spent asleep, so the window spans the whole local day and sleep is
    // subtracted as a commitment. Keying the day's start to the preferred wake time instead meant an
    // early rise bought no capacity at all: awake at 2am with nothing scheduled still read as zero
    // available minutes until 06:00. Nights past the planned run are assumed so a lengthening
    // horizon still cannot inflate capacity per day.
    dayStartTime: "00:00",
    dayEndTime: "00:00",
    recovery: recoverySetting(state)
  });
}

function recoverySetting(state: WireState) {
  const { recoveryStartTime, recoveryEndTime, recoveryWeekdays } = state.settings;
  if (!recoveryStartTime || !recoveryEndTime) return null;
  return {
    startTime: recoveryStartTime,
    endTime: recoveryEndTime,
    weekdays: recoveryWeekdays ?? [0, 1, 2, 3, 4, 5, 6],
    skippedDate: state.dailyPlan?.recoverySkipped ? state.dailyPlan.localDate : null,
    skippedDates: state.dailyPlan?.recoverySkippedDates ?? []
  };
}

/**
 * Sleep is only planned a week out, but forecasts run for months. Without a stand-in night beyond
 * that, full-day capacity would credit every distant project twenty-four usable hours a day. The
 * preferred window is what would be slept absent a constraint, so it is the honest assumption. A night
 * whose preferred window runs into a known commitment (a night shift on day ten) is placed by
 * `planSleep` instead, from the previous morning's wake, so the sleep fits around the commitment
 * (usually the daytime after a night shift) rather than a bed lying on top of it.
 */
export function assumedNightsBeyondPlans(
  state: WireState,
  sleepPlans: SleepPlan[],
  now: Date,
  horizonEnd: Date,
  commitments: FixedCommitment[] = []
): FixedCommitment[] {
  const { timezone, preferredBedtime, preferredWakeTime } = state.settings;
  if (!preferredBedtime || !preferredWakeTime) return [];
  const lastPlannedWake = sleepPlans.reduce(
    (latest, plan) => (plan.plannedWakeAt > latest ? plan.plannedWakeAt : latest),
    now
  );
  const blocked = protectedRanges(commitments, state.settings.arrivalMarginMinutes ?? 0);
  const nights: FixedCommitment[] = [];
  // Where the last emitted night ended: the next one chains from it and may not start before it.
  let lastEmittedEnd = lastPlannedWake;
  // The local date the next night is expected on if it directly follows the last emitted one.
  let expectedNextDate: string | null = null;
  const usedIds = new Set<string>();
  const maxAwakeMs = (state.settings.maxAwakeHours ?? Number.POSITIVE_INFINITY) * 60 * 60_000;
  let date = localDate(lastPlannedWake, timezone);
  for (let day = 0; day < 400; day += 1) {
    const startsAt = zonedDateTime(date, preferredBedtime, timezone);
    // A night may be moved earlier than its preferred bedtime, so only a bedtime well past the horizon
    // ends the run here; the placed night is checked against the horizon below.
    if (startsAt.getTime() >= horizonEnd.getTime() + 2 * DAY) break;
    // A bedtime at or after the wake time is an overnight span, so it wakes on the following date.
    const endsAt = zonedDateTime(
      preferredBedtime >= preferredWakeTime ? addLocalDays(date, 1) : date,
      preferredWakeTime,
      timezone
    );
    if (startsAt >= lastPlannedWake && endsAt > startsAt) {
      let night = { startsAt, endsAt };
      // A night that follows a moved one is chained from the real wake, so a bed moved early (daytime
      // sleep before a night shift) does not leave the next preferred bedtime past `maxAwakeHours`.
      const chained = expectedNextDate === date;
      const overAwake = chained && startsAt.getTime() - lastEmittedEnd.getTime() > maxAwakeMs;
      if (overAwake || blocked.some((range) => range.startsAt < endsAt && range.endsAt > startsAt)) {
        // The wake `planSleep` chains the night from: the previous assumed night's real wake when there
        // is one, else the stand-in morning before this night, so `now` for the planner is that wake
        // rather than the real now.
        const previousWake = chained
          ? lastEmittedEnd
          : new Date(
              Math.max(
                lastEmittedEnd.getTime(),
                zonedDateTime(addLocalDays(localDate(endsAt, timezone), -1), preferredWakeTime, timezone).getTime()
              )
            );
        const [placed] = planSleep({
          now: previousWake,
          timezone,
          lastWokeAt: previousWake,
          // A chained wake is the previous assumed night's real end, so the awake limit binds from it;
          // only the stand-in morning is a guess the limit must not act on.
          assumedWake: !chained,
          preferences: state.settings,
          commitments,
          nights: 1
        });
        // Take the placement only when it truly clears every commitment and stays near this night; a
        // wall of commitments (nothing fits) leaves the preferred window, as before.
        const placedStart = placed?.plannedStartAt ?? null;
        if (
          placed &&
          !placed.minimumShortfallMinutes &&
          placedStart &&
          placedStart >= lastEmittedEnd &&
          placed.plannedWakeAt > placedStart &&
          placed.plannedWakeAt.getTime() <= endsAt.getTime() + 0.75 * DAY &&
          !blocked.some((range) => range.startsAt < placed.plannedWakeAt && range.endsAt > placedStart)
        )
          night = { startsAt: placedStart, endsAt: placed.plannedWakeAt };
      }
      // The run stops at the first night that starts at or after the horizon, moved or not.
      if (night.startsAt >= horizonEnd) break;
      // Back-to-back placements can crowd the next preferred night; one bed never overlaps another.
      if (night.startsAt >= lastEmittedEnd) {
        const baseId = `assumed-sleep:${date}`;
        const id = usedIds.has(baseId) ? `${baseId}@${night.startsAt.toISOString()}` : baseId;
        usedIds.add(id);
        nights.push({ id, title: "Assumed sleep", ...night });
        lastEmittedEnd = night.endsAt;
        // Drive the loop from the placed night: a night moved ahead of a shift can start the day
        // before `date`, so the next candidate is the first date whose preferred bedtime is at or
        // after this night's wake, not simply `date + 1`. `lastEmittedEnd` rises on every emission
        // and the day cap bounds the loop, so a non-advancing iteration cannot spin.
        let next = localDate(night.endsAt, timezone);
        if (zonedDateTime(next, preferredBedtime, timezone) < night.endsAt) next = addLocalDays(next, 1);
        if (next <= date && night.startsAt.getTime() === startsAt.getTime()) next = addLocalDays(date, 1);
        expectedNextDate = next;
        date = next;
        continue;
      }
    }
    date = addLocalDays(date, 1);
  }
  return nights;
}

/**
 * The detailed band read as a week. Reserved minutes come from the exact allocations, which all
 * fall inside that band; areas are reached through outcome, and reported only as a stewardship
 * signal. Under-paced means Behind or At risk *and* holding less of this week than its required
 * weekly pace — a healthy project whose reservation sits later is not a shortfall.
 */
function buildWeekOutlook(state: WireState, schedule: PlanningResult, now: Date): WeekOutlook | null {
  const detailed = schedule.capacityEnvelopes.find((envelope) => envelope.kind === "detailed");
  if (!detailed) return null;
  const cadence = cadenceOutlook(state, now, detailed.freeMinutes);
  const reservedByProject = new Map<string, number>();
  for (const block of schedule.allocations)
    reservedByProject.set(block.projectId, (reservedByProject.get(block.projectId) ?? 0) + block.minutes);
  const areaOfProject = new Map(
    state.projects.map((project) => [
      project.id,
      state.outcomes.find((outcome) => outcome.id === project.outcomeId)?.areaId ?? null
    ])
  );
  const projects: WeekOutlookProject[] = schedule.forecasts
    .map((forecast) => {
      const reservedMinutes = Math.round(reservedByProject.get(forecast.projectId) ?? 0);
      const required = forecast.requiredPaceMinutesPerWeek;
      return {
        projectId: forecast.projectId,
        reservedMinutes,
        requiredPaceMinutesPerWeek: required,
        paceShortfallMinutes: required === null ? 0 : Math.max(0, required - reservedMinutes),
        health: forecast.health
      };
    })
    .sort((a, b) => b.paceShortfallMinutes - a.paceShortfallMinutes || a.projectId.localeCompare(b.projectId));
  const areas = new Map<string, number>();
  for (const project of projects) {
    const areaId = areaOfProject.get(project.projectId);
    if (!areaId || !project.reservedMinutes) continue;
    areas.set(areaId, (areas.get(areaId) ?? 0) + project.reservedMinutes);
  }
  return {
    startsAt: detailed.startsAt,
    endsAt: detailed.endsAt,
    capacityMinutes: Math.round(detailed.adjustedCapacityMinutes),
    reservedMinutes: Math.round(detailed.reservedMinutes),
    freeMinutes: Math.round(detailed.freeMinutes),
    projects,
    underPacedProjectIds: projects
      .filter(
        (project) => project.paceShortfallMinutes > 0 && (project.health === "behind" || project.health === "at_risk")
      )
      .map((project) => project.projectId),
    areas: [...areas]
      .map(([areaId, reservedMinutes]) => ({ areaId, reservedMinutes }))
      .sort((a, b) => b.reservedMinutes - a.reservedMinutes || a.areaId.localeCompare(b.areaId)),
    ...(cadence ? { cadence } : {})
  };
}

/**
 * A cadence never reserves capacity in the forecast itself, so the outlook states what a week of it
 * would want, names what is already due, and — the soft pass — how much of that expected
 * demand this week's own free minutes could actually hold, without ever touching the forecast's own
 * numbers: `weekFreeMinutes` is `WeekOutlook.freeMinutes` itself, already final by the time this
 * runs (every deadline project's own reservation is done), and this function only reads it, never
 * writes back to it or to any project's forecast. Absent when there is no active cadence action, so
 * the outlook's shape does not change for anyone who has none.
 */
function cadenceOutlook(state: WireState, now: Date, weekFreeMinutes: number): WeekOutlook["cadence"] | undefined {
  const active = state.actions.flatMap((action) => {
    const cadence = cadenceOf(action);
    const live = action.status === "planned" || action.status === "active" || action.status === "doing";
    return cadence && live && !action.recurrence?.completedAt ? [{ action, cadence }] : [];
  });
  if (!active.length) return undefined;
  const demandMinutesPerWeek = Math.round(
    active.reduce(
      (sum, { action, cadence }) => sum + action.expectedMinutes * 7 * cadenceOccurrencesPerDay(cadence, now),
      0
    )
  );
  const due = active
    .filter(({ cadence }) => cadenceDueLocalDate(cadence, now) <= localDate(now, cadence.timezone))
    .map(({ action, cadence }) => ({
      actionId: action.id,
      dueLocalDate: cadenceDueLocalDate(cadence, now),
      daysOverdue: cadenceDaysOverdue(cadence, now)
    }))
    .sort((a, b) => b.daysOverdue - a.daysOverdue || a.actionId.localeCompare(b.actionId));
  // Soft pass: greedy, most-pressing cadence first (the same order `due` itself ranks by), against a
  // running copy of this week's free minutes — never the real ledger, so nothing here can change any
  // project's margin, health, latest safe start or allocations (invariant 8). A cadence action with
  // no real per-occurrence cost (an estimate of 0) is treated as fitting outright rather than divided
  // by zero.
  const pressureOrder = [...active].sort(
    (a, b) =>
      cadenceDaysOverdue(b.cadence, now) - cadenceDaysOverdue(a.cadence, now) || a.action.id.localeCompare(b.action.id)
  );
  let remainingBudget = Math.max(0, weekFreeMinutes);
  let softReservedMinutes = 0;
  const actions = pressureOrder.map(({ action, cadence }) => {
    const expectedOccurrences = Math.max(0, Math.round(cadenceOccurrencesPerDay(cadence, now) * 7));
    const perOccurrenceMinutes = Math.max(0, action.expectedMinutes);
    const affordable =
      perOccurrenceMinutes > 0 ? Math.floor(remainingBudget / perOccurrenceMinutes) : expectedOccurrences;
    const fittingOccurrences = Math.min(expectedOccurrences, Math.max(0, affordable));
    remainingBudget -= fittingOccurrences * perOccurrenceMinutes;
    softReservedMinutes += fittingOccurrences * perOccurrenceMinutes;
    return { actionId: action.id, expectedOccurrences, fittingOccurrences };
  });
  return { demandMinutesPerWeek, due, softReservedMinutes, actions };
}

const UPCOMING_LIMIT = 3;

/**
 * What comes next after the current directive, in the same order the directive itself was chosen
 * from: remaining steps in a routine's sequence, or the next-best actions from the plan's ranking. A
 * commitment-anchored routine groups by `commitmentId`; a sleep-anchored one (bedtime/wake)
 * groups by `(anchorId, purpose)` instead, via the `sameRoutine` helper below — both are just
 * `state.routineSteps` rows since the merge.
 */
function selectUpcomingDirectives(
  /**
   * Every commitment presently in force — literal fixed commitments plus materialized
   * recurring-commitment repeats, the same list built by `protectedCommitments()`. Finding 18:
   * this used to read `state.commitments` directly for "what happens next after wake", which misses
   * a recurring commitment's repeat entirely — its id is never in `state.commitments` — so a
   * recurring commitment starting the next morning never appeared in the "up next" strip while asleep.
   */
  commitments: FixedCommitment[],
  state: WireState,
  sleepPlans: SleepPlan[],
  currentDirective: CurrentDirective,
  recommendation: ReturnType<typeof recommend>
): UpcomingDirective[] {
  if (currentDirective.kind === "routine_step") {
    const current = state.routineSteps.find((item) => item.id === currentDirective.targetId);
    // Covers both anchors: a commitment's own preparation groups by `commitmentId`; a
    // bedtime/wake step has none, and groups by `(anchorId, purpose)` instead — without this, every
    // sleep-anchored step (a different night, or the other purpose) would look like the same routine's
    // sibling, since they all alike carry `commitmentId === undefined`.
    const sameRoutine = (item: WireState["routineSteps"][number], other: WireState["routineSteps"][number]): boolean =>
      other.commitmentId !== undefined
        ? item.commitmentId === other.commitmentId
        : item.commitmentId === undefined && item.anchorId === other.anchorId && item.purpose === other.purpose;
    if (current) {
      return state.routineSteps
        .filter((item) => sameRoutine(item, current) && item.status === "pending" && item.sequence > current.sequence)
        .sort((a, b) => a.sequence - b.sequence)
        .slice(0, UPCOMING_LIMIT)
        .map((step) => ({
          kind: "routine_step" as const,
          targetId: step.id,
          title: step.title,
          recommendedMinutes: step.durationMinutes
        }));
    }
  }
  if (currentDirective.kind === "sleep") {
    const sleep = sleepPlans.find((item) => item.id === currentDirective.targetId);
    const wakeAt = sleep ? sleep.plannedWakeAt : null;
    if (wakeAt) {
      // The plan's ranked actions are never eligible while asleep, so "up next" during sleep instead
      // looks past the wake time to what actually happens next: a scheduled morning routine step, or
      // the next confirmed commitment.
      const morningSteps = state.routineSteps
        .filter(
          (item) => item.status === "pending" && item.scheduledStartAt && new Date(item.scheduledStartAt) >= wakeAt
        )
        .map((step) => ({
          kind: "routine_step" as const,
          targetId: step.id,
          title: step.title,
          recommendedMinutes: step.durationMinutes,
          at: new Date(step.scheduledStartAt!)
        }));
      const nextCommitment = commitments
        .filter((item) => item.status === "confirmed" && item.startsAt > wakeAt)
        .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())[0];
      const commitmentItem = nextCommitment
        ? [
            {
              kind: "commitment" as const,
              targetId: nextCommitment.id,
              title: nextCommitment.title ?? "Commitment",
              recommendedMinutes: Math.max(
                1,
                Math.round((nextCommitment.endsAt.getTime() - nextCommitment.startsAt.getTime()) / MINUTE)
              ),
              at: nextCommitment.startsAt
            }
          ]
        : [];
      const merged = [...morningSteps, ...commitmentItem]
        .sort((a, b) => a.at.getTime() - b.at.getTime())
        .slice(0, UPCOMING_LIMIT);
      // Past the wake time an item can be days out, so each carries the instant it starts: without it
      // the strip has nothing to say which day it belongs to and reads as the morning just ahead.
      if (merged.length) return merged.map(({ at, ...item }) => ({ ...item, at: at.toISOString() }));
    }
  }
  // Action, recovery, and none directives draw their "next" from the plan's ranking — recovery/none
  // show what the plan would recommend once the current directive clears.
  return recommendation.alternatives.slice(0, UPCOMING_LIMIT).map((candidate) => ({
    kind: "action" as const,
    targetId: candidate.action.id,
    title: candidate.action.title,
    recommendedMinutes: candidate.recommendedMinutes ?? 0
  }));
}

/**
 * The state with every stale fact withdrawn, or the request itself when none is stale (so a fresh
 * request is byte-identical to what it was before freshness existed). Energy is not withdrawn here:
 * it is required on the wire and the engine reads it in two places, each of which checks freshness.
 */
function withoutStaleFacts(request: PlanForecastRequest, freshness: Freshness): PlanForecastRequest {
  if (!freshness.wake.stale && !freshness.session.stale) return request;
  const { lastWokeAt: _lastWokeAt, ...settings } = request.state.settings;
  return {
    ...request,
    state: {
      ...request.state,
      ...(freshness.wake.stale ? { settings } : {}),
      ...(freshness.session.stale ? { activeSession: null } : {})
    }
  };
}

/**
 * What a session left open past its end puts in place of a directive: the question of when it stopped.
 * Starting anything else is refused while a session is open, so recommending other work would offer a
 * start that fails; and closing it as assumed would record a guessed end. The answer settles it.
 */
function openSessionQuestion(
  session: NonNullable<WireState["activeSession"]>,
  actions: WireState["actions"],
  now: Date
): Extract<CurrentDirective, { kind: "answer" }> {
  return {
    kind: "answer",
    title: `${openSessionTitle(session, actions)} is still open`,
    recommendedMinutes: 0,
    question: sessionEndQuestion(session, now),
    contextIds: [],
    candidate: null
  };
}

/**
 * A result stays valid until something can actually change the decision: a slot edge, a commitment,
 * a sleep boundary, a latest safe start, or the daily horizon. A fixed short cap instead produced a
 * permanent recalculation treadmill and made a brief worker outage look like an expired plan.
 */
function nextValidityBoundary(
  /**
   * Every commitment presently in force — literal fixed commitments plus materialized
   * recurring-commitment repeats, the same list built by `protectedCommitments()`. Finding 18:
   * reading `state.commitments` directly missed a recurring commitment's repeat entirely (its id
   * is never in `state.commitments`), so its start/end never bounded how long a cached plan stayed
   * valid — a stale plan could be served straight through a recurring commitment's boundary.
   */
  commitments: FixedCommitment[],
  now: Date,
  sleepPlans: SleepPlan[],
  schedule: PlanningResult,
  dailyHorizon: Date,
  /** The soonest a fact the plan reads goes stale (`resolveFreshness`): the plan must not outlive it. */
  staleAt?: Date,
  /**
   * The prepared planning actions. An action's `availableFrom` (a cadence cycle, an explicit start, or
   * a recurring occurrence's window opening) and a recurring occurrence's window end change what can
   * be recommended, so each is an edge the plan must not be served across (F1-03).
   */
  actions: readonly Action[] = []
): Date {
  const ceiling = new Date(now.getTime() + MAX_VALIDITY_MINUTES * MINUTE);
  const candidates = [
    ceiling,
    dailyHorizon,
    ...(staleAt ? [staleAt] : []),
    ...commitments.filter((item) => item.status !== "cancelled").flatMap((item) => [item.startsAt, item.endsAt]),
    ...sleepPlans.flatMap((item) => [item.plannedStartAt, item.plannedWakeAt]),
    ...actions.flatMap((item) => [
      ...(item.availableFrom ? [item.availableFrom] : []),
      ...(item.occurrenceId && item.deadlineAt ? [item.deadlineAt] : [])
    ]),
    ...capacityTransitions(schedule),
    ...schedule.forecasts.flatMap((forecast) =>
      Object.values(forecast.latestSafeStarts).filter((date): date is Date => date instanceof Date)
    )
  ].filter((date) => date > now);
  return new Date(Math.min(...candidates.map((date) => date.getTime()), ceiling.getTime()));
}

function activeFocusProjectIds(state: WireState, now: Date): string[] {
  const date = localDateFormat(state.settings.timezone).format(now);
  return [
    ...new Set(
      state.planningFocus
        .filter((focus) => focus.periodStart <= date && date <= focus.periodEnd)
        .flatMap((focus) => focus.projectIds)
    )
  ];
}

/**
 * Daily protection projected into the envelope bands: the share of an average day that routine steps
 * take out of ordinary work, spread across the week they repeat over.
 *
 * Sleep is excluded because it is already subtracted as a commitment — automatic capacity now spans
 * the whole local day, with planned nights and assumed nights beyond them removed from it, so
 * counting sleep again here would take the night out twice.
 */
function projectedDailyProtectionMinutes(state: WireState) {
  // Commitment-anchored only: before this plan, `state.routineSteps` never carried a bedtime/wake step
  // at all (those lived in the now-dropped `routineInstances`), so this sum was implicitly
  // commitment-only. merged the two tables; filtering here preserves the pre-existing capacity
  // envelope rather than silently widening it with sleep-routine minutes no prior calibration accounted
  // for — a storage migration changing a forecast number is its own decision, not this one's to make.
  const routineMinutes = state.routineSteps
    .filter((step) => step.anchorType !== "sleep_plan" && step.status !== "completed" && step.status !== "cancelled")
    .reduce((sum, step) => sum + step.durationMinutes, 0);
  return Math.ceil(routineMinutes / 7);
}

/**
 * Whether an occurrence is already somebody's job — a routine step (commitment-anchored preparation or
 * a bedtime/wake step alike) names a window instead of an occurrence, and stands in for that
 * window's occurrence on the day the step is placed — by day rather than by overlapping minutes,
 * because brushing your teeth before work is the morning brush whether or not those ten minutes happen
 * to land inside the window's own hours. A step already completed or cancelled stops covering: what it
 * stood in for was closed with it, and anything still open is the day's own business again.
 *
 * Before this merge, a bedtime/wake instance named the exact occurrences it swallowed
 * (`occurrenceIds`, computed by overlap) as a second, separate covering mechanism; now that a
 * sleep-anchored step is a `routine_steps` row carrying its own `actionWindowId`, the one day-based
 * rule below already covers it — nothing else is needed (the plan's own "a row's `actionWindowId` is
 * the link" decision, made concrete).
 */
function routineCoverage(state: WireState) {
  const stepDays = new Set(
    state.routineSteps
      .filter(
        (step) => step.actionWindowId && step.scheduledStartAt && !["completed", "cancelled"].includes(step.status)
      )
      .map((step) => `${step.actionWindowId}:${localDate(new Date(step.scheduledStartAt!), state.settings.timezone)}`)
  );
  return (occurrence: { id: string; windowId: string; localDate: string }) =>
    stepDays.has(`${occurrence.windowId}:${occurrence.localDate}`);
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) {
  return aStart < bEnd && aEnd > bStart;
}
function toJson<T>(value: T): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
function toJsonArray<T>(value: T[]): JsonValue[] {
  return JSON.parse(JSON.stringify(value)) as JsonValue[];
}
