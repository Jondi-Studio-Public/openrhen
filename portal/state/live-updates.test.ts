import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LiveUpdatesController,
  liveRefreshActions,
  type EventSourceFactory,
  type EventSourceLike
} from "./live-updates";

/** A minimal fake `EventSource`: records what it was asked to listen for, and lets a test fire
 *  `emit`/`error` on demand instead of needing a real network connection. */
class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  closed = false;
  onerror: ((event: Event) => void) | null = null;
  private readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: data === undefined ? "" : JSON.stringify(data) } as MessageEvent);
    }
  }

  fail(): void {
    this.onerror?.(new Event("error"));
  }
}

function factory(): EventSourceFactory {
  return (url) => new FakeEventSource(url);
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("LiveUpdatesController", () => {
  it("opens exactly one EventSource against the configured URL", () => {
    const controller = new LiveUpdatesController({
      createEventSource: factory(),
      callbacks: { onRefresh: vi.fn() },
      url: "/api/events"
    });
    controller.open();
    controller.open();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]!.url).toBe("/api/events");
  });

  it("reports live once hello arrives, and dead again once an error fires", () => {
    const onConnectionChange = vi.fn();
    const controller = new LiveUpdatesController({
      createEventSource: factory(),
      callbacks: { onRefresh: vi.fn(), onConnectionChange }
    });
    controller.open();
    expect(controller.isLive).toBe(false);

    FakeEventSource.instances[0]!.emit("hello", { lastSuccessfulAt: null });
    expect(controller.isLive).toBe(true);
    expect(onConnectionChange).toHaveBeenLastCalledWith(true);

    FakeEventSource.instances[0]!.fail();
    expect(controller.isLive).toBe(false);
    expect(onConnectionChange).toHaveBeenLastCalledWith(false);
  });

  it("reports every hello, the first included, with its lastSuccessfulAt", async () => {
    const onReconnect = vi.fn();
    const controller = new LiveUpdatesController({
      createEventSource: factory(),
      callbacks: { onRefresh: vi.fn(), onReconnect },
      reconnectDelaysMs: [100]
    });
    controller.open();
    FakeEventSource.instances[0]!.emit("hello", { lastSuccessfulAt: "2026-08-30T09:00:00.000Z" });
    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(onReconnect).toHaveBeenLastCalledWith("2026-08-30T09:00:00.000Z");

    FakeEventSource.instances[0]!.fail();
    await vi.advanceTimersByTimeAsync(100);
    FakeEventSource.instances[1]!.emit("hello", { lastSuccessfulAt: "2026-08-30T10:00:00.000Z" });
    expect(onReconnect).toHaveBeenCalledTimes(2);
    expect(onReconnect).toHaveBeenLastCalledWith("2026-08-30T10:00:00.000Z");
  });

  it("debounces a burst of changed events into a single onRefresh call", async () => {
    const onRefresh = vi.fn();
    const onEvent = vi.fn();
    const controller = new LiveUpdatesController({
      createEventSource: factory(),
      callbacks: { onRefresh, onEvent },
      refreshDebounceMs: 250
    });
    controller.open();
    const source = FakeEventSource.instances[0]!;
    source.emit("hello");

    // The debounce window is 250ms and starts on the first event in a burst — a later event within
    // that same window (fired here at the 100ms mark) does not push the window back out, it only
    // adds another `onEvent` call before the one eventual `onRefresh`.
    source.emit("changed", { kind: "state", at: "t1" });
    await vi.advanceTimersByTimeAsync(100);
    source.emit("changed", { kind: "planning", at: "t2" });
    await vi.advanceTimersByTimeAsync(140); // t=240, still short of the 250ms window
    expect(onRefresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10); // t=250

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledTimes(2);
  });

  it("resolves waitForPlanningEvent as soon as a planning-kind event lands", async () => {
    const controller = new LiveUpdatesController({
      createEventSource: factory(),
      callbacks: { onRefresh: vi.fn() }
    });
    controller.open();
    const source = FakeEventSource.instances[0]!;
    source.emit("hello");

    const waiting = controller.waitForPlanningEvent(5_000);
    source.emit("changed", { kind: "state", at: "t1" }); // not planning — must not resolve it yet
    await vi.advanceTimersByTimeAsync(10);
    source.emit("changed", { kind: "planning", at: "t2" });

    await expect(waiting).resolves.toBe(true);
  });

  it("resolves waitForPlanningEvent false once its timeout elapses with nothing arriving", async () => {
    const controller = new LiveUpdatesController({
      createEventSource: factory(),
      callbacks: { onRefresh: vi.fn() }
    });
    controller.open();

    const waiting = controller.waitForPlanningEvent(5_000);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(waiting).resolves.toBe(false);
  });

  it("reconnects on its own backoff schedule after an error, not immediately", async () => {
    const controller = new LiveUpdatesController({
      createEventSource: factory(),
      callbacks: { onRefresh: vi.fn() },
      reconnectDelaysMs: [1_000, 2_000]
    });
    controller.open();
    FakeEventSource.instances[0]!.fail();
    expect(FakeEventSource.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(FakeEventSource.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("does not reconnect after close(), and reopening starts a fresh connection", async () => {
    const controller = new LiveUpdatesController({
      createEventSource: factory(),
      callbacks: { onRefresh: vi.fn() },
      reconnectDelaysMs: [1_000]
    });
    controller.open();
    controller.close();
    expect(FakeEventSource.instances[0]!.closed).toBe(true);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeEventSource.instances).toHaveLength(1);

    controller.open();
    expect(FakeEventSource.instances).toHaveLength(2);
  });
});

describe("liveRefreshActions", () => {
  it("reloads state for state events, and still checks the plan for recovery", () => {
    // A state event may have enqueued a forecast job whose retry or failure emits no `planning` event.
    expect(liveRefreshActions(new Set(["state"]))).toEqual({ reloadState: true, checkPlan: true });
    expect(liveRefreshActions(new Set(["unregistered"]))).toEqual({ reloadState: false, checkPlan: true });
  });

  it("checks the plan, and does not reload state, for planning and check_in events", () => {
    expect(liveRefreshActions(new Set(["planning"]))).toEqual({ reloadState: false, checkPlan: true });
    expect(liveRefreshActions(new Set(["check_in"]))).toEqual({ reloadState: false, checkPlan: true });
  });

  it("does both for a mixed burst", () => {
    expect(liveRefreshActions(new Set(["state", "planning"]))).toEqual({ reloadState: true, checkPlan: true });
  });
});
