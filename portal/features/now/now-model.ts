import { isClosedStatus } from "@openrhen/contracts";
import {
  buildNeeds,
  buildRecommendationAnswer,
  buildEnergyCostAnswer,
  buildStretchAnswer,
  resolveLocale,
  resolveNowActivity,
  type CanDoNowItem,
  type CurrentDirective,
  type Need,
  type NowActivityResolution,
  type PrepPace,
  type Pulse,
  type RecommendationAnswer,
  type StartByWarning,
  type StayUpOffer,
  type StretchBlock,
  type StretchOfferAnswer,
  type EnergyCostAnswer
} from "@openrhen/contracts";
import { assessDeliverable } from "@openrhen/contracts/readiness";
import type {
  ActiveSession,
  PortalState,
  StoredAction,
  StoredCommitment,
  StoredDeliverable,
  StoredRoutineStep,
  StoredSleepPlan
} from "@/state/portal-state";
import type {
  ClientCandidate,
  ClientContinuation,
  ClientForecast,
  ClientRecommendation,
  PortalContextValue
} from "@/state/portal-provider";
import type { PlanHealth } from "@/features/planning/planning-runtime";
import { localClockMinutes } from "./now-formatting";
import { nextExecutableStepId } from "@/features/deliverables/deliverable-model";

/**
 * The Now page's derived reading of portal state.
 *
 * Everything the page used to compute inline between its hooks and its first branch lives here, in
 * the same order and with the same rules, so the panels below receive decided values rather than
 * re-deciding them. The engine's own conclusions — `scheduledStartAt`, `currentDirective`,
 * `needsAnswer`, `reachable` — are read, never recomputed.
 *
 * What is on the clock — the protected commitment, the routine step, the due sleep, the leg — is not
 * decided here either. `planning/now-activity.ts` in contracts decides it once for every surface that asks, and the
 * handheld device (`server/device/device-now.ts`) reads the same answer; this model maps it onto the
 * page's own view fields and adds the Now-page-only material around it (sleep affordances, answer
 * options, the directed deliverable, candidate lists).
 */
export type NowRecommendation = ClientRecommendation;
export type NowCandidate = ClientCandidate;
export type NowForecast = ClientForecast;
export type NowContinuation = ClientContinuation | null;
export type NowProtectedCommitment = NonNullable<ClientRecommendation["protectedCommitment"]>;
export type NowOpenAnchor = NonNullable<ClientRecommendation["openAnchor"]>;
export type SaveEntityCommand = PortalContextValue["saveEntityCommand"];
export type RunActivityCommand = PortalContextValue["runActivityCommand"];
export type FinishSession = PortalContextValue["finishSession"];
export type StartAlternative = PortalContextValue["startAlternative"];
export type BlockRecommended = PortalContextValue["blockRecommended"];
export type UpcomingDirectives = PortalContextValue["upcomingDirectives"];

export type DeliverableDirective = Extract<CurrentDirective, { kind: "deliverable" }>;
export type AnswerDirective = Extract<CurrentDirective, { kind: "answer" }>;
export type BoundaryDirective = Extract<CurrentDirective, { kind: "boundary" }>;
export type TravelDirective = Extract<CurrentDirective, { kind: "travel" }>;

/**
 * One way of answering the question an `answer` directive carries, mapped onto the situation model:
 * a location is asserted, a portable capability is carried or not, and anything else is overridden.
 * Unknown contexts (archived, or defined since the plan ran) still get a row so the question is never
 * shown without a way to answer it, but they can only be overridden.
 */
export interface AnswerOption {
  contextId: string;
  name: string;
  kind: "location" | "carrying" | "override";
}

/** The next thing that would fit, as an `answer` or `boundary` directive names it. */
export type NextFitTarget = NonNullable<AnswerDirective["candidate"]>;
/**
 * The deliverable the engine is directing attention to, with the step Start should open on. The
 * engine names only the deliverable; the step is the first executable one in the accepted plan, read
 * through the same readiness assessment the workspace and projection use. Null before Breakdown or
 * when nothing is executable, in which case the session opens with no step and the workspace says so.
 */
export type DirectedDeliverable = StoredDeliverable & { startStepId: string | null };

/**
 * The shortest top-up worth offering as a nap. Below this the arithmetic is real but the rest is
 * not one anyone would set an alarm for, so the panel asks for a duration instead of pre-filling a
 * four-minute nap.
 */
const NAP_TOP_UP_FLOOR_MINUTES = 10;

/** An optional change to tonight's sleep, offered against the last recent completed sleep. */
export interface SleepSuggestion {
  kind: "catchup" | "nap";
  minutes: number;
  addedMinutes: number;
  wakeAtIso: string;
}

export interface NowModelInput {
  state: PortalState;
  recommendation: NowRecommendation;
  forecasts: NowForecast[];
  currentDirective: CurrentDirective | null;
  now: Date;
  /**
   * Server clock minus this browser's, from the last status poll (`PortalContextValue.serverClockOffsetMs`).
   * Plan validity is the server's judgement, so it is compared against the server's clock; absent is 0.
   */
  serverClockOffsetMs?: number;
  /** True while an early bedtime has been chosen by hand for the upcoming sleep plan. */
  manualBedtime: boolean;
  /**
   * The freshest `lastSuccessfulAt` any status poll on this tab has seen — from
   * `PortalContextValue.knownLatestSuccessfulAt`, which can be ahead of `state.planning.lastSuccessfulAt`
   * for as long as this tab has not yet reloaded that run. Undefined/null is read as "no fresher run
   * known", not as staleness — a tab that has not polled yet must not read as behind.
   */
  knownLatestSuccessfulAt?: string | null | undefined;
}

export interface NowModel {
  timezone: string;
  planningDecisionCurrent: boolean;
  /**
   * True while a status poll has already seen a `lastSuccessfulAt` newer than the plan this model was
   * built from — the server has moved on and a reload is expected imminently. Distinct from "not
   * current": that plan may simply be expired or missing, this one is known-superseded and about to be
   * replaced. A backgrounded tab kept showing a superseded sleep plan (a naive
   * 6:00 am wake) well after the server had already replanned around a 6:37 am commitment.
   */
  planningRefreshing: boolean;
  session: ActiveSession | null;
  sessionAction: StoredAction | undefined;
  primary: NowCandidate | null;
  situationLocation: PortalState["conditionDefinitions"][number] | undefined;
  situationLocationTrusted: boolean;
  needsAnswer: NowCandidate[];
  reachable: NowCandidate[];
  /** Reachable work the engine costed a journey for and ranked below whatever leads. */
  worthTheTrip: NowCandidate[];
  /** Blocked only by being elsewhere, with no journey the engine will direct at this moment. */
  notWorthTheTrip: NowCandidate[];
  forecast: NowForecast | undefined;
  secondsRemaining: number;
  sessionCheckpointReached: boolean;
  /**
   * True once a running deliverable session's trail holds three or more consecutive unanswered
   * check-ins — see the session reconciliation design note, "When the Now page switches to
   * reconciliation." Never true for a paused session: "A paused session accrues nothing after its
   * pause; its end is the pause, already recorded," so reconciliation has nothing to propose.
   * Derived at read time from `session.unansweredCheckIns`; no column, so it never needs healing
   * when an answer arrives.
   */
  reconciliationDue: boolean;
  plannedStart: Date;
  plannedEnd: Date;
  /**
   * The engine's answer beyond the directive, from the same builder `rhen status` reads
   * (`planning/recommendation-answer.ts` in contracts), so the page and an agent cannot disagree.
   */
  recommendationAnswer: RecommendationAnswer;
  plannedDuration: number;
  nextCommitment: StoredCommitment | undefined;
  protectedCommitment: NowProtectedCommitment | undefined;
  storedProtectedCommitment: StoredCommitment | undefined;
  /** The anchor you are at with the hour still your own; the suggestions below it are for that hour. */
  openAnchor: NowOpenAnchor | undefined;
  storedOpenAnchor: StoredCommitment | undefined;
  upcomingSleep: StoredSleepPlan | undefined;
  currentBedtimeStep: StoredRoutineStep | undefined;
  currentWakeStep: StoredRoutineStep | undefined;
  sleepPanelDue: boolean;
  sleepDue: StoredSleepPlan | undefined;
  /** True while the sleep panel shows only because bedtime was started early by hand. */
  sleepEarlyStart: boolean;
  /** Whole minutes from now until the plan's own bedtime; 0 unless the start is early. */
  sleepMinutesUntilPlannedStart: number;
  /** When sleep begun now would end after the planned minutes; set only during an early start. */
  sleepEarlyStartWakeAt: string | undefined;
  /**
   * The duration the "Constrained sleep" option offers during an early start: as much of
   * `desiredSleepMinutes` as fits before the plan's own `wakeConstraint`, or the full desired amount
   * when there is no constraint (or it is far enough off not to matter). Undefined outside an early
   * start. Never the raw minutes-until-wake on its own — that is what offered a 951-minute "sleep"
   * against a 4:33 am constraint reached from midday.
   */
  sleepConstrainedMinutes: number | undefined;
  /**
   * How long a nap would have to run to bring the most recent night back up to the sleep you say you
   * want. Set only during an early start, and only when the top-up is long enough to be a rest;
   * undefined leaves the panel asking for a duration instead of offering one.
   */
  sleepNapTopUpMinutes: number | undefined;
  deliverableDirective: DeliverableDirective | null;
  directedDeliverable: DirectedDeliverable | undefined;
  /** Nothing fits only because a question is unanswered; the question is the directive. */
  answerDirective: AnswerDirective | null;
  answerOptions: AnswerOption[];
  /** Nothing fits before a boundary; the directive names it and the first thing that fits after. */
  boundaryDirective: BoundaryDirective | null;
  /** True when that boundary is today's planning horizon, which Today's override can move. */
  boundaryIsDailyHorizon: boolean;
  /** Getting somewhere is the thing to do now; the journey and what it is for are the engine's. */
  travelDirective: TravelDirective | null;
  /** The place the leg goes to, when it is still a defined context; the panel names it either way. */
  travelDestination: PortalState["conditionDefinitions"][number] | undefined;
  routineDue: StoredRoutineStep | undefined;
  wakeShiftMinutes: number;
  commitmentAfterWake: StoredCommitment | undefined;
  wakeToCommitmentMinutes: number | undefined;
  tentativeSleepConflict: StoredCommitment | undefined;
  sleepSuggestion: SleepSuggestion | undefined;
  activeSleepPlan: StoredSleepPlan | undefined;
  stepSession: ActiveSession | undefined;
  /**
   * What the shared precedence chain says is on the clock (`planning/now-activity.ts` in contracts) — the same
   * answer the handheld device renders. The page's panels still branch on the individual fields
   * above, whose order differs from this one in two places (it draws a protected commitment ahead of
   * a routine step even while that commitment is `late`, and a due sleep ahead of a routine step);
   * this is carried so the two can be reconciled without a second derivation appearing to do it.
   */
  activity: NowActivityResolution<NowCandidate, NowProtectedCommitment>;
  /**
   * The same reading through the pulse resolver — `doing`
   * and `lastConfirmedAt` only; `onPlan`/`offPlanSince` are undesigned and always absent in v1.
   * Nothing renders it yet; it is carried so a future surface does not need a sixth derivation.
   */
  pulse: Pulse;
  /**
   * Whether getting ready for the next fixed commitment is keeping pace with the clock, straight off
   * `state.planning.result.prepPace` (engine/core/src/recommendation/prep-pace.ts) — the arithmetic
   * lives there, never here. Undefined whenever nothing is currently being prepared for.
   */
  prepPace: PrepPace | undefined;
  /**
   * Every pending step with a `startBy` that is soon or missed, straight off
   * `state.planning.result.startByWarnings` (the routine step timing design note, "Warnings and
   * arrival projection"). `[]` when the field is absent (a result stored before it existed).
   */
  startByWarnings: StartByWarning[];
  /**
   * A behind project's offer to trade tonight's bedtime for its next ready action, straight off
   * `state.planning.result.stayUpOffer`. Undefined once answered —
   * `stay_up_answer_minutes` no longer null — or whenever none of the offer's five conditions hold.
   */
  stayUpOffer: StayUpOffer | undefined;
  /**
   * Every offerable flexible step, less the current directive, straight off
   * `state.planning.result.canDoNow` (the routine step timing design note, "Flexible steps offered
   * early"). `[]` when the field is absent.
   */
  canDoNow: CanDoNowItem[];
  /**
   * What OpenRhen has to be told because a fact it was given has aged out, blocking ones first
   * Built by `buildNeeds` in contracts, the call
   * behind `NowAnswer.needs`, so Now and `status` list the same needs in the same words.
   */
  needs: Need[];
  /** A stretch on offer now, shown as a calm card with equal choices. Built by `buildStretchAnswer`, the call behind `status`. */
  stretchOffer: StretchOfferAnswer | null;
  /** The running stretch, today's count and the morning-after loan line; null when there is nothing to say. */
  stretch: StretchBlock | null;
  /** What declared low energy is holding back, as one plain sentence; null when nothing is. Built by `buildEnergyCostAnswer`. */
  energyCost: EnergyCostAnswer | null;
}

/** Which hero Now is showing, for the needs it already asks in its own words. */
export type NeedsHero = "checkpoint" | "place" | "other";

/**
 * The needs Now lists, less the ones the hero already asks: the checkpoint sheet has "It ended at", and
 * the answer panel is the place question (a blocking location need is that question verbatim).
 */
export function visibleNeeds(needs: readonly Need[], hero: NeedsHero): Need[] {
  return needs.filter(
    (need) =>
      !(hero === "checkpoint" && need.fact === "session_end") &&
      !(hero === "place" && need.fact === "location" && need.blocksDirective)
  );
}

export type PlanStatusChip =
  | "Saving…"
  | "Refreshing…"
  | "Updating plan…"
  | "Couldn't update plan"
  | "Plan current"
  | "Plan stalled"
  | "Plan not current";

/**
 * The words in the status row beside the date. An unexpired run is "current" even while a newer job
 * is due, running or retrying against state it predates, and even after the job that would replace it
 * failed; both are said here rather than letting "Plan current" cover a write the plan has not seen.
 *
 * Precedence: a save in progress, then a newer plan already known on the server, then a newer job in
 * flight (the plan is updating, even if an earlier attempt failed), then a failed job with nothing
 * left in flight (couldn't update; the idle freshness tick requests a new run within a minute), then
 * the plan's own state. A stalled plan keeps its own wording over a failure, as it is the stronger claim.
 */
/**
 * Whether the plan still names an action that local state already shows as finished. Right after
 * "Finished it" the stored plan predates the write for a few seconds, so its primary would otherwise
 * stay on screen as "Do this now". The recommended id may be an action or one of its occurrences.
 */
export function recommendedActionFinished(state: PortalState, primary: NowCandidate | null): boolean {
  if (!primary) return false;
  const id = primary.action.id;
  const action = state.actions.find((item) => item.id === id);
  if (action && (action.status === "done" || isClosedStatus(action.status))) return true;
  return state.occurrences.some(
    (item) => item.id === id && (item.status === "completed" || item.status === "cancelled")
  );
}

export function planStatusChip(input: {
  saving: boolean;
  planningRefreshing: boolean;
  planningDecisionCurrent: boolean;
  planHealth: PlanHealth | null;
  /** `state.planning.awaitingRecalculation`, read only until the first status poll has answered. */
  stateAwaitingRecalculation?: boolean | undefined;
}): PlanStatusChip {
  const { saving, planningRefreshing, planningDecisionCurrent, planHealth } = input;
  if (saving) return "Saving…";
  if (planningRefreshing) return "Refreshing…";
  const stalled = planHealth?.refresh === "stalled" && !planningDecisionCurrent;
  // The newest signal wins: a poll's answer once there is one (the provider overrides it when a save
  // is adopted, `planHealthAfterSave`), the state's own flag before the first poll.
  const updating = planHealth ? Boolean(planHealth.updating) : Boolean(input.stateAwaitingRecalculation);
  if (updating && !stalled) return "Updating plan…";
  if (planHealth?.latestJobFailed && !stalled) return "Couldn't update plan";
  if (planningDecisionCurrent) return "Plan current";
  return planHealth?.refresh === "stalled" ? "Plan stalled" : "Plan not current";
}

export function buildNowModel({
  state,
  recommendation,
  forecasts,
  currentDirective,
  now,
  serverClockOffsetMs = 0,
  manualBedtime,
  knownLatestSuccessfulAt
}: NowModelInput): NowModel {
  const timezone = state.settings.timezone;
  // Behind, not merely different: `currentRecommendationId`-style churn is expected noise (see the
  // review-issue-reports skill), but a strictly newer `lastSuccessfulAt` than the plan on screen means
  // the server has already replanned and this tab has not caught up yet.
  const planningRefreshing = Boolean(
    knownLatestSuccessfulAt &&
    state.planning?.lastSuccessfulAt &&
    knownLatestSuccessfulAt !== state.planning.lastSuccessfulAt &&
    new Date(knownLatestSuccessfulAt) > new Date(state.planning.lastSuccessfulAt)
  );
  const planningDecisionCurrent =
    state.planning?.status === "current" &&
    Boolean(
      state.planning.validUntil && new Date(state.planning.validUntil) > new Date(now.getTime() + serverClockOffsetMs)
    ) &&
    !planningRefreshing;
  const session = state.activeSession;
  const sessionOccurrence = session ? state.occurrences.find((item) => item.id === session.actionId) : undefined;
  const sessionAction = session
    ? state.actions.find((action) => action.id === (sessionOccurrence?.actionId ?? session.actionId))
    : undefined;
  const primary = recommendation.primary;
  const situationLocation = state.conditionDefinitions.find((entry) => entry.id === state.currentSituation.locationId);
  // Only worth asking about work that is otherwise ready, which is what the engine already decided
  // these lists mean; the page does not re-judge eligibility.
  const needsAnswer = recommendation.needsAnswer ?? [];
  // Three ways a candidate earns a place here, all of them the engine's own verdict: it costed a
  // journey (`trip`), it refused one and said why (`tripReason`), or — from a result stored before
  // the engine directed travel — it is merely somewhere else with a journey the matcher found.
  const reachable = (recommendation.reachable ?? []).filter(
    (item) => item.trip || item.tripReason || item.conditionMatch?.reachableVia
  );
  const worthTheTrip = reachable.filter((item) => item.trip);
  const notWorthTheTrip = reachable.filter((item) => !item.trip);
  const forecast = primary ? forecasts.find((item) => item.projectId === primary.action.projectId) : undefined;
  const secondsRemaining =
    session?.status === "paused"
      ? (session.pausedRemainingSeconds ?? 0)
      : session
        ? Math.ceil((new Date(session.plannedEndAt).getTime() - now.getTime()) / 1000)
        : 0;
  const sessionCheckpointReached = Boolean(session?.status === "running" && secondsRemaining <= 0);
  const reconciliationDue = Boolean(
    session?.status === "running" && session.targetType === "deliverable" && (session.unansweredCheckIns ?? 0) >= 3
  );
  const plannedStart = session ? new Date(session.startedAt) : now;
  // Before a session starts, the end shown is when the clock will say the focused minutes are up: the
  // wall-clock figure the engine reports, or the focused figure itself for a result stored before the
  // engine distinguished them. A running session's end is its own record; the Start command still
  // sends focused minutes, which is what the store checks against the candidate. The rule lives in the
  // shared builder so `status` gives an agent the same end.
  const recommendationAnswer = buildRecommendationAnswer({
    state,
    // The stored result itself, as `status` reads it: the provider's empty-plan placeholder must not
    // give the page a headline an agent asking the same question would not get.
    result: state.planning?.result,
    now,
    manualBedtime
  });
  const plannedEnd = recommendationAnswer.plannedEnd ? new Date(recommendationAnswer.plannedEnd) : now;
  const plannedDuration = session ? session.plannedMinutes : (primary?.recommendedMinutes ?? 0);
  const nextCommitment = state.commitments
    .filter((item) => item.status !== "cancelled" && new Date(item.startsAt) > now)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0];
  // What is on the clock is decided once, in `planning/now-activity.ts` in contracts, and read here — the same call
  // the handheld device makes. Everything below maps that answer onto the page's view fields.
  const activity = resolveNowActivity({
    state,
    now,
    currentDirective,
    protectedCommitment: recommendation.protectedCommitment ?? null,
    primary,
    manualBedtime
  });
  const confirmedIds = new Set(state.commitments.filter((item) => item.status === "confirmed").map((item) => item.id));
  const protectedCommitment = activity.protectedInfo?.protectedCommitment;
  const storedProtectedCommitment = activity.protectedInfo?.commitment;
  // Held to the same test as the protected commitment: the engine's own verdict, but only while the
  // commitment it names is still a confirmed row. A stored result outliving a cancelled commitment
  // must not keep offering to record engagement in something that is no longer happening. Stays here
  // rather than in the shared resolution: an open anchor is the opposite of a claim on the clock —
  // the hour is still yours — so it never takes part in the precedence chain.
  const openAnchor =
    recommendation.openAnchor && confirmedIds.has(recommendation.openAnchor.id) ? recommendation.openAnchor : undefined;
  const storedOpenAnchor = openAnchor ? state.commitments.find((item) => item.id === openAnchor.id) : undefined;
  const upcomingSleep = activity.upcomingSleep;
  const currentBedtimeStep = activity.currentBedtimeStep;
  const currentWakeStep = activity.currentWakeStep;
  const sleepPanelDue = activity.sleepPanelDue;
  const sleepDue = activity.sleepDue;
  // A manual early start shows the panel hours before the plan's own bedtime. The planned figures
  // stay internally consistent only at the planned start, so the panel must label them as the plan
  // and anchor everything it says about "now" to now: how far off that bedtime is, and when sleep
  // begun immediately would actually end.
  const sleepEarlyStart = Boolean(
    sleepDue && manualBedtime && !sleepPanelDue && new Date(sleepDue.plannedStartAt) > now
  );
  const sleepMinutesUntilPlannedStart =
    sleepEarlyStart && sleepDue
      ? Math.round((new Date(sleepDue.plannedStartAt).getTime() - now.getTime()) / 60_000)
      : 0;
  const sleepEarlyStartWakeAt =
    sleepEarlyStart && sleepDue ? new Date(now.getTime() + sleepDue.allowedMinutes * 60_000).toISOString() : undefined;
  // The min() is load-bearing: without it, a wake constraint reached hours from now (the 4:33 am
  // constraint reached from a midday start) would offer the raw minutes-until-wake
  // — a 951-minute "sleep" — instead of clamping to what the settings actually ask for.
  const sleepConstrainedMinutes =
    sleepEarlyStart && sleepDue
      ? sleepDue.wakeConstraint
        ? Math.max(
            0,
            Math.min(
              state.settings.desiredSleepMinutes,
              Math.round((new Date(sleepDue.wakeConstraint.protectedStartAt).getTime() - now.getTime()) / 60_000)
            )
          )
        : state.settings.desiredSleepMinutes
      : undefined;
  const deliverableDirective = currentDirective?.kind === "deliverable" ? currentDirective : null;
  const directedStored = deliverableDirective
    ? state.deliverables.find((item) => item.id === deliverableDirective.targetId)
    : undefined;
  const directedDeliverable: DirectedDeliverable | undefined = directedStored
    ? {
        ...directedStored,
        startStepId: nextExecutableStepId(
          directedStored,
          assessDeliverable({
            deliverable: directedStored,
            situation: state.currentSituation,
            conditionDefinitions: state.conditionDefinitions,
            now,
            commitments: state.commitments
          })
        )
      }
    : undefined;
  // The engine's "what would resolve nothing fitting" is read, never recomputed. A protected
  // commitment suppresses both on the engine's side already; here they only need mapping onto the
  // situation model so the question can be answered where it is asked.
  const answerDirective = currentDirective?.kind === "answer" ? currentDirective : null;
  const answerOptions: AnswerOption[] = answerDirective
    ? answerDirective.contextIds.map((contextId) => {
        const definition = state.conditionDefinitions.find((entry) => entry.id === contextId);
        const kind: AnswerOption["kind"] =
          definition?.kind === "location"
            ? "location"
            : definition?.kind === "capability" && definition.portability === "portable" && !definition.pathways.length
              ? "carrying"
              : "override";
        return { contextId, name: definition?.name ?? contextId, kind };
      })
    : [];
  const boundaryDirective = currentDirective?.kind === "boundary" ? currentDirective : null;
  const boundaryIsDailyHorizon = boundaryDirective?.boundaryKind === "daily_horizon";
  // The leg, its length, its source and what it is for are all stated by the engine. Nothing here
  // re-times a journey or re-decides whether it is worth making; only the destination is named.
  const travelDirective = currentDirective?.kind === "travel" ? currentDirective : null;
  const travelDestination = travelDirective
    ? state.conditionDefinitions.find((entry) => entry.id === travelDirective.toLocationId)
    : undefined;
  // Whether a location assertion is old enough to distrust is the context matcher's verdict, taken
  // from the resolution the shared model already ran; the page only says whether to show it as known.
  const situationLocationTrusted = Boolean(situationLocation) && !activity.situation.locationStale;
  const routineDue = activity.routineDue;
  const preferredWakeMinutes =
    Number(state.settings.preferredWakeTime.slice(0, 2)) * 60 + Number(state.settings.preferredWakeTime.slice(3, 5));
  const wakeShiftMinutes = sleepDue
    ? ((localClockMinutes(new Date(sleepDue.plannedWakeAt), timezone) - preferredWakeMinutes + 720) % 1440) - 720
    : 0;
  const commitmentAfterWake = sleepDue
    ? state.commitments
        .filter((item) => item.status !== "cancelled" && new Date(item.startsAt) > new Date(sleepDue.plannedWakeAt))
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0]
    : undefined;
  const wakeToCommitmentMinutes =
    sleepDue && commitmentAfterWake
      ? Math.round(
          (new Date(commitmentAfterWake.startsAt).getTime() - new Date(sleepDue.plannedWakeAt).getTime()) / 60_000
        )
      : undefined;
  const tentativeSleepConflict = sleepDue
    ? state.commitments.find(
        (item) =>
          item.status === "tentative" &&
          new Date(item.startsAt) < new Date(sleepDue.plannedWakeAt) &&
          new Date(item.endsAt) > now
      )
    : undefined;
  // Offered, never applied automatically: the target-minus-pressure calculation has no memory of
  // what was actually slept last time, so a real deficit or a goal already met never changes the
  // plan on its own. This surfaces the adjustment as a one-click opt-in against the last *recent*
  // completed sleep (older history is too stale to say anything about tonight), leaving the
  // computed default and manual entry untouched for anyone who doesn't want it.
  const lastCompletedSleep = state.sleepPlans
    .filter((item) => item.status === "completed" && item.actualWakeAt)
    .sort((a, b) => (b.actualWakeAt as string).localeCompare(a.actualWakeAt as string))[0];
  const lastSleepRecent = Boolean(
    lastCompletedSleep &&
    now.getTime() - new Date(lastCompletedSleep.actualWakeAt as string).getTime() < 36 * 60 * 60 * 1000
  );
  // What a nap offered during an early start should default to: the minutes that would bring the
  // most recent night back up to the sleep the settings say is wanted. The night's own length is
  // measured the way the engine measures it in `completedSleepMinutesEndingAt` — from the actual
  // times — because a live-tracked row keeps the *planned* `allowedMinutes` however long the night
  // really ran, and its stored `sleepDeficitMinutes` with it; that stored figure is the fallback for
  // a row whose recorded window says nothing usable. The goal is read from settings rather than from
  // the row's own `desiredMinutes`, so raising or lowering it changes the next top-up rather than
  // leaving old nights arguing for the amount that was wanted when they were planned.
  const lastSleptMinutes = lastCompletedSleep
    ? (() => {
        const wake = new Date(lastCompletedSleep.actualWakeAt as string).getTime();
        const start = new Date(lastCompletedSleep.actualStartAt ?? lastCompletedSleep.plannedStartAt).getTime();
        return wake > start ? Math.round((wake - start) / 60_000) : undefined;
      })()
    : undefined;
  const napTopUpMinutes =
    lastCompletedSleep && lastSleepRecent
      ? lastSleptMinutes !== undefined
        ? Math.max(0, state.settings.desiredSleepMinutes - lastSleptMinutes)
        : lastCompletedSleep.sleepDeficitMinutes
      : 0;
  const sleepNapTopUpMinutes =
    sleepEarlyStart && napTopUpMinutes >= NAP_TOP_UP_FLOOR_MINUTES ? napTopUpMinutes : undefined;
  const sleepSuggestion =
    sleepDue && lastSleepRecent
      ? (() => {
          // Recomputed from the actual timestamps the same way lastSleptMinutes/napTopUpMinutes above
          // already do, rather than trusted from the stored column directly: a write path that leaves
          // sleepDeficitMinutes at its 0 default (A hand-logged 20-minute nap) must
          // not read as "goal met" here just because nothing recomputes it. Falls back to the stored
          // figure only when the actual times can't say anything usable, same as napTopUpMinutes does.
          const deficit =
            lastSleptMinutes !== undefined
              ? Math.max(0, state.settings.desiredSleepMinutes - lastSleptMinutes)
              : (lastCompletedSleep!.sleepDeficitMinutes ?? 0);
          // Anchored to when the rest could actually begin: the planned start, or now once that has
          // passed. A wake computed from a planned start already behind the clock would offer a
          // "rest" whose end is nearer than its length.
          const startMs = Math.max(now.getTime(), new Date(sleepDue.plannedStartAt).getTime());
          const wakeCeilingMs = sleepDue.wakeConstraint
            ? new Date(sleepDue.wakeConstraint.protectedStartAt).getTime()
            : undefined;
          if (deficit > 0) {
            const baseMinutes = sleepDue.targetMinutes ?? sleepDue.allowedMinutes;
            let wakeMs = startMs + (baseMinutes + deficit) * 60_000;
            if (wakeCeilingMs !== undefined) wakeMs = Math.min(wakeMs, wakeCeilingMs);
            const minutes = Math.round((wakeMs - startMs) / 60_000);
            return minutes > sleepDue.allowedMinutes
              ? {
                  kind: "catchup" as const,
                  minutes,
                  addedMinutes: minutes - sleepDue.allowedMinutes,
                  wakeAtIso: new Date(wakeMs).toISOString()
                }
              : undefined;
          }
          if (sleepDue.allowedMinutes > state.settings.minimumSleepMinutes) {
            const wakeMs = startMs + state.settings.minimumSleepMinutes * 60_000;
            return {
              kind: "nap" as const,
              minutes: state.settings.minimumSleepMinutes,
              addedMinutes: 0,
              wakeAtIso: new Date(wakeMs).toISOString()
            };
          }
          return undefined;
        })()
      : undefined;
  const activeSleepPlan =
    session?.targetType === "sleep" ? state.sleepPlans.find((item) => item.id === session.targetId) : undefined;
  // A sleep-anchored step's session looks identical to a commitment's own preparation step's session
  // now — both are `targetType: "routine_step"` — so telling them apart (only a sleep-
  // anchored one belongs in the bedtime/wake panels below) means checking what the targeted row
  // actually is, not just the session's own shape.
  const stepSession =
    session?.targetType === "routine_step" &&
    state.routineSteps.find((item) => item.id === session.targetId)?.anchorType === "sleep_plan"
      ? session
      : undefined;
  const prepPace = state.planning?.result?.prepPace;
  const startByWarnings = state.planning?.result?.startByWarnings ?? [];
  const canDoNow = state.planning?.result?.canDoNow ?? [];
  const stayUpOffer = state.planning?.result?.stayUpOffer;
  // The forecasts are the stored schedule's, so their health names the at-risk projects whose old estimates
  // status also asks about (`effort` needs).
  const needs = buildNeeds(
    { state, currentDirective, now, schedule: { forecasts } },
    new Map(state.conditionDefinitions.map((entry) => [entry.id, entry.name]))
  );

  // The raw stored recommendation, not the hydrated one: hydration turns ISO instants into Dates, which the offer's
  // schema (strings) does not take, and `status` reads it raw too.
  const stretchAnswer = buildStretchAnswer({
    recommendation: state.planning?.result?.recommendation,
    stretch: state.currentSituation.stretch,
    energySetAt: state.currentSituation.energySetAt,
    planCalculatedAt: state.planning?.lastSuccessfulAt ?? undefined,
    planCurrent: planningDecisionCurrent,
    now: new Date(now.getTime() + serverClockOffsetMs),
    timeZone: timezone,
    locale: resolveLocale(state.settings.locale)
  });

  const energyCost = buildEnergyCostAnswer({
    recommendation: state.planning?.result?.recommendation,
    energySetAt: state.currentSituation.energySetAt,
    planCalculatedAt: state.planning?.lastSuccessfulAt ?? undefined,
    planCurrent: planningDecisionCurrent,
    stretchOfferActionId: stretchAnswer.stretchOffer?.actionId,
    now: new Date(now.getTime() + serverClockOffsetMs),
    timeZone: timezone,
    locale: resolveLocale(state.settings.locale)
  });

  return {
    timezone,
    planningDecisionCurrent,
    planningRefreshing,
    session,
    sessionAction,
    primary,
    situationLocation,
    situationLocationTrusted,
    needsAnswer,
    reachable,
    worthTheTrip,
    notWorthTheTrip,
    forecast,
    secondsRemaining,
    sessionCheckpointReached,
    reconciliationDue,
    plannedStart,
    plannedEnd,
    plannedDuration,
    nextCommitment,
    protectedCommitment,
    storedProtectedCommitment,
    openAnchor,
    storedOpenAnchor,
    upcomingSleep,
    currentBedtimeStep,
    currentWakeStep,
    sleepPanelDue,
    sleepDue,
    sleepEarlyStart,
    sleepMinutesUntilPlannedStart,
    sleepEarlyStartWakeAt,
    sleepConstrainedMinutes,
    sleepNapTopUpMinutes,
    deliverableDirective,
    directedDeliverable,
    answerDirective,
    answerOptions,
    boundaryDirective,
    boundaryIsDailyHorizon,
    travelDirective,
    travelDestination,
    routineDue,
    wakeShiftMinutes,
    commitmentAfterWake,
    wakeToCommitmentMinutes,
    tentativeSleepConflict,
    sleepSuggestion,
    activeSleepPlan,
    stepSession,
    activity: activity.resolution,
    pulse: activity.pulse,
    prepPace,
    startByWarnings,
    canDoNow,
    stayUpOffer,
    recommendationAnswer,
    needs,
    stretchOffer: stretchAnswer.stretchOffer,
    stretch: stretchAnswer.stretch,
    energyCost
  };
}
