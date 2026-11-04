"use client";

import { dateTimeFormat, displayLocale, setDisplayLocale } from "@/shared/locale";
import { SignInRequired } from "@/features/owner-auth/components/sign-in-required";
import { isAnonymousRefusal, wasSignedInBefore } from "@/features/owner-auth/signed-in-marker";
import { Activity, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type {
  ActivityCommand,
  AgentCall,
  BlockingReason,
  CloseEntityCommand,
  CloseEntityResult,
  ConditionMatch,
  ConfirmProjectWantedCommand,
  EndRecurrenceGoalCommand,
  RecordCadenceCompletionCommand,
  IssueSnapshot,
  OverrideReason,
  PlanForecastResponse,
  PlanningEntityCommand,
  SaveActionCommand,
  SaveCommitmentRecurrenceRuleCommand,
  SaveProjectCommand,
  SessionCommand,
  SplitCommitmentSourceCommand,
  TransportMode,
  TravelSource
} from "@openrhen/contracts";
import { settingsLocale } from "@openrhen/contracts";
import { createSeedState, normalizePortalState, type ActiveSession, type PortalState } from "./portal-state";
import { LOGGED_TOAST_MS, loggedMinutes } from "@/features/now/logged-session";
import { refreshEmailReviewCount } from "@/features/capture/email-review-count";
import { usePortalExtensionSlices } from "./extensions";
import { LiveUpdatesController, liveRefreshActions, type LiveEventKind } from "./live-updates";
import {
  serverNow,
  planHealthAfterSave,
  planFailureIsTerminal,
  planIsUpdating,
  UNKNOWN_PLAN_HEALTH,
  type PlanHealth,
  type PlanningStatus
} from "@/features/planning/planning-runtime";
import type { CriticalTier } from "@/features/now/critical-tiers";
import { planningBanner, planTime, type BannerTone } from "@/features/planning/plan-banner";
import { StatusBanner } from "@/features/planning/components/status-banner";
import { HeroSkeleton } from "@/components/hero-skeleton";
import { swapHero } from "@/features/now/hero-transition";
import { createClientId } from "@/shared/client-id";
import { CommandRefusal } from "@/shared/command-refusal";
import { storedActionPayload } from "@/shared/stored-action-payload";
import { canSnooze, snoozeRefusal, snoozeSubject } from "@/features/now/snooze";
import { freezeClock, readNow } from "@/shared/clock";

/**
 * How the browser learns that a fresh plan exists.
 *
 * Every mutation enqueues a job and answers with the run that already existed, so the page is
 * showing a plan computed against state the database has moved past. The page used to find out only
 * on its own five-minute tick, which made "complete an action, see the next directive" a coin toss
 * between instant and five minutes late. After a command the browser instead asks a single cheap
 * question — has a newer run landed? — every couple of seconds until it has, or until half a minute
 * has passed and the answer is clearly not coming soon.
 */
const PLAN_POLL_INTERVAL_MS = 2_000;
const PLAN_POLL_LIMIT_MS = 30_000;
/** Delays before the retries of a failed non-initial state read: about three attempts, each superseded by any later commit. */
const STATE_READ_RETRY_DELAYS_MS = [1_000, 4_000, 15_000] as const;
/** A command that has neither answered nor failed by now is abandoned so the tab cannot wedge. */
const COMMAND_TIMEOUT_MS = 30_000;
/**
 * How long `followPlanRefresh` waits on `/api/events` to push a `planning` event before falling back
 * to its old fixed-interval poll — the push is almost always faster than one poll interval, but a
 * miss (the tab isn't live yet, a coalesced burst dropped it, the connection is mid-reconnect) must
 * not cost the whole `PLAN_POLL_LIMIT_MS` before the poll fallback even starts trying.
 */
const PLAN_EVENT_WAIT_MS = 5_000;
/**
 * The idle tick. It reads the status and enqueues nothing unless the plan is actually missing,
 * expired, or left behind by a failed job; the validity-boundary chain owns timed refreshes. Because
 * it no longer costs an engine run, it can be frequent enough to notice a boundary refresh landing.
 */
const STATUS_TICK_MS = 60_000;
/** While state reads keep failing after their retries, one more is tried after 30s, then 1, 2, 4 and 5 minutes. */
const STATE_RECOVERY_BASE_MS = 30_000;
const STATE_RECOVERY_MAX_MS = 300_000;
/**
 * The idle tick while `/api/events` is live: with a push telling the tab exactly when to look,
 * the tick's only remaining job is a safety net for a missed or coalesced-away event, so it can be
 * far less frequent than the disconnected default above.
 */
const STATUS_TICK_LIVE_MS = 5 * 60_000;
/**
 * A background or unfocused tab can have its timers throttled well past `STATUS_TICK_MS` — Chrome's
 * intensive throttling can stretch a minute into closer to an hour — so the tick alone let a tab left
 * open across a boundary crossing sit on a superseded plan until something else happened to touch it
 *. `visibilitychange`/`focus` force an immediate check when the tab is looked at
 * again; this debounces the pair of events a single tab-switch usually fires so they collapse into one.
 */
const VISIBILITY_REFRESH_DEBOUNCE_MS = 250;
/** The session target types that have a feedback surface to answer on. Every other type runs to its own end. */
const COLLECTS_FEEDBACK_SESSION_TARGETS = new Set(["action", "deliverable"]);

/** An open replay of a captured issue snapshot. Its presence means every write path is closed. */
export interface ReplaySession {
  id: string;
  description: string;
  capturedAt: string;
  observedAt: string;
  source: "server" | "client";
  warnings: string[];
}

/** What a caller can say about one command beyond its body. */
export interface CommandOptions {
  /** True for a refusal the caller shows itself, so the shared save banner stays quiet. */
  handles?: (refusal: CommandRefusal) => boolean;
}

const REPLAY_READ_ONLY = "This is a read-only replay of a captured snapshot. Nothing can be changed here.";

/**
 * Read straight from the address bar rather than from state, so the write guard holds from the very
 * first render — before the snapshot has loaded and before any state could say a replay is running.
 */
function replayRequest() {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const id = params.get("snapshot");
  return id ? { id, source: params.get("source") === "client" ? ("client" as const) : ("server" as const) } : null;
}

const isReplaying = () => replayRequest() !== null;

/**
 * What every consumer of the portal context reads. The clock is deliberately not here: it ticks every
 * second, and a value that ticks makes every consumer re-render with it. A component that shows the
 * time reads `useNow` from `@/shared/clock` at the rate it needs.
 */
export interface PortalContextValue {
  state: PortalState;
  ready: boolean;
  /**
   * The first read failed, so nothing real is loaded: the shell shows a Retry screen in place of the
   * page rather than pages that look empty. Never true while replaying a snapshot.
   */
  loadFailed: boolean;
  saving: boolean;
  recommendation: ClientRecommendation;
  forecasts: ClientForecast[];
  capacityEnvelopes: ClientCapacityEnvelope[];
  projectEnvelopes: ClientProjectEnvelope[];
  /** The engine's slot grid and its latest-safe reservations, for the day timeline. */
  slots: ClientSlot[];
  allocations: ClientAllocation[];
  currentDirective: PlanForecastResponse["currentDirective"] | null;
  upcomingDirectives: PlanForecastResponse["upcomingDirectives"];
  /**
   * The engine's forward-simulated day, as the contract states it: ISO instants, like the directives
   * beside it and unlike the hydrated `slots` and `allocations`. Null for a result stored before
   * engine 1.4.0, which is what the day plan's untimed fallback is for.
   */
  dayPlan: PlanForecastResponse["dayPlan"] | null;
  continuation: ClientContinuation | null;
  /** The engine's read of the coming week; null for a result stored before engine 1.3. */
  weekOutlook: ClientWeekOutlook | null;
  /**
   * The freshest `lastSuccessfulAt` any status poll has seen, which can be ahead of
   * `state.planning?.lastSuccessfulAt` for as long as this tab has not yet reloaded that run. Null
   * until the first poll answers. Lets a panel say it is refreshing rather than quietly show a plan
   * the server has already superseded.
   */
  knownLatestSuccessfulAt: string | null;
  /**
   * What the last status poll said about an out-of-date plan's refresh, and whether the poll itself
   * failed. Null until the first answer. `refresh` separates a refresh in progress (quiet) from one
   * that is retrying or stalled (worth telling the user), so the page never calls a healthy server
   * unavailable and never hides a plan that is stuck.
   */
  planHealth: PlanHealth | null;
  /**
   * Server clock minus this browser's clock, from the last status poll. A browser clock minutes off
   * must not decide that a healthy plan has expired, so every plan-validity comparison adds this.
   */
  serverClockOffsetMs: number;
  /**
   * Whether `/api/events`'s SSE connection is currently up for this tab. False whenever the tab is
   * hidden (the stream is closed then, see `live-updates.ts`), the browser has no `EventSource`, or a
   * reconnect is in flight — never a hard error, just "the idle tick is doing the work right now
   * instead of a push". A small dot beside the freshness chip is the only thing this should drive.
   */
  live: boolean;
  /** Non-null only while replaying a captured snapshot; every command is refused in that state. */
  replay: ReplaySession | null;
  /** The check-in worth showing on Now right now, if any. Delivered on the same tick as `checkPlanFreshness`. */
  pendingCheckIn: CheckInPrompt | null;
  /** Clears the banner immediately after it is answered, ahead of the next tick confirming it server-side. */
  dismissPendingCheckIn: (checkInId?: string) => void;
  /** What registered extensions keep in the provider, by extension id (see `portal-extensions.ts`). */
  extensions: Record<string, unknown>;
  /** The warning currently shown above the page, so a report can record what the user could see. */
  bannerText: string;
  /** Saves a pending capture and resolves with its id. */
  addCapture: (text: string) => Promise<string>;
  saveProjectCommand: (command: SaveProjectCommand) => Promise<void>;
  /** The review's Keep: confirms a project is still wanted, stamping `lastReviewedAt` on the server. */
  confirmProjectWantedCommand: (command: ConfirmProjectWantedCommand) => Promise<void>;
  saveActionCommand: (command: SaveActionCommand) => Promise<void>;
  saveEntityCommand: (command: PlanningEntityCommand) => Promise<void>;
  saveCommitmentRecurrenceRuleCommand: (command: SaveCommitmentRecurrenceRuleCommand) => Promise<void>;
  /** **Not the same event**: takes one secondary source off a commitment as a commitment of its own. */
  splitCommitmentSourceCommand: (command: SplitCommitmentSourceCommand) => Promise<void>;
  endRecurrenceGoalCommand: (command: EndRecurrenceGoalCommand) => Promise<void>;
  /**
   * Archives or cancels one row, or restores it (`POST /api/commands/close`), and resolves with the server's result
   * (what cascaded, what was skipped, the version to restore at). Rejects with a `CommandRefusal`.
   */
  closeEntityCommand: (command: CloseEntityCommand, options?: CommandOptions) => Promise<CloseEntityResult>;
  recordCadenceCompletionCommand: (command: RecordCadenceCompletionCommand) => Promise<void>;
  acceptServerState: (state: PortalState) => void;
  /**
   * Requests an on-demand recalculation through `runCommand`, so it carries the replay guard and the
   * saving/error state every other command does. It rejects rather than swallowing the error — the
   * caller decides what to do — unlike this provider's own two internal callers, which keep their own
   * `.catch`. Exists because a caller reaching around the provider with a raw `fetch` instead also
   * skips `runCommand`'s replay guard.
   */
  recalculate: () => Promise<void>;
  /** `startedAt` (an ISO moment) backdates the start when the work began before Start was tapped. */
  startCurrent: (startedAt?: string) => Promise<void>;
  /** Moves the start of the open session earlier (`correct_start`). */
  correctStart: (startedAt: string) => Promise<void>;
  /** Ends the open action session keeping its estimate and asks Now to open Something else. */
  stopToSwitch: () => Promise<void>;
  /** True from `stopToSwitch` until Now has opened Something else, or two minutes pass. */
  switchPending: boolean;
  clearSwitchPending: () => void;
  /** The id of the task the last Switch to stopped, until something starts or two minutes pass. */
  switchedFrom: string | null;
  /** True after a switch until the plan that follows the stop has landed: the list is not ready yet. */
  switchAwaitingPlan: boolean;
  forgetSwitch: () => void;
  /** What the last finished session logged, for the ten-second "Logged 42 min on X" line. */
  loggedSession: LoggedSession | null;
  dismissLoggedSession: () => void;
  /** The id of a session started right after a switch, whose card should take focus. */
  focusNewSession: string | null;
  clearFocusNewSession: () => void;
  startAlternative: (actionId: string, plannedMinutes: number, reason: OverrideReason, note?: string) => Promise<void>;
  blockRecommended: (reason: BlockingReason, note?: string) => Promise<void>;
  /**
   * Puts an action off until `availableFrom` (an ISO instant) without blocking it: saves the stored
   * action with only that date changed. Rejects, saving nothing, for a date past its deadline or
   * latest safe start, or for a recurring series.
   */
  snoozeAction: (actionId: string, availableFrom: string) => Promise<void>;
  pauseOrResume: () => Promise<void>;
  requestFeedback: () => Promise<void>;
  finishSession: (
    result: "finished" | "progress" | "unsure" | "blocked" | "did_not_start" | "continue",
    remainingMinutes?: number,
    details?: { reason?: string; actionStatus?: "waiting" | "blocked"; note?: string; endedAt?: string }
  ) => Promise<void>;
  runActivityCommand: (command: ActivityCommand) => Promise<void>;
}

/** How long a switch waits for Now to open Something else before it is dropped. */
const SWITCH_PENDING_MS = 120_000;

export interface LoggedSession {
  key: string;
  title: string;
  minutes: number;
}

export type ClientAction = PortalState["actions"][number] & {
  dependenciesComplete?: boolean;
  occurrenceId?: string;
  templateActionId?: string;
  occurrenceWindowName?: string;
};
/**
 * What to do about a deadline that has passed. Computed by the engine, never applied: the person
 * moves the date, or marks the work done or paused.
 */
export interface ClientForecastProposal {
  kind: "move_deadline";
  deadlineOwner: "external" | "internal";
  missedDeadlineAt: Date;
  earliestFeasibleAt: Date | null;
  /** The date when every overdue project moves at once; "Move all" saves this one. */
  jointEarliestFeasibleAt?: Date | null;
  reason: string;
}
/**
 * One of the smallest useful interventions for a live project that does not fit, smallest
 * first. Computed by the engine, never applied; see the engine's `ForecastIntervention`.
 */
export interface ClientForecastIntervention {
  kind: "clarify_estimate" | "split_work" | "add_time" | "move_deadline" | "request_extension";
  actionIds: string[];
  minutes: number;
  proposedDeadlineAt?: Date | null;
  reason: string;
}
/**
 * The journey the engine costed for a candidate that is only workable somewhere else. Every figure
 * is the engine's: `avoidableMinutes` is what a later, nearer moment would have saved, so zero means
 * the trip is unavoidable and carries no penalty at all. The portal reports these, never derives them.
 */
export interface ClientTrip {
  toLocationId: string;
  travelMinutes: number;
  returnMinutes: number;
  mode?: TransportMode;
  source: TravelSource;
  bundleSize: number;
  windowMinutes: number;
  costMinutes: number;
  opportunityMinutes: number | null;
  avoidableMinutes: number;
}
export interface ClientCandidate {
  action: ClientAction;
  eligible: boolean;
  exclusionReasons: string[];
  /** Focused minutes: the clock minutes before the boundary scaled by the window's usable fraction. */
  recommendedMinutes: number | null;
  // Everything from here to `conditionMatch` arrived with engine 1.3 and is optional so a result stored
  // by an earlier engine still renders until the engine next runs.
  /** The clock time those focused minutes occupy. */
  recommendedWallClockMinutes?: number | null;
  usableFraction?: number | null;
  sessionBoundary?: Date;
  criticalTier?: CriticalTier;
  criticalReason?: string;
  proposal?: ClientForecastProposal;
  totalScore: number;
  scoreComponents: Record<string, number>;
  conditionMatch?: ConditionMatch;
  /** Present when the work is only possible after a journey the engine has costed. */
  trip?: ClientTrip;
  /** Why a candidate blocked only by being elsewhere has no journey the engine will direct now. */
  tripReason?: "no_mode" | "no_window";
}
export interface ClientRecommendationChoice {
  targetId: string;
  title: string;
  tier: CriticalTier;
  tierLabel: string;
  reason: string;
}
export interface ClientCounterfactual {
  condition: "at_location" | "energy_high" | "longer_session";
  description: string;
  thenPrimary: { targetId: string; title: string; recommendedMinutes: number } | null;
}
/** Why this, why not the nearer thing, and what would change it — see logic-design §12. */
export interface ClientRecommendationWhy {
  because: ClientRecommendationChoice | null;
  whyNot: (ClientRecommendationChoice & { decidingFactor: string }) | null;
  wouldChangeIf: ClientCounterfactual[];
}
// needsAnswer and reachable are optional because a recommendation persisted before the typed-context
// cutover has neither, and that stored result stays on screen until the engine next runs.
export interface ClientRecommendation {
  primary: ClientCandidate | null;
  alternatives: ClientCandidate[];
  candidates: ClientCandidate[];
  headline: string;
  explanation: string;
  evidence: string[];
  needsAnswer?: ClientCandidate[];
  reachable?: ClientCandidate[];
  why?: ClientRecommendationWhy;
  protectedCommitment?: ClientProtectedCommitment;
  /**
   * The anchor commitment happening right now whose own window this ranking was allowed to fill: you
   * are there, and no engagement session says you are taken up by it. Never set at the same time as
   * `protectedCommitment`, which means the opposite — that the clock is held and nothing is on offer.
   */
  openAnchor?: ClientProtectedCommitment;
}
export interface ClientProtectedCommitment {
  id: string;
  title: string;
  /**
   * In the order they occur. `travel` and `return` are the legs to and from a located commitment
   * and `arrival` the margin after one, all protected exactly as the buffers are.
   */
  phase: "setup" | "travel" | "arrival" | "active" | "transition" | "return";
  startsAt: Date;
  endsAt: Date;
  protectedStartAt: Date;
  protectedEndAt: Date;
  /** The window of the current phase alone — where tracking it, rather than the whole commitment, ends. */
  phaseStartsAt: Date;
  phaseEndsAt: Date;
  /**
   * Set when the clock alone would say `active` but the commitment is not actually ready to be: its
   * own before-phase routine steps are unfinished, or (for a located one) arrival is unasserted.
   * `phase` still reads `setup` or `travel` as usual — this only means the headline says so
   * explicitly ("Running late for X") and, for the Now page's own model, that the routine-step/travel
   * machinery still runs against this commitment rather than being shut out by it.
   */
  late?: boolean;
}
/** One action's adherence to its own period; see `ClientForecast.adherence`. */
export interface ClientProjectAdherenceAction {
  actionId: string;
  done: number;
  expectedSoFar: number;
  target: number;
  periodLabel: string;
}
/**
 * A maintenance project's adherence roll-up; present only when `ClientForecast.healthBasis` is
 * "adherence". `health` is the real classification — `ClientForecast.health` itself stays "unknown"
 * for these projects (see the engine's `ProjectAdherence` for why); read this field to display it.
 */
export interface ClientProjectAdherence {
  health: "behind" | "at_risk" | "on_track" | "ahead";
  ratio: number;
  actions: ClientProjectAdherenceAction[];
}
export interface ClientForecast {
  projectId: string;
  health: "ahead" | "on_track" | "at_risk" | "behind" | "unknown";
  /** The internal deadline has passed; health stays Behind and no work now recovers it. */
  overdue?: boolean;
  /** "feasibility" (default) or "adherence" for a maintenance project; see `ClientProjectAdherence`. */
  healthBasis?: "feasibility" | "adherence";
  adherence?: ClientProjectAdherence;
  proposal?: ClientForecastProposal;
  /** Present only on a live forecast whose work does not fully fit. Absent from results before. */
  interventions?: ClientForecastIntervention[];
  protectedRemainingMinutes: number | null;
  pessimisticRemainingMinutes: number | null;
  compatibleCapacityMinutes: number | null;
  grossCompatibleCapacityMinutes: number | null;
  reservedByEarlierDeadlinesMinutes: number;
  requiredPaceMinutesPerWeek: number | null;
  forecastBand: string | null;
  confidence: string | null;
  forecastThrough: Date;
  expectedMarginMinutes: number | null;
  pessimisticMarginMinutes: number | null;
  marginRatio: number | null;
  scheduleVariance: number | null;
  internalDeadlineAt?: Date;
  unallocatedExpectedMinutes: number;
  latestSafeStarts: Record<string, Date | null>;
  /** Units the engine could not place before the deadline; see the engine's `ProjectForecast`. */
  unplacedUnitIds?: string[];
  /** Estimates whose old remaining time lowered this forecast's confidence (effort age). */
  agedInputs?: { actionId: string; title: string; setAt: Date }[];
  reasons: string[];
}
export interface ClientCapacityEnvelope {
  kind: string;
  confidence: string;
  capacityFactor: number;
  startsAt: Date;
  endsAt: Date;
  rawCapacityMinutes: number;
  adjustedCapacityMinutes: number;
  protectedKnownMinutes: number;
  reservedMinutes: number;
  freeMinutes: number;
}
export interface ClientProjectEnvelope {
  projectId: string;
  kind: string;
  confidence: string;
  startsAt: Date;
  endsAt: Date;
  reservedMinutes: number;
  requiredPaceMinutes: number;
}
/** One fifteen-minute cell of the engine's detailed band, from the calculation time forward. */
export interface ClientSlot {
  id: string;
  startsAt: Date;
  endsAt: Date;
  availability: "free" | "fixed" | "protected" | "unavailable";
  energy: string;
  capacityMinutes: number;
}
/**
 * A latest-safe reservation: the engine allocating backward from a deadline into a slot to prove
 * the work still fits. It is feasibility evidence, not an instruction to do the work then.
 */
export interface ClientAllocation {
  actionId: string;
  projectId: string;
  slotId: string;
  startsAt: Date;
  endsAt: Date;
  minutes: number;
}
interface ClientSchedule {
  slots: ClientSlot[];
  allocations?: ClientAllocation[];
  forecasts: ClientForecast[];
  capacityEnvelopes: ClientCapacityEnvelope[];
  projectEnvelopes: ClientProjectEnvelope[];
}
export interface ClientContinuation {
  safe: boolean;
  recommendedMinutes: number;
  reason: string;
  displacedProjectIds: string[];
}
export interface ClientWeekOutlookProject {
  projectId: string;
  reservedMinutes: number;
  requiredPaceMinutesPerWeek: number | null;
  paceShortfallMinutes: number;
  health: ClientForecast["health"];
}
/** The detailed band read as a week: what is reserved for whom, what is free, who needs more of it. */
export interface ClientWeekOutlook {
  startsAt: Date;
  endsAt: Date;
  capacityMinutes: number;
  reservedMinutes: number;
  freeMinutes: number;
  projects: ClientWeekOutlookProject[];
  underPacedProjectIds: string[];
  areas: Array<{ areaId: string; reservedMinutes: number }>;
  /** A cadence is never reserved: what a week of it would want, and what is already due. */
  cadence?: {
    demandMinutesPerWeek: number;
    due: Array<{ actionId: string; dueLocalDate: string; daysOverdue: number }>;
    softReservedMinutes?: number;
    actions?: Array<{ actionId: string; expectedOccurrences: number; fittingOccurrences: number }>;
  };
}

const EMPTY_RECOMMENDATION: ClientRecommendation = {
  primary: null,
  alternatives: [],
  candidates: [],
  headline: "No plan yet",
  explanation: "The planner hasn't produced a recommendation yet.",
  evidence: ["Now updates by itself as soon as a plan lands."]
};
type CheckRequest = (options?: { force?: boolean; stateReloadQueued?: boolean }) => void;
const noCheck: CheckRequest = () => undefined;
const EMPTY_SCHEDULE: ClientSchedule = { slots: [], forecasts: [], capacityEnvelopes: [], projectEnvelopes: [] };
const EMPTY_ALLOCATIONS: ClientAllocation[] = [];
const EMPTY_DIRECTIVES: PlanForecastResponse["upcomingDirectives"] = [];

/**
 * The one check-in worth showing right now, as `/api/check-ins/current` reports it — outside
 * `PortalState` entirely, since the check-in table has no bearing on planning (see `portal/server/persistence/postgres/readers/check-in-read.ts`
 * on the server). `status` is narrowed to the two a client ever needs to render: 'pending' asks "Still
 * on X?"; 'unknown' is the catch-up case, asked in the past tense about a slot missed while away.
 */
export interface CheckInPrompt {
  id: string;
  version: number;
  status: "pending" | "unknown";
  slotAt: string;
  directiveKind:
    | "action"
    | "sleep"
    | "routine_step"
    | "routine_instance"
    | "deliverable"
    | "travel"
    | "protected_commitment"
    | "open_anchor";
  directiveTitle: string;
  /** The hourly photo is due with this check-in (photo mode `on`, none taken in the last hour). */
  photoRequested?: boolean;
}

const PortalContext = createContext<PortalContextValue | null>(null);
const INITIAL_RENDER_TIME = new Date(0);

export function PortalProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<PortalState>(() => createSeedState(INITIAL_RENDER_TIME));
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  // The first read failed and nothing real has loaded since: pages would only show the seed plan, which
  // reads as an empty one, so the shell shows the failure in their place until a read succeeds.
  const [initialLoadFailed, setInitialLoadFailed] = useState(false);
  // The portal answered 401 for owner auth: nothing is shown until this browser is enrolled (see SignInRequired).
  const [signInRequired, setSignInRequired] = useState(false);
  // The sign-in is needed because a cookie lapsed, not because this browser is new.
  const [signInExpired, setSignInExpired] = useState(false);
  // State reads kept failing after their retries: what is on screen is the last good read, taken at `lastGood`.
  const [stateUnreachable, setStateUnreachable] = useState<{
    lastGood: string | null;
    kind: "network" | "server";
  } | null>(null);
  const lastGoodReadAt = useRef<string | null>(null);
  const stateUnreachableSince = useRef(false);
  const stateRecoveryAttempt = useRef(0);
  const [saveError, setSaveError] = useState("");
  const [online, setOnline] = useState(true);
  const [replay, setReplay] = useState<ReplaySession | null>(null);
  const [awaitingPlan, setAwaitingPlan] = useState(false);
  /**
   * The freshest `lastSuccessfulAt` any status poll has reported, independent of whether `state` has
   * caught up to it yet. `state.planning?.lastSuccessfulAt` alone cannot tell the difference between
   * "current" and "current as of before the server moved on" — this is what lets the Now page say
   * "Refreshing…" honestly instead of "Plan current" for the gap between the two.
   */
  const [knownLatestSuccessfulAt, setKnownLatestSuccessfulAt] = useState<string | null>(null);
  const [planHealth, setPlanHealth] = useState<PlanHealth | null>(null);
  const [serverClockOffsetMs, setServerClockOffsetMs] = useState(0);
  // True once the clock has passed the loaded plan's `validUntil`. The clock does not re-render this
  // provider, so a timer flips it at the boundary; the stored `status` alone cannot, being frozen at
  // the moment of the last fetch.
  const [pendingCheckIn, setPendingCheckIn] = useState<CheckInPrompt | null>(null);
  /** Mirrors `live-updates.ts`'s connection state. See `PortalContextValue.live`'s doc comment. */
  const [live, setLive] = useState(false);
  /** Read by the idle-tick effect on every reschedule, so its interval can lengthen or shorten as the
   *  stream connects/drops without tearing the effect down and rebuilding it. */
  const liveRef = useRef(false);
  useEffect(() => {
    liveRef.current = live;
  }, [live]);
  /** The newest state shown, for `showState` to compare a new one against without re-creating itself. */
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  /** Adopts a stored state, through Now's hero transition when it changes what the hero shows. */
  /** The ETag of the `/api/state` answer on screen, or null once anything else (a command's response, a
   *  snapshot) has replaced it; an identical ETag on a later read means there is nothing new to adopt. */
  const shownStateEtag = useRef<string | null>(null);
  const showState = useCallback((next: PortalState) => {
    shownStateEtag.current = null;
    // Updated here as well as after render, so two adoptions before a render compare in order.
    const previous = stateRef.current;
    stateRef.current = next;
    swapHero(previous, next, () => setState(next));
  }, []);
  /** Null in any environment without `EventSource` (a test's jsdom, an old browser) or while a
   *  snapshot replay is open — every caller below already treats "no controller" as "poll as before". */
  const liveUpdatesRef = useRef<LiveUpdatesController | null>(null);
  const recalculationBucket = useRef<number | null>(null);
  /** The same per-minute guard as `recalculationBucket`, kept separate since the two checks run on
   *  independent schedules (see `checkPendingCheckIn`). */
  const checkInBucket = useRef<number | null>(null);
  /** Bumped on every `checkPendingCheckIn` request; a response is only adopted while it still holds
   *  the generation that issued it, so an answer overtaken by a newer request cannot land after it. */
  const checkInRequestGeneration = useRef(0);
  /** The id of the check-in `dismissPendingCheckIn` most recently cleared, so a request already in
   *  flight when the dismissal happened cannot resurrect the very banner it just closed. */
  const dismissedCheckInId = useRef<string | null>(null);
  // Declared up here, ahead of the effects that read them, and pointed at the real checks by the
  // effect that follows `checkPendingCheckIn` below. Every reader runs from a timer or an
  // event, after that effect has run, so the no-op never answers a real call.
  const checkPlanFreshnessRef = useRef<CheckRequest>(noCheck);
  const checkPendingCheckInRef = useRef<CheckRequest>(noCheck);
  const checkExtensionsRef = useRef<CheckRequest>(noCheck);
  const automaticFeedbackAttempt = useRef<string | null>(null);
  /** One freshness poll at a time; a second command while one runs extends it rather than racing it. */
  const planPollDeadline = useRef(0);
  const planPollRunning = useRef(false);
  /** Set for the whole of a command, so a poll cannot answer with state written before it finished. */
  const commandsInFlight = useRef(0);
  // Bumped whenever a command starts, so a state read that began before a command, or while one ran,
  // can tell when it was overtaken even if the command has already settled by the time it lands.
  const commandEpoch = useRef(0);
  // Bumped when a state read starts. A read may adopt its answer only if no later-started read has
  // already adopted one (`committedStateReadGeneration`), so two reads resolving out of order cannot let
  // the older snapshot overwrite the newer one, while an older read still lands when the newer failed.
  const stateReadGeneration = useRef(0);
  const committedStateReadGeneration = useRef(0);
  // Set when a state read was skipped or discarded because a command was in flight; the last command
  // to settle runs one read to catch up with what the event announced.
  const reloadPending = useRef(false);
  // The same for a plan check asked for while a command was in flight (`checkPlanFreshness` yields to
  // it). A pushed `state` event asks for both a read and a check, and the check is the only thing that
  // puts the tab on the recovery path when a forecast job it enqueued retries or fails; it runs once the
  // last command settles, with the read it rides on already queued (`stateReloadQueued`).
  const planCheckPending = useRef<{ force: boolean; stateReloadQueued: boolean } | null>(null);
  // Kinds of the pushed `changed` events since the last refresh fired; `onRefresh` drains it.
  const pendingLiveKinds = useRef<Set<LiveEventKind>>(new Set());
  // The pending retry of a failed non-initial state read, and how many have been scheduled since the
  // last successful commit. Any commit cancels the timer and resets the count.
  const stateRetryTimer = useRef<number | null>(null);
  const stateRetryAttempt = useRef(0);
  // The generation of the failed read the pending retry is for. A commit cancels the retry only when its
  // own generation is that one or newer: an older read landing later may predate the write the failed
  // read was sent to catch, so it must not stand the retry down.
  const stateRetryGeneration = useRef(0);
  // Set once the provider unmounts, so a read still in flight then cannot arm a retry nobody clears.
  const providerUnmounted = useRef(false);
  useEffect(() => {
    providerUnmounted.current = false;
    return () => {
      providerUnmounted.current = true;
      if (stateRetryTimer.current !== null) window.clearTimeout(stateRetryTimer.current);
    };
  }, []);

  /**
   * The one place a `/api/state` read is committed, for the initial load, `reloadState` and the
   * hello reconcile alike, so the guards and their consequences cannot drift apart:
   * - a read adopts its answer unless a later-started read already has (`committedStateReadGeneration`),
   *   so out-of-order answers never let an older snapshot win, while an older read still lands when the
   *   newer one failed;
   * - a command in flight, or one that started after the read did, owns the newer truth through its own
   *   response. A read held back for a command in flight is run by the last command to settle
   *   (`reloadPending`); one discarded by a command that has since settled gets one follow-up read, since
   *   a command that failed or timed out carries no state and would otherwise leave this tab stale;
   * - any successful commit clears `loadError`: only an initial load that never succeeded leaves the banner.
   * The follow-up is a single fresh read with its own guards, so it cannot loop on its own;
   * - a non-initial read that fails (network error or a non-OK answer) is retried a bounded number of
   *   times with backoff, since a lone `state` event would otherwise stay unread until the five-minute
   *   tick. A retry is dropped as soon as any later read commits.
   */
  /** The portal refused for want of an owner credential: show the sign-in screen and stop every retry. */
  const signInRefused = useCallback((reason: string | null | undefined) => {
    // The refusal clears an expired cookie, so a later read answers read-anonymous; once seen, "expired" sticks.
    // A browser that has signed in before and now reads as anonymous had its cookie dropped after going unused.
    if (reason === "cookie-expired" || (isAnonymousRefusal(reason) && wasSignedInBefore())) setSignInExpired(true);
    setSignInRequired(true);
    setLoadError("Sign in to see your plan.");
    if (stateRetryTimer.current !== null) window.clearTimeout(stateRetryTimer.current);
    stateRetryTimer.current = null;
    stateRetryAttempt.current = 0;
    stateRecoveryAttempt.current = 0;
  }, []);

  const readState = useCallback(
    async function read(initial: boolean): Promise<boolean> {
      // A command that started after the poll did holds the newer truth, and its own response will
      // set it. Overwriting with a read taken mid-write is how a just-saved edit appears to vanish.
      // The read is not lost, though: the last command to settle runs it (see `runCommand`).
      // A snapshot replay shows captured state and must never touch live data: no caller may read over it.
      if (!initial && replayRequest()) return false;
      if (!initial && commandsInFlight.current > 0) {
        reloadPending.current = true;
        return false;
      }
      const epoch = commandEpoch.current;
      const generation = ++stateReadGeneration.current;
      // A refused answer is the server's fault; a thrown fetch is the network's. The banner words them apart.
      let serverError = false;
      try {
        const response = await fetch("/api/state");
        if (response.status === 401 && response.headers?.get("x-owner-reason")) {
          // Owner auth is required and this browser has no credential: show the sign-in screen, retry nothing.
          signInRefused(response.headers.get("x-owner-reason"));
          return false;
        }
        if (!response.ok) {
          serverError = true;
          throw new Error("The saved plan could not be loaded.");
        }
        const etag = response.headers?.get("etag") ?? null;
        const unchanged = etag !== null && etag === shownStateEtag.current;
        // The server vouches that the body is the one already shown: skip parsing 780 KB and re-rendering it.
        const stored = unchanged ? null : ((await response.json()) as { state: PortalState | null }).state;
        if (!unchanged && !stored && !initial) return false;
        if (commandsInFlight.current > 0) {
          reloadPending.current = true;
          return false;
        }
        // A read that started after this one owns the newer snapshot once it has landed.
        if (generation < committedStateReadGeneration.current) return false;
        if (commandEpoch.current !== epoch) {
          // A command started (and has settled) after this read began; if it succeeded its response set
          // the newer state, and if it failed nothing did. One follow-up read covers both.
          void read(false);
          return false;
        }
        committedStateReadGeneration.current = generation;
        if (generation >= stateRetryGeneration.current) {
          if (stateRetryTimer.current !== null) window.clearTimeout(stateRetryTimer.current);
          stateRetryTimer.current = null;
          stateRetryAttempt.current = 0;
        }
        if (!unchanged) {
          showState(stored ? normalizePortalState(stored) : createSeedState());
          shownStateEtag.current = etag;
        }
        lastGoodReadAt.current = new Date().toISOString();
        stateUnreachableSince.current = false;
        stateRecoveryAttempt.current = 0;
        setStateUnreachable(null);
        setLoadError("");
        setInitialLoadFailed(false);
        return true;
      } catch {
        if (!initial && !providerUnmounted.current && committedStateReadGeneration.current <= generation) {
          const attempt = stateRetryAttempt.current;
          if (stateUnreachableSince.current || attempt >= STATE_READ_RETRY_DELAYS_MS.length) {
            stateRetryAttempt.current = 0;
            stateUnreachableSince.current = true;
            setStateUnreachable({ lastGood: lastGoodReadAt.current, kind: serverError ? "server" : "network" });
            // A healthy status poll with an unchanged plan never reloads state, so nothing else would clear the
            // banner once the server is back: keep reading, backing off up to five minutes.
            const recovery = Math.min(
              STATE_RECOVERY_BASE_MS * 2 ** Math.min(stateRecoveryAttempt.current, 4),
              STATE_RECOVERY_MAX_MS
            );
            stateRecoveryAttempt.current += 1;
            stateRetryGeneration.current = generation;
            if (stateRetryTimer.current !== null) window.clearTimeout(stateRetryTimer.current);
            stateRetryTimer.current = window.setTimeout(() => {
              stateRetryTimer.current = null;
              void read(false);
            }, recovery);
          } else {
            stateRetryAttempt.current = attempt + 1;
            stateRetryGeneration.current = generation;
            if (stateRetryTimer.current !== null) window.clearTimeout(stateRetryTimer.current);
            stateRetryTimer.current = window.setTimeout(() => {
              stateRetryTimer.current = null;
              if (committedStateReadGeneration.current > generation) return;
              void read(false);
            }, STATE_READ_RETRY_DELAYS_MS[attempt]);
          }
        }
        // A later-started read that already adopted valid state means there is nothing to report: the
        // page is showing stored data, and the banner would also suppress every poll.
        if (initial && committedStateReadGeneration.current <= generation) {
          setLoadError("Your plan could not be loaded from the database.");
          setInitialLoadFailed(true);
        }
        return false;
      } finally {
        if (initial) setReady(true);
      }
    },
    [showState, signInRefused]
  );

  const reloadState = useCallback(() => readState(false), [readState]);
  /** Bumped whenever a command's state is adopted; a `readPlanningStatus` that began under an older
   *  value read the plan from before that command, so its answer is dropped rather than applied. */
  const planningStatusGeneration = useRef(0);

  useEffect(() => {
    const requested = replayRequest();
    if (!requested) {
      // Deferred a microtask so the load's own state updates never run synchronously inside the effect.
      queueMicrotask(() => void readState(true));
      return;
    }
    fetch(`/api/snapshots/${encodeURIComponent(requested.id)}`)
      .then((response) => {
        if (!response.ok) throw new Error("That snapshot could not be loaded.");
        return response.json() as Promise<IssueSnapshot>;
      })
      .then((snapshot) => {
        // The two copies are kept apart on purpose. The browser polls, so a page can be rendering
        // state the database has already moved past; replaying either one is how that is seen.
        const captured = requested.source === "client" ? snapshot.client.state : snapshot.server.state;
        if (!captured) throw new Error(`The ${requested.source} state was not recorded in that snapshot.`);
        setState(normalizePortalState(captured as unknown as PortalState));
        freezeClock(new Date(snapshot.client.observedAt));
        setReplay({
          id: snapshot.id,
          description: snapshot.description,
          capturedAt: snapshot.capturedAt,
          observedAt: snapshot.client.observedAt,
          source: requested.source,
          warnings: snapshot.warnings
        });
      })
      .catch((error: unknown) =>
        setLoadError(error instanceof Error ? error.message : "That snapshot could not be loaded.")
      )
      .finally(() => setReady(true));
  }, [readState]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  const planValidUntil = state.planning?.validUntil ?? null;
  // The expiry is recorded against the boundary (and clock offset) it was reached for, so a new
  // `validUntil` or a re-measured offset starts again from "not expired" with no reset to write. The
  // timer below only ever sets this; it is the clock, not a render, that decides the boundary is past.
  const planExpiryKey = planValidUntil === null ? null : `${planValidUntil}|${serverClockOffsetMs}`;
  const [expiredPlanKey, setExpiredPlanKey] = useState<string | null>(null);
  const planExpired = planExpiryKey !== null && expiredPlanKey === planExpiryKey;
  useEffect(() => {
    if (!planValidUntil || planExpiryKey === null) return;
    const remaining = new Date(planValidUntil).getTime() - serverNow(serverClockOffsetMs, readNow()).getTime();
    // Already past when this runs: mark it on the next turn of the event loop (a zero-delay timer) and
    // skip the freshness check, as there is no boundary being crossed to ask about.
    const alreadyExpired = remaining <= 0;
    const timer = window.setTimeout(
      () => {
        setExpiredPlanKey(planExpiryKey);
        // The boundary refresh is normally already running, but this tab has no way to know that
        // without asking: look now rather than at the next tick, so Start returns as soon as it lands.
        if (!alreadyExpired) checkPlanFreshnessRef.current({ force: true });
      },
      alreadyExpired ? 0 : Math.min(remaining, 2_147_483_647)
    );
    return () => window.clearTimeout(timer);
  }, [planValidUntil, planExpiryKey, serverClockOffsetMs]);

  const schedule = useMemo(
    () => hydrateJson<ClientSchedule>(state.planning?.result?.schedule) ?? EMPTY_SCHEDULE,
    [state.planning?.result]
  );
  const forecasts = schedule.forecasts;
  const recommendation = useMemo(
    () => hydrateJson<ClientRecommendation>(state.planning?.result?.recommendation) ?? EMPTY_RECOMMENDATION,
    [state.planning?.result]
  );
  const currentDirective = state.planning?.result?.currentDirective ?? null;
  const upcomingDirectives = state.planning?.result?.upcomingDirectives ?? EMPTY_DIRECTIVES;
  const dayPlan = state.planning?.result?.dayPlan ?? null;
  const continuation = useMemo(
    () =>
      state.activeSession?.status === "feedback"
        ? hydrateJson<ClientContinuation>(state.planning?.result?.continuation)
        : null,
    [state.activeSession?.status, state.planning?.result]
  );
  const weekOutlook = useMemo(
    () => hydrateJson<ClientWeekOutlook>(state.planning?.result?.weekOutlook),
    [state.planning?.result]
  );

  // A quiet tab only ever polls the status route, never /api/state, so a failed status check is what starts a
  // state read; that read's own retries then decide whether the banner speaks. One chain at a time.
  const probeStateRead = useCallback(() => {
    if (stateRetryTimer.current === null) void readState(false);
  }, [readState]);

  const readPlanningStatus = useCallback(async (): Promise<PlanningStatus | null> => {
    const generation = planningStatusGeneration.current;
    // A command that finished (or is still running) since this read began holds the newer truth: its
    // own response set the "updating" signal, and an answer from before the save would clear it.
    const superseded = () => generation !== planningStatusGeneration.current || commandsInFlight.current > 0;
    try {
      const response = await fetch("/api/planning/status", { cache: "no-store" });
      if (response.status === 401 && response.headers?.get("x-owner-reason")) {
        // An expired cookie can be refused here first, and the refusal clears it: the next read would then
        // look like a first visit. Show the sign-in screen from this answer, with its reason.
        signInRefused(response.headers.get("x-owner-reason"));
        return null;
      }
      if (!response.ok) {
        if (superseded()) return null;
        setPlanHealth((current) =>
          current ? { ...current, unreachable: true } : { ...UNKNOWN_PLAN_HEALTH, unreachable: true }
        );
        probeStateRead();
        return null;
      }
      const status = (await response.json()) as PlanningStatus;
      if (superseded()) return null;
      setPlanHealth({
        refresh: status.refresh ?? "refreshing",
        updating: planIsUpdating(status),
        latestJobFailed: Boolean(status.latestJobFailed),
        graceEndsAt: status.graceEndsAt ?? null,
        unreachable: false
      });
      const serverTime = status.serverNow ? Date.parse(status.serverNow) : Number.NaN;
      // Whole seconds only: the offset feeds an effect's dependencies, and a few milliseconds of
      // round-trip jitter would otherwise re-arm the expiry timer on every poll.
      if (Number.isFinite(serverTime)) setServerClockOffsetMs(Math.round((serverTime - Date.now()) / 1000) * 1000);
      // Recorded regardless of whether `state` adopts this run — a poll that only confirms freshness
      // still moves the high-water mark, and a stale-but-still-polling tab must not read as caught up.
      if (status.lastSuccessfulAt) setKnownLatestSuccessfulAt(status.lastSuccessfulAt);
      return status;
    } catch {
      if (superseded()) return null;
      setPlanHealth((current) =>
        current ? { ...current, unreachable: true } : { ...UNKNOWN_PLAN_HEALTH, unreachable: true }
      );
      probeStateRead();
      return null;
    }
  }, [probeStateRead, signInRefused]);

  /** Adopts the state a command response carries, letting its "a newer plan is coming" outrank an older poll. */
  const adoptCommandState = useCallback(
    (stored: PortalState) => {
      planningStatusGeneration.current += 1;
      showState(normalizePortalState(stored));
      // A command that got an answer proves the server is reachable and its state is current.
      lastGoodReadAt.current = new Date().toISOString();
      stateUnreachableSince.current = false;
      stateRecoveryAttempt.current = 0;
      setStateUnreachable(null);
      if (stored.planning?.awaitingRecalculation) setPlanHealth(planHealthAfterSave);
    },
    [showState]
  );

  /**
   * Watches for a plan newer than `baseline` and adopts it, for as long as one is plausibly coming.
   *
   * Stopping as soon as nothing is queued and nothing is awaited matters as much as the polling: a
   * job that failed, or a command that changed nothing the engine cares about, must not leave the
   * page checking for half a minute and showing an indicator the whole time.
   */
  const followPlanRefresh = useCallback(
    async (baseline: string | null) => {
      if (replayRequest()) return;
      planPollDeadline.current = Date.now() + PLAN_POLL_LIMIT_MS;
      if (planPollRunning.current) return;
      planPollRunning.current = true;
      setAwaitingPlan(true);
      try {
        // Event-driven first: a live connection means the server will push a `planning` event the
        // moment this command's own forecast job persists, almost always faster than even the first
        // poll interval below. A miss here (not live yet, an unlucky coalesce, a reconnect in
        // progress) is not an error — it just means falling through to the poll loop exactly as
        // before, only having spent at most `PLAN_EVENT_WAIT_MS` finding that out.
        if (liveUpdatesRef.current?.isLive) {
          const remaining = planPollDeadline.current - Date.now();
          const arrived = await liveUpdatesRef.current.waitForPlanningEvent(Math.min(PLAN_EVENT_WAIT_MS, remaining));
          if (replayRequest() || providerUnmounted.current) return;
          if (arrived) {
            const status = await readPlanningStatus();
            if (status?.lastSuccessfulAt && status.lastSuccessfulAt !== baseline) {
              if (await reloadState()) return;
            }
            if (status && !status.awaitingRecalculation && !status.openJob?.dueNow) return;
          }
        }
        while (Date.now() < planPollDeadline.current) {
          await new Promise((resolve) => setTimeout(resolve, PLAN_POLL_INTERVAL_MS));
          // An unmounted provider has no page left to update; polling on would only cost requests.
          if (replayRequest() || providerUnmounted.current) return;
          const status = await readPlanningStatus();
          if (!status) continue;
          if (status.lastSuccessfulAt && status.lastSuccessfulAt !== baseline) {
            if (await reloadState()) return;
          }
          if (!status.awaitingRecalculation && !status.openJob?.dueNow) return;
        }
      } finally {
        planPollRunning.current = false;
        setAwaitingPlan(false);
      }
    },
    [readPlanningStatus, reloadState]
  );

  /**
   * Posts one command and answers with its parsed body. A refusal is thrown as a `CommandRefusal` (an `Error` with the
   * server's sentence), so a caller that can act on it reads `nextCall` and `status`; `options.handles` names the
   * refusals the caller shows itself, which then do not light the global save banner.
   */
  const runCommandJson = useCallback(
    async <Body extends { state?: PortalState }>(
      path: string,
      command: unknown,
      options: CommandOptions = {}
    ): Promise<Body> => {
      // Every mutation in the portal funnels through here, so refusing here is what makes a replay
      // structurally incapable of writing rather than merely discouraged from it.
      if (replayRequest()) {
        setSaveError(REPLAY_READ_ONLY);
        throw new Error(REPLAY_READ_ONLY);
      }
      setSaving(true);
      commandsInFlight.current += 1;
      commandEpoch.current += 1;
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        commandsInFlight.current -= 1;
        // Overlapping commands share the flag: only the last one to finish may clear it.
        if (commandsInFlight.current === 0) {
          setSaving(false);
          // A live event arrived while this command ran and its read was held back; one read now
          // catches up, after the command's own response has been adopted.
          if (reloadPending.current) {
            reloadPending.current = false;
            void reloadState();
            // The held-back plan check must not read state a second time (see the effect on `saving`).
            if (planCheckPending.current) planCheckPending.current.stateReloadQueued = true;
          }
        }
      };
      setSaveError("");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), COMMAND_TIMEOUT_MS);
      try {
        const response = await fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(command),
          signal: controller.signal
        });
        // A proxy 502/504 answers with HTML; never let the parse error become the banner text.
        const result = (await response.json().catch(() => ({}))) as Body & {
          error?: string;
          currentVersion?: number;
          nextCall?: AgentCall;
          validValues?: Record<string, string[]>;
        };
        if (!response.ok || !result.state) {
          if (response.status === 400 || response.status === 409) {
            const refreshed = await fetch("/api/state")
              .then((stateResponse) =>
                stateResponse.ok ? (stateResponse.json() as Promise<{ state: PortalState | null }>) : null
              )
              .catch(() => null);
            // Through `showState`, so the ETag of what was on screen is forgotten along with it.
            if (refreshed?.state) showState(normalizePortalState(refreshed.state));
          }
          const message =
            result.error ??
            (response.ok
              ? "The change was not saved."
              : "The server could not be reached just now. The change may not have been saved; check and try again.");
          throw response.ok
            ? new Error(message)
            : new CommandRefusal(message, {
                status: response.status,
                currentVersion: result.currentVersion,
                nextCall: result.nextCall,
                validValues: result.validValues
              });
        }
        adoptCommandState(result.state);
        // The response carries the run that existed *before* this command, because the recalculation
        // it triggered is only now queued. That timestamp is the baseline a fresher plan must beat.
        const baseline = result.state.planning?.lastSuccessfulAt ?? null;
        settle();
        void followPlanRefresh(baseline);
        return result;
      } catch (error) {
        const message =
          (error as { name?: string } | null)?.name === "AbortError"
            ? "The server took too long to answer. The change may not have been saved; check and try again."
            : error instanceof Error
              ? error.message
              : "The change was not saved.";
        if (!(error instanceof CommandRefusal && options.handles?.(error))) setSaveError(message);
        // Callers that show the rejection themselves get the same plain text as the banner.
        throw error instanceof Error && error.message === message ? error : new Error(message);
      } finally {
        clearTimeout(timer);
        settle();
      }
    },
    [adoptCommandState, followPlanRefresh, reloadState, showState]
  );
  const runCommand = useCallback(
    async (path: string, command: unknown) => {
      await runCommandJson(path, command);
    },
    [runCommandJson]
  );
  const closeEntityCommand = useCallback(
    async (command: CloseEntityCommand, options?: CommandOptions) =>
      (await runCommandJson<{ state: PortalState; closed: CloseEntityResult }>("/api/commands/close", command, options))
        .closed,
    [runCommandJson]
  );
  const recalculate = useCallback(
    () =>
      runCommand("/api/commands/recalculate", {
        commandId: createClientId(),
        type: "recalculate",
        // The server stamps the real planning time; this is only a schema-valid placeholder.
        now: new Date().toISOString()
      }),
    [runCommand]
  );
  const saveProjectCommand = useCallback(
    (command: SaveProjectCommand) => runCommand("/api/commands/project", command),
    [runCommand]
  );
  const confirmProjectWantedCommand = useCallback(
    (command: ConfirmProjectWantedCommand) => runCommand("/api/commands/project-review", command),
    [runCommand]
  );
  const saveActionCommand = useCallback(
    (command: SaveActionCommand) => runCommand("/api/commands/action", command),
    [runCommand]
  );
  const saveEntityCommand = useCallback(
    (command: PlanningEntityCommand) => runCommand("/api/commands/entity", command),
    [runCommand]
  );
  const saveCommitmentRecurrenceRuleCommand = useCallback(
    (command: SaveCommitmentRecurrenceRuleCommand) => runCommand("/api/commands/commitment-recurrence", command),
    [runCommand]
  );
  const splitCommitmentSourceCommand = useCallback(
    (command: SplitCommitmentSourceCommand) => runCommand("/api/commands/commitment-source-split", command),
    [runCommand]
  );
  const endRecurrenceGoalCommand = useCallback(
    (command: EndRecurrenceGoalCommand) => runCommand("/api/commands/recurrence-goal", command),
    [runCommand]
  );
  const recordCadenceCompletionCommand = useCallback(
    (command: RecordCadenceCompletionCommand) => runCommand("/api/commands/cadence-completion", command),
    [runCommand]
  );
  const addCapture = useCallback(
    async (text: string) => {
      const id = createClientId();
      await saveEntityCommand({
        commandId: createClientId(),
        expectedVersion: null,
        type: "save_entity",
        entityType: "capture",
        entity: {
          id,
          text,
          createdAt: new Date().toISOString(),
          status: "pending",
          proposalType: "unclassified",
          proposedFields: { text },
          sourceType: "manual_capture"
        }
      });
      return id;
    },
    [saveEntityCommand]
  );
  const acceptServerState = useCallback(
    (serverState: PortalState) => {
      adoptCommandState(serverState);
      // Like `runCommand`: the state a command response carries is the plan from before the
      // recalculation it queued, so adopting it without following would show that plan as current.
      void followPlanRefresh(serverState.planning?.lastSuccessfulAt ?? null);
    },
    [adoptCommandState, followPlanRefresh]
  );
  const dismissPendingCheckIn = useCallback((checkInId?: string) => {
    // Given an id, that check-in is remembered as answered even if it is not showing yet (a deep link
    // answered before the first poll), and only a prompt with that id is cleared, so a newer one that
    // arrived meanwhile stays.
    const id = typeof checkInId === "string" ? checkInId : undefined;
    if (id) dismissedCheckInId.current = id;
    setPendingCheckIn((current) => {
      if (id && current?.id !== id) return current;
      // Remembered so a `checkPendingCheckIn` response already in flight when this ran — for the
      // very check-in just answered — is recognised as stale and dropped rather than reviving it.
      if (current) dismissedCheckInId.current = current.id;
      return null;
    });
  }, []);

  const runSessionCommand = useCallback(
    async (command: SessionCommand) => runCommand("/api/commands/session", command),
    [runCommand]
  );
  const runActivityCommand = useCallback(
    async (command: ActivityCommand) => runCommand("/api/commands/activity", command),
    [runCommand]
  );

  /**
   * The idle tick: a question, not a command.
   *
   * This used to enqueue a recalculation every five minutes whether or not anything had changed,
   * which on the live database produced twelve hundred and fifty engine runs a week — about two
   * seconds of engine time each — for a plan that was almost always already current. The boundary
   * chain is what keeps a plan fresh over time; the browser only needs to notice when it has, and to
   * ask for a new one when the chain has genuinely stopped.
   *
   * Extracted from the interval effect so `visibilitychange`/`focus` can ask the same question on
   * demand: the interval alone only notices a boundary refresh on its own schedule, and a throttled
   * background tab can miss that schedule for far longer than `STATUS_TICK_MS`.
   */
  const checkPlanFreshness = useCallback(
    (options?: { force?: boolean; stateReloadQueued?: boolean }) => {
      if (!ready || loadError) return;
      // Opening a replay must not touch live data. Without this, merely looking at a snapshot would
      // enqueue a recalculation against the real database.
      if (replayRequest()) return;
      // A command in flight owns the newest truth, so the check yields to it. A forced check (a pushed
      // event, a reconnect, coming back online) answers news that will not be announced again, so it is
      // held and the last command to settle replays it (the effect on `saving` below); an ordinary tick
      // or focus check simply recurs on the next tick, and holding it would only add a request.
      if (commandsInFlight.current > 0) {
        if (options?.force) {
          const held = planCheckPending.current;
          planCheckPending.current = {
            force: true,
            stateReloadQueued: Boolean(options.stateReloadQueued || held?.stateReloadQueued)
          };
        }
        return;
      }
      const known = state.planning?.lastSuccessfulAt ?? null;
      // A running session suppresses recalculation requests so the plan does not churn mid-activity, but
      // it must not stop this tab learning what changed elsewhere (the session stopped from the handheld,
      // a plan replanned around a new commitment). While the plan is current the check is a state read.
      const sessionHoldsPlan = Boolean(state.activeSession && state.planning?.status === "current");
      const bucket = Math.floor(Date.now() / STATUS_TICK_MS);
      // The bucket is claimed before the work and never released, so a portal whose server is down
      // retries once a minute and not on every change of input. Releasing it on failure turned an
      // unreachable server into a request storm. The same bucket also folds a visibility/focus-triggered
      // check into whichever interval tick it lands beside, so tabbing back and forth cannot itself
      // become a request storm.
      // `force` is for an online/reconnect signal: the outage is exactly why the last bucket's answer is
      // stale, so it must not be folded into it.
      if (!options?.force && recalculationBucket.current === bucket) return;
      recalculationBucket.current = bucket;
      if (sessionHoldsPlan) {
        // A pushed `state` event in the same burst has already asked for this read.
        if (!options?.stateReloadQueued) void reloadState();
        return;
      }
      const generation = planningStatusGeneration.current;
      void (async () => {
        const status = await readPlanningStatus();
        // No answer at all is not evidence the plan is fine; fall back to the behaviour that recovers.
        // An answer dropped because a command landed meanwhile is not "no answer": that command has
        // already queued its own recalculation.
        if (!status) {
          if (generation !== planningStatusGeneration.current || commandsInFlight.current > 0) return;
          await requestRecalculation();
          return;
        }
        // A validity-boundary run landing is the ordinary case, and costs one state read to adopt.
        if (status.lastSuccessfulAt && status.lastSuccessfulAt !== known) await reloadState();
        if (status.awaitingRecalculation || status.openJob?.dueNow) {
          void followPlanRefresh(status.lastSuccessfulAt);
          return;
        }
        // Nothing is queued. Only a missing, expired, or abandoned plan is worth an engine run, and not
        // one the engine already rejected: each recalculation is a new job with the same unchanged
        // request, so a terminal failure waits for the state to change instead of resending every tick.
        if (planFailureIsTerminal(status)) return;
        const unusable = !status.lastSuccessfulAt || status.stale || status.lastFinishedStatus === "failed";
        if (!status.openJob && unusable) await requestRecalculation();
      })().catch(() => undefined);
      async function requestRecalculation() {
        await recalculate().catch(() => undefined);
      }
    },
    [
      followPlanRefresh,
      loadError,
      readPlanningStatus,
      ready,
      recalculate,
      reloadState,
      state.activeSession,
      state.planning?.lastSuccessfulAt,
      state.planning?.status
    ]
  );

  /**
   * Delivery for a check-in the scheduler created since the tab last asked, piggybacked on the same
   * tick as `checkPlanFreshness` rather than a polling loop of its own. Deliberately not folded into
   * that function's body: `checkPlanFreshness` suppresses itself while a session is running and the
   * plan is current, which is exactly when a check-in — often on its hourly, session-aware cadence —
   * most needs to still be delivered.
   */
  const checkPendingCheckIn = useCallback(
    (options?: { force?: boolean }) => {
      if (!ready || loadError || replayRequest()) return;
      // The same per-minute bucket `checkPlanFreshness` claims for itself: it folds a visibility/focus
      // ask into whichever tick it lands beside, so tabbing back and forth cannot itself become a
      // request storm, and it is what kept the tick's own churn (see below) from firing this three
      // times over for one command.
      const bucket = Math.floor(Date.now() / STATUS_TICK_MS);
      if (!options?.force && checkInBucket.current === bucket) return;
      checkInBucket.current = bucket;
      const requestId = ++checkInRequestGeneration.current;
      fetch("/api/check-ins/current", { cache: "no-store" })
        .then((response) => (response.ok ? (response.json() as Promise<{ checkIn: CheckInPrompt | null }>) : null))
        .then((payload) => {
          // Superseded by a newer request — including one issued by a fresh mount after this tab was
          // gone for a while — so this answer is no longer the latest word and must not overwrite it.
          if (requestId !== checkInRequestGeneration.current) return;
          const checkIn = payload?.checkIn ?? null;
          // In flight when `dismissPendingCheckIn` ran for this same check-in: answering it already
          // told the server, and re-showing it here would let a second, stale-`expectedVersion` answer
          // go out if it were tapped again.
          if (checkIn && checkIn.id === dismissedCheckInId.current) return;
          setPendingCheckIn(checkIn);
        })
        .catch(() => undefined);
    },
    [ready, loadError]
  );

  // `checkPlanFreshness` and `checkPendingCheckIn` are rebuilt whenever anything they read changes —
  // `state.activeSession` most often, which `normalizePortalState` reconstructs on every reload — so
  // the interval below reaches them through refs kept fresh here rather than depending on the
  // callbacks directly. Depending on them directly used to tear the interval down and rebuild it,
  // firing an extra immediate `checkPendingCheckIn` each time, for every reload one command could
  // cause: its own response, the plan-refresh poll landing, and `checkPlanFreshness`'s own reload.
  useEffect(() => {
    checkPlanFreshnessRef.current = checkPlanFreshness;
    checkPendingCheckInRef.current = checkPendingCheckIn;
  }, [checkPlanFreshness, checkPendingCheckIn]);

  // What registered extensions keep in the provider (see `portal-extensions.ts`): polled on the same triggers as the
  // check-in, so the ref is pointed at their checks on every render.
  const extensionSlices = usePortalExtensionSlices({
    ready,
    loadError,
    reloadState,
    tickMs: STATUS_TICK_MS,
    replaying: isReplaying
  });
  const extensions = extensionSlices.values;
  useEffect(() => {
    checkExtensionsRef.current = extensionSlices.check;
  });

  // The last command to settle replays the plan check that was held back while it ran, once. Run from an
  // effect, not from `settle`, so it reads the state that command's own response has just committed and
  // the ref above is already pointing at the check built from it.
  useEffect(() => {
    if (saving || commandsInFlight.current > 0 || !planCheckPending.current) return;
    const held = planCheckPending.current;
    planCheckPending.current = null;
    checkPlanFreshnessRef.current(held);
  }, [saving]);

  useEffect(() => {
    if (!ready) return;
    checkPlanFreshnessRef.current();
    checkPendingCheckInRef.current();
    checkExtensionsRef.current();
    // The clock no longer re-renders this provider, so the tick keeps its own timer. A self-rescheduling
    // `setTimeout` rather than a plain `setInterval` so each firing can pick a fresh delay off `liveRef`
    // — `STATUS_TICK_LIVE_MS` while `/api/events` is up (this is then only a safety net for a missed or
    // coalesced-away push), `STATUS_TICK_MS` otherwise — without tearing the effect down and rebuilding
    // it every time the stream connects or drops. Armed once `ready` turns true and never rearmed after
    // that — the refs are what keep it calling the freshest checks and reading the freshest delay.
    let cancelled = false;
    let timer: number | null = null;
    const schedule = () => {
      timer = window.setTimeout(
        () => {
          if (cancelled) return;
          checkPlanFreshnessRef.current();
          checkPendingCheckInRef.current();
          checkExtensionsRef.current();
          schedule();
        },
        liveRef.current ? STATUS_TICK_LIVE_MS : STATUS_TICK_MS
      );
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [ready]);

  // One SSE connection per tab, open only while the tab is visible — see `live-updates.ts`. Absent
  // entirely (the ref stays null, and every caller below already treats that as "poll as before")
  // wherever there is no `EventSource` at all (a test's jsdom, an old browser) or during a snapshot
  // replay, which must never touch live data.
  // Closed again once the first read lands on the sign-in screen: there the stream is only refused (401) and retried.
  useEffect(() => {
    if (replayRequest()) return;
    if (signInRequired) return;
    if (typeof window === "undefined" || typeof window.EventSource === "undefined") return;
    const controller = new LiveUpdatesController({
      createEventSource: (url) => new EventSource(url),
      callbacks: {
        // A pushed event is new information, so it bypasses the per-minute bucket that only exists
        // to fold focus/visibility asks into the tick.
        onRefresh: () => {
          const actions = liveRefreshActions(pendingLiveKinds.current);
          pendingLiveKinds.current.clear();
          // `state` events (and an extension's own) carry changes that never start a plan run (a mail
          // ingest, a handheld or CLI edit while the engine is down), so the plan check below would
          // never adopt them. One read per burst; `reloadState` itself yields to a command in flight.
          if (actions.reloadState) {
            void reloadState();
            // The shell's Emails badge polls on its own five-minute clock; a mail ingest is a `state` event.
            void refreshEmailReviewCount();
          }
          if (actions.checkPlan) checkPlanFreshnessRef.current({ force: true, stateReloadQueued: actions.reloadState });
          checkPendingCheckInRef.current({ force: true });
          checkExtensionsRef.current({ force: true });
        },
        onEvent: (event) => pendingLiveKinds.current.add(event.kind),
        onConnectionChange: setLive,
        // Nothing replays what fired while the stream was down, so a reconnect is itself the reason
        // to look now rather than at the next (up to five minute) tick.
        // The first `hello` counts too: the initial state read comes before the stream subscribes, so a write
        // between the two is not replayed either.
        // This also covers a tab becoming visible again: hiding it closes the stream (dropping any
        // pending refresh), and showing it reopens one whose `hello` lands here.
        onReconnect: () => {
          void reloadState();
          void refreshEmailReviewCount();
          checkPlanFreshnessRef.current({ force: true, stateReloadQueued: true });
          checkPendingCheckInRef.current();
          checkExtensionsRef.current();
        }
      }
    });
    liveUpdatesRef.current = controller;
    return () => {
      controller.close();
      liveUpdatesRef.current = null;
    };
    // Mounted once: `reloadState` has no dependencies so its identity never changes, `signInRequired` only ever
    // turns true (signing in reloads the page), and `onRefresh` reaches everything else through the same refs.
  }, [reloadState, signInRequired]);

  // Coming back online is the other half of an outage: the SSE stream may still look healthy to the
  // browser, or reconnect only after its backoff, while the plan has crossed `validUntil` meanwhile.
  useEffect(() => {
    const onOnline = () => {
      // A snapshot replay shows captured state and must not be read over or checked against live data.
      if (replayRequest()) return;
      // The same reconciliation a reconnect or `hello` runs: a state-only write made during the outage
      // (a handheld edit, a mail ingest) starts no plan run, so the plan check alone would never read it.
      // `reloadState` yields to a command in flight and is run by the last one to settle.
      void reloadState();
      void refreshEmailReviewCount();
      checkPlanFreshnessRef.current({ force: true, stateReloadQueued: true });
      checkPendingCheckInRef.current();
      checkExtensionsRef.current();
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [reloadState]);

  // A tab regaining visibility or focus is exactly when a throttled interval is most likely to have
  // fallen behind, so it earns its own immediate ask rather than waiting out whatever is left of the
  // current minute. `visibilitychange` and `focus` commonly fire together on the same tab switch, so
  // the two are debounced into a single check. The SSE connection follows the same visibility split —
  // open only while the tab can actually be looked at, closed the instant it can't — so a houseful of
  // backgrounded tabs never holds a connection open for nothing.
  useEffect(() => {
    let debounce: number | null = null;
    const askSoon = () => {
      if (debounce !== null) window.clearTimeout(debounce);
      debounce = window.setTimeout(() => {
        debounce = null;
        checkPlanFreshnessRef.current();
        checkPendingCheckInRef.current();
        checkExtensionsRef.current();
      }, VISIBILITY_REFRESH_DEBOUNCE_MS);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        liveUpdatesRef.current?.open();
        askSoon();
      } else {
        liveUpdatesRef.current?.close();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", askSoon);
    if (document.visibilityState === "visible") liveUpdatesRef.current?.open();
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", askSoon);
      if (debounce !== null) window.clearTimeout(debounce);
    };
    // Stable — mounted once, like the interval above, and always reaches the freshest checks via ref.
  }, []);

  const startCurrent = useCallback(
    async (startedAt?: string) => {
      if (!planningDecisionIsCurrent(state, knownLatestSuccessfulAt, serverClockOffsetMs)) return;
      const selected = recommendation.primary;
      if (!selected?.recommendedMinutes) return;
      const occurrence = state.occurrences.find((item) => item.id === selected.action.id);
      const stored = state.actions.find(
        (action) => action.id === (occurrence?.actionId ?? selected.action.templateActionId ?? selected.action.id)
      );
      await runSessionCommand({
        commandId: createClientId(),
        expectedVersion: stored?.version ?? null,
        type: "start",
        actionId: selected.action.id,
        plannedMinutes: selected.recommendedMinutes,
        recommendationId: state.currentRecommendationId ?? null,
        ...(startedAt ? { startedAt } : {})
      });
    },
    [knownLatestSuccessfulAt, serverClockOffsetMs, recommendation.primary, runSessionCommand, state]
  );

  const correctStart = useCallback(
    async (startedAt: string) => {
      const session = state.activeSession;
      if (!session) return;
      await runSessionCommand({
        commandId: createClientId(),
        expectedVersion: session.version ?? null,
        type: "correct_start",
        sessionId: session.id,
        startedAt
      });
    },
    [runSessionCommand, state.activeSession]
  );

  const startAlternative = useCallback(
    async (actionId: string, plannedMinutes: number, reason: OverrideReason, note?: string) => {
      if (!planningDecisionIsCurrent(state, knownLatestSuccessfulAt, serverClockOffsetMs)) return;
      const occurrence = state.occurrences.find((item) => item.id === actionId);
      const action = state.actions.find((item) => item.id === (occurrence?.actionId ?? actionId));
      if (!action) return;
      await runSessionCommand({
        commandId: createClientId(),
        expectedVersion: action.version ?? null,
        type: "select_alternative",
        actionId,
        plannedMinutes,
        recommendationId: state.currentRecommendationId ?? null,
        reason,
        ...(note ? { note } : {})
      });
    },
    [knownLatestSuccessfulAt, runSessionCommand, serverClockOffsetMs, state]
  );

  const blockRecommended = useCallback(
    async (reason: BlockingReason, note?: string) => {
      const selected = recommendation.primary;
      const occurrence = state.occurrences.find((item) => item.id === selected?.action.id);
      const action = state.actions.find(
        (item) => item.id === (occurrence?.actionId ?? selected?.action.templateActionId ?? selected?.action.id)
      );
      if (!action) return;
      await saveActionCommand({
        commandId: createClientId(),
        expectedVersion: action.version ?? null,
        blockingReason: reason,
        ...(note ? { note } : {}),
        action: storedActionPayload(action, { status: reason === "waiting_on_someone" ? "waiting" : "blocked" })
      });
    },
    [recommendation.primary, saveActionCommand, state.actions, state.occurrences]
  );

  const snoozeAction = useCallback(
    async (actionId: string, availableFrom: string) => {
      const occurrence = state.occurrences.find((item) => item.id === actionId);
      const action = state.actions.find((item) => item.id === (occurrence?.actionId ?? actionId));
      if (!action) return;
      if (
        !canSnooze({ schedulingMode: action.schedulingMode, ...(occurrence ? { occurrenceId: occurrence.id } : {}) })
      ) {
        throw new Error("A repeating action cannot be put off from here; edit it in Plan.");
      }
      const refusal = snoozeRefusal(
        snoozeSubject(action, state.projects),
        new Date(availableFrom),
        state.settings.timezone
      );
      if (refusal) throw new Error(refusal);
      await saveActionCommand({
        commandId: createClientId(),
        expectedVersion: action.version ?? null,
        action: storedActionPayload(action, { availableFrom })
      });
    },
    [saveActionCommand, state.actions, state.occurrences, state.projects, state.settings.timezone]
  );

  const pauseOrResume = useCallback(async () => {
    const session = state.activeSession;
    if (!session) return;
    await runSessionCommand({
      commandId: createClientId(),
      expectedVersion: session.version ?? null,
      type: session.status === "paused" ? "resume" : "pause",
      sessionId: session.id
    });
  }, [runSessionCommand, state.activeSession]);

  const requestFeedback = useCallback(async () => {
    const session = state.activeSession;
    if (!session || session.status === "feedback") return;
    await runSessionCommand({
      commandId: createClientId(),
      expectedVersion: session.version ?? null,
      type: "request_feedback",
      sessionId: session.id
    });
  }, [runSessionCommand, state.activeSession]);

  useEffect(() => {
    const session = state.activeSession;
    if (replayRequest()) return;
    if (session?.status !== "running") {
      automaticFeedbackAttempt.current = null;
      return;
    }
    // Only action and deliverable sessions have somewhere to answer from. An activity runs into its
    // overtime by design — the panel counts up past zero — and has no feedback surface at all, so
    // pushing one into `awaiting_feedback` strands it: every control it does show, Pause included,
    // requires a running session and starts refusing.
    if (!COLLECTS_FEEDBACK_SESSION_TARGETS.has(session.targetType ?? "action")) {
      automaticFeedbackAttempt.current = null;
      return;
    }
    if (saving) return;
    const attemptKey = `${session.id}:${session.version ?? "unknown"}`;
    if (automaticFeedbackAttempt.current === attemptKey) return;
    const attempt = () => {
      if (automaticFeedbackAttempt.current === attemptKey) return;
      automaticFeedbackAttempt.current = attemptKey;
      void requestFeedback().catch(() => {});
    };
    // Wait for the planned end itself rather than checking every second. The timeout is re-armed
    // whenever the session changes, so a continued session gets a fresh one aimed at its new end.
    const delay = new Date(session.plannedEndAt).getTime() - readNow().getTime();
    if (delay <= 0) {
      attempt();
      return;
    }
    // A browser timeout longer than about 24.8 days fires at once; a session is never planned that
    // far out, but an absurd end must wait, not fire.
    const timer = window.setTimeout(attempt, Math.min(delay, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [requestFeedback, saving, state.activeSession]);

  const [loggedSession, setLoggedSession] = useState<LoggedSession | null>(null);
  const dismissLoggedSession = useCallback(() => setLoggedSession(null), []);
  // The line expires here, not on the Now page, so leaving Now and coming back never shows an old one.
  const loggedKey = loggedSession?.key;
  useEffect(() => {
    if (!loggedKey) return;
    const timer = window.setTimeout(dismissLoggedSession, LOGGED_TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [loggedKey, dismissLoggedSession]);
  // After a finished session: what it logged, so Now can say so for a few seconds.
  const noteLogged = useCallback((session: ActiveSession, endedAt?: string) => {
    // The response has been adopted by now, so the session just ended is in the state ref's history,
    // found by its own id; its title and server minutes win. The client's sum is only for a response
    // that did not carry it.
    const current = stateRef.current;
    const done = current.completedToday.find((item) => item.id === session.id);
    // A recurring session's actionId is its occurrence; the template action holds the title.
    const occurrence = current.occurrences.find((item) => item.id === session.actionId);
    const title =
      done?.actionTitle ??
      current.actions.find((item) => item.id === (occurrence?.actionId ?? session.actionId))?.title ??
      session.targetTitle;
    if (!title) return;
    const minutes = done ? done.activeMinutes : loggedMinutes(session, new Date(), endedAt);
    setLoggedSession({ key: createClientId(), title, minutes });
  }, []);

  const finishSession = useCallback(
    async (
      result: "finished" | "progress" | "unsure" | "blocked" | "did_not_start" | "continue",
      remainingMinutes = 30,
      details?: { reason?: string; actionStatus?: "waiting" | "blocked"; note?: string; endedAt?: string }
    ) => {
      const session = state.activeSession;
      if (!session) return;
      if (result === "continue") {
        if (
          !planningDecisionIsCurrent(state, knownLatestSuccessfulAt, serverClockOffsetMs) ||
          !continuation?.safe ||
          !continuation.recommendedMinutes
        )
          return;
        await runSessionCommand({
          commandId: createClientId(),
          expectedVersion: session.version ?? null,
          type: "continue",
          sessionId: session.id,
          requestedMinutes: continuation.recommendedMinutes
        });
        return;
      }
      if (result === "blocked") {
        await runSessionCommand({
          commandId: createClientId(),
          expectedVersion: session.version ?? null,
          type: "block",
          sessionId: session.id,
          reason: (details?.reason ?? "other") as "other",
          actionStatus: details?.actionStatus ?? "blocked",
          ...(details?.note ? { note: details.note } : {})
        });
      } else if (result === "did_not_start") {
        await runSessionCommand({
          commandId: createClientId(),
          expectedVersion: session.version ?? null,
          type: "did_not_start",
          sessionId: session.id,
          ...(details?.note ? { note: details.note } : {})
        });
      } else {
        await runSessionCommand({
          commandId: createClientId(),
          expectedVersion: session.version ?? null,
          type: "finish",
          sessionId: session.id,
          outcome: result === "finished" ? "completed" : result,
          ...(result === "progress" ? { remainingMinutes } : {}),
          ...(details?.note ? { note: details.note } : {}),
          ...(details?.endedAt ? { endedAt: details.endedAt } : {})
        });
        noteLogged(session, details?.endedAt);
      }
    },
    [continuation, knownLatestSuccessfulAt, noteLogged, runSessionCommand, serverClockOffsetMs, state]
  );

  // "Switch to": the engine rules every other task out while a session is open ("Another work session is
  // already active"), so there is no list to choose from until this one has ended and the plan has run
  // again. So switching ends this session first and then asks Now to open Something else, whose list is
  // the new plan's alternatives and whose Start is the ordinary one.
  const [switchPending, setSwitchPending] = useState(false);
  const clearSwitchPending = useCallback(() => setSwitchPending(false), []);
  // What the switch stopped, so Something else can offer the new plan's primary unless it is that same task.
  const [switchStop, setSwitchStop] = useState<{
    from: string;
    sessionId: string;
    planBaseline: string | null;
  } | null>(null);
  const switchedFrom = switchStop?.from ?? null;
  // Bumped whenever a switch is forgotten, so a stop still in flight when the person leaves Now cannot
  // open Something else the next time they are back.
  const switchGeneration = useRef(0);
  const forgetSwitch = useCallback(() => {
    switchGeneration.current += 1;
    setSwitchPending(false);
    setSwitchStop(null);
  }, []);
  // The card of a session started after a switch takes focus: the buttons that started it are gone.
  const [focusNewSession, setFocusNewSession] = useState<string | null>(null);
  const clearFocusNewSession = useCallback(() => setFocusNewSession(null), []);
  // A different session is open: the switch is over. Adjusted while rendering, not in an effect, so the
  // stop cannot come back to life when that session ends.
  if (switchStop && state.activeSession && state.activeSession.id !== switchStop.sessionId) {
    setSwitchStop(null);
    setSwitchPending(false);
    setFocusNewSession(state.activeSession.id);
  }
  useEffect(() => {
    if (!switchPending && switchedFrom === null) return;
    // A request that Now never got round to showing (a routine step came first) must not open later.
    const timer = window.setTimeout(forgetSwitch, SWITCH_PENDING_MS);
    return () => window.clearTimeout(timer);
  }, [switchPending, switchedFrom, forgetSwitch]);

  const stopToSwitch = useCallback(async () => {
    const session = state.activeSession;
    if (!session || session.status === "feedback") return;
    const current = state.actions.find((item) => item.id === session.actionId);
    const generation = switchGeneration.current;
    await runSessionCommand({
      commandId: createClientId(),
      expectedVersion: session.version ?? null,
      type: "finish",
      sessionId: session.id,
      outcome: "progress",
      // Switching is not a verdict on the estimate, so the task keeps the time it had left.
      remainingMinutes: current?.remainingMinutes ?? session.remainingBeforeMinutes
    });
    noteLogged(session);
    // The finish response carries the plan from before the replan it queued, so a plan newer than this is the one to choose from.
    // The person left Now while the stop was going: it is saved, but nothing opens when they return.
    if (generation !== switchGeneration.current) return;
    setSwitchStop({
      from: session.actionId,
      sessionId: session.id,
      planBaseline: state.planning?.lastSuccessfulAt ?? null
    });
    setSwitchPending(true);
  }, [noteLogged, runSessionCommand, state.actions, state.activeSession, state.planning?.lastSuccessfulAt]);

  const planningNotice = planningBanner({
    planning: state.planning,
    timezone: state.settings.timezone,
    expired: planExpired,
    health: planHealth,
    clockOffsetMs: serverClockOffsetMs,
    now: readNow()
  });
  const planningWarning = planningNotice?.text ?? "";
  // A plan just past its boundary, being refreshed by the worker's own chain, is not an error. It
  // gets the same quiet pill as any other plan on its way rather than the banner.
  const quietRefresh = planExpired && !planningWarning && state.planning?.status === "current";
  const loadFailed = ready && initialLoadFailed && !replay;
  // The load error ("Sign in...", "could not be loaded") already says more, and a failed first read has its own
  // screen in the page's place; the unreachable line only speaks when neither is showing.
  const unreachableLead = stateUnreachable?.kind === "server" ? "OpenRhen had a problem" : "Can't reach OpenRhen";
  const unreachableText =
    stateUnreachable && !loadError && !loadFailed
      ? stateUnreachable.lastGood
        ? `${unreachableLead}. Showing data from ${planTime(stateUnreachable.lastGood, state.settings.timezone, readNow())}.`
        : `${unreachableLead}.`
      : "";
  const bannerText = !online
    ? "You're offline. Unsaved form values stay on this page."
    : (loadFailed ? "" : loadError) ||
      // A failed command is named first; the stale-data line rides along rather than hiding it.
      [saveError, unreachableText].filter(Boolean).join(" ") ||
      planningWarning;
  // Only a failure is red. Being offline is the browser's own state and recovers by itself, and the
  // plan's banner carries its own tone (working, warning or danger).
  const bannerTone: BannerTone = !online
    ? "warning"
    : loadError || saveError
      ? "danger"
      : unreachableText
        ? "warning"
        : (planningNotice?.tone ?? "warning");
  // Memoised so a provider re-render that changes nothing a consumer reads — the "Updating plan…"
  // pill appearing, say — does not re-render every page and panel beneath it.
  const value = useMemo<PortalContextValue>(
    () => ({
      state,
      ready,
      loadFailed,
      saving,
      recommendation,
      forecasts,
      capacityEnvelopes: schedule.capacityEnvelopes,
      projectEnvelopes: schedule.projectEnvelopes,
      slots: schedule.slots,
      allocations: schedule.allocations ?? EMPTY_ALLOCATIONS,
      currentDirective,
      upcomingDirectives,
      dayPlan,
      continuation,
      weekOutlook,
      replay,
      bannerText,
      knownLatestSuccessfulAt,
      planHealth,
      serverClockOffsetMs,
      live,
      pendingCheckIn,
      dismissPendingCheckIn,
      extensions,
      addCapture,
      saveProjectCommand,
      confirmProjectWantedCommand,
      saveActionCommand,
      saveEntityCommand,
      saveCommitmentRecurrenceRuleCommand,
      splitCommitmentSourceCommand,
      endRecurrenceGoalCommand,
      closeEntityCommand,
      recordCadenceCompletionCommand,
      acceptServerState,
      recalculate,
      startCurrent,
      correctStart,
      stopToSwitch,
      switchPending,
      clearSwitchPending,
      // Once something is started the switch is over.
      switchedFrom: state.activeSession ? null : switchedFrom,
      switchAwaitingPlan:
        switchStop !== null &&
        !state.activeSession &&
        (state.planning?.lastSuccessfulAt ?? null) === switchStop.planBaseline,
      forgetSwitch,
      loggedSession,
      dismissLoggedSession,
      focusNewSession,
      clearFocusNewSession,
      startAlternative,
      blockRecommended,
      snoozeAction,
      pauseOrResume,
      requestFeedback,
      finishSession,
      runActivityCommand
    }),
    [
      state,
      ready,
      loadFailed,
      saving,
      recommendation,
      forecasts,
      schedule,
      currentDirective,
      upcomingDirectives,
      dayPlan,
      continuation,
      weekOutlook,
      replay,
      bannerText,
      knownLatestSuccessfulAt,
      planHealth,
      serverClockOffsetMs,
      live,
      pendingCheckIn,
      dismissPendingCheckIn,
      extensions,
      addCapture,
      saveProjectCommand,
      confirmProjectWantedCommand,
      saveActionCommand,
      saveEntityCommand,
      saveCommitmentRecurrenceRuleCommand,
      splitCommitmentSourceCommand,
      endRecurrenceGoalCommand,
      closeEntityCommand,
      recordCadenceCompletionCommand,
      acceptServerState,
      recalculate,
      startCurrent,
      correctStart,
      stopToSwitch,
      switchPending,
      clearSwitchPending,
      switchStop,
      switchedFrom,
      forgetSwitch,
      loggedSession,
      dismissLoggedSession,
      focusNewSession,
      clearFocusNewSession,
      startAlternative,
      blockRecommended,
      snoozeAction,
      pauseOrResume,
      requestFeedback,
      finishSession,
      runActivityCommand
    ]
  );
  // Only an engine problem is fixable in place. Offline and load or save failures still need a reload.
  const engineOnlyWarning =
    Boolean(planningWarning) && online && !loadError && !saveError && !unreachableText && !replay;
  // Set during render, not in an effect, so the children below format with it in the same pass.
  setDisplayLocale(settingsLocale(state.settings));
  const when = (value: string) =>
    dateTimeFormat(displayLocale(), {
      timeZone: state.settings.timezone,
      dateStyle: "medium",
      timeStyle: "medium"
    }).format(new Date(value));
  if (signInRequired)
    return (
      <PortalContext.Provider value={value}>
        <SignInRequired expired={signInExpired} />
      </PortalContext.Provider>
    );
  return (
    <PortalContext.Provider value={value}>
      {replay && (
        <div className="replay-banner" role="status">
          <span>
            Replaying the {replay.source} state of snapshot {replay.id.slice(0, 8)} — “{replay.description}” — frozen at{" "}
            {when(replay.observedAt)}. Read-only.
          </span>
          <a href={`/?snapshot=${replay.id}&source=${replay.source === "server" ? "client" : "server"}`}>
            Show the {replay.source === "server" ? "browser" : "database"} copy
          </a>
          <a href="/reports">Mark reviewed</a>
          <a href="/">Exit replay</a>
        </div>
      )}
      {/*
        Deliberately quiet, and deliberately not the red banner: the plan on screen is usable, a
        fresher one is on its way, and nothing is wrong. It is suppressed while the banner is up so
        an outage is never softened by a reassuring second message.
      */}
      {(awaitingPlan || quietRefresh) && !bannerText && !replay && (
        <div className="plan-updating-pill" role="status" aria-live="polite">
          Updating plan…
        </div>
      )}
      {Boolean(bannerText) && (
        <StatusBanner
          tone={bannerTone}
          text={bannerText}
          action={
            // A plan already on its way needs no button; asking for another would only queue a duplicate.
            bannerTone === "working" ? undefined : engineOnlyWarning ? (
              <button
                className="quiet small"
                disabled={saving}
                onClick={() => {
                  void recalculate().catch(() => undefined);
                }}
              >
                {saving ? "Refreshing…" : "Refresh the plan"}
              </button>
            ) : (
              !replay && (
                <button className="quiet small" onClick={() => window.location.reload()}>
                  Retry and reload
                </button>
              )
            )
          }
        />
      )}
      {/*
        Hidden until the first read has answered: under owner auth that answer may be the sign-in screen,
        and the pages (the seed plan, and their own requests) must not flash up before it. Activity keeps
        the tree mounted, so nothing remounts when it turns visible.
      */}
      {!ready && (
        <main className="content-page portal-loading">
          <HeroSkeleton label="Loading…" />
        </main>
      )}
      <Activity mode={ready ? "visible" : "hidden"}>{children}</Activity>
    </PortalContext.Provider>
  );
}

export function usePortal() {
  const value = useContext(PortalContext);
  if (!value) throw new Error("usePortal must be used inside PortalProvider");
  return value;
}

function hydrateJson<T>(value: unknown): T | null {
  if (value === undefined || value === null) return null;
  return JSON.parse(JSON.stringify(value), (_key, item) =>
    typeof item === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(item) ? new Date(item) : item
  ) as T;
}
/**
 * Mirrors `planningDecisionCurrent` in `now-model.ts`: current by status, inside its validity window,
 * and not already superseded by a newer run this tab has heard of but not yet loaded.
 */
function planningDecisionIsCurrent(state: PortalState, knownLatestSuccessfulAt: string | null, clockOffsetMs: number) {
  const planning = state.planning;
  if (planning?.status !== "current") return false;
  if (!planning.validUntil || new Date(planning.validUntil) <= serverNow(clockOffsetMs, readNow())) return false;
  const superseded = Boolean(
    knownLatestSuccessfulAt &&
    planning.lastSuccessfulAt &&
    new Date(knownLatestSuccessfulAt) > new Date(planning.lastSuccessfulAt)
  );
  return !superseded;
}
