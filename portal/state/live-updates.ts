/**
 * The client half of `/api/events` (`portal/app/api/events/route.ts`): opens one SSE connection,
 * coalesces its `changed` events into a single debounced refresh call, and reconnects on its own
 * backoff schedule when the connection drops. Deliberately free of React and of `EventSource` itself
 * — everything it touches comes in through `LiveUpdatesOptions` — so `portal-provider.tsx` can drive
 * a real `EventSource` while `live-updates.test.ts` drives a fake one under fake timers.
 */
import { extensionReloadsState } from "./extensions";

/** The core kinds, plus whatever an extension names (`reloadKinds`); `string & {}` keeps the core kinds visible. */
export type LiveEventKind = "state" | "planning" | "check_in" | (string & {});

/**
 * What one settled burst of `changed` events should make the client do, by the kinds in the burst.
 * Server kinds (`StateChangedNotification.kind`, `platform/database/src/planning/state-changed.ts`):
 * - `state`: entity data changed (command commit, mail ingest, location, travel spend,
 *   deliverable chat). It need not start a plan run, so a plan check alone never adopts it: reload state.
 * - an extension's own kind (`reloadKinds` in `portal-extensions.ts`): also reload state.
 * - `planning`: a plan run finished. Check plan status, which adopts the run.
 * - `check_in`: a check-in was scheduled. Plan check as before; the check-in poll handles delivery.
 * The plan check is never skipped: a `state` event (a CLI or handheld command) may also have enqueued
 * a forecast job, and a job that retries or fails emits no `planning` event, so only the plan check
 * can put the tab on the recovery path. The provider does not read state twice for it (`stateReloadQueued`).
 */
export function liveRefreshActions(kinds: ReadonlySet<LiveEventKind>): { reloadState: boolean; checkPlan: boolean } {
  return { reloadState: kinds.has("state") || extensionReloadsState(kinds), checkPlan: true };
}

export interface LiveChangedEvent {
  kind: LiveEventKind;
  at: string;
}

/**
 * The slice of the real `EventSource` this controller actually calls. A test's fake need only
 * implement this much, not the rest of the DOM `EventTarget`/`EventSource` interface.
 */
export interface EventSourceLike {
  close(): void;
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  onerror: ((event: Event) => void) | null;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

export interface LiveUpdatesCallbacks {
  /** Fired once per settled burst of `changed` events — the debounced refresh itself. */
  onRefresh: () => void;
  /** Fired once per `changed` event, before debouncing. Optional; mainly for tests and diagnostics. */
  onEvent?: (event: LiveChangedEvent) => void;
  /** Fired every time the connection transitions live/dead, so the UI can show a status dot. */
  onConnectionChange?: (live: boolean) => void;
  /**
   * Fired on every `hello`, the first included, with the server's `lastSuccessfulAt` from the frame.
   * Events that fired while the stream was down are not replayed, and the page's initial state read
   * comes before the stream's subscription, so a write landing between the two is missed too: the
   * caller must reconcile immediately.
   */
  onReconnect?: (lastSuccessfulAt: string | null) => void;
}

export interface LiveUpdatesOptions {
  createEventSource: EventSourceFactory;
  callbacks: LiveUpdatesCallbacks;
  url?: string;
  /** Debounce window for coalescing `changed` events into one `onRefresh` call. */
  refreshDebounceMs?: number;
  /** Reconnect backoff after a dropped connection, capped at the schedule's last entry. */
  reconnectDelaysMs?: readonly number[];
}

const DEFAULT_URL = "/api/events";
const DEFAULT_REFRESH_DEBOUNCE_MS = 250;
/**
 * On top of, not instead of, whatever `retry:` the server's `hello` frame carries: this controller
 * always explicitly closes and re-opens rather than trusting the browser's own automatic retry, so
 * this schedule — not the server's fixed `retry:` value — is what actually governs reconnect timing.
 */
const DEFAULT_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 15_000] as const;

export class LiveUpdatesController {
  private readonly createEventSource: EventSourceFactory;
  private readonly callbacks: LiveUpdatesCallbacks;
  private readonly url: string;
  private readonly refreshDebounceMs: number;
  private readonly reconnectDelaysMs: readonly number[];

  private source: EventSourceLike | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  /** True once `open()` has been called and `close()` has not since — distinct from `live`, which
   *  additionally requires the connection to actually be up. */
  private wantsOpen = false;
  private live = false;
  /** Resolved (by being called) the next time a `planning`-kind event lands; see `waitForPlanningEvent`. */
  private planningWaiters: Array<() => void> = [];

  constructor(options: LiveUpdatesOptions) {
    this.createEventSource = options.createEventSource;
    this.callbacks = options.callbacks;
    this.url = options.url ?? DEFAULT_URL;
    this.refreshDebounceMs = options.refreshDebounceMs ?? DEFAULT_REFRESH_DEBOUNCE_MS;
    this.reconnectDelaysMs = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
  }

  get isLive(): boolean {
    return this.live;
  }

  /** Opens the stream if not already open or awaiting a scheduled reconnect. Idempotent. */
  open(): void {
    this.wantsOpen = true;
    if (this.source || this.reconnectTimer) return;
    this.connect();
  }

  /** Closes the stream and cancels any pending reconnect or refresh debounce — the tab going hidden
   *  calls this, so a background tab holds no connection open at all. */
  close(): void {
    this.wantsOpen = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.reconnectAttempt = 0;
    const source = this.source;
    this.source = null;
    source?.close();
    this.setLive(false);
  }

  /**
   * Resolves `true` if a `planning`-kind `changed` event lands within `timeoutMs`, `false` if the
   * timeout elapses first. Lets a caller (`followPlanRefresh`) try "did the push already tell us?"
   * before falling back to its old fixed-interval poll.
   */
  waitForPlanningEvent(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const onEvent = () => finish(true);
      const finish = (result: boolean) => {
        if (settled) return;
        settled = true;
        this.planningWaiters = this.planningWaiters.filter((waiter) => waiter !== onEvent);
        resolve(result);
      };
      this.planningWaiters.push(onEvent);
      setTimeout(() => finish(false), timeoutMs);
    });
  }

  private connect(): void {
    let source: EventSourceLike;
    try {
      source = this.createEventSource(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.source = source;
    source.addEventListener("hello", (event) => {
      this.reconnectAttempt = 0;
      this.setLive(true);
      let lastSuccessfulAt: string | null = null;
      try {
        const parsed = JSON.parse((event as MessageEvent).data) as { lastSuccessfulAt?: unknown };
        if (typeof parsed.lastSuccessfulAt === "string") lastSuccessfulAt = parsed.lastSuccessfulAt;
      } catch {
        // A hello with no usable payload still means "connected"; reconcile with no hint.
      }
      this.callbacks.onReconnect?.(lastSuccessfulAt);
    });
    source.addEventListener("changed", (event) => {
      let parsed: LiveChangedEvent;
      try {
        parsed = JSON.parse((event as MessageEvent).data) as LiveChangedEvent;
      } catch {
        return;
      }
      this.callbacks.onEvent?.(parsed);
      if (parsed.kind === "planning") for (const waiter of this.planningWaiters.splice(0)) waiter();
      this.scheduleRefresh();
    });
    source.onerror = () => {
      this.setLive(false);
      const dead = this.source;
      this.source = null;
      dead?.close();
      if (this.wantsOpen) this.scheduleReconnect();
    };
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.callbacks.onRefresh();
    }, this.refreshDebounceMs);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = this.reconnectDelaysMs[Math.min(this.reconnectAttempt, this.reconnectDelaysMs.length - 1)]!;
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.wantsOpen) this.connect();
    }, delay);
  }

  private setLive(live: boolean): void {
    if (this.live === live) return;
    this.live = live;
    this.callbacks.onConnectionChange?.(live);
  }
}
