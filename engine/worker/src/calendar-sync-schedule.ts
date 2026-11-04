import {
  calendarSourceConnections,
  intervalCalendarSourceIds,
  type CalendarSyncProvider,
  type CalendarSyncResult
} from "@openrhen/contracts";
import { isSyncAttemptResult, zonedDateAndTime } from "./local-time.js";

/**
 * Pure scheduling logic for the hourly calendar sync: which providers
 * are enabled, whether one is due, and how a run's outcome moves its state, keyed by provider so a new source
 * gets the same rules the day it is added to `CALENDAR_SYNC_PROVIDERS`. Kept separate from the worker
 * loop and its network calls so the interval, the sign-in back-off and the restart seeding can be tested
 * without a live clock or a portal.
 */

export const CALENDAR_SYNC_PROVIDERS: readonly CalendarSyncProvider[] = intervalCalendarSourceIds();
const DEFAULT_PROVIDERS: readonly CalendarSyncProvider[] = ["google_calendar"];
/** The interval schedule the manifests declare (`minutesEnv`, `defaultMinutes`); every interval source shares one today. */
const INTERVAL_SCHEDULE = (() => {
  for (const manifest of calendarSourceConnections()) {
    const schedule = manifest.calendarSource?.schedule;
    if (schedule?.kind === "interval") return schedule;
  }
  return { kind: "interval", minutesEnv: "CALENDAR_SYNC_INTERVAL_MINUTES", defaultMinutes: 60 } as const;
})();
const DEFAULT_INTERVAL_MINUTES = INTERVAL_SCHEDULE.defaultMinutes;
/** When the portal could not be reached at all, try again sooner than a whole interval. */
export const CALENDAR_SYNC_NETWORK_RETRY_MS = 5 * 60_000;

/**
 * The providers the worker syncs, from `CALENDAR_SYNC_PROVIDERS` (comma-separated). Unset or empty means
 * Google only: another source joins the list only once its login is known to work. Unknown names are ignored
 * so a typo cannot start syncing something unintended.
 */
export function parseCalendarSyncProviders(value: string | undefined): CalendarSyncProvider[] {
  if (value === undefined || !value.trim()) return [...DEFAULT_PROVIDERS];
  const requested = value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  return CALENDAR_SYNC_PROVIDERS.filter((provider) => requested.includes(provider));
}

/** The interval from the environment variable the manifest names (`schedule.minutesEnv`). */
export function calendarSyncIntervalMsFromEnv(env: Record<string, string | undefined>): number {
  return calendarSyncIntervalMs(env[INTERVAL_SCHEDULE.minutesEnv]);
}

/** `CALENDAR_SYNC_INTERVAL_MINUTES` as milliseconds; anything that is not a positive whole number falls back to 60. */
export function calendarSyncIntervalMs(value: string | undefined): number {
  const minutes = Number(value);
  return (Number.isInteger(minutes) && minutes > 0 ? minutes : DEFAULT_INTERVAL_MINUTES) * 60_000;
}

/** The portal route that runs one connection's sync (a `WORKER_ROUTES` template). */
export function calendarSyncPath(provider: CalendarSyncProvider): string {
  return `/api/connections/${provider}/sync`;
}

/**
 * The daily schedule a calendar source's manifest declares (a `localTimeEnv` and a default time of day). The seeding,
 * due check and back-off around it live in the private worker loop that runs the source, which protects the account.
 */
export function dailySyncSchedule(connectionId: string): { localTimeEnv: string; defaultLocalTime: string } {
  const schedule = calendarSourceConnections().find((manifest) => manifest.id === connectionId)?.calendarSource
    ?.schedule;
  if (schedule?.kind !== "daily") throw new Error(`${connectionId} has no daily sync schedule.`);
  return { localTimeEnv: schedule.localTimeEnv, defaultLocalTime: schedule.defaultLocalTime };
}

export interface CalendarSyncState {
  /** Epoch ms before which the provider is not due. 0 means it has never run (or should run at once). */
  nextAttemptAt: number;
  /** The local date (`YYYY-MM-DD`) an authentication failure stopped the provider for, or null. */
  blockedLocalDate: string | null;
  /** Epoch ms of the failure that set the block, so a later successful run can be told from an earlier one. */
  blockedAt: number | null;
}

export const initialCalendarSyncState: CalendarSyncState = {
  nextAttemptAt: 0,
  blockedLocalDate: null,
  blockedAt: null
};

/**
 * Whether a run's outcome is a sign-in problem that hammering would only make worse. Google: a revoked or
 * expired grant, or no credential at all. A source whose manifest sets `anyFailure` can lock the account out when retried, so any
 * failed run of it counts.
 */
export function isAuthFailure(provider: CalendarSyncProvider, result: CalendarSyncResult | null): boolean {
  if (!result) return false;
  if (result.status === "not_configured") return true;
  if (result.status !== "failed") return false;
  const authFailure = calendarSourceConnections().find((manifest) => manifest.id === provider)?.calendarSource
    ?.authFailure;
  if (!authFailure) return false;
  return authFailure.anyFailure || (result.reason !== undefined && authFailure.reasons.includes(result.reason));
}

export interface CalendarSyncDueInput {
  now: Date;
  /** IANA timezone the "until tomorrow" back-off is measured in. */
  timezone: string;
  state: CalendarSyncState;
}

/**
 * Due once `nextAttemptAt` has passed, unless an authentication failure blocked today: then not until
 * the local date changes (or `applyObservedRun` sees a manual sync succeed). `localDate` is always
 * returned so a caller records a block against the same date arithmetic.
 */
export function calendarSyncDue({ now, timezone, state }: CalendarSyncDueInput): { due: boolean; localDate: string } {
  const { date: localDate } = zonedDateAndTime(now, timezone);
  if (state.blockedLocalDate === localDate) return { due: false, localDate };
  return { due: now.getTime() >= state.nextAttemptAt, localDate };
}

/**
 * The state after the portal answered a sync request. Any answer counts as this interval's attempt; an
 * authentication failure also blocks the provider until the next local day.
 */
export function afterCalendarSyncAttempt(args: {
  provider: CalendarSyncProvider;
  result: CalendarSyncResult | null;
  now: Date;
  timezone: string;
  intervalMs: number;
}): CalendarSyncState {
  const blocked = isAuthFailure(args.provider, args.result);
  return {
    nextAttemptAt: args.now.getTime() + args.intervalMs,
    blockedLocalDate: blocked ? zonedDateAndTime(args.now, args.timezone).date : null,
    blockedAt: blocked ? args.now.getTime() : null
  };
}

/** The state after the portal could not be reached at all: retry sooner than a whole interval, no block. */
export function afterCalendarSyncNetworkError(
  state: CalendarSyncState,
  now: Date,
  intervalMs: number
): CalendarSyncState {
  return { ...state, nextAttemptAt: now.getTime() + Math.min(intervalMs, CALENDAR_SYNC_NETWORK_RETRY_MS) };
}

/**
 * Whether the portal's answer to a sync trigger is a parsed sync result; anything else is retried like a network error.
 * `already_running` (a manual "Sync now" overlapped) is a real answer: the next check is a normal interval away.
 */
export function isCalendarSyncAttempt(result: unknown): boolean {
  if (result && typeof result === "object" && (result as { status?: unknown }).status === "already_running")
    return true;
  return isSyncAttemptResult(result);
}

/** The portal's own record of a provider's latest run (`GET .../sync` → `lastRun`). */
export interface ObservedRun {
  startedAt: string;
  status: string;
  summary?: unknown;
}

/**
 * Seeds a provider's state at boot from the portal's last recorded run, so a restart neither runs at once
 * (the last run was recent) nor retries a sign-in failure already handled today.
 */
export function seedCalendarSyncState(args: {
  provider: CalendarSyncProvider;
  lastRun: ObservedRun | null;
  timezone: string;
  intervalMs: number;
}): CalendarSyncState {
  if (!args.lastRun) return initialCalendarSyncState;
  const startedAt = new Date(args.lastRun.startedAt);
  if (Number.isNaN(startedAt.getTime())) return initialCalendarSyncState;
  return afterCalendarSyncAttempt({
    provider: args.provider,
    result: summaryAsResult(args.lastRun),
    now: startedAt,
    timezone: args.timezone,
    intervalMs: args.intervalMs
  });
}

/**
 * Lets a blocked provider run again as soon as a manual "Sync now" has succeeded since the block: the
 * worker polls the portal's last run while blocked and passes it here.
 */
export function applyObservedRun(state: CalendarSyncState, lastRun: ObservedRun | null): CalendarSyncState {
  if (state.blockedAt === null || !lastRun) return state;
  const succeeded = lastRun.status === "synced" || lastRun.status === "needs_review";
  return succeeded && new Date(lastRun.startedAt).getTime() > state.blockedAt
    ? { ...state, blockedLocalDate: null, blockedAt: null }
    : state;
}

function summaryAsResult(run: ObservedRun): CalendarSyncResult | null {
  const summary = run.summary;
  if (summary && typeof summary === "object" && "status" in summary) return summary as CalendarSyncResult;
  return null;
}
