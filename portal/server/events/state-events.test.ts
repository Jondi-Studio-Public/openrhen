import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateChangedFanout, type ListenClient, type ListenClientFactory } from "./state-events";

/**
 * A fake `ListenClient` whose `listen()` resolution/rejection and `NOTIFY`/`onListen` delivery are all
 * under the test's control. There is deliberately no way to simulate "the connection silently dropped
 * and porsager's own backoff is reconnecting it" here — that happens entirely inside the real
 * `postgres` client, invisibly, with no callback this module (or a fake standing in for it) can
 * observe; see `state-events.ts`'s class doc comment for the full explanation. What IS real and
 * fake-able: the initial `listen()` call succeeding or failing, notifications arriving once it has,
 * and `onListen` firing again (simulating a drop porsager already silently repaired on its own).
 */
function fakeClient(): {
  client: ListenClient;
  triggerNotify: (payload: string) => void;
  fireOnListenAgain: () => void;
  resolveListen: () => void;
  rejectListen: (error: unknown) => void;
  end: ReturnType<typeof vi.fn>;
} {
  let notify: ((payload: string) => void) | null = null;
  let onListen: (() => void) | null = null;
  let resolveListen!: () => void;
  let rejectListen!: (error: unknown) => void;
  const end = vi.fn(async () => undefined);
  const listenPromise = new Promise<{ unlisten: () => Promise<void> }>((resolve, reject) => {
    resolveListen = () => resolve({ unlisten: async () => undefined });
    rejectListen = reject;
  });
  const client: ListenClient = {
    // Mirrors porsager's own shape: `onListen` fires right as the underlying promise resolves, not
    // merely whenever `listen()` is called — see the real `sql.listen`'s implementation.
    listen: async (_channel, onNotify, onListenArg) => {
      notify = onNotify;
      onListen = onListenArg ?? null;
      const result = await listenPromise;
      onListenArg?.();
      return result;
    },
    end
  };
  return {
    client,
    triggerNotify: (payload) => notify?.(payload),
    fireOnListenAgain: () => onListen?.(),
    resolveListen,
    rejectListen,
    end
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  // The initial-connect-failure tests deliberately trigger `console.error` logging
  // (`StateChangedFanout`'s own failure logs) — silenced so a passing run stays quiet.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("StateChangedFanout", () => {
  it("connects only once the first subscriber arrives", async () => {
    const fake = fakeClient();
    let calls = 0;
    const factory: ListenClientFactory = () => {
      calls += 1;
      return fake.client;
    };
    const fanout = new StateChangedFanout(factory);
    expect(calls).toBe(0);

    fanout.subscribe(() => undefined);
    expect(calls).toBe(1);
    fake.resolveListen();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("reuses the open connection when a subscriber arrives after the last one left", async () => {
    const fake = fakeClient();
    let calls = 0;
    const fanout = new StateChangedFanout(() => {
      calls += 1;
      return fake.client;
    });
    const live = vi.fn();
    const leave = fanout.subscribe(() => undefined);
    fake.resolveListen();
    await vi.advanceTimersByTimeAsync(0);
    leave();

    // A page reload: the old tab's stream closes, then the new tab's opens on the same process.
    fanout.subscribe(() => undefined);
    fanout.onLive(live);
    expect(calls).toBe(1);
    expect(fake.end).not.toHaveBeenCalled();
    expect(live).toHaveBeenCalledTimes(1);
  });

  it("marks itself live once onListen fires, and stays live across a repaired-drop replay", async () => {
    const fake = fakeClient();
    const factory: ListenClientFactory = () => fake.client;
    const fanout = new StateChangedFanout(factory);
    expect(fanout.isLive).toBe(false);

    fanout.subscribe(() => undefined);
    fake.resolveListen();
    await vi.advanceTimersByTimeAsync(0);
    expect(fanout.isLive).toBe(true);

    // porsager's own resubscribe-after-drop calls `onListen` again — this module has no separate
    // "just went down" signal to pair with it (see the class doc comment), so it simply stays live.
    fake.fireOnListenAgain();
    expect(fanout.isLive).toBe(true);
  });

  it("onLive runs once the LISTEN is in place, immediately when it already is, and can be cancelled", async () => {
    const fake = fakeClient();
    const fanout = new StateChangedFanout(() => fake.client);
    const waiting = vi.fn();
    const cancelled = vi.fn();

    fanout.subscribe(() => undefined);
    fanout.onLive(waiting);
    fanout.onLive(cancelled)();
    expect(waiting).not.toHaveBeenCalled();

    fake.resolveListen();
    await vi.advanceTimersByTimeAsync(0);
    expect(waiting).toHaveBeenCalledTimes(1);
    expect(cancelled).not.toHaveBeenCalled();

    const immediate = vi.fn();
    fanout.onLive(immediate);
    expect(immediate).toHaveBeenCalledTimes(1);
  });

  it("onRepaired runs on every onListen after the first, not on the first, and can be removed", async () => {
    const fake = fakeClient();
    const fanout = new StateChangedFanout(() => fake.client);
    const repaired = vi.fn();
    const removed = vi.fn();
    fanout.subscribe(() => undefined);
    fanout.onRepaired(repaired);
    fanout.onRepaired(removed)();

    fake.resolveListen();
    await vi.advanceTimersByTimeAsync(0);
    expect(repaired).not.toHaveBeenCalled();

    fake.fireOnListenAgain();
    expect(repaired).toHaveBeenCalledTimes(1);
    fake.fireOnListenAgain();
    expect(repaired).toHaveBeenCalledTimes(2);
    expect(removed).not.toHaveBeenCalled();
  });

  it("treats the first listen on a rebuilt client as a first listen, not a repair", async () => {
    const first = fakeClient();
    const second = fakeClient();
    const clients = [first.client, second.client];
    const fanout = new StateChangedFanout(() => clients.shift()!, 100, [10]);
    const repaired = vi.fn();
    fanout.subscribe(() => undefined);
    fanout.onRepaired(repaired);

    first.rejectListen(new Error("refused"));
    await vi.advanceTimersByTimeAsync(10);
    second.resolveListen();
    await vi.advanceTimersByTimeAsync(0);
    expect(fanout.isLive).toBe(true);
    expect(repaired).not.toHaveBeenCalled();
  });

  it("delivers a notification to every subscriber", async () => {
    const fake = fakeClient();
    const factory: ListenClientFactory = () => fake.client;
    const fanout = new StateChangedFanout(factory, 100);
    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    fanout.subscribe((n) => seenA.push(n));
    fanout.subscribe((n) => seenB.push(n));
    fake.resolveListen();
    await vi.advanceTimersByTimeAsync(0);

    fake.triggerNotify(JSON.stringify({ userId: "u1", kind: "planning", at: "t1" }));
    await vi.advanceTimersByTimeAsync(100);

    expect(seenA).toEqual([{ userId: "u1", kind: "planning", at: "t1" }]);
    expect(seenB).toEqual([{ userId: "u1", kind: "planning", at: "t1" }]);
  });

  it("coalesces a burst within the window into one delivery per kind, keeping the latest of each", async () => {
    const fake = fakeClient();
    const factory: ListenClientFactory = () => fake.client;
    const fanout = new StateChangedFanout(factory, 100);
    const seen: unknown[] = [];
    fanout.subscribe((n) => seen.push(n));
    fake.resolveListen();
    await vi.advanceTimersByTimeAsync(0);

    fake.triggerNotify(JSON.stringify({ userId: "u1", kind: "state", at: "t1" }));
    await vi.advanceTimersByTimeAsync(30);
    fake.triggerNotify(JSON.stringify({ userId: "u1", kind: "planning", at: "t2" }));
    await vi.advanceTimersByTimeAsync(30);
    fake.triggerNotify(JSON.stringify({ userId: "u1", kind: "check_in", at: "t3" }));
    fake.triggerNotify(JSON.stringify({ userId: "u1", kind: "state", at: "t4" }));
    await vi.advanceTimersByTimeAsync(100);

    // A `state` followed by a `check_in` must not collapse to the `check_in` alone, or the client
    // would skip the state reload the `state` event asked for.
    expect(seen).toEqual([
      { userId: "u1", kind: "state", at: "t4" },
      { userId: "u1", kind: "planning", at: "t2" },
      { userId: "u1", kind: "check_in", at: "t3" }
    ]);
  });

  it("unsubscribing removes a listener from future deliveries", async () => {
    const fake = fakeClient();
    const factory: ListenClientFactory = () => fake.client;
    const fanout = new StateChangedFanout(factory, 100);
    const seen: unknown[] = [];
    const unsubscribe = fanout.subscribe((n) => seen.push(n));
    fake.resolveListen();
    await vi.advanceTimersByTimeAsync(0);

    unsubscribe();
    fake.triggerNotify(JSON.stringify({ userId: "u1", kind: "state", at: "t1" }));
    await vi.advanceTimersByTimeAsync(100);

    expect(seen).toEqual([]);
  });

  it("retries with backoff when the initial LISTEN itself fails (e.g. refused, not merely unreachable)", async () => {
    let created = 0;
    const captured: { reject: ((error: unknown) => void) | null } = { reject: null };
    const factory: ListenClientFactory = () => {
      created += 1;
      const fake = fakeClient();
      captured.reject = fake.rejectListen;
      return fake.client;
    };
    const fanout = new StateChangedFanout(factory, 100, [10, 20]);
    fanout.subscribe(() => undefined);
    expect(created).toBe(1);

    captured.reject?.(new Error("permission denied for channel"));
    await vi.advanceTimersByTimeAsync(0);
    // Not yet — the first backoff delay (10ms) hasn't elapsed.
    await vi.advanceTimersByTimeAsync(5);
    expect(created).toBe(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(created).toBe(2);
  });

  it("retries with backoff when the client cannot even be constructed (e.g. no DATABASE_URL)", async () => {
    let created = 0;
    const factory: ListenClientFactory = () => {
      created += 1;
      throw new Error("Live updates require PostgreSQL: DATABASE_URL is not set.");
    };
    const fanout = new StateChangedFanout(factory, 100, [10]);
    fanout.subscribe(() => undefined);
    expect(created).toBe(1);

    await vi.advanceTimersByTimeAsync(10);
    expect(created).toBe(2);
  });

  it("stops retrying once every subscriber has left", async () => {
    let created = 0;
    const factory: ListenClientFactory = () => {
      created += 1;
      throw new Error("no DATABASE_URL");
    };
    const fanout = new StateChangedFanout(factory, 100, [10]);
    const unsubscribe = fanout.subscribe(() => undefined);
    expect(created).toBe(1);
    unsubscribe();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(created).toBe(1);
  });
});
