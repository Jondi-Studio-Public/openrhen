import { planForecastResponseSchema, type PlanningRuntimeState } from "@openrhen/contracts";

export interface PlanningRunRow {
  calculated_at: Date;
  valid_until: Date;
  result: unknown;
}
export interface PlanningJobRow {
  status: string;
  available_at: Date;
  last_error_message: string | null;
  /** When the portal state this job carries was read. Absent on jobs enqueued before it was stored. */
  state_captured_at?: Date | null;
  created_at?: Date | null;
}

/**
 * The runtime state the portal shows, plus the one fact the shared contract has no field for.
 *
 * `awaitingRecalculation` is derived here rather than added to `planningRuntimeStateSchema` so the
 * portal can report it without a cross-process contract change. It is portal-only by nature: it says
 * something about the page's relationship to the queue, not about the plan itself.
 */
export interface PortalPlanningRuntimeState extends PlanningRuntimeState {
  /**
   * The run on screen was computed against state the database has already moved past, and the job
   * that will replace it is due or already running. The plan is still usable — this is the reason to
   * keep asking for a fresher one, not a reason to refuse to act on this one.
   */
  awaitingRecalculation?: boolean;
}

/**
 * Everything the browser needs to decide whether to ask for the whole state again — the answer
 * `/api/planning/status` returns. Declared here rather than beside its reader because the browser
 * is the consumer and client code cannot import server modules.
 */
export interface PlanningStatus {
  /** The current run's calculation time. A change in this value is a new plan having landed. */
  lastSuccessfulAt: string | null;
  validUntil: string | null;
  /** The current run has passed its validity boundary and nothing has replaced it. */
  stale: boolean;
  /** A due or running job holds state newer than the run above. */
  awaitingRecalculation: boolean;
  openJob: { status: string; availableAt: string; dueNow: boolean } | null;
  lastFinishedStatus: string | null;
  /**
   * The most recent finished job failed and was created after the current run, so the plan on screen
   * is the last one that worked and nothing newer has landed. Optional so a status from before this
   * field existed (an older server during a deploy) reads as "no failure known".
   */
  latestJobFailed?: boolean;
  /** `last_error_code` of that failed job, when `latestJobFailed`. */
  lastErrorCode?: string | null;
  /**
   * A job waiting to retry holds state newer than the current run, so a replacement is still coming
   * even though `awaitingRecalculation` (due or running only) is false during the backoff. An older
   * job that fails into `retrying` after a newer one published the run does not count.
   */
  retryingNewerState?: boolean;
  /**
   * The server's clock when this answer was read. The browser compares its own clock to a plan's
   * `validUntil`, so a clock minutes off would report a healthy plan as expired (or an expired one as
   * fine); the offset between this and the browser's clock corrects for that.
   */
  serverNow: string;
  /** Whole minutes past `validUntil`; 0 while the plan is current. */
  staleForMinutes: number;
  /** When the server stops accepting Start or Continue for the plan above (the handheld and API). */
  graceEndsAt: string | null;
  /** What the refresh of an out-of-date plan is doing — see `planRefreshState`. */
  refresh: PlanRefreshState;
}

/**
 * How long past `validUntil` the server still accepts Start and Continue. Owned here, beside the
 * freshness answer that reports it, so `requireCurrentPlanForecast` and the browser share one figure.
 */
export const PLAN_FORECAST_GRACE_MINUTES = 120;

/** An out-of-date plan this long with no new run is not a refresh in progress; it is stuck. */
export const PLAN_STALLED_AFTER_MINUTES = 10;

/**
 * `current` — inside its validity window. `refreshing` — past it, a replacement is due, running or
 * about to be requested. `retrying` — the last attempt failed and the next is scheduled. `stalled` —
 * out of date for `PLAN_STALLED_AFTER_MINUTES` or more with no replacement having landed; whatever the
 * queue says, the planning worker is not delivering and someone should know.
 */
export type PlanRefreshState = "current" | "refreshing" | "retrying" | "stalled";

/** What the browser keeps of the last status poll's answer about an out-of-date plan. */
export interface PlanHealth {
  refresh: PlanRefreshState;
  /** A newer plan is on its way for state the plan on screen predates (`planIsUpdating`). */
  updating?: boolean;
  /** The latest finished job failed after the current run (`PlanningStatus.latestJobFailed`). */
  latestJobFailed?: boolean;
  graceEndsAt: string | null;
  /** The last status poll got no usable answer: the server may be down, or only this browser offline. */
  unreachable: boolean;
}

/**
 * A newer plan is on its way for this status: a due or running job holds newer state
 * (`awaitingRecalculation`), or a job that failed an attempt is waiting to retry and holds state newer
 * than the current run (`retryingNewerState`, judged on the server by `retryingWithNewerState`).
 */
export function planIsUpdating(status: Pick<PlanningStatus, "awaitingRecalculation" | "retryingNewerState">): boolean {
  return Boolean(status.awaitingRecalculation || status.retryingNewerState);
}

/**
 * What a command response's state says about a newer plan wins over an older status poll: a save
 * returns state with `awaitingRecalculation: true` while `current` still holds the answer from before
 * it, which may say a failure or nothing in flight. Marks the plan updating and clears the failure,
 * keeping every other field; the next poll then has the final say again. With no poll yet there is
 * nothing to override and the chip reads the state's own flag.
 */
export function planHealthAfterSave(current: PlanHealth | null): PlanHealth | null {
  return current ? { ...current, updating: true, latestJobFailed: false } : null;
}

export const UNKNOWN_PLAN_HEALTH: PlanHealth = { refresh: "refreshing", graceEndsAt: null, unreachable: false };

/** The server's clock, as best this browser can tell: its own, shifted by the last polled offset. */
export function serverNow(offsetMs: number, now = new Date()): Date {
  return new Date(now.getTime() + offsetMs);
}

/**
 * The banner for an out-of-date plan, or "" when saying nothing is the honest answer.
 *
 * A plan that has just crossed its boundary is being refreshed within seconds by the worker's own
 * chain; calling that an error is the false "unavailable" this exists to prevent, so it stays quiet
 * (the status row and the disabled Start already say what is happening). It speaks when the server
 * cannot be reached, a refresh failed and is retrying, or the plan has been out of date long enough
 * to be stuck, and in that last case says how long and when Start stops working elsewhere.
 */
export function outOfDatePlanWarning(input: {
  health: PlanHealth | null;
  validUntil: string | null;
  now: Date;
  format: (iso: string) => string;
}): string {
  const { health, validUntil, now, format } = input;
  if (!health) return "";
  const minutes = validUntil ? Math.max(0, Math.floor((now.getTime() - new Date(validUntil).getTime()) / 60_000)) : 0;
  const age = minutes >= 120 ? `${Math.floor(minutes / 60)} hours` : minutes >= 60 ? "an hour" : `${minutes} minutes`;
  if (health.refresh === "stalled" && !validUntil)
    return "No plan has been produced yet and the planning worker is not delivering one, so it may be down. Start is off.";
  if (health.refresh === "stalled") {
    const graceOpen = health.graceEndsAt !== null && new Date(health.graceEndsAt) > now;
    const reach = graceOpen
      ? `Start is off on this page; the handheld and API still accept Start until ${format(health.graceEndsAt!)}.`
      : "Start is off everywhere until it refreshes.";
    return `The plan has been out of date for ${age} and is not refreshing, so the planning worker may be down. ${reach}`;
  }
  if (health.unreachable)
    return "The plan is out of date and the server could not be reached to refresh it. Start returns once it can.";
  if (health.refresh === "retrying")
    return "The plan is out of date: the last refresh failed and will retry. Start returns once a new plan lands.";
  return "";
}

export function planRefreshState(
  run: PlanningRunRow | undefined,
  openJob: PlanningJobRow | undefined,
  now = new Date()
): PlanRefreshState {
  if (run && run.valid_until > now) return "current";
  // With no run at all there is no boundary to measure from, so the age of the job that should have
  // produced one stands in for it: a first plan queued for ten minutes is as stuck as an old one that
  // has not been replaced. No run and no job at all is stuck outright; nothing is on its way.
  if (!run && !openJob) return "stalled";
  const since = run ? run.valid_until : (openJob?.created_at ?? openJob?.available_at ?? null);
  const staleFor = since ? (now.getTime() - since.getTime()) / 60_000 : 0;
  if (staleFor >= PLAN_STALLED_AFTER_MINUTES) return "stalled";
  if (openJob && ["pending", "retrying"].includes(openJob.status) && openJob.available_at > now) return "retrying";
  return "refreshing";
}

/**
 * When the portal state a job carries was read, falling back to its creation time for a job enqueued
 * before that was stored. `created_at` is the transaction's start, so a long command transaction looks
 * older than the state it captured; `stateCapturedAt` is the better clock and wins when present.
 */
function jobStateTime(job: Pick<PlanningJobRow, "state_captured_at" | "created_at"> | undefined): Date | null {
  return job?.state_captured_at ?? job?.created_at ?? null;
}

/**
 * True when the most recent finished job failed after the run on screen was calculated, so a newer
 * plan was wanted and did not arrive. A failure whose state predates the run is history: the run
 * landed anyway. With no run at all any failure counts. A job with neither `stateCapturedAt` nor
 * `created_at` is not placed in time, so it is not counted: a failure that cannot be ordered must not
 * hide a healthy plan.
 */
export function latestJobFailedAfterRun(
  run: Pick<PlanningRunRow, "calculated_at"> | undefined,
  finishedJob: Pick<PlanningJobRow, "status" | "state_captured_at" | "created_at"> | undefined
): boolean {
  if (finishedJob?.status !== "failed") return false;
  if (!run) return true;
  const at = jobStateTime(finishedJob);
  return at !== null && at > run.calculated_at;
}

/**
 * Failure codes that no resend can fix: the engine rejected the request, the payload cannot parse, or
 * the job's claims kept dying (`abandoned_lock`). A fresh recalculation carries the same state and
 * fails the same way, so the browser waits for the state to change (which enqueues its own job)
 * instead of resending on every idle tick. `plan_forecast_persist_failed` is the transient one.
 */
const TERMINAL_PLAN_FAILURE_CODES = new Set(["plan_forecast_rejected", "invalid_payload", "abandoned_lock"]);

/** True when the latest failure after the current run is one that asking again cannot change. */
export function planFailureIsTerminal(status: Pick<PlanningStatus, "latestJobFailed" | "lastErrorCode">): boolean {
  return Boolean(
    status.latestJobFailed && status.lastErrorCode && TERMINAL_PLAN_FAILURE_CODES.has(status.lastErrorCode)
  );
}

/**
 * True when a job waiting to retry holds state newer than the current run. Only a `retrying` job
 * counts: a `pending` one scheduled for a future boundary is not a replacement in progress, and an
 * older job failing into backoff after a newer one published the run has nothing newer to deliver.
 * Judged like `awaitingRecalculation`: no run, or an unknown snapshot, counts as newer.
 */
export function retryingWithNewerState(run: PlanningRunRow | undefined, openJob: PlanningJobRow | undefined): boolean {
  if (openJob?.status !== "retrying") return false;
  if (!run) return true;
  const at = jobStateTime(openJob);
  return at === null || at > run.calculated_at;
}

/** A job is work in flight when a worker holds it, or when its scheduled time has arrived. */
function jobIsDue(openJob: PlanningJobRow | undefined, now: Date) {
  const running = openJob?.status === "running";
  const due = Boolean(openJob && ["pending", "retrying"].includes(openJob.status) && openJob.available_at <= now);
  return { running, due, pending: running || due };
}

/**
 * True when a due or running job holds a snapshot newer than the run the portal is showing.
 *
 * A scheduled validity-boundary job is deliberately not enough. Every completed run chains one, and
 * its snapshot is by definition newer than the run it came from, so counting it would leave the
 * portal permanently "awaiting" for the whole hour a healthy plan is valid. Only work that is
 * actually due can be waited for.
 *
 * A job enqueued before `stateCapturedAt` was recorded falls back to its creation time, and a job
 * with neither is treated as newer: the queue holding work against an unknown snapshot is the case
 * where asking again is worth more than assuming.
 */
export function awaitingRecalculation(
  run: PlanningRunRow | undefined,
  openJob: PlanningJobRow | undefined,
  now = new Date()
): boolean {
  if (!jobIsDue(openJob, now).pending) return false;
  if (!run) return true;
  const captured = jobStateTime(openJob);
  return captured === null || captured > run.calculated_at;
}

/**
 * Derives the runtime state the portal shows from the stored run and the queue.
 *
 * `openJob` is the earliest unfinished job, `terminalJob` the most recent finished one. They are read
 * separately so a completed job cannot mask an earlier failure, and so a job scheduled for a future
 * validity boundary is not mistaken for work in flight.
 */
export function planningRuntime(
  run: PlanningRunRow | undefined,
  openJob: PlanningJobRow | undefined,
  terminalJob: PlanningJobRow | undefined,
  now = new Date(),
  /** The due or running job holding the newest snapshot; the earliest one when the caller has no better. */
  newestDueJob: PlanningJobRow | undefined = openJob
): PortalPlanningRuntimeState {
  const result = run ? planForecastResponseSchema.safeParse(run.result) : null;
  const parsedResult = result?.success ? result.data : undefined;
  // A queued job scheduled for a future validity boundary is not work in flight. Treating it as
  // pending kept the "engine is updating" banner up for the whole hour a healthy plan was valid.
  const { pending } = jobIsDue(openJob, now);
  const failed = terminalJob?.status === "failed";
  const stale = Boolean(run && run.valid_until <= now);
  // Precedence, most to least informative: a usable unexpired result outranks a refresh that has
  // merely been queued; work genuinely in flight outranks an older terminal failure.
  const status =
    parsedResult && !stale
      ? "current"
      : pending
        ? "pending"
        : failed
          ? "failed"
          : stale
            ? "stale"
            : parsedResult
              ? "current"
              : "unavailable";
  const lastError = openJob?.last_error_message ?? (failed ? terminalJob?.last_error_message : null);
  const message =
    status === "current"
      ? undefined
      : status === "unavailable"
        ? "The Plan and Forecast Engine has not produced a result yet."
        : (lastError ?? (status === "failed" ? "The last Plan and Forecast Engine calculation failed." : undefined));
  const awaiting = awaitingRecalculation(run, newestDueJob, now);
  return {
    status,
    ...(run ? { lastSuccessfulAt: run.calculated_at.toISOString(), validUntil: run.valid_until.toISOString() } : {}),
    // Queued-immediately jobs carry an epoch `available_at` sentinel; reporting it as a next attempt
    // renders as 1 Jan 1970. Only a genuinely future time is worth showing.
    ...(openJob && openJob.available_at > now ? { nextAttemptAt: openJob.available_at.toISOString() } : {}),
    ...(message ? { message } : {}),
    ...(awaiting ? { awaitingRecalculation: true } : {}),
    ...(parsedResult ? { result: parsedResult } : {})
  };
}
