// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { EventSourceFactory, EventSourceLike } from "@/state/live-updates";
import { useCoordination } from "./use-coordination";

/** A minimal fake `EventSource`, copied from `live-updates.test.ts`'s pattern: records what it was
 *  asked to listen for and lets a test fire `emit` on demand instead of needing a real connection. */
class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  closed = false;
  onerror: ((event: Event) => void) | null = null;
  private readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();

  constructor() {
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
}

function factory(): EventSourceFactory {
  return () => new FakeEventSource();
}

const coordination = { handedOff: false, tool: null, since: null, lastDropOffSummary: null };
const prompts = { handoff: "Run pick-up.", bringBack: "Run drop-off." };

function mockFetch(handler: () => unknown) {
  return vi.fn(async () => new Response(JSON.stringify(handler()), { status: 200 }));
}

afterEach(() => {
  // Unmount every hook this test rendered before clearing the fake instances, or a hook left mounted
  // across tests (only the last test in the file calls `unmount` itself) would keep its live
  // connection open and leak into the next test's instance count.
  cleanup();
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

describe("useCoordination", () => {
  it("loads messages, coordination and prompts from the chat endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() => ({
        messages: [{ id: "m1", role: "assistant", content: "hi", attachments: [], createdAt: "t" }],
        coordination,
        prompts
      }))
    );
    // `createEventSource` must be a stable reference across renders — an inline `factory()` call would
    // give the live-subscription effect a new dependency every render, closing and reopening a fresh
    // connection each time.
    const createEventSource = factory();
    const { result } = renderHook(() => useCoordination("d1", 0, createEventSource));
    await waitFor(() => expect(result.current.messages).not.toBeNull());
    expect(result.current.messages).toEqual([
      { id: "m1", role: "assistant", content: "hi", attachments: [], createdAt: "t" }
    ]);
    expect(result.current.coordination).toEqual(coordination);
    expect(result.current.prompts).toEqual(prompts);
    expect(result.current.error).toBe("");
  });

  it("surfaces a load failure and settles messages to an empty array", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() => ({ error: "The deliverable was not found." }))
    );
    const createEventSource = factory();
    const { result } = renderHook(() => useCoordination("d1", 0, createEventSource));
    await waitFor(() => expect(result.current.error).not.toBe(""));
    expect(result.current.messages).toEqual([]);
    expect(result.current.error).toBe("The deliverable was not found.");
  });

  it("re-fetches when the caller's reloadKey is bumped", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return new Response(JSON.stringify({ messages: [], coordination, prompts }), { status: 200 });
      })
    );
    const createEventSource = factory();
    const { rerender } = renderHook(({ key }) => useCoordination("d1", key, createEventSource), {
      initialProps: { key: 0 }
    });
    await waitFor(() => expect(calls).toBe(1));
    rerender({ key: 1 });
    await waitFor(() => expect(calls).toBe(2));
  });

  it("re-fetches on a live changed event and via a manual reload", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return new Response(JSON.stringify({ messages: [], coordination, prompts }), { status: 200 });
      })
    );
    const createEventSource = factory();
    const { result } = renderHook(() => useCoordination("d1", 0, createEventSource));
    await waitFor(() => expect(calls).toBe(1));
    act(() => FakeEventSource.instances[0]!.emit("changed", { kind: "state", at: "2026-09-07T00:00:00.000Z" }));
    await waitFor(() => expect(calls).toBe(2));
    act(() => result.current.reload());
    await waitFor(() => expect(calls).toBe(3));
  });

  it("opens and closes exactly one live connection per mount", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() => ({ messages: [], coordination, prompts }))
    );
    const createEventSource = factory();
    const { unmount } = renderHook(() => useCoordination("d1", 0, createEventSource));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(FakeEventSource.instances[0]!.closed).toBe(false);
    unmount();
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
  });
});
