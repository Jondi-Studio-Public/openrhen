// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import "@/test/render";
import { createSeedState, type ActiveSession, type PortalState } from "./portal-state";
import { LOGGED_TOAST_MS } from "@/features/now/logged-session";
import { PortalProvider, usePortal } from "./portal-provider";

/**
 * Logging that matches what happened: a start that says it began earlier, a start moved back, a
 * switch that finishes one task keeping its estimate and starts another, and the line that follows Save.
 */

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

function openSession(overrides: Partial<ActiveSession> = {}, actionId = "a1"): ActiveSession {
  return {
    id: SESSION_ID,
    version: 4,
    actionId,
    status: "running",
    startedAt: new Date(Date.now() - 40 * 60_000).toISOString(),
    plannedEndAt: new Date(Date.now() + 20 * 60_000).toISOString(),
    plannedMinutes: 60,
    remainingBeforeMinutes: 180,
    activeElapsedSeconds: 0,
    segmentStartedAt: new Date(Date.now() - 40 * 60_000).toISOString(),
    ...overrides
  };
}

function stateWith(activeSession: ActiveSession | null): PortalState {
  const seed = createSeedState(new Date());
  const [first, second] = seed.actions;
  return {
    ...seed,
    actions: [
      { ...first!, id: "a1", title: "Write the report", remainingMinutes: 180, version: 2 },
      { ...second!, id: "a2", title: "Reply to Sam", version: 7 },
      ...seed.actions.slice(2)
    ],
    currentRecommendationId: "22222222-2222-4222-8222-222222222222",
    planning: {
      ...seed.planning,
      status: "current",
      lastSuccessfulAt: "2026-08-30T09:00:00.000Z",
      validUntil: "2099-01-01T00:00:00.000Z"
    },
    activeSession
  } as PortalState;
}

function stubFetch(state: PortalState) {
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ state }) } as Response);
    }
    if (url === "/api/state") return Promise.resolve({ ok: true, json: () => Promise.resolve({ state }) } as Response);
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
  });
  vi.stubGlobal("fetch", fetchMock);
  return posts;
}

function Probe({ onReady }: { onReady: (portal: ReturnType<typeof usePortal>) => void }) {
  onReady(usePortal());
  return null;
}

async function mount() {
  let latest!: ReturnType<typeof usePortal>;
  render(
    <PortalProvider>
      <Probe onReady={(portal) => (latest = portal)} />
    </PortalProvider>
  );
  await waitFor(() => expect(latest?.ready).toBe(true));
  return () => latest;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PortalProvider session logging", () => {
  it("moves the start of the open session with correct_start", async () => {
    const posts = stubFetch(stateWith(openSession()));
    const portal = await mount();
    await act(async () => portal().correctStart("2026-08-30T08:15:00.000Z"));
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("/api/commands/session");
    expect(posts[0]!.body).toMatchObject({
      type: "correct_start",
      sessionId: SESSION_ID,
      expectedVersion: 4,
      startedAt: "2026-08-30T08:15:00.000Z"
    });
  });

  it("ends the open task keeping its estimate, then asks Now to open Something else", async () => {
    const posts = stubFetch(stateWith(openSession()));
    const portal = await mount();
    expect(portal().switchPending).toBe(false);
    await act(async () => portal().stopToSwitch());
    // Only the finish: the other task is started from Something else once the plan has run again.
    expect(posts.map((post) => post.body.type)).toEqual(["finish"]);
    expect(posts[0]!.body).toMatchObject({
      sessionId: SESSION_ID,
      outcome: "progress",
      // The estimate it had, not the 30 minutes Made progress used to preselect, and never "unsure".
      remainingMinutes: 180
    });
    expect(portal().switchPending).toBe(true);
    expect(portal().loggedSession).toMatchObject({ title: "Write the report", minutes: 40 });
    act(() => portal().clearSwitchPending());
    expect(portal().switchPending).toBe(false);
  });

  it("does not switch from a session at its checkpoint", async () => {
    const posts = stubFetch(stateWith(openSession({ status: "feedback" })));
    const portal = await mount();
    await act(async () => portal().stopToSwitch());
    expect(posts).toHaveLength(0);
    expect(portal().switchPending).toBe(false);
  });

  const history = (overrides: Record<string, unknown> = {}) =>
    ({
      id: SESSION_ID,
      actionId: "a1",
      actionTitle: "Write the report",
      result: "stopped",
      startedAt: new Date(Date.now() - 40 * 60_000).toISOString(),
      endedAt: new Date().toISOString(),
      plannedMinutes: 60,
      activeMinutes: 37,
      remainingBeforeMinutes: 180,
      remainingAfterMinutes: 180,
      ...overrides
    }) as PortalState["completedToday"][number];

  it("reads the minutes from the server's record of this very session", async () => {
    const state = stateWith(openSession());
    // Another task's session sits first, as it does when the list is ordered by target.
    state.completedToday = [
      history({ id: "other", actionId: "zz", actionTitle: "Other", activeMinutes: 99 }),
      history()
    ];
    stubFetch(state);
    const portal = await mount();
    await act(async () => portal().finishSession("finished"));
    expect(portal().loggedSession).toMatchObject({ title: "Write the report", minutes: 37 });
  });

  it("sums the segments itself when the response does not carry the session", async () => {
    const state = stateWith(openSession());
    state.completedToday = [history({ id: "other", actionTitle: "Other", activeMinutes: 99 })];
    stubFetch(state);
    const portal = await mount();
    await act(async () => portal().finishSession("finished"));
    expect(portal().loggedSession).toMatchObject({ title: "Write the report", minutes: 40 });
  });

  it("finds the title of a recurring session, whose action id is its occurrence", async () => {
    const state = stateWith(openSession({}, "occ-1"));
    state.occurrences = [{ id: "occ-1", actionId: "a1" } as PortalState["occurrences"][number]];
    stubFetch(state);
    const portal = await mount();
    await act(async () => portal().finishSession("finished"));
    expect(portal().loggedSession).toMatchObject({ title: "Write the report" });
  });

  it("remembers what a switch stopped until something starts", async () => {
    stubFetch(stateWith(openSession()));
    const portal = await mount();
    await act(async () => portal().stopToSwitch());
    // The stubbed response still shows the session open, so it reads as already started.
    expect(portal().switchPending).toBe(true);
  });

  it("says the plan is awaited after a switch until a newer one lands", async () => {
    const open = stateWith(openSession());
    stubFetch(open);
    const portal = await mount();
    await act(async () => portal().stopToSwitch());
    // The stop's response ends the session but carries the plan from before the replan it queued.
    const afterStop = { ...open, activeSession: null } as PortalState;
    act(() => portal().acceptServerState(afterStop));
    expect(portal().switchedFrom).toBe("a1");
    expect(portal().switchAwaitingPlan).toBe(true);
    const planned = {
      ...afterStop,
      planning: { ...afterStop.planning, lastSuccessfulAt: "2026-08-30T09:30:00.000Z" }
    } as PortalState;
    act(() => portal().acceptServerState(planned));
    expect(portal().switchAwaitingPlan).toBe(false);
  });

  it("says what a finished session logged, and not for one that did not start", async () => {
    const posts = stubFetch(stateWith(openSession()));
    const portal = await mount();
    await act(async () => portal().finishSession("did_not_start"));
    expect(portal().loggedSession).toBeNull();
    await act(async () => portal().finishSession("progress", 120));
    expect(posts.map((post) => post.body.type)).toEqual(["did_not_start", "finish"]);
    expect(portal().loggedSession).toMatchObject({ title: "Write the report", minutes: 40 });
    act(() => portal().dismissLoggedSession());
    expect(portal().loggedSession).toBeNull();
  });

  it("lets the logged line run out in the provider, wherever the person is", async () => {
    stubFetch(stateWith(openSession()));
    const portal = await mount();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await act(async () => portal().finishSession("finished"));
      expect(portal().loggedSession).not.toBeNull();
      act(() => vi.advanceTimersByTime(LOGGED_TOAST_MS - 1));
      expect(portal().loggedSession).not.toBeNull();
      act(() => vi.advanceTimersByTime(1));
      expect(portal().loggedSession).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("forgets the stop when a replacement session starts, so it cannot return when that one ends", async () => {
    const open = stateWith(openSession());
    stubFetch(open);
    const portal = await mount();
    await act(async () => portal().stopToSwitch());
    expect(portal().switchPending).toBe(true);
    const replacement = {
      ...open,
      activeSession: openSession({ id: "99999999-9999-4999-8999-999999999999", actionId: "a2" })
    };
    act(() => portal().acceptServerState(replacement as PortalState));
    expect(portal().switchedFrom).toBeNull();
    expect(portal().switchPending).toBe(false);
    expect(portal().focusNewSession).toBe("99999999-9999-4999-8999-999999999999");
    // The replacement ends: nothing about the first stop comes back.
    act(() => portal().acceptServerState({ ...open, activeSession: null } as PortalState));
    expect(portal().switchedFrom).toBeNull();
    expect(portal().switchAwaitingPlan).toBe(false);
    // A later session that no switch started is not the one that was marked for focus.
    act(() =>
      portal().acceptServerState({
        ...open,
        activeSession: openSession({ id: "88888888-8888-4888-8888-888888888888", actionId: "a2" })
      } as PortalState)
    );
    expect(portal().focusNewSession).toBe("99999999-9999-4999-8999-999999999999");
    expect(portal().focusNewSession).not.toBe("88888888-8888-4888-8888-888888888888");
  });

  it("opens nothing when the person left Now while the stop was still going", async () => {
    const open = stateWith(openSession());
    const posts = stubFetch(open);
    const portal = await mount();
    const send = vi.mocked(fetch).getMockImplementation()!;
    const gate: { release: (() => void) | null } = { release: null };
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) =>
        init?.method === "POST"
          ? new Promise<Response>((resolve) => {
              gate.release = () => resolve(send(url, init) as unknown as Response);
            })
          : send(url, init)
      )
    );
    let stopping: Promise<void> = Promise.resolve();
    act(() => {
      stopping = portal().stopToSwitch();
    });
    await waitFor(() => expect(gate.release).not.toBeNull());
    // Leaving Now forgets the switch.
    act(() => portal().forgetSwitch());
    await act(async () => {
      gate.release!();
      await stopping;
    });
    expect(posts).toHaveLength(1);
    expect(portal().switchPending).toBe(false);
    expect(portal().switchedFrom).toBeNull();
  });
});
