import {
  buildDay,
  buildNowAnswer,
  buildRecommendationAnswer,
  buildRisks,
  catchUpLedgerSchema,
  resolvePulse,
  runningAnchors,
  type DayEntry,
  type DirectiveSummary,
  type Need,
  type NowAnswerAnchors,
  type RecommendationAnswer,
  type RiskSummary,
  type PrepPace,
  type Pulse,
  type PulseReentryView,
  type PulseSessionTargetType
} from "@openrhen/contracts";
import { booleanOption, type CommandContext, type CommandSpec, type ParsedArgs } from "../command.js";
import type { PortalState } from "../client.js";
import { localiseInstants, toJson } from "../output.js";
import { OUTSIDE_IDS_KEY, outsideCommitments, outsideSourceOf } from "../outside-text.js";
import { catchUpDue } from "./catch-up.js";
import { formatClock, formatWhen, localiseInstant, minutesBetween, sameLocalDay } from "../when.js";

interface PlanSummary {
  status: string;
  calculatedAt: string | null;
  validUntil: string | null;
  awaitingRecalculation: boolean;
  message?: string;
}

interface UpcomingSummary {
  kind: string;
  title: string;
  targetId: string;
  recommendedMinutes: number;
  at?: string;
}

interface SessionSummary {
  id: string;
  status: string;
  title: string;
  targetType?: string;
  startedAt: string;
  plannedEndAt: string;
  plannedMinutes: number;
  elapsedMinutes: number;
  minutesLeft: number;
}

interface CommitmentSummary {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  location: string | null;
  locationId?: string;
  /** Only on a commitment that came from a calendar or an email, whose title is then not the person's own. */
  sourceType?: string;
  pendingRoutineSteps: number;
  /** `anchor` leaves the hour open for other work until you are engaged; `blocking` takes it outright. */
  presence?: string;
  /**
   * Anchor only, while it is running: `open` means you are there and no engagement session is
   * running against it, so work is on offer (the portal's "I'm engaged" strip); `engaged` means a
   * session against it is running, and `activity finish` is "I'm free". Derived from the wire, so a
   * looser proxy than the engine's own `openAnchor` (no running-late test).
   */
  anchorState?: "open" | "engaged";
  /** The engine's planned journeys to and from this commitment, when it has any. */
  journey?: JourneySummary;
  /** "planned" when absent — the ordinary editor never sends this, so its absence is not itself news. */
  origin?: string;
  disruptionOpenEnded?: boolean;
  landedAt?: string;
}

interface JourneyEdgeSummary {
  from: string;
  to: string;
  minutes: number;
  typicalMinutes: number;
  source: string;
  mode?: string;
  originAssumed?: boolean;
}

interface JourneySummary {
  leaveBy?: string;
  arriveBy: string;
  before?: JourneyEdgeSummary;
  after?: JourneyEdgeSummary;
  /** Why a located commitment has no estimate: no_place or no_estimate. */
  gap?: string;
}

interface TodayItemSummary {
  actionId: string;
  title: string;
  status: string;
  done: boolean;
}

interface TodayDeferredSummary {
  actionId: string;
  title: string;
  reason: string;
}

interface TodaySummary {
  localDate: string;
  items: TodayItemSummary[];
  deferred: TodayDeferredSummary[];
}

interface DoneTodaySummary {
  id: string;
  title: string;
  result: string;
  activeMinutes: number;
  endedAt: string;
}

interface SituationSummary {
  locationId: string | null;
  locationName: string | null;
  conditions: string[];
  energy: string;
}

/** `state.pulse` — the recorder's own judgement, distinct
    from `resolvePulse`'s `doing`/`lastConfirmedAt` approximation this file already builds as `pulse`
    below. Null before the recorder's first run. */
interface PulseRecordSummary {
  state: string;
  since: string;
  todayPercent: number | null;
  /** The recorded disruption holding `on/disrupted`; absent otherwise. */
  disruption?: { doing: string; until: string; locationId: string; contexts: string[]; exclusive: boolean };
}

/** `status`'s catch-up line: `due` only when the switch is on and the window is due. */
export interface CatchUpLine {
  state: "none" | "due";
  since: string | null;
  unsettled: number;
  staleDates: number;
}

interface StatusSummary {
  now: string;
  timezone: string;
  plan: PlanSummary;
  directive: DirectiveSummary | null;
  /**
   * The one sentence to say to the person: the directive on the clock. When the directive is not the ranked
   * pick (a routine step, travel, a boundary), `recommendation.headline` speaks only for the ranked task list
   * and the sentence says so, so the two never read as rival answers.
   */
  answer: string;
  /**
   * The rest of the engine's answer, as the Now page shows it from the same planning run: why this and
   * why not the nearer thing, what would change it, its planned end, the runner-up, what gates the step
   * on the clock, tonight's sleep errors and stay-up offer.
   */
  recommendation: RecommendationAnswer;
  /** What is at risk, worst first: preparation behind, steps past their latest start, projects behind. The first ten. */
  risks: RiskSummary[];
  /** Risks past the first ten; `rhen forecast` lists every project. Absent when none were left out. */
  risksOmitted?: number;
  /** The rest of today's plan, block by block, in local time. The next sixteen blocks. */
  day: DayEntry[];
  /** Blocks past the first sixteen. Absent when none were left out. */
  dayOmitted?: number;
  /** Every running anchor: `open` ones are "I'm free" (work on offer), `engaged` ones have a session against them. */
  anchors: NowAnswerAnchors;
  /** What has gone stale and has to be told again, blocking ones first; the same list Now shows. Empty when every fact is current. */
  needs: Need[];
  upcoming: UpcomingSummary[];
  session: SessionSummary | null;
  currentCommitment: CommitmentSummary | null;
  nextCommitment: CommitmentSummary | null;
  today: TodaySummary | null;
  /** The latest ten sessions ended today. */
  doneToday: DoneTodaySummary[];
  /** Sessions ended today before those ten. Absent when none were left out. */
  doneTodayOmitted?: number;
  situation: SituationSummary;
  checkIn: unknown;
  checkInError?: string;
  /** Each add-on's mode (`off`, `shadow` or `on`; most add-ons are off or on only), read-only: only the owner sets them. Absent when the read failed. */
  addOns?: Record<string, string>;
  /** Absent when the ledger read failed. */
  catchUp?: CatchUpLine;
  /** Whether getting ready for the next commitment is keeping pace; absent when nothing is prepping. */
  prepPace: PrepPace | null;
  /**
   * `doing`/`lastConfirmedAt` from the pulse resolver; `onPlan`
   * and `offPlanSince` are undesigned and always absent. Built from what the wire actually carries —
   * `recommendation.protectedCommitment`/`.openAnchor` are never serialized to `PortalState`, so
   * `commitment` below is `currentCommitment` (whichever commitment's own window contains `now`), a
   * looser proxy than the portal's admissibility-tested reading: no confirmed-row test, no `late`
   * exception. Acceptable for a read-only reporting surface.
   */
  pulse: Pulse & Partial<Omit<PulseReentryView, "lastConfirmedAt">>;
  pulseRecord: PulseRecordSummary | null;
}

function buildSessionSummary(
  session: PortalState["activeSession"],
  now: Date,
  actions: PortalState["actions"]
): SessionSummary | null {
  if (!session) return null;
  // The portal only stamps targetTitle on non-action sessions; an action session is named by its action.
  const actionTitle =
    session.targetTitle === undefined && (session.targetType === undefined || session.targetType === "action")
      ? actions.find((action) => action.id === (session.targetId ?? session.actionId))?.title
      : undefined;
  // A paused session's clock is stopped: what is left is what the pause froze, not the distance to a
  // planned end that keeps receding as the pause goes on.
  const minutesLeft =
    session.status === "paused" && session.pausedRemainingSeconds !== undefined
      ? Math.round(session.pausedRemainingSeconds / 60)
      : minutesBetween(now, new Date(session.plannedEndAt));
  return {
    id: session.id,
    status: session.status,
    title: session.targetTitle ?? actionTitle ?? session.actionId,
    ...(session.targetType !== undefined ? { targetType: session.targetType } : {}),
    startedAt: session.startedAt,
    plannedEndAt: session.plannedEndAt,
    plannedMinutes: session.plannedMinutes,
    elapsedMinutes: Math.round(session.activeElapsedSeconds / 60),
    minutesLeft
  };
}

type CommitmentTimelines = NonNullable<
  NonNullable<PortalState["planning"]>["result"]
>["derivedState"]["commitmentTimelines"];

function buildJourney(
  timeline: NonNullable<CommitmentTimelines>[number] | undefined,
  locationNameById: ReadonlyMap<string, string>
): JourneySummary | undefined {
  if (!timeline) return undefined;
  const name = (id: string): string => locationNameById.get(id) ?? id;
  const edge = (value: NonNullable<NonNullable<CommitmentTimelines>[number]["journeyBefore"]>): JourneyEdgeSummary => ({
    from: name(value.fromLocationId),
    to: name(value.toLocationId),
    minutes: value.minutes,
    typicalMinutes: value.typicalMinutes,
    source: value.source,
    ...(value.mode !== undefined ? { mode: value.mode } : {}),
    ...(value.originAssumed !== undefined ? { originAssumed: value.originAssumed } : {})
  });
  if (!timeline.journeyBefore && !timeline.journeyAfter && !timeline.travelGap) return undefined;
  return {
    ...(timeline.leaveBy !== undefined ? { leaveBy: timeline.leaveBy } : {}),
    arriveBy: timeline.arriveBy,
    ...(timeline.journeyBefore ? { before: edge(timeline.journeyBefore) } : {}),
    ...(timeline.journeyAfter ? { after: edge(timeline.journeyAfter) } : {}),
    ...(timeline.travelGap !== undefined ? { gap: timeline.travelGap } : {})
  };
}

function anchorStateOf(anchors: NowAnswerAnchors, id: string): "open" | "engaged" | undefined {
  return anchors.engaged.includes(id) ? "engaged" : anchors.open.includes(id) ? "open" : undefined;
}

function buildCommitmentSummary(
  commitment: PortalState["commitments"][number],
  routineSteps: PortalState["routineSteps"],
  locationNameById: ReadonlyMap<string, string>,
  timelines: CommitmentTimelines,
  state?: PortalState,
  now?: Date
): CommitmentSummary {
  const journey = buildJourney(
    timelines?.find((item) => item.id === commitment.id),
    locationNameById
  );
  const anchorState = state && now ? anchorStateOf(runningAnchors(state, now), commitment.id) : undefined;
  const pendingRoutineSteps = routineSteps.filter(
    (step) => step.commitmentId === commitment.id && step.status === "pending"
  ).length;
  const location =
    commitment.location ?? (commitment.locationId ? (locationNameById.get(commitment.locationId) ?? null) : null);
  return {
    id: commitment.id,
    title: commitment.title,
    startsAt: commitment.startsAt,
    endsAt: commitment.endsAt,
    location,
    ...(commitment.locationId !== undefined ? { locationId: commitment.locationId } : {}),
    ...(outsideSourceOf(commitment) ? { sourceType: outsideSourceOf(commitment)!.type } : {}),
    pendingRoutineSteps,
    ...(commitment.presence !== undefined ? { presence: commitment.presence } : {}),
    ...(anchorState ? { anchorState } : {}),
    ...(journey ? { journey } : {}),
    ...(commitment.origin !== undefined ? { origin: commitment.origin } : {}),
    ...(commitment.disruptionOpenEnded !== undefined ? { disruptionOpenEnded: commitment.disruptionOpenEnded } : {}),
    ...(commitment.landedAt !== undefined ? { landedAt: commitment.landedAt } : {})
  };
}

function buildTodaySummary(
  state: PortalState,
  sessionsToday: PortalState["completedToday"],
  now: Date
): TodaySummary | null {
  const dailyPlan = state.dailyPlan;
  if (!dailyPlan) return null;
  // The portal serves the latest day's plan, which is tomorrow's once that has been made; like the
  // portal's own Now page, show it as today's only when it is for today's date in the planning timezone.
  if (dailyPlan.localDate !== formatClock(now.toISOString(), state.settings.timezone).slice(0, 10)) return null;
  const actionById = new Map(state.actions.map((action) => [action.id, action]));
  const completedActionIds = new Set(
    sessionsToday.filter((session) => session.result === "completed").map((session) => session.actionId)
  );
  const items = dailyPlan.desiredActionIds.map((actionId) => {
    const action = actionById.get(actionId);
    const status = action?.status ?? "unknown";
    const done = status === "done" || completedActionIds.has(actionId);
    return { actionId, title: action?.title ?? actionId, status, done };
  });
  const deferred = dailyPlan.deferredItems.map((item) => ({
    actionId: item.actionId,
    title: actionById.get(item.actionId)?.title ?? item.actionId,
    reason: item.reason
  }));
  return { localDate: dailyPlan.localDate, items, deferred };
}

const STATUS_RISK_CAP = 10;
const STATUS_DAY_CAP = 16;
const STATUS_DONE_CAP = 10;
const STATUS_EVIDENCE_CAP = 5;

function buildSummary(
  state: PortalState,
  checkIn: unknown,
  checkInError: string | undefined,
  now: Date,
  addOns?: Record<string, string>,
  catchUp?: CatchUpLine,
  pulseView?: PulseReentryView
): StatusSummary {
  const timezone = state.settings.timezone;
  const planning = state.planning;
  const plan: PlanSummary = {
    status: planning?.status ?? "unavailable",
    calculatedAt: planning?.lastSuccessfulAt ?? null,
    validUntil: planning?.validUntil ?? null,
    awaitingRecalculation: planning?.awaitingRecalculation ?? false,
    ...(planning?.message !== undefined ? { message: planning.message } : {})
  };

  const locationNameById = new Map(state.conditionDefinitions.map((context) => [context.id, context.name]));

  const currentDirective = planning?.result?.currentDirective;
  const answer = buildNowAnswer(
    {
      state,
      currentDirective,
      dayPlan: planning?.result?.dayPlan,
      recommendation: planning?.result?.recommendation,
      schedule: planning?.result?.schedule,
      now
    },
    locationNameById
  );
  const directive = answer.directive;
  const built = buildRecommendationAnswer({ state, result: planning?.result, now });
  // A plan that is not current cannot promise when suggested work ends or what it fits before: Now says
  // "Plan not current" beside those, and an agent reading only these fields would not see that.
  const planCurrent =
    plan.status === "current" && plan.validUntil !== null && new Date(plan.validUntil).getTime() > now.getTime();
  // A running session's end is its own record, not the plan's, so it stands either way.
  // The engine writes place ids ("Missing context: ctx-work."); the person and the agent know them by name.
  const nameIds = (text: string) => text.replace(/[A-Za-z0-9_-]+/g, (word) => locationNameById.get(word) ?? word);
  const trimmed = { ...built, evidence: built.evidence.slice(0, STATUS_EVIDENCE_CAP).map(nameIds) };
  const recommendation =
    planCurrent || state.activeSession ? trimmed : { ...trimmed, plannedEnd: null, fitsBefore: null };
  // Capped so a bad week cannot make the one small read an agent is told to make large again.
  const allRisks = buildRisks({ state, result: planning?.result });
  const allDay = buildDay({ state, result: planning?.result, now });
  const risks = allRisks.slice(0, STATUS_RISK_CAP);
  const day = allDay.slice(0, STATUS_DAY_CAP);

  const upcoming: UpcomingSummary[] = (planning?.result?.upcomingDirectives ?? []).map((item) => ({
    kind: item.kind,
    title: item.title,
    targetId: item.targetId,
    recommendedMinutes: item.recommendedMinutes,
    ...(item.at !== undefined ? { at: item.at } : {})
  }));

  const session = buildSessionSummary(state.activeSession, now, state.actions);

  const activeCommitments = state.commitments.filter((commitment) => commitment.status !== "cancelled");
  const currentRaw = activeCommitments.find(
    (commitment) => new Date(commitment.startsAt) <= now && now < new Date(commitment.endsAt)
  );
  const upcomingCommitments = activeCommitments
    .filter((commitment) => new Date(commitment.startsAt) > now)
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  const nextRaw = upcomingCommitments[0];
  const currentCommitment = currentRaw
    ? buildCommitmentSummary(
        currentRaw,
        state.routineSteps,
        locationNameById,
        planning?.result?.derivedState.commitmentTimelines,
        state,
        now
      )
    : null;
  const nextCommitment = nextRaw
    ? buildCommitmentSummary(
        nextRaw,
        state.routineSteps,
        locationNameById,
        planning?.result?.derivedState.commitmentTimelines,
        state,
        now
      )
    : null;

  // The portal names this field `completedToday` but serves the whole recent history through it.
  const sessionsToday = state.completedToday.filter((session) =>
    sameLocalDay(new Date(session.endedAt), now, timezone)
  );
  const today = buildTodaySummary(state, sessionsToday, now);
  // The latest ten, oldest first; `rhen history` has the rest.
  const allDone = [...sessionsToday].sort((a, b) => a.endedAt.localeCompare(b.endedAt));
  const doneToday: DoneTodaySummary[] = allDone.slice(-STATUS_DONE_CAP).map((session) => ({
    id: session.id,
    title: session.actionTitle,
    result: session.result,
    activeMinutes: session.activeMinutes,
    endedAt: session.endedAt
  }));

  const locationId = state.currentSituation.locationId;
  const situation: SituationSummary = {
    locationId,
    locationName: locationId ? (locationNameById.get(locationId) ?? null) : null,
    conditions: state.assertedConditions,
    energy: state.currentEnergy
  };

  // The same precedence `now-activity.ts` reads on the portal, over what the wire actually carries —
  // see this file's own `pulse` doc comment for what is approximated and why.
  const pulse = resolvePulse({
    session:
      state.activeSession && (state.activeSession.status === "running" || state.activeSession.status === "paused")
        ? {
            targetType: (state.activeSession.targetType as PulseSessionTargetType | undefined) ?? "action",
            id: state.activeSession.targetId ?? state.activeSession.actionId,
            title: state.activeSession.targetTitle ?? ""
          }
        : undefined,
    travel: currentDirective?.kind === "travel",
    routineStep:
      currentDirective?.kind === "routine_step"
        ? { id: currentDirective.targetId, title: currentDirective.title }
        : undefined,
    commitment: currentCommitment ? { id: currentCommitment.id, title: currentCommitment.title } : undefined,
    sleep: currentDirective?.kind === "sleep" ? { id: currentDirective.targetId, title: "Sleep" } : undefined,
    action:
      currentDirective?.kind === "action"
        ? { id: currentDirective.targetId, title: currentDirective.title }
        : undefined,
    lastConfirmedAt: state.activeSession?.lastVerifiedAt
  });

  const pulseRecord: PulseRecordSummary | null = state.pulse
    ? {
        state: state.pulse.state,
        since: state.pulse.since,
        todayPercent: state.pulse.shares.today.onPercent,
        ...(state.pulse.disruption ? { disruption: state.pulse.disruption } : {})
      }
    : null;

  return {
    now: localiseInstant(now.toISOString(), timezone),
    timezone,
    plan,
    directive,
    answer: answerLine(directive, recommendation, timezone, now),
    recommendation,
    risks,
    ...(allRisks.length > risks.length ? { risksOmitted: allRisks.length - risks.length } : {}),
    day,
    ...(allDay.length > day.length ? { dayOmitted: allDay.length - day.length } : {}),
    anchors: answer.anchors,
    needs: answer.needs,
    upcoming,
    session,
    currentCommitment,
    nextCommitment,
    today,
    doneToday,
    ...(allDone.length > doneToday.length ? { doneTodayOmitted: allDone.length - doneToday.length } : {}),
    situation,
    checkIn,
    ...(checkInError !== undefined ? { checkInError } : {}),
    ...(addOns !== undefined ? { addOns } : {}),
    ...(catchUp !== undefined ? { catchUp } : {}),
    prepPace: planning?.result?.prepPace ?? null,
    // The recorder's own `state`, `since`, `lastConfirmedAt`, `silenceUntil` and what re-entry needs
    // sit on the resolver's `pulse`; its confirmation wins when it has one.
    pulse: pulseView
      ? (({ lastConfirmedAt: confirmed, ...rest }) => ({
          ...pulse,
          ...rest,
          ...((confirmed ?? pulse.lastConfirmedAt)
            ? { lastConfirmedAt: (confirmed ?? pulse.lastConfirmedAt) as string }
            : {})
        }))(pulseView)
      : pulse,
    pulseRecord
  };
}

function planLine(plan: PlanSummary, timezone: string, now: Date): string {
  const parts = [plan.status];
  if (plan.calculatedAt) parts.push(`calculated ${formatWhen(plan.calculatedAt, timezone, now)}`);
  if (plan.validUntil) parts.push(`valid until ${formatWhen(plan.validUntil, timezone, now)}`);
  if (plan.awaitingRecalculation) parts.push("awaiting recalculation");
  if (plan.message) parts.push(plan.message);
  return parts.join(" · ");
}

/** What to say now: the directive, plus a note that the headline is only the ranked list's when they differ. */
function answerLine(
  directive: DirectiveSummary | null,
  recommendation: { headline: string | null; primary: { targetId: string } | null },
  timezone: string,
  now: Date
): string {
  const { headline, primary } = recommendation;
  const base = directive ? directiveLine(directive, timezone, now) : "No directive is on the clock";
  // The directive is the ranked pick: one answer, nothing to add. Anything else gets the note, even an action.
  const isRankedPick = directive?.kind === "action" && primary !== null && directive.targetId === primary.targetId;
  if (isRankedPick || headline === null) return base;
  return `${base}. recommendation.headline speaks only for the ranked task list: ${headline}`;
}

function directiveLine(directive: DirectiveSummary | null, timezone: string, now: Date): string {
  if (!directive) return "none";
  switch (directive.kind) {
    case "travel": {
      const place = directive.toLocationName ?? directive.toLocationId ?? "?";
      const then = directive.then ? ` · then ${directive.then.title}` : "";
      const leave = directive.leaveBy ? ` · leave by ${formatWhen(directive.leaveBy, timezone, now)}` : "";
      const basis = directive.travelSource ? ` (${directive.travelSource})` : "";
      return `Travel to ${place} · ${directive.recommendedMinutes} min${basis}${leave}${breakFirst(directive, timezone, now)}${then}`;
    }
    case "boundary": {
      const boundaryNames: Record<string, string> = {
        daily_horizon: "the daily horizon",
        commitment: "the next commitment",
        sleep: "sleep",
        capacity: "capacity opens"
      };
      const boundaryName =
        directive.boundaryTitle ?? boundaryNames[directive.boundaryKind ?? ""] ?? directive.boundaryKind ?? "boundary";
      const at = directive.boundaryAt ? formatWhen(directive.boundaryAt, timezone, now) : "";
      const nextFit = directive.nextFit
        ? `; next: ${directive.nextFit.title} at ${formatWhen(directive.nextFit.at, timezone, now)}`
        : "";
      return directive.boundaryEdge === "end"
        ? `Nothing fits until ${boundaryName}'s protection ends at ${at}${nextFit}`
        : `Nothing fits before ${boundaryName} at ${at}${nextFit}`;
    }
    case "answer":
      return directive.question ?? directive.title;
    case "recovery":
    case "none":
      return directive.title;
    case "sleep": {
      const idSuffix = directive.targetId ? `  [${directive.targetId}]` : "";
      const until = directive.sleep ? ` · until ${formatWhen(directive.sleep.wakesAt, timezone, now)}` : "";
      const step = directive.sleep?.currentStep
        ? ` · first: ${directive.sleep.currentStep.title} (${directive.sleep.currentStep.durationMinutes} min)  [${directive.sleep.currentStep.id}]`
        : "";
      return `${directive.title} · sleep · ${directive.recommendedMinutes} min${until}${idSuffix}${step}`;
    }
    default: {
      const idSuffix = directive.targetId ? `  [${directive.targetId}]` : "";
      const projectSuffix = directive.projectTitle ? `  (${directive.projectTitle})` : "";
      return `${directive.title} · ${directive.kind} · ${directive.recommendedMinutes} min${breakFirst(directive, timezone, now)}${idSuffix}${projectSuffix}`;
    }
  }
}

/** " · after a break until 10:15": the earliest start of work still inside its break; nothing once it is over. */
function breakFirst(directive: DirectiveSummary, timezone: string, now: Date): string {
  return directive.notBefore && new Date(directive.notBefore) > now
    ? ` · after a break until ${formatWhen(directive.notBefore, timezone, now)}`
    : "";
}

/** One need: its question, whether the directive waits on it, and the command that settles it. */
function needLine(need: Need): string {
  // The question never names a session; the title is what tells two apart.
  const subject = need.fact === "session_end" ? `${need.title} · ` : "";
  return `${need.blocksDirective ? "blocking · " : ""}${subject}${need.question} (settle: ${need.answer.cli})`;
}

function whyLine(directive: DirectiveSummary, timezone: string, now: Date): string {
  if (directive.sleep) {
    const { sleep } = directive;
    const cap = sleep.wakeConstraint
      ? `Wake capped by ${sleep.wakeConstraint.title ?? "a confirmed commitment"}`
      : "No confirmed commitment caps this wake; an alarm or plan the engine has not been told about is not counted";
    return `${sleep.explanation} Preferred wake ${sleep.preferredWakeTime}; planned wake ${formatWhen(sleep.wakesAt, timezone, now)}. ${cap}.`;
  }
  const tier = directive.tier ? `  (tier: ${directive.tier})` : "";
  return `${directive.reason}${tier}`;
}

function whyNotLine(recommendation: RecommendationAnswer): string | null {
  const { whyNot } = recommendation;
  return whyNot ? `${whyNot.title}: ${whyNot.reason} (decided by ${whyNot.decidingFactor.replace(/_/g, " ")})` : null;
}

function wouldChangeLines(recommendation: RecommendationAnswer): string[] {
  return recommendation.wouldChangeIf.map(
    (item) =>
      `${item.description}: ${item.thenPrimary ? `${item.thenPrimary.title} for ${item.thenPrimary.recommendedMinutes} min` : "nothing would lead"}`
  );
}

function endsLine(recommendation: RecommendationAnswer, timezone: string, now: Date): string | null {
  if (!recommendation.plannedEnd) return null;
  const fits = recommendation.fitsBefore;
  const before = fits
    ? fits.spareMinutes >= 0
      ? ` · fits before ${fits.title} at ${formatWhen(fits.startsAt, timezone, now)}, ${fits.spareMinutes} min to spare`
      : ` · ${fits.title} starts at ${formatWhen(fits.startsAt, timezone, now)}`
    : "";
  return `${formatWhen(recommendation.plannedEnd, timezone, now)}${before}`;
}

function riskLine(risk: RiskSummary, timezone: string, now: Date): string {
  switch (risk.kind) {
    case "project": {
      const health = risk.lapsed ? "date lapsed" : `${risk.health.replace("_", " ")}${risk.overdue ? ", overdue" : ""}`;
      const margin = risk.marginMinutes === null ? "" : ` · margin ${risk.marginMinutes} min`;
      const fix = risk.smallestFix ? ` · smallest fix: ${risk.smallestFix.reason}` : "";
      return `${risk.title} · ${health}${margin}${fix}  [${risk.projectId}]`;
    }
    case "step_start_by":
      return `${risk.title} for ${risk.anchorTitle} · start by ${formatWhen(risk.startBy, timezone, now)} (${risk.status})  [${risk.stepId}]`;
    case "prep_pace": {
      const late = risk.projectedLateMinutes ? `, ${risk.projectedLateMinutes} min late` : "";
      return `Prep for ${risk.title} · ${risk.status}, ${risk.minutesBehind} min behind${late}`;
    }
  }
}

function dayLine(entry: DayEntry, timezone: string, now: Date): string {
  const id = entry.targetId ? `  [${entry.targetId}]` : "";
  const projected = entry.confidence === "projected" ? " (projected)" : "";
  return `${formatWhen(entry.startsAt, timezone, now)}–${formatWhen(entry.endsAt, timezone, now)} · ${entry.title} · ${entry.kind}${projected}${id}`;
}

function stayUpLine(recommendation: RecommendationAnswer, timezone: string, now: Date): string | null {
  const offer = recommendation.stayUpOffer;
  if (!offer) return null;
  const choices = offer.choices.map((item) => `+${item.minutes} min (wake ${formatWhen(item.wakeAt, timezone, now)})`);
  return `${offer.projectTitle} is ${offer.minutesBehind} min behind: stay up for ${offer.actionTitle}? ${choices.join(", ")}`;
}

function sessionLines(session: SessionSummary | null, timezone: string, now: Date): string[] {
  if (!session) return ["none"];
  // A paused session has no end time to speak of: it moves out as long as the pause lasts.
  const tail =
    session.status === "paused"
      ? `${session.minutesLeft} min left when resumed`
      : `ends ${formatWhen(session.plannedEndAt, timezone, now)}`;
  return [
    `${session.status} · ${session.title} · started ${formatWhen(session.startedAt, timezone, now)} · ` +
      `${session.elapsedMinutes} of ${session.plannedMinutes} min · ${tail}  [${session.id}]`
  ];
}

function upcomingLine(item: UpcomingSummary, timezone: string, now: Date): string {
  const at = item.at ? `  at ${formatWhen(item.at, timezone, now)}` : "";
  return `${item.title} · ${item.recommendedMinutes} min  [${item.targetId}]${at}`;
}

function commitmentText(commitment: CommitmentSummary, timezone: string, now: Date): string {
  const count = commitment.pendingRoutineSteps;
  const prep = count > 0 ? ` · ${count} prep step${count === 1 ? "" : "s"} pending` : "";
  const location = commitment.location ? ` · ${commitment.location}` : "";
  const disruption = commitment.origin === "disruption" ? " (disruption)" : "";
  const anchor =
    commitment.anchorState === "open"
      ? ` · hour open (engage: activity start --type fixed_commitment --target ${commitment.id} --phase active --minutes <n>)`
      : commitment.anchorState === "engaged"
        ? " · engaged (free: activity finish)"
        : "";
  const leave = commitment.journey?.leaveBy
    ? ` · leave by ${formatWhen(commitment.journey.leaveBy, timezone, now)}`
    : "";
  const trip = commitment.journey?.before
    ? ` · ${commitment.journey.before.minutes} min from ${commitment.journey.before.from} (${commitment.journey.before.source})`
    : commitment.journey?.gap
      ? ` · no travel estimate (${commitment.journey.gap})`
      : "";
  return (
    `${commitment.title}${disruption} · ${formatWhen(commitment.startsAt, timezone, now)}` +
    `–${formatWhen(commitment.endsAt, timezone, now)}${location}${trip}${leave}${anchor}${prep}  [${commitment.id}]`
  );
}

function commitmentLines(
  current: CommitmentSummary | null,
  next: CommitmentSummary | null,
  timezone: string,
  now: Date
): string[] {
  const lines: string[] = [];
  if (current) lines.push(`now: ${commitmentText(current, timezone, now)}`);
  if (next) lines.push(`next: ${commitmentText(next, timezone, now)}`);
  return lines.length ? lines : ["none"];
}

function todayLines(today: TodaySummary): string[] {
  const items = today.items.map((item) => `[${item.done ? "x" : " "}] ${item.title}`).join("  ");
  const lines = [items || "(none)"];
  if (today.deferred.length)
    lines.push(`deferred: ${today.deferred.map((item) => `${item.title} (${item.reason})`).join(", ")}`);
  return lines;
}

function doneTodayLine(item: DoneTodaySummary): string {
  return `${item.title} · ${item.result} · ${item.activeMinutes} min`;
}

function situationLine(situation: SituationSummary): string {
  const place = situation.locationName ? `at ${situation.locationName}` : "location unknown";
  const conditions = situation.conditions.length ? situation.conditions.join(", ") : "none";
  return `${place} · conditions ${conditions} · energy ${situation.energy}`;
}

function pulseRecordLine(pulse: PulseRecordSummary | null, timezone: string, now: Date): string {
  if (!pulse) return "not recorded yet";
  const since = formatWhen(pulse.since, timezone, now);
  const today = pulse.todayPercent === null ? "n/a" : `${pulse.todayPercent}%`;
  const base = `${pulse.state} · since ${since} · today ${today}`;
  const d = pulse.disruption;
  if (!d) return base;
  return `${base} · disrupted: ${d.doing} until ${formatWhen(d.until, timezone, now)} at ${d.locationId} (${
    d.exclusive ? "takes all of you" : "could still do other things"
  }; available: ${d.contexts.join(", ")})`;
}

/**
 * "Prep   behind by 7 min for Maths Online at 10:00 · arrive ~10:05 (5 min late)" — null only when no
 * commitment is being prepped for. The arrival clause is appended only when the engine's forward
 * simulation reports `projectedArriveAt` (the routine step timing design note, "Warnings and arrival
 * projection"); the "(N min late)" suffix only when `projectedLateMinutes` is positive.
 */
function prepPaceLine(prepPace: PrepPace | null, timezone: string, now: Date): string | null {
  if (!prepPace) return null;
  const at = formatWhen(prepPace.commitmentStartsAt, timezone, now);
  const base = (() => {
    switch (prepPace.status) {
      case "behind":
        return `behind by ${prepPace.minutesBehind} min for ${prepPace.commitmentTitle} at ${at}`;
      case "tight":
        return `tight, ${prepPace.availableMinutes - prepPace.requiredMinutes} min spare for ${prepPace.commitmentTitle} at ${at}`;
      default:
        return `on track for ${prepPace.commitmentTitle} at ${at}`;
    }
  })();
  if (!prepPace.projectedArriveAt) return base;
  const arrive = formatWhen(prepPace.projectedArriveAt, timezone, now);
  const late = prepPace.projectedLateMinutes ?? 0;
  return `${base} · arrive ~${arrive}${late > 0 ? ` (${late} min late)` : ""}`;
}

function checkInLine(checkIn: unknown, checkInError: string | undefined): string {
  if (checkInError) return `unavailable (${checkInError})`;
  if (!checkIn || typeof checkIn !== "object") return "none";
  const record = checkIn as Record<string, unknown>;
  const title =
    typeof record.directiveTitle === "string"
      ? record.directiveTitle
      : typeof record.directive_title === "string"
        ? record.directive_title
        : "check-in";
  const id = typeof record.id === "string" ? record.id : "";
  return `pending: ${title}${id ? `  [${id}]` : ""}`;
}

/** Non-off add-ons by mode; an agent needs to see a switch it cannot set. */
function addOnsLine(addOns: Record<string, string>): string {
  const active = Object.entries(addOns).filter(([, mode]) => mode !== "off");
  return active.length
    ? `${active.map(([addon, mode]) => `${addon} ${mode}`).join(", ")} (all others off)`
    : "all off (only the owner switches them on, in Settings > Add-ons and sign-in)";
}

function catchUpText(line: CatchUpLine, timezone: string, now: Date): string {
  const since = line.since === null ? "never" : formatWhen(line.since, timezone, now);
  return line.state === "due"
    ? `due: away since ${since}, ${line.unsettled} to settle, ${line.staleDates} stale date${line.staleDates === 1 ? "" : "s"} (rhen catch-up)`
    : "none";
}

function renderStatusTable(summary: StatusSummary, timezone: string, now: Date): string {
  const rows: [string, string[]][] = [["Plan", [planLine(summary.plan, timezone, now)]]];
  // Before Now: a stale fact is why Now may be wrong, or blocked, so it is read first.
  if (summary.needs.length) rows.push(["Needs", summary.needs.map(needLine)]);
  rows.push(["Now", [directiveLine(summary.directive, timezone, now)]]);
  if (summary.directive?.reason || summary.directive?.sleep)
    rows.push(["Why", [whyLine(summary.directive, timezone, now)]]);
  const rec = summary.recommendation;
  const whyNot = whyNotLine(rec);
  if (whyNot) rows.push(["Why not", [whyNot]]);
  const wouldChange = wouldChangeLines(rec);
  if (wouldChange.length) rows.push(["Would change", wouldChange]);
  const ends = summary.session ? null : endsLine(rec, timezone, now);
  if (ends) rows.push(["Ends", [ends]]);
  if (rec.runnerUp)
    rows.push([
      "Runner-up",
      [`${rec.runnerUp.title} · ${rec.runnerUp.recommendedMinutes} min  [${rec.runnerUp.targetId}]`]
    ]);
  if (rec.sleep?.hardErrors.length) rows.push(["Sleep", rec.sleep.hardErrors]);
  const stayUp = stayUpLine(rec, timezone, now);
  if (stayUp) rows.push(["Stay up", [stayUp]]);
  rows.push(["Session", sessionLines(summary.session, timezone, now)]);
  if (summary.upcoming.length)
    rows.push(["Up next", summary.upcoming.map((item) => upcomingLine(item, timezone, now))]);
  rows.push(["Commitment", commitmentLines(summary.currentCommitment, summary.nextCommitment, timezone, now)]);
  const prepLine = prepPaceLine(summary.prepPace, timezone, now);
  if (prepLine) rows.push(["Prep", [prepLine]]);
  if (summary.today) rows.push(["Today", todayLines(summary.today)]);
  if (summary.doneToday.length)
    rows.push([
      "Done today",
      [
        ...(summary.doneTodayOmitted ? [`${summary.doneTodayOmitted} earlier (rhen history)`] : []),
        ...summary.doneToday.map(doneTodayLine)
      ]
    ]);
  if (summary.risks.length)
    rows.push([
      "Risks",
      [
        ...summary.risks.map((risk) => riskLine(risk, timezone, now)),
        ...(summary.risksOmitted ? [`and ${summary.risksOmitted} more`] : [])
      ]
    ]);
  if (summary.day.length)
    rows.push([
      "Day",
      [
        ...summary.day.map((entry) => dayLine(entry, timezone, now)),
        ...(summary.dayOmitted ? [`and ${summary.dayOmitted} more blocks`] : [])
      ]
    ]);
  rows.push(["Situation", [situationLine(summary.situation)]]);
  rows.push(["Check-in", [checkInLine(summary.checkIn, summary.checkInError)]]);
  rows.push(["Pulse", [pulseRecordLine(summary.pulseRecord, timezone, now)]]);
  if (summary.pulse.reentry?.due)
    rows.push(["Re-entry", [`required: rhen reenter (still needed: ${summary.pulse.reentry.missing.join("; ")})`]]);
  if (summary.catchUp?.state === "due") rows.push(["Catch-up", [catchUpText(summary.catchUp, timezone, now)]]);
  if (summary.addOns) rows.push(["Add-ons", [addOnsLine(summary.addOns)]]);

  const width = Math.max(...rows.map(([label]) => label.length));
  const lines: string[] = [];
  for (const [label, values] of rows)
    values.forEach((value, index) => {
      const prefix = index === 0 ? label.padEnd(width) : " ".repeat(width);
      lines.push(`${prefix}  ${value}`);
    });
  return lines.join("\n");
}

const CLOSED_STATUSES = new Set(["done", "completed", "cancelled", "skipped", "archived", "ended", "abandoned"]);
const BRIEF_NEXT_COUNT = 3;
const BRIEF_DEADLINE_HOURS = 48;
const BRIEF_DEADLINE_CAP = 10;

interface BriefDeadline {
  kind: "action" | "project" | "outcome" | "deliverable";
  id: string;
  title: string;
  at: string;
  overdue: boolean;
}

/** Open work whose deadline falls within the next 48 hours, plus anything already past its deadline, soonest first. */
function briefDeadlines(state: PortalState, now: Date): BriefDeadline[] {
  const horizon = now.getTime() + BRIEF_DEADLINE_HOURS * 3_600_000;
  const sources: { kind: BriefDeadline["kind"]; items: unknown; field: string }[] = [
    { kind: "action", items: state.actions, field: "deadlineAt" },
    { kind: "project", items: state.projects, field: "externalDeadlineAt" },
    { kind: "outcome", items: state.outcomes, field: "deadlineAt" },
    { kind: "deliverable", items: state.deliverables, field: "externalDeadlineAt" }
  ];
  const found: BriefDeadline[] = [];
  for (const { kind, items, field } of sources) {
    for (const item of Array.isArray(items) ? (items as Record<string, unknown>[]) : []) {
      const at = item[field];
      const status = item.status;
      if (typeof at !== "string" || typeof item.id !== "string") continue;
      if (typeof status === "string" && CLOSED_STATUSES.has(status)) continue;
      const time = new Date(at).getTime();
      if (Number.isNaN(time) || time > horizon) continue;
      found.push({
        kind,
        id: item.id,
        title: String(item.title ?? item.id),
        at,
        overdue: time < now.getTime()
      });
    }
  }
  found.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  return found.slice(0, BRIEF_DEADLINE_CAP);
}

/**
 * `status --brief`: the few facts a small context needs to decide what to say next — what has gone
 * stale and has to be told again, the next three things to do, the running session and the next
 * commitment (minutes away), minutes until planned sleep, deadlines due within 48 hours, and how many
 * captures wait in the inbox.
 */
function buildBrief(summary: StatusSummary, state: PortalState, now: Date) {
  const next: { kind: string; title: string; recommendedMinutes: number; targetId?: string; at?: string }[] = [];
  if (summary.directive)
    next.push({
      kind: summary.directive.kind,
      title: summary.directive.title,
      recommendedMinutes: summary.directive.recommendedMinutes,
      ...(summary.directive.targetId !== undefined ? { targetId: summary.directive.targetId } : {})
    });
  for (const item of summary.upcoming) {
    if (next.length >= BRIEF_NEXT_COUNT) break;
    if (next.some((entry) => entry.targetId !== undefined && entry.targetId === item.targetId)) continue;
    next.push({
      kind: item.kind,
      title: item.title,
      recommendedMinutes: item.recommendedMinutes,
      targetId: item.targetId,
      ...(item.at !== undefined ? { at: item.at } : {})
    });
  }
  const sleep = state.sleepPlans
    .filter((plan) => plan.status !== "cancelled" && new Date(plan.plannedStartAt) > now)
    .sort((a, b) => new Date(a.plannedStartAt).getTime() - new Date(b.plannedStartAt).getTime())[0];
  const nextCommitment = summary.nextCommitment;
  return {
    now: summary.now,
    timezone: summary.timezone,
    plan: summary.plan.status,
    // The digest an agent reads right after a write: without these a pre-write plan reads as current.
    awaitingRecalculation: summary.plan.awaitingRecalculation,
    calculatedAt: summary.plan.calculatedAt,
    answer: summary.answer,
    headline: summary.recommendation.headline,
    needs: summary.needs,
    reason: summary.directive?.reason ?? null,
    plannedEnd: summary.recommendation.plannedEnd,
    next,
    session: summary.session
      ? { title: summary.session.title, status: summary.session.status, minutesLeft: summary.session.minutesLeft }
      : null,
    currentCommitment: summary.currentCommitment
      ? {
          title: summary.currentCommitment.title,
          endsAt: summary.currentCommitment.endsAt,
          ...(summary.currentCommitment.sourceType !== undefined
            ? { sourceType: summary.currentCommitment.sourceType }
            : {})
        }
      : null,
    nextCommitment: nextCommitment
      ? {
          title: nextCommitment.title,
          startsAt: nextCommitment.startsAt,
          minutesAway: minutesBetween(now, new Date(nextCommitment.startsAt)),
          ...(nextCommitment.sourceType !== undefined ? { sourceType: nextCommitment.sourceType } : {})
        }
      : null,
    minutesUntilSleep: sleep ? minutesBetween(now, new Date(sleep.plannedStartAt)) : null,
    deadlinesWithin48h: briefDeadlines(state, now),
    inboxPending: state.captures.filter((capture) => capture.status === "pending").length,
    risks: summary.risks.length + (summary.risksOmitted ?? 0),
    ...(summary.catchUp !== undefined ? { catchUp: summary.catchUp } : {}),
    ...(summary.pulse.state !== undefined
      ? {
          pulse: {
            state: summary.pulse.state,
            since: summary.pulse.since,
            lastConfirmedAt: summary.pulse.lastConfirmedAt ?? null,
            silenceUntil: summary.pulse.silenceUntil ?? null,
            reentry: summary.pulse.reentry
          }
        }
      : {})
  };
}

function renderBriefTable(brief: ReturnType<typeof buildBrief>, timezone: string, now: Date): string {
  const rows: [string, string][] = [
    ["Plan", brief.awaitingRecalculation ? `${brief.plan} · awaiting recalculation` : brief.plan]
  ];
  brief.needs.forEach((need, index) => rows.push([index === 0 ? "Needs" : "", needLine(need)]));
  brief.next.forEach((item, index) =>
    rows.push([index === 0 ? "Next" : "", `${item.title} · ${item.kind} · ${item.recommendedMinutes} min`])
  );
  if (brief.session) rows.push(["Session", `${brief.session.title} · ${brief.session.minutesLeft} min left`]);
  if (brief.nextCommitment)
    rows.push([
      "Commitment",
      `${brief.nextCommitment.title} in ${brief.nextCommitment.minutesAway} min (${formatWhen(brief.nextCommitment.startsAt, timezone, now)})`
    ]);
  if (brief.minutesUntilSleep !== null) rows.push(["Sleep in", `${brief.minutesUntilSleep} min`]);
  brief.deadlinesWithin48h.forEach((item, index) =>
    rows.push([
      index === 0 ? "Deadlines" : "",
      `${item.title} · ${item.kind} · ${item.overdue ? "overdue, was " : ""}${formatWhen(item.at, timezone, now)}`
    ])
  );
  if (brief.catchUp?.state === "due") rows.push(["Catch-up", catchUpText(brief.catchUp, timezone, now)]);
  if (brief.risks) rows.push(["Risks", `${brief.risks} (rhen status for the list)`]);
  rows.push(["Inbox", `${brief.inboxPending} pending`]);
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join("\n");
}

export const statusCommand: CommandSpec = {
  name: "status",
  summary: "What to do now, what is running, and what is next",
  description:
    "What to do now and why, as the Now page shows it from the same planning run: the plan's freshness, what has " +
    "gone stale and has to be told again (needs, each with the exact call that settles it in answer.call (replace each " +
    "<placeholder>; answer.action is only a label) and whether the " +
    "directive waits on it), the engine's directive with its reason, why not the runner-up, what would change it, when it " +
    "ends, tonight's sleep errors and stay-up offer; then what is at risk, the rest of today hour by hour, the " +
    "active session, commitments, what is done and any pending check-in. Read this rather than state. Reading the " +
    "check-in marks it as prompted, exactly as opening the portal does. Tell the person `answer`: it is the directive " +
    "on the clock; recommendation.headline speaks only for the ranked task list and can say nothing fits while the " +
    "directive is a routine step.",
  positionals: [],
  options: {
    brief: {
      type: "boolean",
      description:
        "A compact digest for a small context: plan freshness, the next three things to do, session and next " +
        "commitment timing, minutes until sleep, deadlines within 48 hours, the risk count and the inbox count"
    }
  },
  mutates: false,
  examples: ["status", "status --json", "status --brief --json"],
  async run(context: CommandContext, args: ParsedArgs) {
    const state = await context.client.getState();
    const brief = booleanOption(args.values, "brief");
    let checkIn: unknown = null;
    let checkInError: string | undefined;
    // Reading the current check-in marks it as prompted, so the digest — which never shows it — leaves it alone.
    if (!brief) {
      try {
        const response = await context.client.get<{ checkIn: unknown }>("/api/check-ins/current");
        checkIn = response?.checkIn ?? null;
      } catch (error) {
        checkIn = null;
        checkInError = error instanceof Error ? error.message : String(error);
      }
    }

    let addOns: Record<string, string> | undefined;
    if (!brief) {
      try {
        const map = await context.client.get<{ switches?: { addon: string; mode: string }[] }>("/api/plan-map");
        if (Array.isArray(map?.switches))
          addOns = Object.fromEntries(map.switches.map((item) => [item.addon, item.mode]));
      } catch {
        // Add-on modes are context, not the answer; a failed read must not fail `status`.
      }
    }

    let catchUp: CatchUpLine | undefined;
    try {
      const ledger = catchUpLedgerSchema.parse(await context.client.get<unknown>("/api/catch-up"));
      catchUp = {
        state: catchUpDue(ledger) ? "due" : "none",
        since: ledger.since,
        unsettled: ledger.unsettled,
        staleDates: ledger.staleDates
      };
    } catch {
      // Catch-up is context for the answer, not the answer; a failed read must not fail `status`.
    }

    let pulseView: PulseReentryView | undefined;
    try {
      const read = await context.client.get<{ pulse?: PulseReentryView | null }>("/api/pulse/reentry?brief=1");
      if (read?.pulse) pulseView = read.pulse;
    } catch {
      // The pulse is context for the answer, not the answer; a failed read must not fail `status`.
    }

    const now = context.now();
    const summary = buildSummary(state, checkIn, checkInError, now, addOns, catchUp, pulseView);

    // The directive, the day and upcoming show commitment titles by id only; list the calendar-sourced ids so
    // the MCP result can fence those titles (see outside-text.ts). `outsideText` exists only for the MCP fence,
    // which removes it from the result it returns. Absent when the plan has none.
    const outside = outsideCommitments(state.commitments, new Date(now.getTime() - 24 * 3_600_000));
    const outsideText = outside.commitmentIds.length > 0 ? { [OUTSIDE_IDS_KEY]: outside } : {};

    if (brief) {
      const digest = buildBrief(summary, state, now);
      if (context.mode !== "table")
        context.stdout(toJson(localiseInstants({ ...digest, ...outsideText }, summary.timezone), true));
      else context.stdout(renderBriefTable(digest, summary.timezone, now));
      return;
    }

    if (context.mode !== "table")
      context.stdout(toJson(localiseInstants({ ...summary, ...outsideText }, summary.timezone), true));
    else context.stdout(renderStatusTable(summary, summary.timezone, now));
  }
};
