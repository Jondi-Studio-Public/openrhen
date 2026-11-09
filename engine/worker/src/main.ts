import postgres from "postgres";
import type { CalendarSyncProvider, CalendarSyncResult } from "@openrhen/contracts";
import {
  planForecastConfigFromEnv,
  planningRetentionConfigFromEnv,
  planForecastLeaseSeconds,
  processPlanForecastJob,
  pruneExpiredPlanningEvidence,
  reclaimExpiredPlanForecastJobs,
  recoverAbandonedPlanForecastJobs,
  pruneAgentWakes,
  runCheckInSchedulerTick,
  runLeaveByTick,
  agentWakeRoutingFromEnv,
  sendNextAgentWake,
  validateAgentWakeUrl
} from "@openrhen/database";
import {
  afterCalendarSyncAttempt,
  afterCalendarSyncNetworkError,
  applyObservedRun,
  calendarSyncDue,
  calendarSyncIntervalMsFromEnv,
  calendarSyncPath,
  initialCalendarSyncState,
  isCalendarSyncAttempt,
  parseCalendarSyncProviders,
  seedCalendarSyncState,
  type CalendarSyncState,
  type ObservedRun
} from "./calendar-sync-schedule.js";
import { normalizeLocalTime } from "./local-time.js";
import { withSeedRetry } from "./seed-retry.js";
import { planMapSweepDue } from "./plan-map-sweep-schedule.js";
import { extraLoopSteps } from "./extra-loops.js";
import "./private/index.js";
import { travelLookupTickDue } from "./travel-lookup-schedule.js";
import { derivedTickDelayMs } from "./derived-tick-schedule.js";
import { runIndependentLoops } from "./independent-loops.js";
import { postTrigger, runLeaveByPushTick } from "./drain-log.js";
import { createOwnerTimezone } from "./owner-timezone.js";
import { createWorkerId } from "./worker-id.js";
import { portalHeaders } from "./portal-auth.js";
import { PORTAL_WAIT_TIMEOUT_DEFAULT_MS, waitForPortal } from "./portal-ready.js";

/** A missing setting is a setup step, not a crash: one line saying what and how to fix it, no stack trace. */
const SETUP_FIX =
  'Run "docker compose run --rm setup" to generate it (it never overwrites a value you set), then "docker compose up -d".';
function refuseToStart(reason: string, fix = SETUP_FIX): never {
  process.stderr.write(`${JSON.stringify({ level: "error", message: `OpenRhen cannot start: ${reason}. ${fix}` })}\n`);
  process.exit(1);
}

const workerId = createWorkerId();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl)
  refuseToStart(
    "DATABASE_URL is required",
    'Set it in .env (for the bundled database, "docker compose run --rm setup" writes it), then run "docker compose up -d".'
  );
const config = planForecastConfigFromEnv();
if (!config.token) refuseToStart("PLAN_FORECAST_SERVICE_TOKEN is required");
const retention = planningRetentionConfigFromEnv();
// One connection per loop that can hold one at once: the job loop, the three database ticks, and headroom.
const sql = postgres(databaseUrl, {
  max: 5,
  connect_timeout: 10,
  connection: { application_name: "OpenRhen Plan and Forecast Worker" }
});
let stopping = false;
const leaseSeconds = planForecastLeaseSeconds(config.timeoutMs);
let nextReclaimAt = 0;
/** Well inside the lease, so a dead claim waits at most a lease and a half before it runs again. */
const RECLAIM_INTERVAL_MS = 60_000;
let nextPruneAt = 0;
let nextCheckInTickAt = 0;
/** ~60s, matching the prune gate's own shape — cheap enough to run far more often than a plan job. */
const CHECK_IN_TICK_INTERVAL_MS = 60_000;
let nextAgentWakeTickAt = 0;
const AGENT_WAKE_TICK_INTERVAL_MS = 60_000;
const AGENT_WAKE_PRUNE_INTERVAL_MS = 60 * 60_000;
let nextAgentWakePruneAt = 0;
let agentWakeConfigLogged = false;
let nextLeaveByTickAt = 0;
/**
 * Leave-by push: a minute is the design's own stated cadence for
 * catching a reminder or leave-by instant close to on time, and cheap enough to run every loop like
 * the check-in scheduler beside it.
 */
const LEAVE_BY_TICK_INTERVAL_MS = 60_000;
let nextPulseTickAt = 0;
let nextDerivedTickAt = 0;
let nextDerivedModelTickAt = 0;
/**
 * The pulse recorder's tick: "the worker's 60s
 * tick", posted to the portal's route since the recorder itself lives in the portal (it needs the
 * portal's own state read and command-layer types, which this package does not import). Gated on
 * `PORTAL_INTERNAL_URL` like every other trigger that hands off to the portal for its own network or
 * database work.
 */
const PULSE_TICK_INTERVAL_MS = 60_000;

/**
 * No default for `PORTAL_INTERNAL_URL`: unlike every other config
 * value here, an absent one means "this deployment has nothing to call", not "use localhost" — a
 * placeholder default would make the trigger silently fire against the wrong host.
 */
const portalInternalUrl = process.env.PORTAL_INTERNAL_URL;
/** The owner's timezone from Settings (`users.timezone`), re-read each minute; `APP_TIMEZONE` and the default are the fallbacks. */
const ownerTimezone = createOwnerTimezone(
  async () =>
    (await sql<{ timezone: string | null }[]>`SELECT timezone FROM users ORDER BY created_at LIMIT 1`)[0]?.timezone ??
    null,
  process.env
);
/**
 * The daily plan-map sweep: once per local day at `PLAN_MAP_SWEEP_LOCAL_TIME`
 * (default 03:30) the worker posts to the portal, which deletes orphaned links, expires stale suggestions and
 * prunes the shadow log. Advisory housekeeping: it never touches a plan row. A failed attempt (no answer, or a non-2xx
 * one) is retried after 30 minutes; the sweep is idempotent so a repeat is harmless.
 */
const planMapSweepLocalTime = configuredLocalTime("PLAN_MAP_SWEEP_LOCAL_TIME", "03:30");
const planMapSweepEnabled = Boolean(portalInternalUrl);
let nextPlanMapSweepTickAt = 0;
let planMapSweepLastRunLocalDate: string | null = null;
const PLAN_MAP_SWEEP_TICK_INTERVAL_MS = 60_000;
const PLAN_MAP_SWEEP_REQUEST_TIMEOUT_MS = 5 * 60_000;
const PLAN_MAP_SWEEP_RETRY_DELAY_MS = 30 * 60_000;

/**
 * The calendar sync trigger: every `CALENDAR_SYNC_INTERVAL_MINUTES`
 * (default 60) the portal syncs each provider in `CALENDAR_SYNC_PROVIDERS` (default Google only; a provider
 * is added once its login is known to work). A provider that
 * failed to sign in is skipped until the next local day instead (or until a manual Sync now succeeds),
 * because hammering a bad login can lock the account. Reuses the `portalInternalUrl` binding above.
 */
const calendarSyncProviders = parseCalendarSyncProviders(process.env.CALENDAR_SYNC_PROVIDERS);
const calendarSyncIntervalMsValue = calendarSyncIntervalMsFromEnv(process.env);
const calendarSyncEnabled = Boolean(portalInternalUrl) && calendarSyncProviders.length > 0;
const calendarSyncStates = new Map<CalendarSyncProvider, CalendarSyncState>(
  calendarSyncProviders.map((provider) => [provider, initialCalendarSyncState])
);
const calendarSyncLastObservedAt = new Map<CalendarSyncProvider, number>();
/** Providers whose state has been seeded from the portal's last run; an unseeded one is seeded on its tick before syncing. */
const calendarSyncSeeded = new Set<CalendarSyncProvider>();
let nextCalendarTickAt = 0;
const CALENDAR_SYNC_TICK_INTERVAL_MS = 60_000;
const CALENDAR_SYNC_REQUEST_TIMEOUT_MS = 5 * 60_000;
/** While a provider is blocked, how often the worker looks for a manual sync that has cleared the block. */
const CALENDAR_SYNC_BLOCK_POLL_MS = 5 * 60_000;

/**
 * The travel lookup trigger (the travel time model design note, "Spending the budget (T5)"): every
 * five minutes, when `PORTAL_INTERNAL_URL` is set, posts to the tick route, which runs the planner and
 * spends through the one spender. No proxy client here — the portal alone talks to Google, through the
 * outbound proxy; the worker only tells it when to look. There is no "already ran
 * today" concept: every tick that is due fires, and the tick route's own budget and idempotency bound
 * what actually gets spent.
 */
const travelLookupIntervalMs = positiveInteger(process.env.TRAVEL_LOOKUP_INTERVAL_MS, 300_000);
const travelLookupEnabled = Boolean(portalInternalUrl);
let nextTravelLookupTickAt = 0;
let lastTravelLookupRunAt = 0;
const TRAVEL_LOOKUP_TICK_INTERVAL_MS = 30_000;

if (!calendarSyncEnabled)
  process.stdout.write(
    `${JSON.stringify({
      level: "info",
      message: portalInternalUrl
        ? "Calendar sync trigger disabled: CALENDAR_SYNC_PROVIDERS names no provider"
        : "Calendar sync trigger disabled: PORTAL_INTERNAL_URL is not set",
      workerId
    })}\n`
  );

if (!travelLookupEnabled)
  process.stdout.write(
    `${JSON.stringify({
      level: "info",
      message: "Travel lookup trigger disabled: PORTAL_INTERNAL_URL is not set",
      workerId
    })}\n`
  );

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    stopping = true;
    process.stdout.write(
      `${JSON.stringify({ level: "info", message: "Plan and Forecast Worker stopping", workerId, signal })}\n`
    );
    // A hung job-loop iteration (e.g. blocked on a database call that never returns) must not stop the
    // container from ever exiting. `unref()` means this timer alone never keeps the process alive —
    // it only forces the issue if something else already is.
    setTimeout(() => process.exit(1), 15_000).unref();
  });

process.stdout.write(`${JSON.stringify({ level: "info", message: "Plan and Forecast Worker started", workerId })}\n`);
await withRetryForever(
  () => recoverAbandonedPlanForecastJobs(sql, leaseSeconds),
  (attempt, delayMs, error) =>
    process.stderr.write(
      `${JSON.stringify({
        level: "error",
        message: "Recovering abandoned Plan and Forecast jobs failed, retrying",
        workerId,
        attempt,
        delayMs,
        error: error instanceof Error ? error.message : "Unknown error"
      })}\n`
    )
);
// The calendar tick seeds itself from the portal's last run on their first pass (retrying
// while the portal is still booting), so no seed blocks the loops, plan-forecast jobs included, here.

// The portal-calling loops wait (bounded) for the portal to answer its health route, so a fresh
// `docker compose up` does not log "fetch failed" for every first tick. The other loops do not wait.
// Compose starts this worker once the engine service is healthy and migrations are done, not when the
// portal listens. After PORTAL_WAIT_TIMEOUT_MS the loops start anyway, as they always did.
let portalReadyWait: Promise<unknown> | undefined;
function afterPortalReady(run: () => Promise<unknown>): () => Promise<unknown> {
  return async () => {
    if (portalInternalUrl) {
      portalReadyWait ??= waitForPortal(portalInternalUrl, {
        timeoutMs: positiveInteger(process.env.PORTAL_WAIT_TIMEOUT_MS, PORTAL_WAIT_TIMEOUT_DEFAULT_MS),
        isStopping: () => stopping,
        log: (line) => process.stdout.write(`${JSON.stringify({ ...line, workerId })}\n`)
      });
      await portalReadyWait;
    }
    return run();
  };
}

// Each step gets its own loop: the integration triggers wait on network calls of up to five
// minutes, and plan-forecast jobs must never wait behind them. The ticks gate themselves on their own
// schedules, so looping each one every second only re-checks that gate.
await runIndependentLoops(
  [
    {
      name: "plan-forecast-jobs",
      run: () =>
        processPlanForecastJob(sql, config, workerId, undefined, (record) =>
          process.stdout.write(
            `${JSON.stringify({ level: "info", message: "Plan and Forecast job finished", workerId, ...record })}\n`
          )
        )
    },
    { name: "reclaim-plan-forecast-jobs", run: reclaimPlanForecastJobs },
    { name: "prune-planning-evidence", run: prunePlanningEvidence },
    { name: "check-in-scheduler", run: tickCheckInScheduler },
    { name: "agent-wake", run: tickAgentWake },
    { name: "leave-by-push", run: afterPortalReady(tickLeaveByPush) },
    { name: "pulse-tick", run: afterPortalReady(tickPulseRecorder) },
    { name: "derived-tick", run: afterPortalReady(tickDerivedRows) },
    // Its own loop: a model call takes minutes, and this must never hold up the T0 tick or the jobs beside it.
    { name: "derived-model-tick", run: afterPortalReady(tickDerivedModelRows) },
    { name: "plan-map-sweep", run: afterPortalReady(tickPlanMapSweep) },
    { name: "calendar-sync", run: afterPortalReady(tickCalendarSync) },
    ...extraLoopSteps({
      portalInternalUrl,
      workerId,
      portalHeaders,
      positiveInteger,
      sql,
      ownerTimezone,
      configuredLocalTime
    }).map((step) => ({
      name: step.name,
      run: afterPortalReady(step.run)
    })),
    { name: "travel-lookup", run: afterPortalReady(tickTravelLookup) }
  ],
  {
    isStopping: () => stopping,
    onError: (step, error) =>
      process.stderr.write(
        `${JSON.stringify({ level: "error", message: "Plan and Forecast Worker loop failed", workerId, step, error: error instanceof Error ? error.message : "Unknown error" })}\n`
      )
  }
);

await sql.end();

/**
 * Boot recovery alone left a dead claim `running` for good: a worker restarts within seconds of a
 * crash, while its claim is still inside the lease, and a live worker whose status UPDATE failed never
 * restarts at all. Gated like `prunePlanningEvidence` below, so a failure waits for the next interval.
 */
async function reclaimPlanForecastJobs() {
  if (Date.now() < nextReclaimAt) return;
  nextReclaimAt = Date.now() + RECLAIM_INTERVAL_MS;
  try {
    const counts = await reclaimExpiredPlanForecastJobs(sql, leaseSeconds);
    if (counts.requeued + counts.failed > 0)
      process.stdout.write(
        `${JSON.stringify({ level: "info", message: "Abandoned Plan and Forecast jobs reclaimed", workerId, ...counts })}\n`
      );
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ level: "error", message: "Reclaiming abandoned Plan and Forecast jobs failed", workerId, error: error instanceof Error ? error.message : "Unknown error" })}\n`
    );
  }
}

/**
 * Planning evidence grows with every mutation and every validity boundary, so something has to
 * remove it and the worker is the only process already running continuously against this database.
 *
 * The schedule advances before the work runs: a prune that throws must not be retried on the very
 * next loop iteration, and it must never stop jobs being processed.
 */
async function prunePlanningEvidence() {
  if (!retention.enabled || Date.now() < nextPruneAt) return;
  nextPruneAt = Date.now() + retention.intervalMinutes * 60_000;
  const startedAt = Date.now();
  try {
    const counts = await pruneExpiredPlanningEvidence(sql, retention);
    process.stdout.write(
      `${JSON.stringify({ level: "info", message: "Planning evidence pruned", workerId, ...counts, durationMs: Date.now() - startedAt })}\n`
    );
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ level: "error", message: "Planning evidence prune failed", workerId, error: error instanceof Error ? error.message : "Unknown error" })}\n`
    );
  }
}

/**
 * The check-in scheduler's own tick, gated the same way as `prunePlanningEvidence` above: the
 * schedule advances before the work runs, so a failure is never retried on the very next loop
 * iteration and never stops plan-forecast jobs being processed.
 *
 * Single-tenant in practice (see the system architecture's tenancy decision) — the oldest `users` row
 * is the one this app has ever really had, and there is nothing here yet for a second user to reach.
 */
async function tickCheckInScheduler() {
  if (Date.now() < nextCheckInTickAt) return;
  nextCheckInTickAt = Date.now() + CHECK_IN_TICK_INTERVAL_MS;
  try {
    const users = await sql<{ id: string }[]>`SELECT id FROM users ORDER BY created_at LIMIT 1`;
    const userId = users[0]?.id;
    if (!userId) return;
    await runCheckInSchedulerTick(sql, userId, new Date());
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ level: "error", message: "Check-in scheduler tick failed", workerId, error: error instanceof Error ? error.message : "Unknown error" })}\n`
    );
  }
}

/**
 * Sends one queued agent wake. Gated like `tickCheckInScheduler`. Needs
 * `OPENCLAW_HOOKS_URL` and `OPENCLAW_HOOKS_TOKEN`; with either empty or the URL invalid it does nothing. The optional
 * `OPENCLAW_HOOKS_AGENT_ID`, `_CHANNEL`, `_ACCOUNT_ID`, `_TO` and `_SESSION_KEY` route the wake into the user's main
 * chat session. The token is never logged.
 */
async function tickAgentWake() {
  if (Date.now() < nextAgentWakeTickAt) return;
  nextAgentWakeTickAt = Date.now() + AGENT_WAKE_TICK_INTERVAL_MS;
  const rawUrl = process.env.OPENCLAW_HOOKS_URL ?? "";
  const token = process.env.OPENCLAW_HOOKS_TOKEN ?? "";
  const url = validateAgentWakeUrl(rawUrl);
  try {
    const now = new Date();
    // Pruned even while the sender is off: the producers still queue rows, and nothing else would ever remove them.
    if (Date.now() >= nextAgentWakePruneAt) {
      nextAgentWakePruneAt = Date.now() + AGENT_WAKE_PRUNE_INTERVAL_MS;
      await pruneAgentWakes(sql, now);
    }
    if (!url || !token) {
      if (!agentWakeConfigLogged) {
        agentWakeConfigLogged = true;
        process.stderr.write(
          `${JSON.stringify({ level: "info", message: "Agent wake sender off: OPENCLAW_HOOKS_URL or OPENCLAW_HOOKS_TOKEN is empty or the URL is not allowed", workerId })}\n`
        );
      }
      return;
    }
    await sendNextAgentWake(sql, { url, token, routing: agentWakeRoutingFromEnv(process.env), now });
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ level: "error", message: "Agent wake tick failed", workerId, error: error instanceof Error ? error.message : "Unknown error" })}\n`
    );
  }
}

/**
 * The leave-by push tick, gated the same way as
 * `tickCheckInScheduler` above: the schedule advances before the work runs, so a failure is never
 * retried on the very next loop iteration and never stops plan-forecast jobs being processed.
 *
 * `runLeaveByTick` only enqueues `push_outbox` rows; it never sends. The drain — the part that talks
 * to a push service — runs in the portal (it alone holds the subscription rows and calls the outbound
 * proxy), so this tick posts to its route afterward, the same way the travel lookup tick hands off to
 * the portal for the part that needs a network call. Draining is skipped, not the whole tick, when
 * `PORTAL_INTERNAL_URL` is unset: enqueuing is still worth doing so nothing is missed once a drain
 * route becomes reachable, and the drain is safe to call from anywhere so a later tick or a manual
 * "Send a test" catches up whatever is still pending.
 */
function writeLogLine(stream: "stdout" | "stderr", line: Record<string, unknown>) {
  (stream === "stderr" ? process.stderr : process.stdout).write(`${JSON.stringify(line)}\n`);
}

async function tickLeaveByPush() {
  if (Date.now() < nextLeaveByTickAt) return;
  nextLeaveByTickAt = Date.now() + LEAVE_BY_TICK_INTERVAL_MS;
  await runLeaveByPushTick({
    enqueue: async () => {
      const users = await sql<{ id: string }[]>`SELECT id FROM users ORDER BY created_at LIMIT 1`;
      const userId = users[0]?.id;
      if (!userId) return;
      await runLeaveByTick(sql, userId, new Date());
    },
    onEnqueueError: (error) =>
      process.stderr.write(
        `${JSON.stringify({ level: "error", message: "Leave-by push tick failed", workerId, error: error instanceof Error ? error.message : "Unknown error" })}\n`
      ),
    drain: portalInternalUrl
      ? async () => {
          await postTrigger({
            fetchImpl: fetch,
            url: `${portalInternalUrl}/api/integrations/push/drain`,
            init: {
              method: "POST",
              headers: portalHeaders({ "content-type": "application/json" }),
              body: JSON.stringify({}),
              signal: AbortSignal.timeout(30_000)
            },
            okMessage: "Push drain triggered",
            errorMessage: "Push drain returned an error",
            failedMessage: "Push drain request failed",
            workerId,
            write: writeLogLine
          });
        }
      : null
  });
}

/**
 * A `HH:MM` time of day from the environment. `5:30` is padded; an invalid value is logged and the default
 * used, because the schedule compares it as text and a bad one would leave the job never (or always) due.
 */
function configuredLocalTime(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const normalized = normalizeLocalTime(raw);
  if (normalized) return normalized;
  process.stderr.write(
    `${JSON.stringify({ level: "error", message: `${name} is not a valid HH:MM time; using the default`, workerId, value: raw, fallback })}\n`
  );
  return fallback;
}

/**
 * The daily plan-map sweep trigger, gated like `tickCheckInScheduler`: the poll schedule advances before any network
 * call, and a failed attempt waits 30 minutes before the next try, so a broken portal is not hammered every minute.
 */
async function tickPlanMapSweep() {
  if (!planMapSweepEnabled || Date.now() < nextPlanMapSweepTickAt) return;
  nextPlanMapSweepTickAt = Date.now() + PLAN_MAP_SWEEP_TICK_INTERVAL_MS;
  const timezone = await ownerTimezone();
  try {
    const { due, localDate } = planMapSweepDue({
      now: new Date(),
      timezone,
      localTime: planMapSweepLocalTime,
      lastRunLocalDate: planMapSweepLastRunLocalDate
    });
    if (!due) return;
    let response: Response;
    try {
      response = await fetch(`${portalInternalUrl}/api/plan-map/sweep`, {
        method: "POST",
        headers: portalHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ trigger: "scheduled" }),
        signal: AbortSignal.timeout(PLAN_MAP_SWEEP_REQUEST_TIMEOUT_MS)
      });
    } catch (error) {
      nextPlanMapSweepTickAt = Date.now() + PLAN_MAP_SWEEP_RETRY_DELAY_MS;
      throw error;
    }
    // Only a successful answer is today's sweep; a 403/5xx is retried after a delay, not tomorrow.
    if (response.ok) planMapSweepLastRunLocalDate = localDate;
    else nextPlanMapSweepTickAt = Date.now() + PLAN_MAP_SWEEP_RETRY_DELAY_MS;
    const result = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    process.stdout.write(
      `${JSON.stringify({
        level: response.ok ? "info" : "error",
        message: "Plan map sweep triggered",
        workerId,
        httpStatus: response.status,
        status: result?.status ?? "unknown",
        orphanedLinksDeleted: result?.orphanedLinksDeleted,
        suggestionsExpired: result?.suggestionsExpired,
        shadowRowsDeleted: result?.shadowRowsDeleted
      })}\n`
    );
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ level: "error", message: "Plan map sweep failed", workerId, error: error instanceof Error ? error.message : "Unknown error" })}\n`
    );
  }
}

/** The portal's own record of a provider's latest sync run, or null when there is none or it cannot be read. */
async function fetchLastCalendarRun(provider: CalendarSyncProvider): Promise<ObservedRun | null> {
  const response = await fetch(`${portalInternalUrl}${calendarSyncPath(provider)}`, {
    headers: portalHeaders(),
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`Portal answered ${response.status}`);
  const body = (await response.json()) as { lastRun: ObservedRun | null };
  return body.lastRun ?? null;
}

/**
 * Seeds a provider's schedule from the portal's last recorded run, so a restart neither syncs at once (the
 * last run was recent) nor retries a sign-in failure already seen today. Never throws: on failure the
 * provider stays unseeded and `tickCalendarSync` retries the seed before it syncs that provider.
 */
async function seedCalendarProvider(provider: CalendarSyncProvider) {
  if (calendarSyncSeeded.has(provider)) return;
  const timezone = await ownerTimezone();
  try {
    calendarSyncStates.set(
      provider,
      seedCalendarSyncState({
        provider,
        lastRun: await withSeedRetry(() => fetchLastCalendarRun(provider)),
        timezone,
        intervalMs: calendarSyncIntervalMsValue
      })
    );
    calendarSyncSeeded.add(provider);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        level: "error",
        message: "Seeding the last calendar sync run failed; the provider waits and retries the seed",
        workerId,
        provider,
        error: error instanceof Error ? error.message : "Unknown error"
      })}
`
    );
  }
}

/**
 * The calendar sync trigger, gated like the other integration ticks: the poll schedule advances before
 * any network call, so a slow tick is never repeated on the very next loop and never holds up
 * plan-forecast jobs. Providers run one after another, each on its own schedule and its own back-off.
 */
async function tickCalendarSync() {
  if (!calendarSyncEnabled || Date.now() < nextCalendarTickAt) return;
  nextCalendarTickAt = Date.now() + CALENDAR_SYNC_TICK_INTERVAL_MS;
  const timezone = await ownerTimezone();
  for (const provider of calendarSyncProviders) {
    try {
      if (!calendarSyncSeeded.has(provider)) {
        await seedCalendarProvider(provider);
        // Not seeded: a blocked sign-in could be forgotten, so do not risk signing in again.
        if (!calendarSyncSeeded.has(provider)) continue;
      }
      let state = calendarSyncStates.get(provider) ?? initialCalendarSyncState;
      if (state.blockedAt !== null) {
        // Blocked by a sign-in failure: only a manual "Sync now" that succeeds can lift it before tomorrow.
        const lastLooked = calendarSyncLastObservedAt.get(provider) ?? 0;
        if (Date.now() - lastLooked >= CALENDAR_SYNC_BLOCK_POLL_MS) {
          calendarSyncLastObservedAt.set(provider, Date.now());
          state = applyObservedRun(state, await fetchLastCalendarRun(provider).catch(() => null));
          calendarSyncStates.set(provider, state);
        }
      }
      if (!calendarSyncDue({ now: new Date(), timezone, state }).due) continue;
      try {
        const response = await fetch(`${portalInternalUrl}${calendarSyncPath(provider)}`, {
          method: "POST",
          headers: portalHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ trigger: "scheduled" }),
          signal: AbortSignal.timeout(CALENDAR_SYNC_REQUEST_TIMEOUT_MS)
        });
        const result = (await response.json().catch(() => null)) as CalendarSyncResult | null;
        if (!isCalendarSyncAttempt(result)) {
          // 403 / 5xx / non-JSON: the portal recorded no run, so retry soon rather than after a full interval.
          throw new Error(`Portal answered ${response.status} without a sync result`);
        }
        const counts =
          result && (result.status === "synced" || result.status === "needs_review")
            ? {
                eventCount: result.eventCount,
                updated: result.updated,
                deleted: result.deleted,
                heldForReview: result.heldForReview
              }
            : {};
        const failure = result?.status === "failed" ? { message: result.message, reason: result.reason } : {};
        process.stdout.write(
          `${JSON.stringify({
            level: "info",
            message: "Calendar sync triggered",
            workerId,
            provider,
            httpStatus: response.status,
            status: result?.status ?? "unknown",
            ...counts,
            ...failure
          })}\n`
        );
        calendarSyncStates.set(
          provider,
          afterCalendarSyncAttempt({
            provider,
            result,
            now: new Date(),
            timezone,
            intervalMs: calendarSyncIntervalMsValue
          })
        );
      } catch (error) {
        process.stderr.write(
          `${JSON.stringify({
            level: "error",
            message: "Calendar sync request failed",
            workerId,
            provider,
            error: error instanceof Error ? error.message : "Unknown error"
          })}\n`
        );
        calendarSyncStates.set(provider, afterCalendarSyncNetworkError(state, new Date(), calendarSyncIntervalMsValue));
      }
    } catch (error) {
      process.stderr.write(
        `${JSON.stringify({
          level: "error",
          message: "Calendar sync tick failed",
          workerId,
          provider,
          error: error instanceof Error ? error.message : "Unknown error"
        })}\n`
      );
    }
  }
}

/**
 * The travel lookup trigger, gated the same way as `tickCheckInScheduler` above: the poll schedule
 * advances before any network call, so a slow or failing tick is never retried on the very next loop
 * iteration and never stops plan-forecast jobs being processed.
 *
 * This has no "already ran today" tracking: every tick that is due fires
 * unconditionally. Network failures leave `lastTravelLookupRunAt` unchanged so the next tick retries
 * (no exponential backoff or per-day retry limits) — the tick route itself is idempotent and
 * budget-bound, so retrying early costs nothing.
 */
async function tickTravelLookup() {
  if (!travelLookupEnabled || Date.now() < nextTravelLookupTickAt) return;
  nextTravelLookupTickAt = Date.now() + TRAVEL_LOOKUP_TICK_INTERVAL_MS;
  try {
    if (
      !travelLookupTickDue({
        now: new Date(),
        lastRanAt: lastTravelLookupRunAt,
        intervalMs: travelLookupIntervalMs
      })
    )
      return;
    const ran = await postTrigger({
      fetchImpl: fetch,
      url: `${portalInternalUrl}/api/integrations/travel/tick`,
      init: {
        method: "POST",
        headers: portalHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ trigger: "scheduled" }),
        signal: AbortSignal.timeout(30_000)
      },
      okMessage: "Travel lookup tick triggered",
      errorMessage: "Travel lookup tick returned an error",
      failedMessage: "Travel lookup tick request failed",
      workerId,
      write: writeLogLine
    });
    if (ran) lastTravelLookupRunAt = Date.now();
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        level: "error",
        message: "Travel lookup tick failed",
        workerId,
        error: error instanceof Error ? error.message : "Unknown error"
      })}\n`
    );
  }
}

/**
 * The derived-rows tick (communication understanding, slice 2a-2c): only POSTs `{trigger:"scheduled"}` to the portal,
 * which owns the extractors, their cursors and the writes. Gated on `PORTAL_INTERNAL_URL` like the other triggers that
 * hand off to the portal, and never switched off. How soon it asks again comes from the answer (`derivedTickDelayMs`):
 * straight away while a run is filling its batches, a minute when idle. The route is idempotent and locks per person,
 * so asking early or twice is harmless.
 */
async function tickDerivedRows() {
  if (!portalInternalUrl || Date.now() < nextDerivedTickAt) return;
  nextDerivedTickAt = Date.now() + derivedTickDelayMs({ ok: true, body: null });
  try {
    const response = await fetch(`${portalInternalUrl}/api/integrations/derived/tick`, {
      method: "POST",
      headers: portalHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ trigger: "scheduled" }),
      signal: AbortSignal.timeout(120_000)
    });
    const body = await response.json().catch(() => null);
    nextDerivedTickAt = Date.now() + derivedTickDelayMs({ ok: response.ok, body });
    if (!response.ok) {
      process.stderr.write(
        `${JSON.stringify({ level: "error", message: "Derived rows tick request failed", workerId, httpStatus: response.status })}\n`
      );
    }
  } catch (error) {
    nextDerivedTickAt = Date.now() + derivedTickDelayMs({ ok: false, body: null });
    process.stderr.write(
      `${JSON.stringify({ level: "error", message: "Derived rows tick request failed", workerId, error: error instanceof Error ? error.message : "Unknown error" })}\n`
    );
  }
}

/**
 * The model-backed derived-rows tick (communication understanding, slice 2b-4): the same hand-off as `tickDerivedRows`
 * (only POSTs `{trigger:"scheduled"}`; pacing from `derivedTickDelayMs`), to the portal's own route, because a run
 * calls a language model and may take up to the run's 5 minute call budget plus writing. So it waits 20 minutes for the
 * answer (a 5 minute call budget, then at most one message still running, which is bounded by the 15 minute lease it renews), not 120 seconds, and it is a separate loop so a slow run never delays the T0 tick. The route is idempotent and
 * leases its batch, so a second POST while one is running does nothing. No extractor registered is a normal idle answer.
 */
async function tickDerivedModelRows() {
  if (!portalInternalUrl || Date.now() < nextDerivedModelTickAt) return;
  nextDerivedModelTickAt = Date.now() + derivedTickDelayMs({ ok: true, body: null });
  try {
    const response = await fetch(`${portalInternalUrl}/api/integrations/derived/model-tick`, {
      method: "POST",
      headers: portalHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ trigger: "scheduled" }),
      signal: AbortSignal.timeout(1_200_000)
    });
    const body = await response.json().catch(() => null);
    nextDerivedModelTickAt = Date.now() + derivedTickDelayMs({ ok: response.ok, body });
    if (!response.ok) {
      process.stderr.write(
        `${JSON.stringify({ level: "error", message: "Derived model tick request failed", workerId, httpStatus: response.status })}\n`
      );
    }
  } catch (error) {
    nextDerivedModelTickAt = Date.now() + derivedTickDelayMs({ ok: false, body: null });
    process.stderr.write(
      `${JSON.stringify({ level: "error", message: "Derived model tick request failed", workerId, error: error instanceof Error ? error.message : "Unknown error" })}\n`
    );
  }
}

/**
 * The pulse recorder's tick, gated the same way as `tickLeaveByPush` above: unconditional every 60s
 * while `PORTAL_INTERNAL_URL` is set, since the route itself is idempotent (it only re-judges) and a
 * failed POST is simply retried on the next loop.
 */
async function tickPulseRecorder() {
  if (!portalInternalUrl || Date.now() < nextPulseTickAt) return;
  nextPulseTickAt = Date.now() + PULSE_TICK_INTERVAL_MS;
  try {
    const response = await fetch(`${portalInternalUrl}/api/integrations/pulse/tick`, {
      method: "POST",
      headers: portalHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ trigger: "scheduled" }),
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) {
      process.stderr.write(
        `${JSON.stringify({ level: "error", message: "Pulse tick request failed", workerId, httpStatus: response.status })}\n`
      );
    }
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ level: "error", message: "Pulse tick request failed", workerId, error: error instanceof Error ? error.message : "Unknown error" })}\n`
    );
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Parse an environment variable as a positive integer, with a default fallback.
 * Returns the default if the value is unset or cannot be parsed.
 */
function positiveInteger(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

/**
 * Retries `fn` forever with exponential backoff (1s doubling to a 30s cap) rather than letting a
 * single failure crash the process. Used at boot for `recoverAbandonedPlanForecastJobs`, which used to
 * be the one unguarded top-level `await`: with `restart: unless-stopped`, a database blip mid-restart
 * threw there, killed the container, and Docker restarted it into the exact same failure — a tight
 * crash loop instead of a worker that just waits the outage out.
 *
 * `sleep` is injectable so the backoff schedule itself can be unit-tested without real timers.
 */
export async function withRetryForever<T>(
  fn: () => Promise<T>,
  onFailure: (attempt: number, delayMs: number, error: unknown) => void,
  sleep: (milliseconds: number) => Promise<void> = delay,
  options: { initialDelayMs?: number; maxDelayMs?: number } = {}
): Promise<T> {
  const initialDelayMs = options.initialDelayMs ?? 1_000;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  let attempt = 0;
  let delayMs = initialDelayMs;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      attempt += 1;
      onFailure(attempt, delayMs, error);
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, maxDelayMs);
    }
  }
}
