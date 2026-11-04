import postgres from "postgres";
import { STATE_CHANGED_CHANNEL, type StateChangedNotification } from "@openrhen/database";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { runPulseRecorderTick } from "@/server/pulse/pulse-recorder";
import { runPulsePublisher } from "@/server/pulse/pulse-publisher";
import { requestCalendarPublish } from "@/server/imports/calendar-providers";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * Live-update fan-out for `/api/events` (`portal/app/api/events/route.ts`).
 *
 * One dedicated `LISTEN state_changed` connection is held for the whole process and every open SSE
 * stream subscribes to it, rather than each stream opening its own — Postgres has no fan-out of its
 * own for `NOTIFY`, so N tabs opening N listening connections would mean N times the notification
 * traffic (and N times the reconnect storms) for the exact same event. This connection is never taken
 * from `sqlPool` (`portal/server/persistence/postgres/sql-pool.ts`, capped at `max: 5` for ordinary
 * request/response queries): a `LISTEN` connection is held open indefinitely and does nothing else, so
 * sharing it with the request pool would either starve ordinary queries of a pool slot or force the
 * pool bigger than request traffic ever needs.
 *
 * Single-process only, exactly like `device-state-cache.ts`'s in-memory cache: this module-level
 * subscriber set and its one connection live in one Node process's memory. A second portal process
 * (a second container, a horizontally scaled deploy) would need its own `LISTEN` connection and would
 * only fan out to the tabs attached to *that* process — fine for the current single-instance
 * deployment, not a multi-process one.
 *
 * A dropped connection is deliberately NOT this module's job to notice or repair. porsager's `postgres`
 * client (`sql.listen`) already re-issues the `LISTEN` command and keeps retrying with its own capped,
 * jittered backoff (the `backoff` option below) the moment the underlying socket comes back — silently,
 * with no callback exposed for "just disconnected" (its `onclose` connection option is only reachable
 * before a connection's first successful query ever completes, which for a listen connection is the
 * `LISTEN` itself; every drop after that is retried internally and never surfaces). `onListen` firing
 * more than once IS observable, though — the second and later calls mark exactly the moments a drop was
 * silently repaired — so that is this module's only "are we live" signal; there is no matching "just
 * went down" signal to pair it with. What this fan-out DOES still own: retrying the handful of failures
 * the client-library can't self-heal, because they happen before any `postgres()` connection exists to
 * retry with — `databaseUrl()` unset, or the very first `LISTEN` being refused outright (bad
 * permissions, a typo'd channel) rather than merely unreachable.
 */

/** What a subscriber is told once a burst of notifications has settled — see `coalesceWindowMs`. */
export type ChangedListener = (notification: StateChangedNotification) => void;

/**
 * The shape this module needs from a listening connection — exactly the one `postgres.Sql` member it
 * calls, factored out so a test can hand in a fake without spinning up a real `postgres()` client.
 */
export interface ListenClient {
  listen(
    channel: string,
    onNotify: (payload: string) => void,
    onListen?: () => void
  ): Promise<{ unlisten: () => Promise<void> }>;
  end(options?: { timeout?: number }): Promise<void>;
}

/** Builds one `ListenClient`. */
export type ListenClientFactory = () => ListenClient;

/** How long a burst of notifications is allowed to settle before subscribers are told about it once. */
const DEFAULT_COALESCE_WINDOW_MS = 100;

/**
 * Backoff before retrying a `.listen()` call this module's own `connect()` saw fail outright — see the
 * class doc comment for why this covers only that narrow case, not an ordinary connection drop.
 */
const DEFAULT_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 15_000, 30_000];

/**
 * The reconnect backoff `sql.listen`'s own internal resubscribe-after-drop uses, passed explicitly
 * (porsager's default — `(0.5 + random/2) * min(3^retries/100, 20)` seconds — is already reasonable,
 * but naming it here makes the choice this module's own rather than an implicit library default,
 * and keeps it in the same rough shape as the client's own schedule in `live-updates.ts`).
 */
function listenConnectionBackoffSeconds(retries: number): number {
  const capped = Math.min(2 ** retries, 15);
  return (0.5 + Math.random() * 0.5) * capped;
}

/**
 * The real `ListenClient`: its own `postgres()` instance, `max: 1`, never idled or recycled out from
 * under a long-lived `LISTEN` the way `sqlPool`'s ordinary connections are (`idle_timeout`/
 * `max_lifetime` are both disabled here for exactly that reason).
 */
function createRealListenClient(connectionString: string): ListenClient {
  const sql = postgres(connectionString, {
    max: 1,
    idle_timeout: undefined,
    max_lifetime: null,
    fetch_types: false,
    connection: { application_name: "OpenRhen live-updates listener" },
    backoff: listenConnectionBackoffSeconds
  });
  return {
    // `sql.listen` is porsager's own LISTEN helper: it opens (and, on a drop, transparently reopens)
    // the connection above, replays the `LISTEN` command after every reconnect, and calls `onListen`
    // again each time that replay succeeds — see the class doc comment for what that does and doesn't
    // tell this module.
    listen: (channel, onNotify, onListen) => sql.listen(channel, onNotify, onListen),
    // Ending `sql` also ends the dedicated connection `sql.listen` opened internally — porsager's own
    // `end()` explicitly folds that in, so this does not leak it.
    end: (options) => sql.end(options)
  };
}

/**
 * Subscribe/unsubscribe, coalescing and the narrow reconnect case described above, kept as a plain
 * class (rather than a pile of closures over module state) so a test can construct one against a fake
 * `ListenClientFactory` instead of the real database — see `state-events.test.ts`.
 */
export class StateChangedFanout {
  private readonly subscribers = new Set<ChangedListener>();
  private client: ListenClient | null = null;
  private connecting = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Map<string, StateChangedNotification>();
  private live = false;
  private readonly liveWaiters = new Set<() => void>();
  private readonly repairedListeners = new Set<() => void>();

  constructor(
    private readonly createClient: ListenClientFactory,
    private readonly coalesceWindowMs: number = DEFAULT_COALESCE_WINDOW_MS,
    private readonly reconnectDelaysMs: readonly number[] = DEFAULT_RECONNECT_DELAYS_MS
  ) {}

  /** Adds `listener`, starting the connection on the first subscriber. Returns the unsubscribe function. */
  subscribe(listener: ChangedListener): () => void {
    const wasEmpty = this.subscribers.size === 0;
    this.subscribers.add(listener);
    if (wasEmpty) this.connect();
    return () => this.unsubscribe(listener);
  }

  /**
   * Kept alive rather than torn down on the last unsubscribe: a `LISTEN` connection sits idle for
   * free (its `idle_timeout`/`max_lifetime` are disabled precisely so it can), and every tab closing
   * at once — a laptop lid closing, a phone locking — is an ordinary event for a household portal,
   * not a rare one worth paying a fresh `LISTEN` round-trip to recover from the moment the next tab
   * opens. A future deployment that wants to release the connection when nobody is subscribed can
   * call `stop()` explicitly from wherever tracks that.
   */
  private unsubscribe(listener: ChangedListener): void {
    this.subscribers.delete(listener);
  }

  /** Closes the connection and cancels any pending reconnect or coalesce timer. Not used by the route
   *  today (see `unsubscribe`'s comment) — kept for tests and for a future idle-teardown policy. */
  stop(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.coalesceTimer) clearTimeout(this.coalesceTimer);
    this.reconnectTimer = null;
    this.coalesceTimer = null;
    this.pending.clear();
    this.live = false;
    const client = this.client;
    this.client = null;
    void client?.end({ timeout: 0 }).catch(() => undefined);
  }

  /**
   * Calls `callback` once the `LISTEN` is actually in place: immediately when it already is, else on
   * the next `onListen`. `subscribe()` returns before the asynchronous `.listen()` finishes, so a
   * caller that must not miss a notification (the SSE route's `hello`, which makes the client
   * reconcile) waits on this first. Returns a function that cancels a still-pending wait.
   */
  onLive(callback: () => void): () => void {
    if (this.live) {
      callback();
      return () => undefined;
    }
    this.liveWaiters.add(callback);
    return () => {
      this.liveWaiters.delete(callback);
    };
  }

  /**
   * Calls `callback` every time the `LISTEN` is re-established after the first time, i.e. each moment
   * porsager's own resubscribe-after-drop repaired a silently dropped connection. Notifications sent
   * during the outage are gone, so a subscriber that must not miss a state change (the SSE route, which
   * answers with a fresh `hello` so the client reconciles) reconciles on this boundary. porsager exposes
   * no "just disconnected" callback, so `isLive` cannot be reset on a drop; the repeated `onListen` is
   * the only signal there is. Returns the function that removes the callback.
   */
  onRepaired(callback: () => void): () => void {
    this.repairedListeners.add(callback);
    return () => {
      this.repairedListeners.delete(callback);
    };
  }

  /** Test-only escape hatch: how many reconnect attempts have been scheduled since the last success. */
  get reconnectAttemptCount(): number {
    return this.reconnectAttempt;
  }

  /** Whether `onListen` has fired at least once for the current client. Diagnostic only — nothing in
   *  this module changes behaviour based on it, since there is no matching "just went down" signal to
   *  pair it with (see the class doc comment). */
  get isLive(): boolean {
    return this.live;
  }

  private connect(): void {
    // The connection outlives its last subscriber (see `unsubscribe`), so the next first subscriber
    // finds it still open: reuse it. Building another here leaked one Postgres connection for every
    // tab opened after the previous one closed, until the database refused new clients.
    if (this.connecting || this.client) return;
    this.connecting = true;
    let client: ListenClient;
    try {
      client = this.createClient();
    } catch (error) {
      this.connecting = false;
      console.error("StateChangedFanout: could not open the LISTEN connection", error);
      this.scheduleReconnect();
      return;
    }
    this.client = client;
    // A new client's first `onListen` is a first listen, not a repair.
    this.live = false;
    client
      .listen(
        STATE_CHANGED_CHANNEL,
        (payload) => this.onNotify(payload),
        () => {
          const repaired = this.live;
          this.live = true;
          const waiters = [...this.liveWaiters];
          this.liveWaiters.clear();
          for (const waiter of waiters) waiter();
          if (repaired) for (const listener of this.repairedListeners) listener();
        }
      )
      .then(() => {
        this.connecting = false;
        this.reconnectAttempt = 0;
      })
      .catch((error: unknown) => {
        this.connecting = false;
        this.client = null;
        console.error("StateChangedFanout: LISTEN failed", error);
        this.scheduleReconnect();
      });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = this.reconnectDelaysMs[Math.min(this.reconnectAttempt, this.reconnectDelaysMs.length - 1)]!;
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.subscribers.size > 0) this.connect();
    }, delay);
  }

  private onNotify(payload: string): void {
    let notification: StateChangedNotification;
    try {
      notification = JSON.parse(payload) as StateChangedNotification;
    } catch (error) {
      console.error("StateChangedFanout: malformed NOTIFY payload", error);
      return;
    }
    // Bursts (a chain of writes, or several tabs writing close together) collapse into one delivery per
    // kind: the latest notification of each kind in the window wins, since every subscriber's reaction
    // to `changed` is "go check what's fresh now", not "replay every intermediate state". The kinds
    // are kept apart because they ask for different refreshes (`liveRefreshActions`): a `state`
    // followed by a `check_in` in one window must still reload state.
    this.pending.set(`${notification.userId}:${notification.kind}`, notification);
    if (this.coalesceTimer) return;
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = null;
      const toDeliver = [...this.pending.values()];
      this.pending.clear();
      for (const notification of toDeliver) for (const listener of this.subscribers) listener(notification);
    }, this.coalesceWindowMs);
  }
}

let singleton: StateChangedFanout | null = null;

/** The one process-wide fan-out, built lazily so a missing `DATABASE_URL` only surfaces on first use. */
export function stateChangedFanout(): StateChangedFanout {
  if (!singleton) {
    singleton = new StateChangedFanout(() => {
      const connectionString = databaseUrl();
      if (!connectionString) throw new Error("Live updates require PostgreSQL: DATABASE_URL is not set.");
      return createRealListenClient(connectionString);
    });
  }
  return singleton;
}

/**
 * The pulse recorder's other trigger:
 * beside the worker's 60s tick, every `state_changed` notification re-runs the recorder too, debounced
 * so a burst of writes (several commands in quick succession) produces one recorder pass, not one per
 * write. Registered once, lazily, the first time anything calls `ensurePulseRecorderSubscribed` — the
 * pulse tick route does this on every call, which is enough to guarantee it runs at least once per
 * process without this module reaching out to start it unasked.
 */
const PULSE_DEBOUNCE_MS = 2_000;
let pulseSubscribed = false;
let pulseDebounceTimer: ReturnType<typeof setTimeout> | null = null;

export function ensurePulseRecorderSubscribed(): void {
  if (pulseSubscribed) return;
  pulseSubscribed = true;
  stateChangedFanout().subscribe(() => {
    if (pulseDebounceTimer) return;
    pulseDebounceTimer = setTimeout(() => {
      pulseDebounceTimer = null;
      const connectionString = databaseUrl();
      if (!connectionString) return;
      // Recorder writes never call `recordStateChange` or `NOTIFY` (see the design note's "Recording"),
      // so this can never trigger itself — and neither can the publisher below it, for the same reason.
      const sql = sqlPool(connectionString);
      void runPulseRecorderTick(sql)
        .then(() => ensureUser(sql))
        .then((userId) => runPulsePublisher(sql, userId))
        .catch((error: unknown) => {
          console.error("ensurePulseRecorderSubscribed: pulse recorder/publisher tick failed", error);
        });
    }, PULSE_DEBOUNCE_MS);
  });
}

/**
 * The calendar publish sweep's `state_changed` door:
 * every notification asks for a sweep through the debounced request the sink registers (`provider-hooks.ts`)
 * (5 s), so a shift moved at breakfast reaches the frame within seconds. Registered once, lazily, like
 * the pulse recorder above — the publish route the worker's fallback tick posts to calls this on every
 * request, which guarantees it is registered in any process that is running. The sweep only ever
 * writes `calendar_publications` and `integration_sync_runs`, never a notifying table, so it cannot
 * trigger itself.
 */
let calendarPublishSubscribed = false;

export function ensureCalendarPublishSubscribed(): void {
  if (calendarPublishSubscribed) return;
  calendarPublishSubscribed = true;
  stateChangedFanout().subscribe(() => requestCalendarPublish());
}
