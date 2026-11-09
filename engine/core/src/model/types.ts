import type {
  ActionStatus,
  CommitmentRepeat,
  ConditionMatch,
  EnergyType,
  ProjectHealth,
  RequirementPathway,
  TransportMode,
  TravelSource,
  Uncertainty
} from "@openrhen/contracts";
import type { EnergyCost } from "../recommendation/energy-cost.js";
import type { StretchOffer } from "../recommendation/stretch.js";
import { commitmentTimeline } from "./commitment-timeline.js";
import type { CommitmentTimeline } from "./commitment-timeline.js";

export interface PlanningConfig {
  uncertaintyMultipliers: Record<Uncertainty, number>;
  riskMarginRatio: number;
  aheadMarginRatio: number;
  aheadVariance: number;
  forecastHorizonDays: number;
  horizonBands: HorizonBandConfig[];
  /**
   * How many local days the forward day plan simulates, each to its own daily planning horizon.
   * One is the rest of today; the loop is the same for more, so a week outlook can turn it up later.
   */
  dayPlanDays: number;
}

export type HorizonBandKind = "detailed" | "daily" | "weekly" | "fortnightly" | "monthly";
export type ForecastConfidence = "high" | "medium_high" | "medium" | "low_medium" | "low";
export interface HorizonBandConfig {
  kind: HorizonBandKind;
  startDay: number;
  endDay: number;
  capacityFactor: number;
  confidence: ForecastConfidence;
}

export const defaultPlanningConfig: PlanningConfig = {
  uncertaintyMultipliers: { known: 1.15, some: 1.35, high: 1.6 },
  riskMarginRatio: 0.2,
  aheadMarginRatio: 0.5,
  aheadVariance: 0.1,
  forecastHorizonDays: 180,
  dayPlanDays: 1,
  horizonBands: [
    { kind: "detailed", startDay: 0, endDay: 7, capacityFactor: 1, confidence: "high" },
    { kind: "daily", startDay: 7, endDay: 14, capacityFactor: 0.9, confidence: "medium_high" },
    { kind: "weekly", startDay: 14, endDay: 30, capacityFactor: 0.8, confidence: "medium" },
    { kind: "fortnightly", startDay: 30, endDay: 90, capacityFactor: 0.65, confidence: "low_medium" },
    { kind: "monthly", startDay: 90, endDay: 180, capacityFactor: 0.5, confidence: "low" }
  ]
};

export interface TimeRange {
  startsAt: Date;
  endsAt: Date;
}

export type CapacityEnergy = EnergyType | "unconfirmed";

export interface CapacityWindow extends TimeRange {
  id: string;
  energy: CapacityEnergy;
  usableFraction: number;
  contexts?: string[];
}

/**
 * Minutes to be at a place before a commitment starts. Travel is additive, not folded into the setup
 * buffer: you get ready (setup), travel, arrive with this margin, then start.
 *
 * A real setting now (`state.settings.arrivalMarginMinutes`), not a constant — every function below
 * that once read this module-level value directly now takes it as an explicit parameter, threaded
 * down from wherever `state`/`WireState` is in scope, the same way `submissionBufferMinutes` and
 * `timezone` already are. This is only the fallback: the default a caller reaches for when it has
 * none of its own, and the value baked into every test and dead-code path that predates the setting.
 */
export const ARRIVAL_MARGIN_MINUTES = 2;

/**
 * Default gap owed after an exact session reaches `maximumSessionMinutes`, for a caller that has no
 * `sessionBreakMinutes` of its own — the fallback a test or a dead-code path reaches for, mirroring
 * `ARRIVAL_MARGIN_MINUTES`. Production always supplies `state.settings.sessionBreakMinutes`, whose
 * own schema default (15) this matches.
 */
export const SESSION_BREAK_MINUTES = 15;

/** One journey a commitment requires, as the plan resolved it. */
export interface CommitmentTravelLeg {
  fromLocationId: string;
  toLocationId: string;
  /** Allowing: the planned figure. */
  minutes: number;
  mode?: TransportMode;
  source: TravelSource;
  /** The tier's median (or the live/fallback figure), for display beside the allowing minutes. */
  typicalMinutes: number;
  /** How many samples the figure rests on; 0 for a fallback, assumed or estimated journey. */
  sampleCount: number;
  /** Set when the leg starts from an assumed origin rather than a confirmed live location. */
  originAssumed?: boolean;
  /** What the journey serves, when that is something other than the commitment carrying the leg. */
  anchor?: { kind: "commitment" | "sleep"; targetId: string; title: string; recommendedMinutes: number };
}

/**
 * What being at a commitment costs.
 *
 * `blocking` takes the hour outright. `anchor` takes exactly as much of the *plan*: capacity, the day
 * plan and the forward replay subtract an anchor's protected window identically, because no plan can
 * know in advance which obligations will leave gaps. The difference is live only — being present at
 * something is not the same as being taken up by it, so an anchor's own window reopens for other work
 * at the moment it is happening, until an engagement session says otherwise.
 */
export type CommitmentPresence = "blocking" | "anchor";

export interface FixedCommitment extends TimeRange {
  id: string;
  title?: string;
  status?: string;
  location?: string;
  /** The location context the commitment happens at; `location` is only a label. */
  locationId?: string;
  /** Absent means `blocking`, which is what every commitment was before presence existed. */
  presence?: CommitmentPresence;
  setupBeforeMinutes?: number;
  transitionAfterMinutes?: number;
  /**
   * The journey to and from this commitment, when the projection says one is required. Both extend
   * the protected window and therefore come off capacity, exactly as setup and transition do.
   */
  travelBeforeMinutes?: number;
  travelAfterMinutes?: number;
  travelBefore?: CommitmentTravelLeg;
  travelAfter?: CommitmentTravelLeg;
  /**
   * The journey there could not be worked out, so `travelBeforeMinutes` is the engine's assumed figure
   * (`ASSUMED_TRAVEL_MINUTES`), not an estimate. Unknown travel is not zero travel.
   */
  travelBeforeUnknown?: boolean;
  recurrenceRuleId?: string;
  localDate?: string;
  projectId?: string;
  /**
   * Set only on a range derived from a `flexible` before-phase routine step: the instant its
   * `maxLeadMinutes` lead window opens (parent commitment start minus the lead). A step whose window
   * is already open before a night's bedtime may be done the evening before, so the sleep planner's
   * wake constraint skips it (`resolveSleepWindow`); every other consumer of protected ranges still
   * treats the step's scheduled slot as protected.
   */
  flexibleLeadOpensAt?: Date;
  /**
   * The actual end of a tracked session against this commitment, when it ran (or is still running)
   * later than the scheduled `endsAt` — the latest finished session's own end, or, while a session
   * against it is still open past `endsAt`, the live instant itself (`engine.ts` resolves both from
   * `state.commitments[].trackedEndedAt` and `state.activeSession`). Read through
   * `commitmentTimeline` (`commitment-timeline.ts`), never directly: a value at or before `endsAt`
   * must count for nothing, which that function is the one place that guarantees;
   * `effectiveCommitmentEnd` below is its projection. A shift tracked
   * 38 minutes past its scheduled end left both the protected window and the after-routine chain
   * computed against the stale scheduled end, so the after-steps' window had already elapsed and the
   * commitment read as long since unprotected while the person was still there.
   */
  trackedEndedAt?: Date;
  /**
   * "I'm free": the instant the person released the rest of this occurrence (`commitments.freed_from`).
   * From then until the effective end `openAnchorsNow` hands the active phase to the live ranking,
   * whatever the presence, an open tracking session or running late; setup, travel and the transition
   * after stay protected. Nothing is ended or finished. Absent means not freed.
   */
  freedFrom?: Date;
  /**
   * Whether lateness to this commitment matters. Stored and carried on the timeline
   * (`commitmentTimeline`'s `latenessMatters`, defaulting to `true` when absent); the situation
   * projection reads it to pick the journey caution for the leave-by estimate.
   */
  latenessMatters?: boolean;
  /**
   * How the person gets to this commitment, when chosen. Stored; the situation projection passes it
   * to the travel estimate for the journey to this commitment.
   */
  transportMode?: TransportMode;
  /**
   * The slug of a `condition_definitions` row of kind `contact` this commitment is with, when set.
   * Stored and copied through (including onto recurrence occurrences); the engine does not rank on
   * it, the portal uses it to offer letting that contact know.
   */
  contactId?: string;
  /**
   * How the person takes part. Absent means `in_person`. A `remote` commitment has no journey: no
   * travel leg is planned to it and leave-by never fires (`isRemote`), and `preferredLocationId` is
   * a preference, not the requirement `locationId` is for an in-person one.
   */
  attendance?: CommitmentAttendance;
  /** A location condition slug preferred for a remote commitment; never a requirement. */
  preferredLocationId?: string;
}

export type CommitmentAttendance = "in_person" | "remote";

/** Whether the person attends this commitment remotely, so there is nowhere to travel to. */
export function isRemoteCommitment(commitment: { attendance?: CommitmentAttendance }): boolean {
  return commitment.attendance === "remote";
}

/**
 * The instant a commitment's protection and after-phase machinery should treat as "actually ended":
 * the later of its scheduled `endsAt` and any known overtime (`trackedEndedAt`). A commitment with no
 * tracked overtime — everyone before this field existed, and the ordinary on-time or early case —
 * gets back exactly `endsAt`, unchanged.
 */
export function effectiveCommitmentEnd(commitment: FixedCommitment): Date {
  // `effectiveEndsAt` needs only `trackedEndedAt`, not legs, so the margin passed here never affects
  // the answer — see `commitment-timeline.ts`'s "What needs legs".
  return commitmentTimeline(commitment, 0).effectiveEndsAt;
}

/**
 * Whether the person has said they are free from this commitment, and that still holds at `now`: the
 * statement has been made (`freedFrom <= now`) and the commitment has not yet reached its effective end.
 * One predicate for the open-anchor path, the directive's step search and the pulse.
 */
export function isFreedNow(commitment: FixedCommitment, now: Date): boolean {
  if (!commitment.freedFrom || commitment.freedFrom > now || commitment.startsAt > now) return false;
  return effectiveCommitmentEnd(commitment) > now;
}

/**
 * The whole interval a commitment protects: setup, then the journey and its arrival margin, then the
 * commitment, then transition, then the journey onward. One definition, because capacity subtraction,
 * slot normalization, sleep's wake constraint, the boundary naming and the live directive must all
 * read the same edges — a leg protected in one place and ignored in another is capacity counted twice.
 *
 * The "after" edge chains from `effectiveCommitmentEnd`, not the bare `endsAt`, so tracked overtime
 * (see `FixedCommitment.trackedEndedAt`) keeps the commitment protected for the same
 * transition/travel allowance measured from when it actually ended, rather than one that had already
 * elapsed while the person was still there.
 *
 * A projection of `commitmentTimeline`: exactly `[setupStartsAt, protectedUntil]` of the commitment's
 * timeline, for every commitment (the property the unit sweep in `commitment-protection.test.ts` checks).
 */
export function commitmentProtection(commitment: FixedCommitment, arrivalMarginMinutes: number): TimeRange {
  const timeline = commitmentTimeline(commitment, arrivalMarginMinutes);
  return { startsAt: timeline.setupStartsAt, endsAt: timeline.protectedUntil };
}

/** The journey plus its arrival margin. No journey means no margin: you are already there. */
export function travelLeadMinutes(commitment: FixedCommitment, arrivalMarginMinutes: number): number {
  const timeline = commitmentTimeline(commitment, arrivalMarginMinutes);
  return (timeline.startsAt.getTime() - (timeline.leaveBy ?? timeline.startsAt).getTime()) / 60_000;
}

/** The minimal shape of a routine step needed to judge whether a commitment is running late. */
export interface RoutineStepStatus {
  // Optional: a sleep-anchored step carries no
  // `commitmentId` at all, and `step.commitmentId === commitmentId` below already excludes it (a real
  // commitment id is never `undefined`) without this field needing to require it. `| undefined`
  // spelled out because `exactOptionalPropertyTypes` distinguishes an optional property from one
  // whose value may explicitly be `undefined`, which is what the wire schema's `.optional()` output
  // actually produces for a caller's array element.
  commitmentId?: string | undefined;
  phase: "before" | "after";
  status: string;
  /**
   * The remaining fields are optional and unused by `beforeStepsComplete`/`isRunningLate` above; they
   * exist only so `recommend()`'s early-step gate (the routine step timing design note, "Flexible
   * steps offered early") can look a candidate's own prerequisites up by id in the very same array
   * every caller already threads through as `RecommendArguments.routineSteps` — real callers (the
   * engine's `derivedState.routineSteps`, the day plan's `simulatedState.routineSteps`) always carry
   * every one of these, so widening the type costs nothing at any existing call site.
   */
  id?: string | undefined;
  dependencyIds?: string[] | undefined;
  /** ISO timestamp; a wait runs from here. */
  completedAt?: string | undefined;
  waitAfterMinutes?: number | undefined;
  /** ISO timestamp; feeds `earliestRoutineWindowStart` for the arrival-mootness check. */
  scheduledStartAt?: string | null | undefined;
}

/** Whether every before-phase routine step of a commitment is done (or moot, i.e. cancelled). */
export function beforeStepsComplete(commitmentId: string, routineSteps: readonly RoutineStepStatus[]): boolean {
  const incomplete = new Set(["pending", "doing", "blocked"]);
  return routineSteps
    .filter((step) => step.commitmentId === commitmentId && step.phase === "before")
    .every((step) => !incomplete.has(step.status));
}

/**
 * Whether a located commitment has actually been reached, judged only against the
 * asserted/confirmed location, never a projected one — a projection assumes the day went as
 * planned, which is exactly what is false when running late. A stale or unknown location
 * (`arrivedLocationId: null`) counts as "not arrived". A place-less commitment has nothing to
 * arrive at, so this is always `false` for one — callers that mean "and hasn't arrived" should
 * gate a place-less commitment on its steps alone instead, as `isRunningLate` does below.
 *
 * Shared by `isRunningLate` and by `resolveProtectedCommitment` (recommend.ts), which applies the
 * same arrival check before the commitment's own start (pre-start setup/travel/arrival phases),
 * where `isRunningLate`'s own clock guard does not apply.
 */
export function hasArrivedAtCommitment(commitment: FixedCommitment, arrivedLocationId: string | null): boolean {
  return commitment.locationId ? arrivedLocationId === commitment.locationId : false;
}

/**
 * Whether a commitment's own hour has arrived by the clock while it is not actually ready to be:
 * either its before-phase routine steps are not all done, or — for a commitment with a place — it
 * has not actually been reached yet.
 *
 * A located commitment is judged on arrival alone, not on its steps: arrival wins outright (once you
 * are there, prep is moot, leftover steps or not — the explicit "arrival wins" decision), but the
 * converse also holds — finishing every step does not make you present somewhere you have not
 * physically reached, so a located commitment with its steps done but arrival unasserted is still
 * late (still, e.g., in transit; `resolveProtectedCommitment` reports this specific shape as its
 * `travel` phase rather than `setup`, since there is nothing left to prepare, only to arrive). A
 * place-less commitment has nothing to arrive at, so its steps are the only gate: it stops being
 * late the moment they are done.
 *
 * Shared by `resolveProtectedCommitment` (recommend.ts), which uses it to keep a late commitment's
 * phase honest instead of reporting "active" from the clock alone, and `openAnchorsNow` (engine.ts),
 * which uses it to keep a late anchor's own window from opening for other work.
 */
export function isRunningLate(args: {
  commitment: FixedCommitment;
  now: Date;
  routineSteps: readonly RoutineStepStatus[];
  arrivedLocationId: string | null;
}): boolean {
  const { commitment, now, routineSteps, arrivedLocationId } = args;
  if (!(commitment.startsAt <= now && commitment.endsAt > now)) return false;
  if (commitment.locationId) return !hasArrivedAtCommitment(commitment, arrivedLocationId);
  return !beforeStepsComplete(commitment.id, routineSteps);
}

export interface SleepPreferences {
  preferredBedtime: string;
  preferredWakeTime: string;
  desiredSleepMinutes: number;
  minimumSleepMinutes: number;
  maxAwakeHours: number;
  /**
   * How far before the preferred bedtime a night may be placed, in minutes, before it carries a
   * deviation warning and the near-night choice. Sleep is a wall:
   * the engine never shortens a night to protect work.
   */
  bedtimeDeviationMinutes: number;
  /** Threaded through to `commitmentProtection` inside sleep planning's own protected-range check. */
  arrivalMarginMinutes: number;
}
export interface SleepWakeConstraint {
  commitmentId: string;
  title?: string;
  protectedStartAt: Date;
}
/** One side of a night's bedtime-deviation choice: the early placement or the nearer alternative. */
export interface SleepDeviationOption {
  startsAt: Date;
  wakesAt: Date;
  minutes: number;
}
export interface SleepDeviationOptions {
  early: SleepDeviationOption;
  near: SleepDeviationOption;
  /** False once `early` is chosen, or once the lapse leaves nothing left to choose. */
  warn: boolean;
}
export interface SleepPlan {
  id: string;
  plannedStartAt: Date;
  plannedWakeAt: Date;
  desiredMinutes: number;
  allowedMinutes: number;
  sleepDeficitMinutes: number;
  anchorDeviationMinutes: number;
  hardErrors: string[];
  explanation: string;
  targetMinutes?: number;
  minimumShortfallMinutes?: number;
  replannedFromMissedStart?: boolean;
  wakeConstraint?: SleepWakeConstraint;
  deviationOptions?: SleepDeviationOptions;
  placementChoice?: "early" | "near";
  stayUpAnswerMinutes?: number;
}

/**
 * `recurring` is a requirement inside fixed windows; `cadence` is a rhythm without windows — suggested every
 * N days when time allows, never required.
 */
export type ActionSchedulingMode = "one_off" | "recurring" | "cadence";
export type RecurrenceWindowAnchor = "wake" | "sleep_start" | "local_time";
export type OccurrenceStatus = "pending" | "completed" | "missed" | "cancelled";
export type OccurrenceAnchorSource =
  "actual_wake" | "planned_wake" | "preferred_wake" | "planned_sleep" | "local_time" | "fallback";
export interface ClockWindow {
  startTime: string;
  endTime: string;
}
export interface RecurrenceWindow {
  id: string;
  name: string;
  anchor: RecurrenceWindowAnchor;
  startOffsetMinutes?: number;
  endOffsetMinutes?: number;
  localStartTime?: string;
  localEndTime?: string;
  fallback?: ClockWindow;
}
export type RecurrenceCompletionMode = "end_date" | "total_minutes" | "manual";
export interface ActionRecurrenceRule {
  id: string;
  actionId: string;
  timezone: string;
  startDate: string;
  endDate?: string;
  intervalDays: number;
  windows: RecurrenceWindow[];
  completionMode?: RecurrenceCompletionMode;
  targetTotalMinutes?: number;
  accumulatedMinutes?: number;
  completedAt?: Date;
}

export interface CommitmentRecurrenceRule {
  id: string;
  title: string;
  timezone: string;
  startDate: string;
  endDate?: string;
  repeat: CommitmentRepeat;
  localStartTime: string;
  localEndTime: string;
  location?: string;
  locationId?: string;
  /** Copied onto every occurrence this rule derives; absent means `blocking`. */
  presence?: CommitmentPresence;
  setupBeforeMinutes: number;
  transitionAfterMinutes: number;
  status: "active" | "ended";
  projectId?: string;
  /** Copied onto every occurrence (`FixedCommitment.latenessMatters`); absent means true. */
  latenessMatters?: boolean;
  /** Copied onto every occurrence; stored, not read by the engine yet. */
  transportMode?: TransportMode;
  /** Copied onto every occurrence; the engine never reads it. */
  contactId?: string;
}
/**
 * A block of `length` days counted off from the rule's `startDate` (the same way a plain interval
 * counts cycles), or the calendar month containing today. See, `recurrence/cadence.ts`.
 */
export type CadencePeriod = { unit: "days"; length: number } | { unit: "month" };

/**
 * The facts a cadence action ranks on. How far past its interval it has drifted is computed
 * at ranking time, in whole local days, so the day plan's synthetic now sees it move.
 *
 * `period`/`targetOccurrences` are an alternative to the plain `intervalDays` due date: a count of
 * occurrences wanted inside a rolling window or calendar month, with the engine choosing which days.
 * `intervalDays` keeps working unchanged for a rule without `period` — see `recurrence/cadence.ts`.
 */
export interface ActionCadence {
  intervalDays: number;
  timezone: string;
  /** Local date the series began; a never-done action is due from here. */
  startDate: string;
  /** Local date of the last completion, from the completion log. */
  lastCompletedLocalDate?: string;
  completionCount: number;
  /** When present, takes precedence over `intervalDays` for due/pressure/eligibility math. */
  period?: CadencePeriod;
  /** Completions wanted per period; defaults to 1 when `period` is set. */
  targetOccurrences?: number;
  /** Minimum days between two completions, so a period's target cannot be met in one sitting. */
  minSpacingDays?: number;
  /** Weekdays (0 = Sunday .. 6 = Saturday) this cadence may be suggested on, if restricted. */
  eligibleWeekdays?: number[];
  /** Local dates of every completion within reach of the current period, from the completion log. */
  completionLocalDates?: string[];
}
export interface RecurrenceAnchor {
  localDate: string;
  wakeLocalDate?: string;
  sleepLocalDate?: string;
  actualWakeAt?: Date;
  plannedWakeAt?: Date;
  plannedSleepStartAt?: Date;
}
export interface ActionOccurrence {
  id: string;
  actionId: string;
  recurrenceRuleId: string;
  windowId: string;
  windowName: string;
  localDate: string;
  /** The window's bounds, not a placed slot: the occurrence is due at windowEndsAt and available from windowStartsAt. */
  windowStartsAt: Date;
  windowEndsAt: Date;
  status: OccurrenceStatus;
  anchorSource: OccurrenceAnchorSource;
  routineCovered?: boolean;
}

export interface Project {
  id: string;
  status: "active" | "paused" | "done" | "cancelled" | "archived";
  uncertainty: Uncertainty;
  internalDeadlineAt?: Date;
  externalDeadlineAt?: Date;
  value: number;
  consequence: number;
  /**
   * Comparison-refined consequence (finite, 0..6), fitted by `fitConsequence`. Used only by the ordinary
   * consequence score and the ordinary-tier tiebreak; deadline tiers and continuation read `consequence`.
   * Absent means exactly the stars.
   */
  consequenceRefined?: number;
  remainingEffortOverrideMinutes?: number;
  lastWorkedAt?: Date;
  createdAt?: Date;
  requiredCompletionRatio?: number;
  actualCompletionRatio?: number;
  outcomeActive?: boolean;
  /**
   * Learned estimate calibration for this project's area (logic design §5): every action
   * estimate scales by `factor`. Absent while calibration is off or history is too thin.
   */
  estimateCalibration?: {
    factor: number;
    samples: number;
    scope: "area" | "overall";
    /** Learned padding multiplier over the calibrated mean; replaces the uncertainty multiplier. */
    spread?: number;
  };
}

export interface Action {
  id: string;
  projectId: string;
  title: string;
  status: ActionStatus;
  optimisticMinutes?: number;
  expectedMinutes: number;
  remainingMinutes: number;
  /**
   * When `remainingMinutes` was last set or confirmed. The forecast reads it only to list an aged estimate on an
   * at-risk project and lower its confidence one band; ranking never does.
   * Absent on a synthesized recurring unit and on a deliverable unit, whose effort is not a stored estimate.
   */
  remainingSetAt?: Date;
  pessimisticMinutes: number;
  energy: EnergyType;
  minimumSessionMinutes: number;
  maximumSessionMinutes: number;
  importance: number;
  consequence: number;
  /**
   * Comparison-refined consequence (finite, 0..6), fitted by `fitConsequence`. Used only by the ordinary
   * consequence score and the ordinary-tier tiebreak; deadline tiers and continuation read `consequence`.
   * Absent means exactly the stars.
   */
  consequenceRefined?: number;
  availableFrom?: Date;
  deadlineAt?: Date;
  /**
   * A deliverable unit's own external date, carried beside `deadlineAt` (which is the earlier of its
   * internal and external dates) so the critical ladder can tell a passed external date from a passed
   * self-set one. Absent on every ordinary action, whose project supplies the external date.
   */
  externalDeadlineAt?: Date;
  latestStartAt?: Date;
  /** Legacy flat tagging, still carried while the portal writes both. Superseded by requirementPathways. */
  contexts: string[];
  /** Satisfied when ANY pathway holds. Absent means the action states no requirement at all. */
  requirementPathways?: RequirementPathway[];
  /** Nice-to-have contexts. They shade the ranking but never gate eligibility. */
  preferences?: string[];
  dependenciesComplete: boolean;
  dependencyIds?: string[];
  /**
   * Titles of unfinished prerequisites that are not other actions: a project, a deliverable, or the
   * prerequisites its own project or deliverable carries. `dependenciesComplete` is already false
   * while any remain; the forecast holds the work back on them the way it does for a blocked action.
   */
  waitingOn?: string[];
  splittable?: boolean;
  setupMinutes?: number;
  lastWorkedAt?: Date;
  createdAt?: Date;
  schedulingMode?: ActionSchedulingMode;
  /** Present only on a cadence action. */
  cadence?: ActionCadence;
  occurrenceId?: string;
  occurrenceWindowName?: string;
  routineCovered?: boolean;
  templateActionId?: string;
  /**
   * Present only on a synthesized recurring-mode unit (one per pending occurrence — see
   * `prepare()`/`hydrateAction` in engine.ts), carrying the series' own windows and interval so
   * `scheduling/adherence.ts` can measure a period without a second trip to the wire state.
   */
  recurrenceRule?: ActionRecurrenceRule;
  /**
   * Set on units synthesized from a deliverable projection. The engine plans these exactly like
   * actions; these fields only let the recommendation say which deliverable, and which way of working
   * on it, the result refers to.
   */
  deliverableId?: string;
  executionOptionId?: string;
  executionOptionTitle?: string;
  /** Where to read forecast evidence, when this unit is not itself the one the schedule reserved for. */
  forecastUnitId?: string;
  /** A ready-made exclusion sentence, used where a generic reason could not name the actual obstacle. */
  blockedReason?: string;
  /**
   * Why this cannot be worked on at all right now, even though it exists and its prerequisites are
   * met. A deliverable uses it when every route into its remaining work is blocked.
   */
  unavailableReason?: string;
}

/** The energy a piece of work demands, as distinct from the energy a capacity option offers. */
export type EnergyDemand = EnergyType;

export interface ActionEffort {
  actionId: string;
  optimisticMinutes: number | null;
  mostLikelyMinutes: number;
  pessimisticMinutes: number | null;
  expectedMinutes: number;
  standardDeviationMinutes: number | null;
  riskAdjustedMinutes: number;
  riskAdjustedRemainingMinutes: number;
  pessimisticRemainingMinutes: number;
  /** Mean remaining minutes (calibrated, setup included): what the project total adds up. */
  expectedRemainingMinutes: number;
  /** Standard deviation of the remaining minutes; a single-figure estimate's is implied by its padding. */
  remainingDeviationMinutes: number;
  /** True once a re-estimate has pushed remaining effort above the original baseline. */
  remainingExceedsBaseline: boolean;
  method: "pert" | "uncertainty_multiplier";
  /** The learned factor applied (`Project.estimateCalibration`); 1 when none. */
  calibrationFactor: number;
}

export interface PlanningSlot extends TimeRange {
  id: string;
  availability: "free" | "fixed" | "protected" | "unavailable";
  energy: CapacityEnergy;
  contexts: string[];
  usableFraction: number;
  capacityMinutes: number;
  capacityOptions: Array<{
    id: string;
    energy: CapacityEnergy;
    contexts: string[];
    usableFraction: number;
    availability: "free" | "protected";
  }>;
}

export interface AllocationBlock extends TimeRange {
  actionId: string;
  projectId: string;
  slotId: string;
  minutes: number;
}

export interface CapacityEnvelope extends TimeRange {
  kind: HorizonBandKind;
  confidence: ForecastConfidence;
  capacityFactor: number;
  rawCapacityMinutes: number;
  adjustedCapacityMinutes: number;
  protectedKnownMinutes: number;
  reservedMinutes: number;
  freeMinutes: number;
}

export interface ProjectEnvelope extends TimeRange {
  projectId: string;
  kind: HorizonBandKind;
  confidence: ForecastConfidence;
  reservedMinutes: number;
  requiredPaceMinutes: number;
}

/**
 * What to do about a deadline that has already passed. Computed, never applied: the engine reports
 * the earliest instant at which the project's remaining protected effort fits the capacity nobody
 * else has reserved, and the person decides whether to move the date there, mark the work done, or
 * pause it. Aggregate minutes only — shape (minimum sessions, splittability) is not re-checked.
 */
export interface ForecastProposal {
  kind: "move_deadline";
  deadlineOwner: "external" | "internal";
  /** The date that has passed. */
  missedDeadlineAt: Date;
  /** Null when the remaining effort does not fit anywhere inside the forecast horizon. */
  earliestFeasibleAt: Date | null;
  /**
   * The same date when every overdue project is moved at once: projects take capacity in the order
   * the scheduler reserves them, each seeing only what the earlier ones left, so the dates fit
   * together. "Move all" saves these; a single move keeps `earliestFeasibleAt`. Null when it fits
   * nowhere in the horizon.
   */
  jointEarliestFeasibleAt?: Date | null;
  reason: string;
}

/**
 * The smallest useful intervention for a live project whose remaining work does not fit,
 * ordered smallest first: narrow an uncertain estimate, let work split, add time, then renegotiate
 * the date. Computed from the forecast's own ledgers after every project has reserved, never
 * applied: the person decides.
 *
 * - `clarify_estimate`: expected work fits; the named actions' risk buffer (or pessimistic spread)
 *   does not. `minutes` is the buffer that cannot be reserved.
 * - `split_work`: enough minutes, wrong shape. The named actions cannot be placed whole or at their
 *   minimum session. `minutes` is the unplaced effort.
 * - `add_time`: a real shortage of `minutes` compatible minutes before the deadline.
 * - `move_deadline` (self-set) / `request_extension` (external): the earliest date the shortfall fits
 *   capacity nobody has reserved, null when the horizon runs out first.
 */
export type ForecastInterventionKind =
  "clarify_estimate" | "split_work" | "add_time" | "move_deadline" | "request_extension";

export interface ForecastIntervention {
  kind: ForecastInterventionKind;
  /** The actions it concerns, largest effect first; empty when it concerns the whole project. */
  actionIds: string[];
  minutes: number;
  /** Only on `move_deadline` and `request_extension`. */
  proposedDeadlineAt?: Date | null;
  /** Only on `split_work`: let indivisible work split (`whole`), or shorten a minimum session. */
  shape?: "whole" | "minimum_session";
  reason: string;
}

/**
 * One action's adherence to its own period, as `scheduling/adherence.ts` measured it: how many
 * completions are in, how many were wanted by now, the full-period target, and a human label for the
 * period ("this week", "today", "this 3-day period") so a reason string never has to reconstruct it.
 */
export interface ProjectAdherenceAction {
  actionId: string;
  done: number;
  expectedSoFar: number;
  target: number;
  periodLabel: string;
}

/**
 * The project-level roll-up for a maintenance project: see `healthBasis` on `ProjectForecast`.
 * `health` here is the classification adherence actually produced (behind/at_risk/on_track/ahead) —
 * §8 "Maintenance projects" of the logic design. It is deliberately *not* copied onto the forecast's
 * own top-level `health`: `recommendation/score.ts` treats a project's `health` of "behind" or
 * "at_risk" as proof a real deadline is being missed, ranking every one of its actions onto the
 * deadline-critical ladder regardless of whether a deadline exists — an invariant that held for every
 * project before adherence existed, because feasibility health was never computed without one. A
 * maintenance project has no deadline at all, so its top-level `health` stays "unknown" (exactly what
 * it already read before this field existed) to leave that ladder, sleep pressure, and continuation
 * displacement unchanged; a display surface that means to show the real status reads `adherence.health`
 * (and `healthBasis`) instead of the top-level field.
 */
export interface ProjectAdherence {
  health: "behind" | "at_risk" | "on_track" | "ahead";
  /** sum(done) / sum(expectedSoFar) across the project's actions; 1 when nothing is due yet. */
  ratio: number;
  actions: ProjectAdherenceAction[];
}

/** An action whose remaining-effort estimate has gone unconfirmed for too long (`ProjectForecast.agedInputs`). */
export interface AgedInput {
  actionId: string;
  title: string;
  /** When its remaining effort was last set or confirmed. */
  setAt: Date;
}

export interface ProjectForecast {
  projectId: string;
  /**
   * Always "unknown" when `healthBasis` is "adherence" — see the comment on `ProjectAdherence`. Every
   * other consumer of this field (ranking, sleep pressure, continuation) needs no change and sees
   * nothing different from before adherence existed; read `adherence.health` for the real status.
   */
  health: ProjectHealth;
  /** The internal deadline is already in the past. Health stays Behind; this says why it can never recover. */
  overdue: boolean;
  /**
   * What this forecast measures. "feasibility" (the default, and the only basis before this field
   * existed) is whether the remaining effort fits before a deadline. "adherence" is a maintenance
   * project's own basis — every live action is `recurring` or `cadence`, so there is no deadline to be
   * feasible against, only whether the cadence is being kept up; see `scheduling/adherence.ts` and
   * `ProjectAdherence.health` for where the real classification lives. Optional so results stored by
   * earlier engine versions still parse as feasibility.
   */
  healthBasis?: "feasibility" | "adherence";
  /** Present only when `healthBasis` is "adherence". */
  adherence?: ProjectAdherence;
  proposal?: ForecastProposal;
  /** Present only on a live (not overdue) feasibility forecast whose work does not fully fit. */
  interventions?: ForecastIntervention[];
  protectedRemainingMinutes: number | null;
  pessimisticRemainingMinutes: number | null;
  /**
   * The project's mean remaining effort and the standard deviation of the total, so a range can be
   * shown. `protectedRemainingMinutes` is mean + 1.04 sd (about p85), not the sum of each action's own
   * p85. Absent on a forecast that measured no effort.
   */
  expectedRemainingMinutes?: number;
  remainingDeviationMinutes?: number;
  /**
   * Which date the forecast was measured against. "none" means the project has no deadline: the
   * numbers are measured against the end of the forecast horizon, health never says "on track", and
   * `estimatedFinishAt` says when the work would be done at the available pace instead.
   */
  deadlineSource?: "internal" | "external" | "none";
  /** Present when `deadlineSource` is "none" and the remaining effort fits the forecast horizon. */
  estimatedFinishAt?: Date;
  compatibleCapacityMinutes: number | null;
  grossCompatibleCapacityMinutes: number | null;
  reservedByEarlierDeadlinesMinutes: number;
  requiredPaceMinutesPerWeek: number | null;
  forecastBand: HorizonBandKind | null;
  confidence: ForecastConfidence | null;
  forecastThrough: Date;
  expectedMarginMinutes: number | null;
  pessimisticMarginMinutes: number | null;
  marginRatio: number | null;
  scheduleVariance: number | null;
  internalDeadlineAt?: Date;
  unallocatedExpectedMinutes: number;
  /** Risk-adjusted effort held by blocked or waiting actions, excluded from the forecast above. */
  blockedEffortMinutes: number;
  /**
   * Present only when the project is behind or at risk and some action it plans from has a remaining-effort
   * estimate set 14 days ago or more, oldest first. The figures were still used as given: this lists the
   * input as aged and `confidence` is already one band lower for it.
   */
  agedInputs?: AgedInput[];
  /** Work fits the remaining capacity but not its shape, such as an unplaceable indivisible action. */
  schedulingBlocked: boolean;
  latestSafeStarts: Record<string, Date | null>;
  /**
   * Units whose expected (not risk-adjusted) remaining minutes can't all be reserved before the
   * deadline — starved work, not merely held back or unforecast. Every reader of `latestSafeStarts`
   * treats a unit listed here as pressing at maximum: its latest safe start has already passed, even
   * though the map above may still hold `null` or a placed date for it. Absent, and every reader's
   * fallback is unaffected, in results stored before `forecast-reservation` populated it.
   */
  unplacedUnitIds?: string[];
  reasons: string[];
}

export interface PlanningResult {
  slots: PlanningSlot[];
  allocations: AllocationBlock[];
  capacityEnvelopes: CapacityEnvelope[];
  projectEnvelopes: ProjectEnvelope[];
  forecasts: ProjectForecast[];
  dependencyOrder: string[];
  dependencyErrors: string[];
}

/**
 * Deadline severity ladder. Lower ranks are ordered ahead of higher ones before the weighted score
 * is consulted at all, so committed work is never displaced by a preference that merely carries a
 * high self-reported value.
 *
 * A deadline someone else imposed cannot be renegotiated, so every severity splits by whether the
 * project answers to an external commitment. An externally committed project that is merely at risk
 * therefore outranks a self-set one that is already behind.
 *
 * A date that has already passed is a different problem from one that cannot be met: no amount of
 * work recovers it. An overdue external date stays at the top, because the outcome still has to be
 * dealt with; a passed self-set date is stale, not overdue: it competes as
 * ordinary work with no deadline pressure, and its remedy is a decision — move the date, or mark the
 * work done or paused — carried as a proposal.
 *
 * Every rank has a name (`CriticalTier`); the number only fixes the order.
 */
export type CriticalRank = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type CriticalTier =
  | "overdue_external"
  | "behind_external"
  | "at_risk_external"
  | "behind_internal"
  | "at_risk_internal"
  | "due_this_week_external"
  | "ordinary"
  /** A passed self-set date: stale, not overdue. Ranks as `ordinary` (not on the ladder) and carries the date proposal. */
  | "stale_date";

/**
 * A pending flexible commitment before-step `recommend()` may offer early, once placed
 * Built by `engine.ts` from a
 * run's own placement (`PlacedStep.earliestAt`/`placedStartAt`/`startBy`), threaded through
 * `RecommendArguments.offerableSteps` and re-supplied unchanged to every day-plan replay step (the
 * placement itself never moves during a day; only which steps are currently eligible does).
 */
export interface EarlyStepCandidate {
  stepId: string;
  commitmentId: string;
  title: string;
  /** Hands-on minutes. */
  durationMinutes: number;
  energy: EnergyType;
  contexts: string[];
  dependencyIds: string[];
  /** Earliest legal start. */
  earliestAt: Date;
  /** The step's own due time — from here it is an ordinary due routine step, not an early offer. */
  placedStartAt: Date;
  /** Latest legal start; present only when a wait or must-start-by constrains the step. */
  startBy?: Date;
}

export interface RecommendationCandidate {
  action: Action;
  eligible: boolean;
  exclusionReasons: string[];
  /**
   * Excluded only because too little compatible time fits before the next protected boundary or the
   * daily horizon. The work itself is possible; the moment is not. Read structurally so the boundary
   * directive never has to match exclusion text.
   */
  windowBound: boolean;
  /** Focused minutes: wall-clock minutes before the boundary scaled by the window's usable fraction. */
  recommendedMinutes: number | null;
  /** The clock time those focused minutes occupy, so a session can be stated as "45 in the 60 before X". */
  recommendedWallClockMinutes: number | null;
  /** The usable fraction that relates the two figures above. Null when nothing fits. */
  usableFraction: number | null;
  /** When the current compatible window closes: the next protected boundary or the daily horizon. */
  sessionBoundary: Date;
  totalScore: number;
  scoreComponents: Record<string, number>;
  criticalRank: CriticalRank;
  criticalTier: CriticalTier;
  criticalReason?: string;
  /**
   * Set only on deadline-tier work that is still inside the break owed after a full session. It stays
   * eligible, but ranks behind equally urgent work that is not resting.
   */
  restUntil?: Date;
  /**
   * Remaining minutes of the longest dependency chain waiting on this action. A tie-break
   * only: among otherwise equal candidates, the one more work waits on goes first. Absent reads as 0.
   */
  downstreamMinutes?: number;
  /** Present in the stale-date and overdue-external tiers: what to do about the passed date. */
  proposal?: ForecastProposal;
  /** How the action's requirements stand against the current situation. */
  conditionMatch: ConditionMatch;
  /**
   * Present when this candidate is only workable after a journey. Eligibility via a trip is ordinary
   * eligibility measured at the destination; the journey shows up as a cost in the ranking and as
   * wall-clock minutes in the session, never as a gate on whether the work is worth doing.
   */
  trip?: TripPlan;
  /** Why a candidate blocked only by being elsewhere cannot be reached by a trip right now. */
  tripReason?: TripRefusal;
}

export type TripRefusal = "no_mode" | "no_window";

export interface TripPlan {
  toLocationId: string;
  /** The journey there, in minutes, from wherever the ranking is being made. */
  travelMinutes: number;
  /** The journey on to the next place the plan pins you to; zero when it is the destination itself. */
  returnMinutes: number;
  /** No stored journey on to the next anchor: `returnMinutes` is the outbound time, or the assumed figure. */
  returnUnknown?: boolean;
  mode?: TransportMode;
  source: TravelSource;
  /** How many errands at this destination share the one journey (§9 bundling, capped at three). */
  bundleSize: number;
  /** Compatible minutes available at the destination, which is what the bundle is packed into. */
  windowMinutes: number;
  /**
   * The round trip the ranking may charge for. Zero when the leg is plan-required anyway — the next
   * anchor is at this very destination, so going early costs nothing that was not already spent.
   */
  costMinutes: number;
  /** The cheapest later moment's extra travel, or null when the projection offers no later moment. */
  opportunityMinutes: number | null;
  /**
   * Round-trip minutes a later moment would have saved: `costMinutes` shared across the bundle, less
   * the cheapest future opportunity, floored at zero. Zero means the journey is unavoidable, which is
   * exactly when it carries no penalty. This is what the travel cost is scaled from.
   */
  avoidableMinutes: number;
}

/** The single comparison that separated two candidates in the ranking. */
export type DecidingFactor =
  | "eligibility"
  | "tier"
  | "consequence"
  | "latest_safe_start"
  | "deadline"
  | "critical_path"
  | "completion"
  | "neglect"
  | "score"
  | "margin"
  | "travel"
  | "momentum"
  | "rest"
  | "identifier";

export interface RecommendationChoice {
  targetId: string;
  title: string;
  tier: CriticalTier;
  tierLabel: string;
  reason: string;
}

export type CounterfactualCondition = "at_location" | "energy_high" | "longer_session";

export interface Counterfactual {
  condition: CounterfactualCondition;
  /** Human wording of the condition, e.g. "if you were at home". */
  description: string;
  /** What would lead under the condition; null when nothing would. */
  thenPrimary: { targetId: string; title: string; recommendedMinutes: number } | null;
}

/**
 * The contrastive answer to "why this, why not the nearer thing, what would change it". `whyNot`
 * names the runner-up and the one comparison that separated them; `wouldChangeIf` lists only the
 * counterfactuals under which a different primary would lead.
 */
export interface RecommendationWhy {
  because: RecommendationChoice | null;
  whyNot: (RecommendationChoice & { decidingFactor: DecidingFactor }) | null;
  wouldChangeIf: Counterfactual[];
}

export interface NextFit {
  at: Date;
  targetId: string;
  title: string;
  recommendedMinutes: number;
  deliverableId?: string;
}

/**
 * Why nothing fits right now, stated as the thing that would resolve it. `answer` when the only
 * obstacle across the possible work is a question nobody has answered; `boundary` when the daily
 * horizon or a protected boundary is what binds; `none` when the work itself is the problem.
 */
export type NoFit =
  | {
      kind: "answer";
      question: string;
      contextIds: string[];
      /** What would lead if the answer were yes, from a re-run of the ranking under that answer. */
      candidate: { targetId: string; title: string; recommendedMinutes: number; deliverableId?: string } | null;
    }
  | {
      kind: "boundary";
      boundaryAt: Date;
      boundaryKind: "daily_horizon" | "commitment" | "sleep" | "capacity";
      boundaryTitle?: string;
      /** Whether `boundaryAt` is where the named commitment's protection starts or where it ends. */
      boundaryEdge?: "start" | "end";
      nextFit: NextFit | null;
    }
  | { kind: "none" };

/**
 * The phases of a protected commitment, in the order they occur: get ready, travel, wait out the
 * arrival margin, do the thing, come back down, travel on. `travel` and `return` are the two the
 * person is not simply waiting through, and are the two that become a `travel` directive.
 */
export type ProtectedCommitmentPhase = "setup" | "travel" | "arrival" | "active" | "transition" | "return";

export interface ProtectedCommitment {
  id: string;
  title: string;
  phase: ProtectedCommitmentPhase;
  startsAt: Date;
  endsAt: Date;
  protectedStartAt: Date;
  protectedEndAt: Date;
  /** The window of the current phase alone — where tracking it, rather than the whole commitment, ends. */
  phaseStartsAt: Date;
  phaseEndsAt: Date;
  locationId?: string;
  presence?: CommitmentPresence;
  transitionAfterMinutes?: number;
  travelBefore?: CommitmentTravelLeg;
  travelAfter?: CommitmentTravelLeg;
  /**
   * Before-phase steps are unfinished and the commitment has not been arrived at, whether that is
   * caught by `isRunningLate` past the commitment's own start, or — the pre-start case — caught
   * directly in `resolveProtectedCommitment` before the commitment has even begun. `phase` is still
   * one of the ordinary literals (`setup` or `travel`) rather than `active`, so every existing
   * consumer — `plannedLeg`, day-plan replay, the wording map — keeps working unchanged; this flag
   * only swaps the headline to name the lateness explicitly.
   */
  late?: boolean;
  /**
   * The commitment's own timeline, computed once by `resolveProtectedCommitment` and carried here so
   * the effective end (and every other edge) survives the `{ ...commitment, ... }` spread that builds
   * this object — a plain field lookup instead of a second `trackedEndedAt`/arithmetic path the type
   * would otherwise have to expose. See the commitment timeline design note, "Consumers that change".
   */
  timeline: CommitmentTimeline;
}

/** When the journey to a protected commitment leaves, and when the person is free of it. */
export function protectedLegEdges(commitment: ProtectedCommitment): { leaveBy: Date; freeAt: Date } {
  const { timeline } = commitment;
  return { leaveBy: timeline.leaveBy ?? timeline.arriveBy, freeAt: timeline.freeAt };
}

export interface Recommendation {
  primary: RecommendationCandidate | null;
  alternatives: RecommendationCandidate[];
  candidates: RecommendationCandidate[];
  headline: string;
  explanation: string;
  evidence: string[];
  protectedCommitment?: ProtectedCommitment;
  /**
   * The `anchor` commitment happening right now whose window this ranking was allowed to fill: you
   * are at it, and nothing says you are taken up by it. A separate field from `protectedCommitment`
   * on purpose — that one means the clock is held and no work is on offer, which is exactly what an
   * open anchor is not. Both are never set at once.
   */
  openAnchor?: ProtectedCommitment;
  /**
   * Blocked only by something nobody has answered yet. These are worth asking about, because one
   * answer can make them available; hiding them is how the flat model lost work.
   */
  needsAnswer: RecommendationCandidate[];
  /** Blocked only by being somewhere else, and that somewhere has a known travel cost. */
  reachable: RecommendationCandidate[];
  why: RecommendationWhy;
  /** Present when there is no primary and no protected commitment. */
  noFit?: NoFit;
  /**
   * The best offerable flexible commitment before-step, ranked beside ordinary work but never
   * appearing in `candidates`/`primary`/`alternatives`/`why` (the routine step timing design note,
   * "Flexible steps offered early"). Absent while a protected commitment is in force, or when no
   * offerable step scored. `selectCurrentDirective` directs it in `primary`'s place under the stated
   * conditions; the engine lists every offerable step (this one included) under `canDoNow`.
   */
  earlyStep?: { stepId: string; totalScore: number };
  /**
   * Low energy is the only thing between the person and an action with a near external deadline:
   * a bounded stretch they may choose (or refuse). Absent in every other case, and never alters the
   * ranking above. See `deriveStretchOffer`.
   */
  stretchOffer?: StretchOffer;
  /**
   * What declared low energy is holding back: how many actions only the energy check keeps out, and
   * which of them have a near external date. Absent when nothing is blocked, energy is stale or
   * recovery. Describes only; never alters the ranking above. See `deriveEnergyCost`.
   */
  energyCost?: EnergyCost;
}

export interface WeekOutlookProject {
  projectId: string;
  reservedMinutes: number;
  requiredPaceMinutesPerWeek: number | null;
  /** Required pace minus reserved minutes, floored at zero. */
  paceShortfallMinutes: number;
  health: ProjectHealth;
}

/**
 * The detailed band read as a week: what is reserved for whom, what is free, and which projects
 * need more of it than they hold. Minutes by area are a stewardship signal, never a ranking term.
 */
export interface WeekOutlook {
  startsAt: Date;
  endsAt: Date;
  capacityMinutes: number;
  reservedMinutes: number;
  freeMinutes: number;
  projects: WeekOutlookProject[];
  /** Projects Behind or At risk whose required weekly pace exceeds what this week reserves for them. */
  underPacedProjectIds: string[];
  areas: Array<{ areaId: string; reservedMinutes: number }>;
  /**
   * A cadence is never reserved, so this says what a week of it would want and which of it is
   * already overdue — a stewardship signal beside the area minutes, never a ranking term.
   */
  cadence?: WeekOutlookCadence;
}

export interface WeekOutlookCadence {
  /** Expected minutes per week across every active cadence action, at its stated interval. */
  demandMinutesPerWeek: number;
  /** Cadence actions due today or earlier, most overdue first. */
  due: Array<{ actionId: string; dueLocalDate: string; daysOverdue: number }>;
  /**
   * What the soft pass placed against this week's own free minutes, after every deadline project's
   * own reservation: never subtracted from `WeekOutlook.freeMinutes` itself, and never able
   * to change any project's margin, health, latest safe start or allocations — informational only,
   * read the way `due` already is. Absent exactly when `due` is (no active cadence action at all).
   */
  softReservedMinutes?: number;
  /** Per action, this week's expected occurrences against how many the soft pass could fit. */
  actions?: Array<{ actionId: string; expectedOccurrences: number; fittingOccurrences: number }>;
}

export interface ContinuationSimulation {
  safe: boolean;
  recommendedMinutes: number;
  reason: string;
  displacedProjectIds: string[];
}
