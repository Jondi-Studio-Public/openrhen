import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The planning-status read and the fan-out are both replaced wholesale: what's under test is this
 * route's own framing (retry, hello, changed, cleanup), not `readPlanningStatus`'s query or
 * `StateChangedFanout`'s reconnect/coalescing logic — those have their own tests
 * (`state-events.test.ts`).
 */
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => "postgres://test" }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
const planningRead = vi.hoisted(() => ({
  /** When set, the next freshness read waits on it, so a test can disconnect mid-`hello`. */
  hold: null as Promise<void> | null
}));
vi.mock("@/server/persistence/postgres/state-read", () => ({
  readPlanningStatus: async () => {
    const held = planningRead.hold;
    planningRead.hold = null;
    if (held) await held;
    return {
      lastSuccessfulAt: "2026-09-04T09:00:00.000Z",
      validUntil: "2026-09-04T11:00:00.000Z",
      stale: false,
      awaitingRecalculation: false,
      openJob: null,
      lastFinishedStatus: "succeeded"
    };
  }
}));

const fanout = vi.hoisted(() => ({
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  listener: null as ((notification: { userId: string; kind: string; at: string }) => void) | null,
  /** Whether the Postgres listener is already live when a stream asks; tests flip it to model the gap. */
  isLive: true,
  liveCallbacks: [] as Array<() => void>,
  repairedCallbacks: [] as Array<() => void>
}));
vi.mock("@/server/events/state-events", () => ({
  stateChangedFanout: () => ({
    subscribe: (listener: (notification: { userId: string; kind: string; at: string }) => void) => {
      fanout.listener = listener;
      fanout.subscribe(listener);
      return fanout.unsubscribe;
    },
    onRepaired: (callback: () => void) => {
      fanout.repairedCallbacks.push(callback);
      return () => {
        fanout.repairedCallbacks = fanout.repairedCallbacks.filter((entry) => entry !== callback);
      };
    },
    onLive: (callback: () => void) => {
      if (fanout.isLive) callback();
      else fanout.liveCallbacks.push(callback);
      return () => {
        fanout.liveCallbacks = fanout.liveCallbacks.filter((entry) => entry !== callback);
      };
    }
  })
}));

const { GET } = await import("./route");

afterEach(() => {
  vi.restoreAllMocks();
  fanout.subscribe.mockClear();
  fanout.unsubscribe.mockClear();
  fanout.listener = null;
  fanout.isLive = true;
  fanout.liveCallbacks = [];
  fanout.repairedCallbacks = [];
  vi.useRealTimers();
});

/** Reads and decodes chunks off the response body until `until` returns true, or gives up. */
async function readUntil(response: Response, until: (text: string) => boolean, maxReads = 20): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (let i = 0; i < maxReads; i += 1) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (until(text)) break;
  }
  reader.releaseLock();
  return text;
}

describe("GET /api/events", () => {
  it("starts no ping timer when the client disconnects while the hello freshness read is in flight", async () => {
    let release: () => void = () => undefined;
    planningRead.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const intervals = vi.spyOn(globalThis, "setInterval");
    const controller = new AbortController();
    await GET(new Request("http://portal.test/api/events", { signal: controller.signal }), {});
    await new Promise((resolve) => setTimeout(resolve, 0));

    controller.abort();
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(intervals).not.toHaveBeenCalled();
  });

  it("sends retry then hello with the current planning freshness", async () => {
    const controller = new AbortController();
    const response = await GET(new Request("http://portal.test/api/events", { signal: controller.signal }), {});
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const text = await readUntil(response, (value) => value.includes("event: hello"));
    expect(text).toContain("retry: 3000\n\n");
    expect(text).toContain("event: hello");
    expect(text).toContain('"lastSuccessfulAt":"2026-09-04T09:00:00.000Z"');

    controller.abort();
  });

  it("forwards a changed notification from the fan-out as its own SSE frame", async () => {
    const controller = new AbortController();
    const response = await GET(new Request("http://portal.test/api/events", { signal: controller.signal }), {});
    await readUntil(response, (value) => value.includes("event: hello"));
    expect(fanout.listener).not.toBeNull();

    fanout.listener?.({ userId: "user-1", kind: "planning", at: "2026-09-04T09:05:00.000Z" });

    const chunk = await readUntil(response, (value) => value.includes("event: changed"));
    expect(chunk).toContain("event: changed");
    expect(chunk).toContain('"kind":"planning"');
    expect(chunk).toContain('"at":"2026-09-04T09:05:00.000Z"');

    controller.abort();
  });

  it("unsubscribes from the fan-out once the request is aborted", async () => {
    const controller = new AbortController();
    const response = await GET(new Request("http://portal.test/api/events", { signal: controller.signal }), {});
    await readUntil(response, (value) => value.includes("event: hello"));

    controller.abort();
    // The abort listener runs synchronously off the signal's own event, but give the microtask queue
    // a turn since `start()` awaits the planning-status read before subscribing.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fanout.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("holds hello until the Postgres listener is live, and never sends changed ahead of it", async () => {
    fanout.isLive = false;
    const controller = new AbortController();
    const response = await GET(new Request("http://portal.test/api/events", { signal: controller.signal }), {});
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe("retry: 3000\n\n");

    // Subscribed already (so the listener is starting), but the stream says nothing while it is not live.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fanout.listener).not.toBeNull();
    fanout.listener?.({ userId: "user-1", kind: "state", at: "2026-09-04T09:05:00.000Z" });

    let pending = reader.read();
    const early = await Promise.race([
      pending.then(() => "frame"),
      new Promise((resolve) => setTimeout(() => resolve("none"), 20))
    ]);
    expect(early).toBe("none");

    for (const callback of fanout.liveCallbacks) callback();
    let text = decoder.decode((await pending).value);
    while (!text.includes("event: changed")) text += decoder.decode((await reader.read()).value);
    expect(text.indexOf("event: hello")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("event: hello")).toBeLessThan(text.indexOf("event: changed"));

    controller.abort();
  });

  it("still says hello after the bounded wait when the listener never comes up, then again once it does", async () => {
    vi.useFakeTimers();
    fanout.isLive = false;
    const controller = new AbortController();
    const response = await GET(new Request("http://portal.test/api/events", { signal: controller.signal }), {});
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    await reader.read();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(decoder.decode((await reader.read()).value)).toContain("event: hello");

    for (const callback of fanout.liveCallbacks) callback();
    expect(decoder.decode((await reader.read()).value)).toContain("event: hello");

    controller.abort();
  });

  it("sends another hello to a connected stream each time the LISTEN is repaired, and stops after abort", async () => {
    const controller = new AbortController();
    const response = await GET(new Request("http://portal.test/api/events", { signal: controller.signal }), {});
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("event: hello")) text += decoder.decode((await reader.read()).value);
    expect(text.match(/event: hello/g)).toHaveLength(1);

    // porsager repaired a silently dropped connection: state writes during the outage were never notified.
    expect(fanout.repairedCallbacks).toHaveLength(1);
    for (const callback of fanout.repairedCallbacks) callback();
    expect(decoder.decode((await reader.read()).value)).toContain("event: hello");

    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fanout.repairedCallbacks).toHaveLength(0);
  });
});
