// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import "@/test/render";
import { registerFakeMailSource } from "@/test/fake-mail-source";
import { createSeedState } from "./portal-state";
import { PortalProvider, usePortal } from "./portal-provider";

// The core provider only: the seam is stubbed empty, as it is in the OpenRhen export, and a stand-in mail source is registered.
vi.mock("@/state/private/index", () => ({}));
registerFakeMailSource();

/**
 * A tab left open in the background can have its `setInterval` throttled by the
 * browser well past `STATUS_TICK_MS`, so the idle tick alone left a stale sleep plan on screen long
 * after the server had replanned it. `visibilitychange`/`focus` are how the provider forces an
 * immediate freshness check instead of waiting out the throttle — these tests drive that path
 * directly, since jsdom cannot reproduce background-tab throttling itself.
 */

const planningStatus = {
  lastSuccessfulAt: "2026-08-30T09:00:00.000Z",
  validUntil: "2026-08-30T11:00:00.000Z",
  stale: false,
  awaitingRecalculation: false,
  openJob: null,
  lastFinishedStatus: "succeeded"
};

function statusCallCount(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([url]) => url === "/api/planning/status").length;
}

function stubFetch() {
  const fetchMock = vi.fn((url: string) => {
    if (url === "/api/state")
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ state: null }) } as Response);
    if (url === "/api/planning/status")
      return Promise.resolve({ ok: true, json: () => Promise.resolve(planningStatus) } as Response);
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PortalProvider freshness on visibility/focus", () => {
  it("asks for planning status again once the tab is looked at, without waiting for the interval", async () => {
    const fetchMock = stubFetch();
    render(
      <PortalProvider>
        <div />
      </PortalProvider>
    );
    // The mount-time tick runs as soon as the initial /api/state load settles.
    await waitFor(() => expect(statusCallCount(fetchMock)).toBeGreaterThan(0));
    const beforeVisibility = statusCallCount(fetchMock);

    // The idle tick dedupes by wall-clock minute, so a flip within the same minute the mount-time
    // tick already claimed would be a legitimate no-op; jump the clock forward first so the visibility
    // check lands in a minute nothing has claimed yet, exactly as it would after a real throttled gap.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 5 * 60_000));
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(statusCallCount(fetchMock)).toBeGreaterThan(beforeVisibility);
  });

  it("collapses a visibilitychange+focus pair from the same tab switch into one check", async () => {
    const fetchMock = stubFetch();
    render(
      <PortalProvider>
        <div />
      </PortalProvider>
    );
    await waitFor(() => expect(statusCallCount(fetchMock)).toBeGreaterThan(0));
    const beforeVisibility = statusCallCount(fetchMock);

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 5 * 60_000));
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(400);
    });

    // Both events fired within the debounce window, so exactly one extra check should have run —
    // not zero (the listeners must fire) and not two (a tab switch must not burst).
    expect(statusCallCount(fetchMock)).toBe(beforeVisibility + 1);
  });

  it("stops listening once unmounted", async () => {
    const fetchMock = stubFetch();
    const { unmount } = render(
      <PortalProvider>
        <div />
      </PortalProvider>
    );
    await waitFor(() => expect(statusCallCount(fetchMock)).toBeGreaterThan(0));
    unmount();
    const afterUnmount = statusCallCount(fetchMock);

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 5 * 60_000));
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(statusCallCount(fetchMock)).toBe(afterUnmount);
  });
});

/**
 * A pushed `state` event (a mail ingest, a handheld or CLI edit) changes entities without starting a
 * plan run, so the plan-status check never adopts it; the provider reloads `/api/state` itself.
 */
describe("PortalProvider live events", () => {
  // Runs before the suites that leave a plan-follow loop polling after their provider unmounts, whose
  // reads would otherwise land in this suite's shared fetch stub.
  beforeEach(() => cleanup());
  function installFakeSources() {
    const sources: Array<{ emit: (type: string, data?: unknown) => void }> = [];
    class FakeSource {
      onerror: ((event: Event) => void) | null = null;
      private readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
      constructor() {
        sources.push(this);
      }
      addEventListener(type: string, listener: (event: MessageEvent) => void) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }
      close() {}
      emit(type: string, data?: unknown) {
        for (const listener of this.listeners.get(type) ?? [])
          listener({ data: JSON.stringify(data ?? {}) } as MessageEvent);
      }
    }
    vi.stubGlobal("EventSource", FakeSource);
    return sources;
  }

  async function mountSettled(fetchMock: ReturnType<typeof vi.fn>, sources: unknown[], children: React.ReactNode) {
    const view = render(<PortalProvider>{children}</PortalProvider>);
    await waitFor(() => expect(stateCallCount(fetchMock)).toBeGreaterThan(0));
    await waitFor(() => expect(sources.length).toBeGreaterThan(0));
    // Let the initial load, the first freshness check and the first poll of everything settle. That check
    // is a plan-status read, or a second state read while a running session holds a current plan, so
    // waiting on status reads alone only passed when an earlier test's leftover poll supplied one.
    await waitFor(() => expect(stateCallCount(fetchMock) + statusCallCount(fetchMock)).toBeGreaterThan(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    return view;
  }

  const badgeCallCount = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls.filter(([url]) => url === "/api/mail/review-count").length;

  const settle = (ms = 400) =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });

  it("reloads state on a state event even though the plan has not changed, once per burst", async () => {
    const sources = installFakeSources();
    const fetchMock = stubFetchWithState(
      storedState({
        planning: {
          status: "current",
          lastSuccessfulAt: planningStatus.lastSuccessfulAt,
          validUntil: "2099-01-01T00:00:00.000Z"
        }
      })
    );
    await mountSettled(fetchMock, sources, <div />);
    const before = stateCallCount(fetchMock);
    const statusBefore = statusCallCount(fetchMock);

    const badgeBefore = badgeCallCount(fetchMock);

    await act(async () => {
      sources[0]!.emit("changed", { kind: "state", at: "t1" });
      sources[0]!.emit("changed", { kind: "state", at: "t2" });
    });
    await waitFor(() => expect(stateCallCount(fetchMock)).toBe(before + 1));
    await settle();

    expect(stateCallCount(fetchMock)).toBe(before + 1);
    // The plan is checked too: a state event may have enqueued a forecast job that retries or fails
    // without any `planning` event, and only this check puts the tab on the recovery path.
    expect(statusCallCount(fetchMock)).toBe(statusBefore + 1);
    // One badge read per burst, so the nav badge follows a mail ingest without waiting for its poll.
    expect(badgeCallCount(fetchMock)).toBe(badgeBefore + 1);
  });

  it("does not reload state on a planning event while the plan is unchanged", async () => {
    const sources = installFakeSources();
    const fetchMock = stubFetchWithState(
      storedState({
        planning: {
          status: "current",
          lastSuccessfulAt: planningStatus.lastSuccessfulAt,
          validUntil: "2099-01-01T00:00:00.000Z"
        }
      })
    );
    await mountSettled(fetchMock, sources, <div />);
    const stateBefore = stateCallCount(fetchMock);
    const statusBefore = statusCallCount(fetchMock);

    await act(async () => sources[0]!.emit("changed", { kind: "planning", at: "t1" }));
    await waitFor(() => expect(statusCallCount(fetchMock)).toBeGreaterThan(statusBefore));
    await settle();

    expect(stateCallCount(fetchMock)).toBe(stateBefore);
  });

  it("reloads state on a planning event when a newer plan run has landed", async () => {
    const sources = installFakeSources();
    const stored = storedState({
      planning: {
        status: "current",
        lastSuccessfulAt: planningStatus.lastSuccessfulAt,
        validUntil: "2099-01-01T00:00:00.000Z"
      }
    });
    const fetchMock = stubFetchWithState(stored);
    await mountSettled(fetchMock, sources, <div />);
    const before = stateCallCount(fetchMock);
    fetchMock.mockImplementation((url: string) => {
      if (url === "/api/state")
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ state: stored }) } as Response);
      if (url === "/api/planning/status")
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ...planningStatus, lastSuccessfulAt: "2026-08-30T10:00:00.000Z" })
        } as Response);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    });

    await act(async () => sources[0]!.emit("changed", { kind: "planning", at: "t1" }));

    await waitFor(() => expect(stateCallCount(fetchMock)).toBe(before + 1));
  });

  it("leaves a command's own response alone: a held-back read runs once it settles, and a read begun before a command is discarded", async () => {
    const sources = installFakeSources();
    const stale = storedState({
      planning: {
        status: "current",
        lastSuccessfulAt: "2026-08-30T09:00:00.000Z",
        validUntil: "2097-01-01T00:00:00.000Z"
      }
    });
    const fresh = storedState({
      planning: {
        status: "current",
        lastSuccessfulAt: "2026-08-30T09:00:00.000Z",
        validUntil: "2098-01-01T00:00:00.000Z"
      }
    });
    let stateReads = 0;
    let slowRead: ReturnType<typeof deferred<{ state: unknown }>> | null = null;
    const command = deferred<{ state: unknown }>();
    const fetchMock = vi.fn((url: string) => {
      if (url === "/api/state") {
        stateReads += 1;
        if (stateReads === 1)
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ state: stale }) } as Response);
        slowRead = deferred();
        return Promise.resolve({ ok: true, json: () => slowRead!.promise } as Response);
      }
      if (url === "/api/planning/status")
        return Promise.resolve({ ok: true, json: () => Promise.resolve(planningStatus) } as Response);
      if (url === "/api/commands/recalculate")
        return Promise.resolve({ ok: true, json: () => command.promise } as Response);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
    function Probe() {
      const { state, recalculate } = usePortal();
      return (
        <div>
          <span data-testid="plan-at">{state.planning?.validUntil ?? "none"}</span>
          <button onClick={() => void recalculate().catch(() => undefined)}>go</button>
        </div>
      );
    }
    const view = await mountSettled(fetchMock, sources, <Probe />);
    expect(view.getByTestId("plan-at").textContent).toBe(stale.planning.validUntil);

    // 1. An event while a command is in flight asks for no read yet; the read waits for the command.
    await act(async () => view.getByText("go").click());
    const readsBeforeEvent = stateReads;
    await act(async () => sources[0]!.emit("changed", { kind: "state", at: "echo" }));
    await settle();
    expect(stateReads).toBe(readsBeforeEvent);
    await act(async () => command.resolve({ state: fresh }));
    await waitFor(() => expect(view.getByTestId("plan-at").textContent).toBe(fresh.planning.validUntil));
    // The held-back read runs exactly once, after the command settled.
    await waitFor(() => expect(stateReads).toBe(readsBeforeEvent + 1));
    await act(async () => slowRead!.resolve({ state: fresh }));
    await settle(100);
    expect(stateReads).toBe(readsBeforeEvent + 1);
    slowRead = null;

    // 2. A read that started before a later command must not overwrite that command's response.
    await act(async () => sources[0]!.emit("changed", { kind: "state", at: "later" }));
    await waitFor(() => expect(slowRead).not.toBeNull());
    const command2 = deferred<{ state: unknown }>();
    fetchMock.mockImplementation((url: string) => {
      if (url === "/api/commands/recalculate")
        return Promise.resolve({ ok: true, json: () => command2.promise } as Response);
      return Promise.resolve({ ok: true, json: () => Promise.resolve(planningStatus) } as Response);
    });
    await act(async () => view.getByText("go").click());
    const newest = storedState({
      planning: {
        status: "current",
        lastSuccessfulAt: "2026-08-30T09:00:00.000Z",
        validUntil: "2099-01-01T00:00:00.000Z"
      }
    });
    await act(async () => command2.resolve({ state: newest }));
    await waitFor(() => expect(view.getByTestId("plan-at").textContent).toBe(newest.planning.validUntil));
    await act(async () => slowRead!.resolve({ state: stale }));
    await settle(100);
    expect(view.getByTestId("plan-at").textContent).toBe(newest.planning.validUntil);
  });

  it("replays a plan check that a pushed state event asked for while a command ran, once the command settles", async () => {
    // A `state` event asks for a read and for a plan check. The read is held back for the command; the
    // check used to be dropped outright, so a forecast job that had failed stayed unrecovered until the
    // five-minute tick.
    const sources = installFakeSources();
    const current = storedState({
      planning: {
        status: "current",
        lastSuccessfulAt: planningStatus.lastSuccessfulAt,
        validUntil: "2099-01-01T00:00:00.000Z"
      }
    });
    let status: Record<string, unknown> = planningStatus;
    let recalculations = 0;
    const command = deferred<{ state: unknown }>();
    const fetchMock = vi.fn((url: string) => {
      if (url === "/api/state")
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ state: current }) } as Response);
      if (url === "/api/planning/status")
        return Promise.resolve({ ok: true, json: () => Promise.resolve(status) } as Response);
      if (url === "/api/commands/recalculate") {
        recalculations += 1;
        return Promise.resolve({
          ok: true,
          json: () => (recalculations === 1 ? command.promise : Promise.resolve({ state: current }))
        } as Response);
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
    function Probe() {
      const { recalculate } = usePortal();
      return <button onClick={() => void recalculate().catch(() => undefined)}>go</button>;
    }
    const view = await mountSettled(fetchMock, sources, <Probe />);

    await act(async () => view.getByText("go").click());
    expect(recalculations).toBe(1);
    // The forecast job the event announced has since failed: only a plan check can see that.
    status = { ...planningStatus, stale: true, lastFinishedStatus: "failed" };
    const statusDuring = statusCallCount(fetchMock);
    await act(async () => sources[0]!.emit("changed", { kind: "state", at: "echo" }));
    await settle();
    expect(statusCallCount(fetchMock)).toBe(statusDuring);
    expect(recalculations).toBe(1);

    await act(async () => command.resolve({ state: current }));
    // Held, then replayed exactly once after the command settled: it finds the failed run and recovers.
    await waitFor(() => expect(recalculations).toBe(2));
    await settle(100);
    expect(recalculations).toBe(2);
  });

  it("reads state once, not twice, when a held read and a held plan check replay together", async () => {
    const sources = installFakeSources();
    const running = storedState({
      planning: {
        status: "current",
        lastSuccessfulAt: planningStatus.lastSuccessfulAt,
        validUntil: "2099-01-01T00:00:00.000Z"
      },
      activeSession: {
        id: "session-1",
        actionId: "networking-section-one",
        status: "running",
        startedAt: "2026-08-30T09:20:00.000Z",
        plannedEndAt: "2099-01-01T00:00:00.000Z",
        plannedMinutes: 25,
        remainingBeforeMinutes: 90,
        activeElapsedSeconds: 600
      }
    });
    const command = deferred<{ state: unknown }>();
    const fetchMock = vi.fn((url: string) => {
      if (url === "/api/state")
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ state: running }) } as Response);
      if (url === "/api/planning/status")
        return Promise.resolve({ ok: true, json: () => Promise.resolve(planningStatus) } as Response);
      if (url === "/api/commands/recalculate")
        return Promise.resolve({ ok: true, json: () => command.promise } as Response);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
    function Probe() {
      const { recalculate } = usePortal();
      return <button onClick={() => void recalculate().catch(() => undefined)}>go</button>;
    }
    const view = await mountSettled(fetchMock, sources, <Probe />);

    await act(async () => view.getByText("go").click());
    const before = stateCallCount(fetchMock);
    await act(async () => sources[0]!.emit("changed", { kind: "state", at: "echo" }));
    await settle();
    expect(stateCallCount(fetchMock)).toBe(before);

    await act(async () => command.resolve({ state: running }));
    // A running session turns the plan check into a state read; the one already queued must serve both.
    await waitFor(() => expect(stateCallCount(fetchMock)).toBe(before + 1));
    await settle(100);
    expect(stateCallCount(fetchMock)).toBe(before + 1);
  });

  it("reloads state on the first hello and on each reconnect, once each, and refreshes the email badge", async () => {
    const sources = installFakeSources();
    const fetchMock = stubFetchWithState(
      storedState({
        planning: {
          status: "current",
          lastSuccessfulAt: planningStatus.lastSuccessfulAt,
          validUntil: "2099-01-01T00:00:00.000Z"
        }
      })
    );
    await mountSettled(fetchMock, sources, <div />);
    const beforeFirst = stateCallCount(fetchMock);
    // The first hello reconciles too: the server subscribes only after its freshness read, so a write
    // between the initial state read and the subscription would otherwise be missed.
    await act(async () => sources[0]!.emit("hello", { lastSuccessfulAt: planningStatus.lastSuccessfulAt }));
    await waitFor(() => expect(stateCallCount(fetchMock)).toBe(beforeFirst + 1));
    await settle(100);
    expect(stateCallCount(fetchMock)).toBe(beforeFirst + 1);
    const stateBefore = stateCallCount(fetchMock);
    const badgeBefore = badgeCallCount(fetchMock);

    await act(async () => sources[0]!.emit("hello", { lastSuccessfulAt: planningStatus.lastSuccessfulAt }));
    await waitFor(() => expect(stateCallCount(fetchMock)).toBe(stateBefore + 1));
    await settle();

    expect(stateCallCount(fetchMock)).toBe(stateBefore + 1);
    expect(badgeCallCount(fetchMock)).toBe(badgeBefore + 1);
  });

  it("does not re-render a state read whose ETag is the one already shown, but adopts one whose ETag changed", async () => {
    const sources = installFakeSources();
    const shown = storedState({
      planning: {
        status: "current",
        lastSuccessfulAt: planningStatus.lastSuccessfulAt,
        validUntil: "2097-01-01T00:00:00.000Z"
      }
    });
    const other = storedState({
      planning: {
        status: "current",
        lastSuccessfulAt: planningStatus.lastSuccessfulAt,
        validUntil: "2098-01-01T00:00:00.000Z"
      }
    });
    // The body differs on purpose: an identical ETag means the server vouches for the body, so it is not parsed.
    const answers = [
      { etag: 'W/"a"', state: shown },
      { etag: 'W/"a"', state: other },
      { etag: 'W/"b"', state: other }
    ];
    let reads = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url === "/api/state") {
        const answer = answers[Math.min(reads, answers.length - 1)]!;
        reads += 1;
        return Promise.resolve({
          ok: true,
          headers: new Headers({ etag: answer.etag }),
          json: () => Promise.resolve({ state: answer.state })
        } as Response);
      }
      if (url === "/api/planning/status")
        return Promise.resolve({ ok: true, json: () => Promise.resolve(planningStatus) } as Response);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
    function Probe() {
      const { state } = usePortal();
      return <span data-testid="plan-at">{state.planning?.validUntil ?? "none"}</span>;
    }
    const view = render(
      <PortalProvider>
        <Probe />
      </PortalProvider>
    );
    await waitFor(() => expect(view.getByTestId("plan-at").textContent).toBe(shown.planning.validUntil));
    await waitFor(() => expect(sources.length).toBeGreaterThan(0));

    await act(async () => sources[0]!.emit("hello", { lastSuccessfulAt: planningStatus.lastSuccessfulAt }));
    await waitFor(() => expect(stateCallCount(fetchMock)).toBe(2));
    await settle(100);
    expect(view.getByTestId("plan-at").textContent).toBe(shown.planning.validUntil);

    await act(async () => sources[0]!.emit("hello", { lastSuccessfulAt: planningStatus.lastSuccessfulAt }));
    await waitFor(() => expect(view.getByTestId("plan-at").textContent).toBe(other.planning.validUntil));
  });

  it("forgets the shown ETag when a conflicted command refreshes the screen, so a later read of the old bytes is adopted", async () => {
    const sources = installFakeSources();
    const planWith = (validUntil: string) =>
      storedState({ planning: { status: "current", lastSuccessfulAt: planningStatus.lastSuccessfulAt, validUntil } });
    const first = planWith("2097-01-01T00:00:00.000Z");
    const refreshed = planWith("2098-01-01T00:00:00.000Z");
    const back = planWith("2099-01-01T00:00:00.000Z");
    // The conflict refresh is a plain fetch with no ETag bookkeeping; a later read carries the first ETag again.
    let phase: "first" | "refresh" | "back" = "first";
    const answer = () =>
      phase === "first"
        ? { etag: 'W/"a"', state: first }
        : phase === "refresh"
          ? { etag: 'W/"b"', state: refreshed }
          : { etag: 'W/"a"', state: back };
    const fetchMock = vi.fn((url: string) => {
      if (url === "/api/state") {
        const { etag, state } = answer();
        return Promise.resolve({
          ok: true,
          headers: new Headers({ etag }),
          json: () => Promise.resolve({ state })
        } as Response);
      }
      if (url === "/api/planning/status")
        return Promise.resolve({ ok: true, json: () => Promise.resolve(planningStatus) } as Response);
      if (url === "/api/commands/recalculate") {
        phase = "refresh";
        return Promise.resolve({
          ok: false,
          status: 409,
          json: () => Promise.resolve({ error: "That changed elsewhere." })
        } as Response);
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
    function Probe() {
      const { state, recalculate } = usePortal();
      return (
        <div>
          <span data-testid="plan-at">{state.planning?.validUntil ?? "none"}</span>
          <button onClick={() => void recalculate().catch(() => undefined)}>go</button>
        </div>
      );
    }
    const view = await mountSettled(fetchMock, sources, <Probe />);
    expect(view.getByTestId("plan-at").textContent).toBe(first.planning.validUntil);

    await act(async () => view.getByText("go").click());
    await waitFor(() => expect(view.getByTestId("plan-at").textContent).toBe(refreshed.planning.validUntil));
    phase = "back";
    await settle(100);

    await act(async () => sources[0]!.emit("hello", { lastSuccessfulAt: planningStatus.lastSuccessfulAt }));
    await waitFor(() => expect(view.getByTestId("plan-at").textContent).toBe(back.planning.validUntil));
  });

  it("does not let a slow initial load overwrite state a later hello reconcile adopted", async () => {
    const sources = installFakeSources();
    const initial = storedState({
      planning: {
        status: "current",
        lastSuccessfulAt: planningStatus.lastSuccessfulAt,
        validUntil: "2097-01-01T00:00:00.000Z"
      }
    });
    const reconciled = storedState({
      planning: {
        status: "current",
        lastSuccessfulAt: planningStatus.lastSuccessfulAt,
        validUntil: "2098-01-01T00:00:00.000Z"
      }
    });
    const initialRead = deferred<{ state: unknown }>();
    let stateReads = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url === "/api/state") {
        stateReads += 1;
        if (stateReads === 1) return Promise.resolve({ ok: true, json: () => initialRead.promise } as Response);
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ state: reconciled }) } as Response);
      }
      if (url === "/api/planning/status")
        return Promise.resolve({ ok: true, json: () => Promise.resolve(planningStatus) } as Response);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
    function Probe() {
      const { state } = usePortal();
      return <span data-testid="plan-at">{state.planning?.validUntil ?? "none"}</span>;
    }
    const view = render(
      <PortalProvider>
        <Probe />
      </PortalProvider>
    );
    await waitFor(() => expect(sources.length).toBeGreaterThan(0));

    // The hello lands while the initial request is still pending, and its reconcile resolves first.
    await act(async () => sources[0]!.emit("hello", { lastSuccessfulAt: planningStatus.lastSuccessfulAt }));
    await waitFor(() => expect(view.getByTestId("plan-at").textContent).toBe(reconciled.planning.validUntil));
    await act(async () => initialRead.resolve({ state: initial }));
    await settle(100);

    expect(view.getByTestId("plan-at").textContent).toBe(reconciled.planning.validUntil);
  });

  it("reports no load error when the initial load fails after a later read already adopted state", async () => {
    const sources = installFakeSources();
    const reconciled = storedState({
      planning: {
        status: "current",
        lastSuccessfulAt: planningStatus.lastSuccessfulAt,
        validUntil: "2098-01-01T00:00:00.000Z"
      }
    });
    let rejectInitial!: (error: Error) => void;
    const initialBody = new Promise<{ state: unknown }>((_resolve, reject) => (rejectInitial = reject));
    let stateReads = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url === "/api/state") {
        stateReads += 1;
        if (stateReads === 1) return Promise.resolve({ ok: true, json: () => initialBody } as Response);
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ state: reconciled }) } as Response);
      }
      if (url === "/api/planning/status")
        return Promise.resolve({ ok: true, json: () => Promise.resolve(planningStatus) } as Response);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
    function Probe() {
      const { state, bannerText } = usePortal();
      return (
        <>
          <span data-testid="plan-at">{state.planning?.validUntil ?? "none"}</span>
          <span data-testid="banner">{bannerText}</span>
        </>
      );
    }
    const view = render(
      <PortalProvider>
        <Probe />
      </PortalProvider>
    );
    await waitFor(() => expect(sources.length).toBeGreaterThan(0));
    await act(async () => sources[0]!.emit("hello", { lastSuccessfulAt: planningStatus.lastSuccessfulAt }));
    await waitFor(() => expect(view.getByTestId("plan-at").textContent).toBe(reconciled.planning.validUntil));

    await act(async () => rejectInitial(new Error("offline")));
    await settle(100);

    expect(view.getByTestId("banner").textContent).toBe("");
    expect(view.getByTestId("plan-at").textContent).toBe(reconciled.planning.validUntil);
  });

  it("clears the load failure when a later read commits after the initial load failed first", async () => {
    const sources = installFakeSources();
    const reconciled = storedState({
      planning: {
        status: "current",
        lastSuccessfulAt: planningStatus.lastSuccessfulAt,
        validUntil: "2098-01-01T00:00:00.000Z"
      }
    });
    let rejectInitial!: (error: Error) => void;
    const initialBody = new Promise<{ state: unknown }>((_resolve, reject) => (rejectInitial = reject));
    const reconcileRead = deferred<{ state: unknown }>();
    let stateReads = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url === "/api/state") {
        stateReads += 1;
        if (stateReads === 1) return Promise.resolve({ ok: true, json: () => initialBody } as Response);
        return Promise.resolve({ ok: true, json: () => reconcileRead.promise } as Response);
      }
      if (url === "/api/planning/status")
        return Promise.resolve({ ok: true, json: () => Promise.resolve(planningStatus) } as Response);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
    function Probe() {
      const { state, bannerText, loadFailed } = usePortal();
      return (
        <>
          <span data-testid="plan-at">{state.planning?.validUntil ?? "none"}</span>
          <span data-testid="banner">{bannerText}</span>
          <span data-testid="failed">{String(loadFailed)}</span>
        </>
      );
    }
    const view = render(
      <PortalProvider>
        <Probe />
      </PortalProvider>
    );
    await waitFor(() => expect(sources.length).toBeGreaterThan(0));
    // The reconcile starts first and is still pending when the initial load fails: the failure shows...
    await act(async () => sources[0]!.emit("hello", { lastSuccessfulAt: planningStatus.lastSuccessfulAt }));
    await waitFor(() => expect(stateReads).toBe(2));
    await act(async () => rejectInitial(new Error("offline")));
    await waitFor(() => expect(view.getByTestId("failed").textContent).toBe("true"));

    // ...and the reconcile's successful commit then takes it away.
    await act(async () => reconcileRead.resolve({ state: reconciled }));
    await waitFor(() => expect(view.getByTestId("plan-at").textContent).toBe(reconciled.planning.validUntil));
    expect(view.getByTestId("failed").textContent).toBe("false");
    expect(view.getByTestId("banner").textContent).toBe("");
  });

  it("keeps the unreachable line off the banner while the failed-load screen shows", async () => {
    const sources = installFakeSources();
    const fetchMock = vi.fn((url: string) => {
      if (url === "/api/state") return Promise.reject(new TypeError("Failed to fetch"));
      if (url === "/api/planning/status")
        return Promise.resolve({ ok: true, json: () => Promise.resolve(planningStatus) } as Response);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    function Probe() {
      const { bannerText, loadFailed } = usePortal();
      return (
        <>
          <span data-testid="banner">{bannerText}</span>
          <span data-testid="failed">{String(loadFailed)}</span>
        </>
      );
    }
    const view = render(
      <PortalProvider>
        <Probe />
      </PortalProvider>
    );
    await waitFor(() => expect(view.getByTestId("failed").textContent).toBe("true"));
    await waitFor(() => expect(sources.length).toBeGreaterThan(0));
    // Later reads fail through all their retries too; the failed-load screen already says it.
    await act(async () => sources[0]!.emit("changed", { kind: "state", at: "t1" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(view.getByTestId("failed").textContent).toBe("true");
    expect(view.getByTestId("banner").textContent).toBe("");
  });

  it("queues one follow-up read when a command that failed overtook a read in flight", async () => {
    const sources = installFakeSources();
    const stale = storedState({
      planning: {
        status: "current",
        lastSuccessfulAt: planningStatus.lastSuccessfulAt,
        validUntil: "2097-01-01T00:00:00.000Z"
      }
    });
    const fresh = storedState({
      planning: {
        status: "current",
        lastSuccessfulAt: planningStatus.lastSuccessfulAt,
        validUntil: "2098-01-01T00:00:00.000Z"
      }
    });
    let stateReads = 0;
    const slowRead = deferred<{ state: unknown }>();
    let failCommand!: (error: Error) => void;
    const commandResponse = new Promise<Response>((_resolve, reject) => (failCommand = reject));
    const fetchMock = vi.fn((url: string) => {
      if (url === "/api/state") {
        stateReads += 1;
        if (stateReads === 1)
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ state: stale }) } as Response);
        if (stateReads === 2) return Promise.resolve({ ok: true, json: () => slowRead.promise } as Response);
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ state: fresh }) } as Response);
      }
      if (url === "/api/planning/status")
        return Promise.resolve({ ok: true, json: () => Promise.resolve(planningStatus) } as Response);
      if (url === "/api/commands/recalculate") return commandResponse;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
    function Probe() {
      const { state, recalculate } = usePortal();
      return (
        <div>
          <span data-testid="plan-at">{state.planning?.validUntil ?? "none"}</span>
          <button onClick={() => void recalculate().catch(() => undefined)}>go</button>
        </div>
      );
    }
    const view = await mountSettled(fetchMock, sources, <Probe />);
    expect(view.getByTestId("plan-at").textContent).toBe(stale.planning.validUntil);

    // A read is in flight, a command starts and fails before it returns, then the read answers.
    await act(async () => sources[0]!.emit("changed", { kind: "state", at: "t1" }));
    await waitFor(() => expect(stateReads).toBe(2));
    await act(async () => view.getByText("go").click());
    await act(async () => failCommand(new Error("timed out")));
    await settle(100);
    await act(async () => slowRead.resolve({ state: fresh }));

    // The failed command carried no state, so the discarded read is replaced by exactly one follow-up.
    await waitFor(() => expect(view.getByTestId("plan-at").textContent).toBe(fresh.planning.validUntil));
    await settle(100);
    expect(stateReads).toBe(3);
  });

  it("retries a failed state read after a backoff and commits the retry", async () => {
    const sources = installFakeSources();
    const stale = storedState({
      planning: {
        status: "current",
        lastSuccessfulAt: planningStatus.lastSuccessfulAt,
        validUntil: "2097-01-01T00:00:00.000Z"
      }
    });
    const fresh = storedState({
      planning: {
        status: "current",
        lastSuccessfulAt: planningStatus.lastSuccessfulAt,
        validUntil: "2098-01-01T00:00:00.000Z"
      }
    });
    let stateReads = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url === "/api/state") {
        stateReads += 1;
        if (stateReads === 1)
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ state: stale }) } as Response);
        // The lone `state` event's read fails once, as a non-OK answer.
        if (stateReads === 2) return Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response);
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ state: fresh }) } as Response);
      }
      if (url === "/api/planning/status")
        return Promise.resolve({ ok: true, json: () => Promise.resolve(planningStatus) } as Response);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
    function Probe() {
      const { state } = usePortal();
      return <span data-testid="plan-at">{state.planning?.validUntil ?? "none"}</span>;
    }
    const view = await mountSettled(fetchMock, sources, <Probe />);
    expect(view.getByTestId("plan-at").textContent).toBe(stale.planning.validUntil);

    await act(async () => sources[0]!.emit("changed", { kind: "state", at: "t1" }));
    await waitFor(() => expect(stateReads).toBe(2));
    // About a second later the retry reads again and commits.
    await waitFor(() => expect(view.getByTestId("plan-at").textContent).toBe(fresh.planning.validUntil), {
      timeout: 4000
    });
    await settle(100);
    expect(stateReads).toBe(3);
  });

  /** A stored-state page whose /api/state and /api/planning/status answers the test can break and mend. */
  function mountWithBreakableServer() {
    const sources = installFakeSources();
    const stored = storedState({
      planning: {
        status: "current",
        lastSuccessfulAt: planningStatus.lastSuccessfulAt,
        validUntil: "2097-01-01T00:00:00.000Z"
      }
    });
    const server = { mode: "up" as "up" | "offline" | "error" | "auth" };
    const fetchMock = vi.fn((url: string) => {
      if (url === "/api/state" || url === "/api/planning/status" || url.startsWith("/api/commands/")) {
        if (server.mode === "offline") return Promise.reject(new TypeError("Failed to fetch"));
        // The status check meets the expired cookie first; the refusal clears it, so state then reads as anonymous.
        if (server.mode === "auth")
          return Promise.resolve({
            ok: false,
            status: 401,
            headers: new Headers({
              "x-owner-reason": url === "/api/planning/status" ? "cookie-expired" : "read-anonymous"
            }),
            json: () => Promise.resolve({})
          } as Response);
        if (server.mode === "error")
          return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) } as Response);
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(url === "/api/planning/status" ? planningStatus : { state: stored })
        } as Response);
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
    return { sources, fetchMock, server };
  }
  const banner = (view: { container: HTMLElement }) =>
    view.container.querySelector(".status-banner")?.textContent ?? "";

  it("says it can't reach OpenRhen, with the last good time, when a quiet tab's checks fail after their retries", async () => {
    const { sources, fetchMock, server } = mountWithBreakableServer();
    // Faked from the start, so the page's own minute tick is the one that fires.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = await mountSettled(fetchMock, sources, <span>page</span>);
    expect(banner(view)).not.toMatch(/reach OpenRhen/);
    try {
      server.mode = "offline";
      // No event is pushed: only the minute tick checks the status, fails, and starts a read whose
      // retries (1s, 4s, 15s) run out before the banner speaks.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(90_000);
      });
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(banner(view)).toMatch(/Can't reach OpenRhen\. Showing data from \d{1,2}:\d{2} [ap]m\./));
    // The next good read clears it.
    server.mode = "up";
    await act(async () => sources[0]!.emit("changed", { kind: "state", at: "t2" }));
    await waitFor(() => expect(banner(view)).not.toMatch(/reach OpenRhen/));
  });

  it("clears the banner when a command gets an answer, with no state read needed", async () => {
    const { sources, fetchMock, server } = mountWithBreakableServer();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    function Save() {
      const { recalculate } = usePortal();
      return <button onClick={() => void recalculate().catch(() => undefined)}>save</button>;
    }
    const view = await mountSettled(fetchMock, sources, <Save />);
    server.mode = "offline";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    await waitFor(() => expect(banner(view)).toMatch(/Can't reach OpenRhen/));
    // The server answers again; the command's own answer clears the banner without a state read.
    server.mode = "up";
    const reads = fetchMock.mock.calls.filter(([url]) => url === "/api/state").length;
    await act(async () => view.getByText("save").click());
    await waitFor(() => expect(banner(view)).not.toMatch(/reach OpenRhen/));
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/state").length).toBe(reads);
  });

  it("words a server error differently from a network failure", async () => {
    const { sources, fetchMock, server } = mountWithBreakableServer();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = await mountSettled(fetchMock, sources, <span>page</span>);
    try {
      server.mode = "error";
      await act(async () => {
        await vi.advanceTimersByTimeAsync(90_000);
      });
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(banner(view)).toMatch(/OpenRhen had a problem\. Showing data from/));
    expect(banner(view)).not.toMatch(/Can't reach/);
    // The failed automatic recalculation is named too, not hidden behind the stale-data line.
    expect(banner(view)).toMatch(/could not be reached just now/);
  });

  it("keeps trying while it is unreachable, so the banner clears when the server returns with nothing new", async () => {
    const { sources, fetchMock, server } = mountWithBreakableServer();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = await mountSettled(fetchMock, sources, <span>page</span>);
    server.mode = "offline";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    await waitFor(() => expect(banner(view)).toMatch(/Can't reach OpenRhen/));
    // Back up, and the status poll's plan is unchanged: only the recovery read can clear it.
    server.mode = "up";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    await waitFor(() => expect(banner(view)).not.toMatch(/reach OpenRhen/));
  });

  it("stops its retries and keeps saying expired once auth is refused, even if a later read is anonymous", async () => {
    const { sources, fetchMock, server } = mountWithBreakableServer();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = await mountSettled(fetchMock, sources, <span>page</span>);
    server.mode = "offline";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    await waitFor(() => expect(banner(view)).toMatch(/Can't reach OpenRhen/));
    // A recovery read is now armed. The server answers with an auth refusal.
    server.mode = "auth";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400_000);
    });
    await waitFor(() => expect(view.getByText(/sign-in has expired/)).toBeTruthy());
    const reads = fetchMock.mock.calls.filter(([url]) => url === "/api/state").length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900_000);
    });
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/state").length).toBe(reads);
    expect(view.getByText(/sign-in has expired/)).toBeTruthy();
  });

  it("treats an anonymous refusal as an expired sign-in on a browser that has signed in before", async () => {
    const refuse = () =>
      Promise.resolve({
        ok: false,
        status: 401,
        headers: new Headers({ "x-owner-reason": "read-anonymous" }),
        json: () => Promise.resolve({})
      } as Response);
    vi.stubGlobal("fetch", vi.fn(refuse));
    // The browser dropped its own expired cookie, so the server has nothing to call expired.
    window.localStorage.setItem("openrhen.signedInBefore", "1");
    try {
      const view = render(
        <PortalProvider>
          <span>page</span>
        </PortalProvider>
      );
      expect(await view.findByText(/sign-in has expired/)).toBeTruthy();
      view.unmount();
      window.localStorage.clear();
      const fresh = render(
        <PortalProvider>
          <span>page</span>
        </PortalProvider>
      );
      expect(await fresh.findByText(/isn't signed in yet/)).toBeTruthy();
    } finally {
      window.localStorage.clear();
    }
  });

  it("keeps its own wording for an invalid or throttled refusal, marker or not", async () => {
    window.localStorage.setItem("openrhen.signedInBefore", "1");
    try {
      for (const reason of ["token-invalid", "owner-throttled", "agent-anonymous"]) {
        vi.stubGlobal(
          "fetch",
          vi.fn(() =>
            Promise.resolve({
              ok: false,
              status: 401,
              headers: new Headers({ "x-owner-reason": reason }),
              json: () => Promise.resolve({})
            } as Response)
          )
        );
        const view = render(
          <PortalProvider>
            <span>page</span>
          </PortalProvider>
        );
        expect(await view.findByText(/isn't signed in yet/)).toBeTruthy();
        expect(view.queryByText(/sign-in has expired/)).toBeNull();
        view.unmount();
      }
    } finally {
      window.localStorage.clear();
    }
  });

  it("shows the expired sign-in screen when the plan-status check is the first to be refused", async () => {
    const sources = installFakeSources();
    const stored = storedState({
      planning: {
        status: "current",
        lastSuccessfulAt: planningStatus.lastSuccessfulAt,
        validUntil: "2097-01-01T00:00:00.000Z"
      }
    });
    const fetchMock = vi.fn((url: string) => {
      if (url === "/api/planning/status")
        return Promise.resolve({
          ok: false,
          status: 401,
          headers: new Headers({ "x-owner-reason": "cookie-expired" }),
          json: () => Promise.resolve({})
        } as Response);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ state: stored }) } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(
      <PortalProvider>
        <span>page</span>
      </PortalProvider>
    );
    expect(await view.findByText(/sign-in has expired/)).toBeTruthy();
    expect(sources.length).toBeGreaterThanOrEqual(0);
  });

  it("drops the retry of a failed state read once a newer read has committed", async () => {
    const sources = installFakeSources();
    const stale = storedState({
      planning: {
        status: "current",
        lastSuccessfulAt: planningStatus.lastSuccessfulAt,
        validUntil: "2097-01-01T00:00:00.000Z"
      }
    });
    const fresh = storedState({
      planning: {
        status: "current",
        lastSuccessfulAt: planningStatus.lastSuccessfulAt,
        validUntil: "2098-01-01T00:00:00.000Z"
      }
    });
    let stateReads = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url === "/api/state") {
        stateReads += 1;
        if (stateReads === 1)
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ state: stale }) } as Response);
        if (stateReads === 2) return Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response);
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ state: fresh }) } as Response);
      }
      if (url === "/api/planning/status")
        return Promise.resolve({ ok: true, json: () => Promise.resolve(planningStatus) } as Response);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
    function Probe() {
      const { state } = usePortal();
      return <span data-testid="plan-at">{state.planning?.validUntil ?? "none"}</span>;
    }
    const view = await mountSettled(fetchMock, sources, <Probe />);

    await act(async () => sources[0]!.emit("changed", { kind: "state", at: "t1" }));
    await waitFor(() => expect(stateReads).toBe(2));
    // A newer read (a second event) commits before the retry's delay elapses.
    await act(async () => sources[0]!.emit("changed", { kind: "state", at: "t2" }));
    await waitFor(() => expect(view.getByTestId("plan-at").textContent).toBe(fresh.planning.validUntil));
    expect(stateReads).toBe(3);

    // Well past the first backoff, no retry read was issued.
    await settle(1500);
    expect(stateReads).toBe(3);
  });

  it("keeps the retry of a failed read when an older read lands after it", async () => {
    // Event A starts a read; event B starts a later read that fails and schedules a retry; then A's
    // answer commits. A's snapshot can predate the write B was sent to catch, so it must not cancel B's retry.
    const sources = installFakeSources();
    const plan = (validUntil: string) =>
      storedState({
        planning: { status: "current", lastSuccessfulAt: planningStatus.lastSuccessfulAt, validUntil }
      });
    const stale = plan("2097-01-01T00:00:00.000Z");
    const older = plan("2098-01-01T00:00:00.000Z");
    const fresh = plan("2099-01-01T00:00:00.000Z");
    const slowA = deferred<{ state: unknown }>();
    let stateReads = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url === "/api/state") {
        stateReads += 1;
        if (stateReads === 1)
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ state: stale }) } as Response);
        if (stateReads === 2) return Promise.resolve({ ok: true, json: () => slowA.promise } as Response);
        if (stateReads === 3) return Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response);
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ state: fresh }) } as Response);
      }
      if (url === "/api/planning/status")
        return Promise.resolve({ ok: true, json: () => Promise.resolve(planningStatus) } as Response);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
    function Probe() {
      const { state } = usePortal();
      return <span data-testid="plan-at">{state.planning?.validUntil ?? "none"}</span>;
    }
    const view = await mountSettled(fetchMock, sources, <Probe />);

    await act(async () => sources[0]!.emit("changed", { kind: "state", at: "A" }));
    await waitFor(() => expect(stateReads).toBe(2));
    await act(async () => sources[0]!.emit("changed", { kind: "state", at: "B" }));
    await waitFor(() => expect(stateReads).toBe(3));
    // A lands after B failed: it commits, but B's retry stands.
    await act(async () => slowA.resolve({ state: older }));
    await waitFor(() => expect(view.getByTestId("plan-at").textContent).toBe(older.planning.validUntil));
    await waitFor(() => expect(view.getByTestId("plan-at").textContent).toBe(fresh.planning.validUntil), {
      timeout: 4000
    });
    expect(stateReads).toBe(4);
  });

  it("keeps the newer state when two reads resolve out of order", async () => {
    const sources = installFakeSources();
    const initial = storedState({
      planning: {
        status: "current",
        lastSuccessfulAt: planningStatus.lastSuccessfulAt,
        validUntil: "2097-01-01T00:00:00.000Z"
      }
    });
    const older = storedState({
      planning: {
        status: "current",
        lastSuccessfulAt: planningStatus.lastSuccessfulAt,
        validUntil: "2098-01-01T00:00:00.000Z"
      }
    });
    const newer = storedState({
      planning: {
        status: "current",
        lastSuccessfulAt: planningStatus.lastSuccessfulAt,
        validUntil: "2099-01-01T00:00:00.000Z"
      }
    });
    const reads: Array<ReturnType<typeof deferred<{ state: unknown }>>> = [];
    let stateReads = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url === "/api/state") {
        stateReads += 1;
        if (stateReads === 1)
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ state: initial }) } as Response);
        const read = deferred<{ state: unknown }>();
        reads.push(read);
        return Promise.resolve({ ok: true, json: () => read.promise } as Response);
      }
      if (url === "/api/planning/status")
        return Promise.resolve({ ok: true, json: () => Promise.resolve(planningStatus) } as Response);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
    function Probe() {
      const { state } = usePortal();
      return <span data-testid="plan-at">{state.planning?.validUntil ?? "none"}</span>;
    }
    const view = await mountSettled(fetchMock, sources, <Probe />);

    await act(async () => sources[0]!.emit("changed", { kind: "state", at: "a" }));
    await waitFor(() => expect(reads).toHaveLength(1));
    await act(async () => sources[0]!.emit("changed", { kind: "state", at: "b" }));
    await waitFor(() => expect(reads).toHaveLength(2));

    await act(async () => reads[1]!.resolve({ state: newer }));
    await waitFor(() => expect(view.getByTestId("plan-at").textContent).toBe(newer.planning.validUntil));
    await act(async () => reads[0]!.resolve({ state: older }));
    await settle(100);

    expect(view.getByTestId("plan-at").textContent).toBe(newer.planning.validUntil);
  });

  it("adopts the older read when the newest overlapping read fails", async () => {
    const sources = installFakeSources();
    const initial = storedState({
      planning: {
        status: "current",
        lastSuccessfulAt: planningStatus.lastSuccessfulAt,
        validUntil: "2097-01-01T00:00:00.000Z"
      }
    });
    const older = storedState({
      planning: {
        status: "current",
        lastSuccessfulAt: planningStatus.lastSuccessfulAt,
        validUntil: "2098-01-01T00:00:00.000Z"
      }
    });
    const reads: Array<{ resolve: (value: { state: unknown }) => void; reject: (error: Error) => void }> = [];
    let stateReads = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url === "/api/state") {
        stateReads += 1;
        if (stateReads === 1)
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ state: initial }) } as Response);
        const body = new Promise<{ state: unknown }>((resolve, reject) => reads.push({ resolve, reject }));
        return Promise.resolve({ ok: true, json: () => body } as Response);
      }
      if (url === "/api/planning/status")
        return Promise.resolve({ ok: true, json: () => Promise.resolve(planningStatus) } as Response);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
    function Probe() {
      const { state } = usePortal();
      return <span data-testid="plan-at">{state.planning?.validUntil ?? "none"}</span>;
    }
    const view = await mountSettled(fetchMock, sources, <Probe />);

    await act(async () => sources[0]!.emit("changed", { kind: "state", at: "a" }));
    await waitFor(() => expect(reads).toHaveLength(1));
    await act(async () => sources[0]!.emit("changed", { kind: "state", at: "b" }));
    await waitFor(() => expect(reads).toHaveLength(2));

    // The newest read fails first, then the older one answers: it is the only good answer there is.
    await act(async () => reads[1]!.reject(new Error("offline")));
    await act(async () => reads[0]!.resolve({ state: older }));
    await waitFor(() => expect(view.getByTestId("plan-at").textContent).toBe(older.planning.validUntil));
  });
});

/**
 * `checkPendingCheckIn` has no in-flight guard by construction — it fires on a timer, on
 * visibility/focus, and once per state reload — so more than one request can be outstanding at once.
 * These drive that directly: a slow response landing after a faster, later one (or after the banner
 * it answers has already been dismissed) must not resurrect a check-in the user has moved past.
 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((value) => (resolve = value));
  return { promise, resolve };
}

function checkInPrompt(id: string) {
  return {
    id,
    version: 1,
    status: "pending" as const,
    slotAt: "2026-08-30T09:15:00.000Z",
    directiveKind: "action" as const,
    directiveTitle: `Still on ${id}?`
  };
}

function CheckInProbe() {
  const { pendingCheckIn, dismissPendingCheckIn } = usePortal();
  return (
    <div>
      <span data-testid="pending-check-in-id">{pendingCheckIn?.id ?? "none"}</span>
      <button onClick={() => dismissPendingCheckIn()}>dismiss</button>
      <button onClick={() => dismissPendingCheckIn("ci-1")}>dismiss ci-1</button>
    </div>
  );
}

function stubFetchWithCheckIns(checkInCalls: Array<{ resolve: (value: { checkIn: unknown }) => void }>) {
  const fetchMock = vi.fn((url: string) => {
    if (url === "/api/state")
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ state: null }) } as Response);
    if (url === "/api/planning/status")
      return Promise.resolve({ ok: true, json: () => Promise.resolve(planningStatus) } as Response);
    if (url === "/api/check-ins/current") {
      const next = deferred<{ checkIn: unknown }>();
      checkInCalls.push(next);
      return Promise.resolve({ ok: true, json: () => next.promise } as Response);
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * Fires a second check outside the real `STATUS_TICK_MS` interval, the way `visibilitychange` does
 * on a genuine tab switch. Only `Date.now()` is stubbed forward — real timers are left running, so
 * the 250ms visibility debounce still elapses on its own and `waitFor` below can simply poll for it,
 * rather than mixing fake timers with resolving hand-controlled promises (the two do not mix well
 * with React's own scheduler and were observed to hang the test rather than fail it).
 */
function bumpMinuteBucket() {
  return vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5 * 60_000);
}

describe("PortalProvider pending check-in", () => {
  it("drops a response overtaken by a newer request", async () => {
    const checkInCalls: Array<{ resolve: (value: { checkIn: unknown }) => void }> = [];
    stubFetchWithCheckIns(checkInCalls);
    const { getByTestId } = render(
      <PortalProvider>
        <CheckInProbe />
      </PortalProvider>
    );
    await waitFor(() => expect(checkInCalls.length).toBeGreaterThan(0));

    bumpMinuteBucket();
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(checkInCalls.length).toBeGreaterThanOrEqual(2));

    // The newer request answers first, naming a check-in...
    await act(async () => checkInCalls[1]!.resolve({ checkIn: checkInPrompt("ci-new") }));
    await waitFor(() => expect(getByTestId("pending-check-in-id").textContent).toBe("ci-new"));

    // ...then the older, slower request finally answers too, with a different one. Its answer is
    // stale the moment the newer request was issued and must not overwrite what is now on screen.
    await act(async () => checkInCalls[0]!.resolve({ checkIn: checkInPrompt("ci-stale") }));
    expect(getByTestId("pending-check-in-id").textContent).toBe("ci-new");
  });

  it("drops a late response for a check-in already dismissed", async () => {
    const checkInCalls: Array<{ resolve: (value: { checkIn: unknown }) => void }> = [];
    stubFetchWithCheckIns(checkInCalls);
    const { getByTestId, getByText } = render(
      <PortalProvider>
        <CheckInProbe />
      </PortalProvider>
    );
    await waitFor(() => expect(checkInCalls.length).toBeGreaterThan(0));

    // The first request answers with a real check-in, which the user immediately answers/dismisses...
    await act(async () => checkInCalls[0]!.resolve({ checkIn: checkInPrompt("ci-1") }));
    await waitFor(() => expect(getByTestId("pending-check-in-id").textContent).toBe("ci-1"));
    await act(async () => getByText("dismiss").click());
    expect(getByTestId("pending-check-in-id").textContent).toBe("none");

    // ...but a second request, already in flight before the dismissal, was still asking about the
    // same check-in and answers only now. It must not bring the just-closed banner back.
    bumpMinuteBucket();
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(checkInCalls.length).toBeGreaterThanOrEqual(2));
    await act(async () => checkInCalls[1]!.resolve({ checkIn: checkInPrompt("ci-1") }));
    expect(getByTestId("pending-check-in-id").textContent).toBe("none");
  });

  it("drops a poll for a check-in answered by id before any poll had returned it", async () => {
    const checkInCalls: Array<{ resolve: (value: { checkIn: unknown }) => void }> = [];
    stubFetchWithCheckIns(checkInCalls);
    const { getByTestId, getByText } = render(
      <PortalProvider>
        <CheckInProbe />
      </PortalProvider>
    );
    await waitFor(() => expect(checkInCalls.length).toBeGreaterThan(0));
    // A deep link answered it first; the first poll was already in flight and only now names it.
    await act(async () => getByText("dismiss ci-1").click());
    await act(async () => checkInCalls[0]!.resolve({ checkIn: checkInPrompt("ci-1") }));
    expect(getByTestId("pending-check-in-id").textContent).toBe("none");
  });

  it("keeps a newer prompt when an older check-in is dismissed by id", async () => {
    const checkInCalls: Array<{ resolve: (value: { checkIn: unknown }) => void }> = [];
    stubFetchWithCheckIns(checkInCalls);
    const { getByTestId, getByText } = render(
      <PortalProvider>
        <CheckInProbe />
      </PortalProvider>
    );
    await waitFor(() => expect(checkInCalls.length).toBeGreaterThan(0));
    await act(async () => checkInCalls[0]!.resolve({ checkIn: checkInPrompt("ci-2") }));
    await waitFor(() => expect(getByTestId("pending-check-in-id").textContent).toBe("ci-2"));
    await act(async () => getByText("dismiss ci-1").click());
    expect(getByTestId("pending-check-in-id").textContent).toBe("ci-2");
  });
});

/**
 * AT-P outage-to-recovery: the tab that went offline (or lost its event stream) while the plan
 * crossed `validUntil` must reconcile when connectivity returns, not at the next five-minute tick, and
 * a tab with a running session must still learn what changed elsewhere.
 */
function storedState(overrides: Record<string, unknown>) {
  return JSON.parse(JSON.stringify({ ...createSeedState(new Date("2026-08-30T09:30:00.000Z")), ...overrides }));
}

function stubFetchWithState(stored: unknown, status: Record<string, unknown> = planningStatus) {
  const fetchMock = vi.fn((url: string) => {
    if (url === "/api/state")
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ state: stored }) } as Response);
    if (url === "/api/planning/status")
      return Promise.resolve({ ok: true, json: () => Promise.resolve(status) } as Response);
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stateCallCount(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([url]) => url === "/api/state").length;
}

describe("PortalProvider outage recovery", () => {
  it("checks the plan at once when the browser comes back online, within the same minute", async () => {
    const fetchMock = stubFetch();
    render(
      <PortalProvider>
        <div />
      </PortalProvider>
    );
    await waitFor(() => expect(statusCallCount(fetchMock)).toBeGreaterThan(0));
    const before = statusCallCount(fetchMock);

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });

    await waitFor(() => expect(statusCallCount(fetchMock)).toBeGreaterThan(before));
  });

  it("reads state once when the browser comes back online, so a state-only write made during the outage is adopted", async () => {
    const fetchMock = stubFetchWithState(
      storedState({
        planning: {
          status: "current",
          lastSuccessfulAt: planningStatus.lastSuccessfulAt,
          validUntil: "2099-01-01T00:00:00.000Z"
        }
      })
    );
    render(
      <PortalProvider>
        <div />
      </PortalProvider>
    );
    await waitFor(() => expect(statusCallCount(fetchMock)).toBeGreaterThan(0));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    const before = stateCallCount(fetchMock);

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(stateCallCount(fetchMock)).toBe(before + 1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    // One read: the plan check that rides on it does not read state again.
    expect(stateCallCount(fetchMock)).toBe(before + 1);
  });

  it("holds the online read for a command in flight and runs it once the command settles", async () => {
    const stored = storedState({
      planning: {
        status: "current",
        lastSuccessfulAt: planningStatus.lastSuccessfulAt,
        validUntil: "2099-01-01T00:00:00.000Z"
      }
    });
    const command = deferred<{ state: unknown }>();
    const fetchMock = vi.fn((url: string) => {
      if (url === "/api/state")
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ state: stored }) } as Response);
      if (url === "/api/planning/status")
        return Promise.resolve({ ok: true, json: () => Promise.resolve(planningStatus) } as Response);
      if (url === "/api/commands/recalculate")
        return Promise.resolve({ ok: true, json: () => command.promise } as Response);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
    function Probe() {
      const { recalculate } = usePortal();
      return <button onClick={() => void recalculate().catch(() => undefined)}>go</button>;
    }
    const view = render(
      <PortalProvider>
        <Probe />
      </PortalProvider>
    );
    await waitFor(() => expect(statusCallCount(fetchMock)).toBeGreaterThan(0));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    await act(async () => view.getByText("go").click());
    const before = stateCallCount(fetchMock);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(stateCallCount(fetchMock)).toBe(before);

    await act(async () => command.resolve({ state: stored }));
    await waitFor(() => expect(stateCallCount(fetchMock)).toBe(before + 1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(stateCallCount(fetchMock)).toBe(before + 1);
  });

  it("checks the plan at once when the event stream reconnects", async () => {
    const sources: Array<{ emit: (type: string, data?: unknown) => void }> = [];
    class FakeSource {
      onerror: ((event: Event) => void) | null = null;
      private readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
      constructor() {
        sources.push(this);
      }
      addEventListener(type: string, listener: (event: MessageEvent) => void) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }
      close() {}
      emit(type: string, data?: unknown) {
        for (const listener of this.listeners.get(type) ?? [])
          listener({ data: JSON.stringify(data ?? {}) } as MessageEvent);
      }
    }
    vi.stubGlobal("EventSource", FakeSource);
    const fetchMock = stubFetch();
    render(
      <PortalProvider>
        <div />
      </PortalProvider>
    );
    await waitFor(() => expect(statusCallCount(fetchMock)).toBeGreaterThan(0));
    await waitFor(() => expect(sources.length).toBeGreaterThan(0));
    await act(async () => sources[0]!.emit("hello", { lastSuccessfulAt: planningStatus.lastSuccessfulAt }));
    const afterFirstHello = statusCallCount(fetchMock);

    await act(async () => sources[0]!.emit("hello", { lastSuccessfulAt: planningStatus.lastSuccessfulAt }));

    await waitFor(() => expect(statusCallCount(fetchMock)).toBeGreaterThan(afterFirstHello));
  });

  it("keeps reading state while a session runs and the plan is current", async () => {
    const stored = storedState({
      planning: {
        status: "current",
        lastSuccessfulAt: planningStatus.lastSuccessfulAt,
        validUntil: "2099-01-01T00:00:00.000Z"
      },
      activeSession: {
        id: "session-1",
        actionId: "networking-section-one",
        status: "running",
        startedAt: "2026-08-30T09:20:00.000Z",
        plannedEndAt: "2099-01-01T00:00:00.000Z",
        plannedMinutes: 25,
        remainingBeforeMinutes: 90,
        activeElapsedSeconds: 600
      }
    });
    const fetchMock = stubFetchWithState(stored);
    render(
      <PortalProvider>
        <div />
      </PortalProvider>
    );
    await waitFor(() => expect(stateCallCount(fetchMock)).toBeGreaterThan(0));
    await act(async () => {
      await Promise.resolve();
    });
    const before = stateCallCount(fetchMock);

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });

    await waitFor(() => expect(stateCallCount(fetchMock)).toBeGreaterThan(before));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("recalculate"))).toBe(false);
  });

  const expiredPlan = () =>
    storedState({
      planning: {
        status: "current",
        lastSuccessfulAt: "2020-01-01T00:00:00.000Z",
        validUntil: new Date(Date.now() - 2 * 60_000).toISOString()
      }
    });
  const expiredStatus = (refresh: string, extra: Record<string, unknown> = {}) => ({
    ...planningStatus,
    lastSuccessfulAt: "2020-01-01T00:00:00.000Z",
    validUntil: new Date(Date.now() - 2 * 60_000).toISOString(),
    stale: true,
    // A job in the queue, so the tab does not ask for a recalculation of its own: this is the
    // worker's chain, which is what these tests are about.
    openJob: { status: "running", availableAt: "2020-01-01T00:00:00.000Z", dueNow: true },
    serverNow: new Date().toISOString(),
    staleForMinutes: 2,
    graceEndsAt: new Date(Date.now() + 118 * 60_000).toISOString(),
    refresh,
    ...extra
  });

  it("stays quiet while a plan that just passed validUntil is being refreshed, not calling a healthy server unavailable", async () => {
    stubFetchWithState(expiredPlan(), expiredStatus("refreshing"));
    const { findByText, queryByRole } = render(
      <PortalProvider>
        <div />
      </PortalProvider>
    );
    expect(await findByText("Updating plan…")).toBeTruthy();
    expect(queryByRole("alert")).toBeNull();
  });

  it("says the plan is stuck, for how long and until when the handheld still accepts Start, once it has stalled", async () => {
    stubFetchWithState(
      storedState({
        planning: {
          status: "current",
          lastSuccessfulAt: "2020-01-01T00:00:00.000Z",
          validUntil: new Date(Date.now() - 45 * 60_000).toISOString()
        }
      }),
      expiredStatus("stalled", {
        validUntil: new Date(Date.now() - 45 * 60_000).toISOString(),
        staleForMinutes: 45,
        graceEndsAt: new Date(Date.now() + 75 * 60_000).toISOString()
      })
    );
    const { findByRole } = render(
      <PortalProvider>
        <div />
      </PortalProvider>
    );
    const alert = await findByRole("alert");
    expect(alert.textContent).toMatch(/out of date for 45 minutes and is not refreshing/);
    expect(alert.textContent).toMatch(/handheld and API still accept Start until/);
  });

  it("tells the user a failed refresh is retrying rather than staying silent", async () => {
    stubFetchWithState(expiredPlan(), expiredStatus("retrying"));
    const { findByText } = render(
      <PortalProvider>
        <div />
      </PortalProvider>
    );
    // Amber, not red: a refresh that will retry has not failed yet.
    const banner = (await findByText(/last refresh failed and will retry/)).closest(".status-banner")!;
    expect(banner.className).toBe("status-banner tone-warning");
    expect(banner.getAttribute("role")).toBe("status");
  });

  it("calls a first plan on its way a calm working wait, with no refresh button", async () => {
    stubFetchWithState(storedState({ planning: { status: "pending" } }), {
      ...planningStatus,
      lastSuccessfulAt: null,
      validUntil: null,
      awaitingRecalculation: true,
      refresh: "refreshing"
    });
    const { findByText, queryByRole } = render(
      <PortalProvider>
        <div />
      </PortalProvider>
    );
    const banner = (await findByText("Working out your plan…")).closest(".status-banner")!;
    expect(banner.className).toBe("status-banner tone-working");
    expect(queryByRole("alert")).toBeNull();
    expect(queryByRole("button", { name: "Refresh the plan" })).toBeNull();
  });

  it("does not treat a plan as expired because this browser's clock runs ahead of the server's", async () => {
    // The server says the plan has five minutes left; the browser, ten minutes ahead, would say it ended.
    const validUntil = new Date(Date.now() - 5 * 60_000).toISOString();
    stubFetchWithState(
      storedState({ planning: { status: "current", lastSuccessfulAt: "2026-08-30T09:00:00.000Z", validUntil } }),
      { ...planningStatus, validUntil, serverNow: new Date(Date.now() - 10 * 60_000).toISOString(), refresh: "current" }
    );
    const { queryByText, queryByRole } = render(
      <PortalProvider>
        <div />
      </PortalProvider>
    );
    await waitFor(() => expect(queryByText("Updating plan…")).toBeNull());
    expect(queryByRole("alert")).toBeNull();
  });
});

describe("PortalProvider failed-plan recovery", () => {
  const failedStatus = (lastErrorCode: string) => ({
    ...planningStatus,
    lastFinishedStatus: "failed",
    latestJobFailed: true,
    lastErrorCode
  });
  const recalculateCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls.filter(([url]) => String(url).includes("recalculate")).length;

  it("asks for a fresh calculation after a transient persist failure", async () => {
    const fetchMock = stubFetchWithState(null, failedStatus("plan_forecast_persist_failed"));
    render(
      <PortalProvider>
        <div />
      </PortalProvider>
    );
    await waitFor(() => expect(recalculateCalls(fetchMock)).toBeGreaterThan(0));
  });

  it.each(["plan_forecast_rejected", "invalid_payload", "abandoned_lock"])(
    "does not resend a request that failed terminally with %s, waiting for the state to change",
    async (code) => {
      const fetchMock = stubFetchWithState(null, failedStatus(code));
      render(
        <PortalProvider>
          <div />
        </PortalProvider>
      );
      await waitFor(() => expect(statusCallCount(fetchMock)).toBeGreaterThan(0));
      await act(async () => {
        await Promise.resolve();
      });
      expect(recalculateCalls(fetchMock)).toBe(0);
    }
  );
});

describe("PortalProvider client-state follow-ups", () => {
  it("starts following the plan when a caller adopts server state directly (S10-11)", async () => {
    stubFetchWithState(storedState({}));
    function Adopt() {
      const { acceptServerState } = usePortal();
      return <button onClick={() => acceptServerState(storedState({}))}>adopt</button>;
    }
    const { getByText, queryByText, findByText } = render(
      <PortalProvider>
        <Adopt />
      </PortalProvider>
    );
    expect(queryByText("Updating plan…")).toBeNull();
    await act(async () => {
      getByText("adopt").click();
    });
    expect(await findByText("Updating plan…")).toBeTruthy();
  });

  it("lets a pushed event ask for check-ins again within the same minute (S10-12)", async () => {
    const sources: Array<{ emit: (type: string, data?: unknown) => void }> = [];
    class FakeSource {
      onerror: ((event: Event) => void) | null = null;
      private readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
      constructor() {
        sources.push(this);
      }
      addEventListener(type: string, listener: (event: MessageEvent) => void) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }
      close() {}
      emit(type: string, data?: unknown) {
        for (const listener of this.listeners.get(type) ?? [])
          listener({ data: JSON.stringify(data ?? {}) } as MessageEvent);
      }
    }
    vi.stubGlobal("EventSource", FakeSource);
    const fetchMock = stubFetch();
    const count = (path: string) => fetchMock.mock.calls.filter(([url]) => url === path).length;
    render(
      <PortalProvider>
        <div />
      </PortalProvider>
    );
    await waitFor(() => expect(count("/api/check-ins/current")).toBe(1));
    await waitFor(() => expect(sources.length).toBeGreaterThan(0));
    await act(async () => sources[0]!.emit("changed", { kind: "check_in" }));
    await waitFor(() => expect(count("/api/check-ins/current")).toBe(2));
  });
});

describe("PortalProvider session answers", () => {
  function awaitingFeedback() {
    return storedState({
      planning: {
        status: "current",
        lastSuccessfulAt: planningStatus.lastSuccessfulAt,
        validUntil: "2099-01-01T00:00:00.000Z"
      },
      activeSession: {
        id: "0b0c1b4a-6a39-4c30-9d27-5d1b9f0c2a11",
        version: 3,
        actionId: "networking-section-one",
        status: "feedback",
        startedAt: "2026-08-30T09:20:00.000Z",
        plannedEndAt: "2026-08-30T09:45:00.000Z",
        plannedMinutes: 25,
        remainingBeforeMinutes: 90,
        activeElapsedSeconds: 1500,
        feedbackRequestedAt: "2026-08-30T22:23:00.000Z"
      }
    });
  }

  function Probe({ details }: { details: { note: string; endedAt?: string } }) {
    const { finishSession } = usePortal();
    return <button onClick={() => void finishSession("finished", 0, details)}>finish</button>;
  }

  async function finishAndReadCommand(details: { note: string; endedAt?: string }) {
    const stored = awaitingFeedback();
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
      if (url === "/api/state")
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ state: stored }) } as Response);
      if (url === "/api/planning/status")
        return Promise.resolve({ ok: true, json: () => Promise.resolve(planningStatus) } as Response);
      if (url === "/api/commands/session")
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ state: stored }) } as Response);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(
      <PortalProvider>
        <Probe details={details} />
      </PortalProvider>
    );
    await waitFor(() => expect(stateCallCount(fetchMock)).toBeGreaterThan(0));
    await act(async () => view.getByText("finish").click());
    const posted = fetchMock.mock.calls.find(([url]) => url === "/api/commands/session");
    return JSON.parse(posted![1]!.body as string) as Record<string, unknown>;
  }

  it("sends the end time given at the checkpoint with the finish", async () => {
    const command = await finishAndReadCommand({ note: "", endedAt: "2026-08-30T09:30:00.000Z" });
    expect(command).toMatchObject({ type: "finish", outcome: "completed", endedAt: "2026-08-30T09:30:00.000Z" });
  });

  it("sends no end time when none was given", async () => {
    const command = await finishAndReadCommand({ note: "" });
    expect(command.type).toBe("finish");
    expect(command).not.toHaveProperty("endedAt");
  });
});

describe("PortalProvider when the first read fails", () => {
  function Probe() {
    const { ready, loadFailed } = usePortal();
    return <p>{ready ? (loadFailed ? "failed" : "loaded") : "loading"}</p>;
  }
  function serve(stateOk: boolean) {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "/api/state" && !stateOk)
          return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) } as Response);
        if (url === "/api/planning/status")
          return Promise.resolve({ ok: true, json: () => Promise.resolve(planningStatus) } as Response);
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
      })
    );
  }

  it("reports the failure for the shell's Retry screen, without repeating it in the red banner", async () => {
    serve(false);
    const view = render(
      <PortalProvider>
        <Probe />
      </PortalProvider>
    );
    expect(await view.findByText("failed")).toBeTruthy();
    expect(view.queryByText(/could not be loaded/)).toBeNull();
  });

  it("is not failed when the first read answers", async () => {
    serve(true);
    const view = render(
      <PortalProvider>
        <Probe />
      </PortalProvider>
    );
    expect(await view.findByText("loaded")).toBeTruthy();
  });
});

describe("PortalProvider snooze", () => {
  function Probe({ availableFrom, actionId = "networking-section-one" }: { availableFrom: string; actionId?: string }) {
    const { snoozeAction } = usePortal();
    return (
      <button
        onClick={() =>
          void snoozeAction(actionId, availableFrom).catch((error: Error) => (document.title = error.message))
        }
      >
        snooze
      </button>
    );
  }

  async function snooze(availableFrom: string, actionId?: string, patch: (state: any) => void = () => {}) {
    const stored = storedState({});
    patch(stored);
    const fetchMock = stubFetchWithState(stored);
    const view = render(
      <PortalProvider>
        <Probe availableFrom={availableFrom} {...(actionId ? { actionId } : {})} />
      </PortalProvider>
    );
    await waitFor(() => expect(stateCallCount(fetchMock)).toBeGreaterThan(0));
    await act(async () => view.getByText("snooze").click());
    const posted = (fetchMock.mock.calls as unknown as [string, RequestInit][]).find(
      ([url]) => url === "/api/commands/action"
    );
    return { stored, posted: posted ? (JSON.parse(posted[1].body as string) as Record<string, any>) : null };
  }

  it("saves the action with only availableFrom changed, and never blocks it", async () => {
    const { stored, posted } = await snooze("2026-08-31T04:00:00.000Z");
    const before = stored.actions.find((item: { id: string }) => item.id === "networking-section-one");
    expect(posted).not.toBeNull();
    expect(posted!.action).toMatchObject({
      id: "networking-section-one",
      status: before.status,
      availableFrom: "2026-08-31T04:00:00.000Z",
      deadlineAt: before.deadlineAt
    });
    expect(posted!.action.status).not.toBe("blocked");
    expect(posted).not.toHaveProperty("blockingReason");
    expect(posted!.expectedVersion).toBe(before.version ?? null);
  });

  it("allows a date past the action's own passed target while the project's external deadline is ahead", async () => {
    const { posted } = await snooze("2026-09-02T04:00:00.000Z", undefined, (stored) => {
      stored.actions.find((a: any) => a.id === "networking-section-one").deadlineAt = "2026-08-01T00:00:00.000Z";
    });
    expect(posted).not.toBeNull();
    expect(posted!.action.availableFrom).toBe("2026-09-02T04:00:00.000Z");
  });

  it("refuses a date after the project's external deadline without sending anything", async () => {
    const { posted } = await snooze("2099-01-01T00:00:00.000Z", undefined, (stored) => {
      stored.actions.find((a: any) => a.id === "networking-section-one").deadlineAt = "2026-08-01T00:00:00.000Z";
    });
    expect(posted).toBeNull();
    expect(document.title).toMatch(/deadline/i);
  });
});
