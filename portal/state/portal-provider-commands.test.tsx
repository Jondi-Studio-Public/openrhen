// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import "@/test/render";
import { createSeedState } from "./portal-state";
import { PortalProvider, usePortal } from "./portal-provider";

function Probe({ onReady }: { onReady: (portal: ReturnType<typeof usePortal>) => void }) {
  onReady(usePortal());
  return null;
}

function mount() {
  let latest!: ReturnType<typeof usePortal>;
  render(
    <PortalProvider>
      <Probe onReady={(portal) => (latest = portal)} />
    </PortalProvider>
  );
  return () => latest;
}

const okState = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ state: null }) } as Response);

beforeEach(() => {
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PortalProvider command resilience", () => {
  it("shows a plain message, not a JSON parse error, when a proxy answers 502 with HTML", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        init?.method === "POST"
          ? Promise.resolve({
              ok: false,
              status: 502,
              json: () => Promise.reject(new SyntaxError("Unexpected token <"))
            } as unknown as Response)
          : okState()
      )
    );
    const portal = mount();
    await act(async () => {
      await portal()
        .recalculate()
        .catch(() => undefined);
    });
    expect(portal().bannerText).toMatch(/could not be reached/);
    expect(portal().bannerText).not.toMatch(/token|JSON/i);
    expect(portal().saving).toBe(false);
  });

  it("names the field that failed when the route refuses a command with schema issues", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        init?.method === "POST"
          ? Promise.resolve({
              ok: false,
              status: 400,
              json: () =>
                Promise.resolve({
                  error: "Recalculation command validation failed.",
                  issues: [{ path: ["reason"], message: "Required" }]
                })
            } as unknown as Response)
          : okState()
      )
    );
    const portal = mount();
    await act(async () => {
      await portal()
        .recalculate()
        .catch(() => undefined);
    });
    expect(portal().bannerText).toBe("Recalculation command validation failed. reason: Required");
  });

  it("abandons a hung command after the timeout so the tab is not wedged", async () => {
    vi.useFakeTimers();
    // Only the first command hangs. Once it is abandoned the provider's own freshness check may ask
    // for a recalculation of its own, and that one must not hang the test too.
    let posts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        init?.method === "POST"
          ? posts++ > 0
            ? Promise.resolve({
                ok: false,
                status: 500,
                json: () => Promise.resolve({ error: "later" })
              } as unknown as Response)
            : new Promise<Response>((_resolve, reject) => {
                init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
              })
          : okState()
      )
    );
    const portal = mount();
    let pending!: Promise<string>;
    act(() => {
      pending = portal()
        .recalculate()
        .then(
          () => "",
          (error: Error) => error.message
        );
    });
    expect(portal().saving).toBe(true);
    let message = "";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_001);
      message = await pending;
    });
    expect(portal().saving).toBe(false);
    expect(message).toMatch(/took too long/);
  });

  it("keeps saving true until the last of two overlapping commands finishes", async () => {
    const resolvers: Array<(response: Response) => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        init?.method === "POST" ? new Promise<Response>((resolve) => resolvers.push(resolve)) : okState()
      )
    );
    const portal = mount();
    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    act(() => {
      first = portal()
        .recalculate()
        .catch(() => undefined);
      second = portal()
        .recalculate()
        .catch(() => undefined);
    });
    // Commands are sent one at a time, in press order: the second waits for the first's answer.
    await waitFor(() => expect(resolvers.length).toBe(1));
    const fail = { ok: false, status: 500, json: () => Promise.resolve({ error: "nope" }) } as unknown as Response;
    await act(async () => {
      resolvers[0]!(fail);
      await first;
    });
    await waitFor(() => expect(resolvers.length).toBe(2));
    expect(portal().saving).toBe(true);
    await act(async () => {
      resolvers[1]!(fail);
      await second;
    });
    expect(portal().saving).toBe(false);
  });

  it("ignores a status poll that began before a save but answers after the save's response", async () => {
    const settled = {
      lastSuccessfulAt: "2026-08-30T09:00:00.000Z",
      validUntil: "2026-08-30T11:00:00.000Z",
      stale: false,
      awaitingRecalculation: false,
      openJob: null,
      lastFinishedStatus: "succeeded"
    };
    const saved = JSON.parse(JSON.stringify(createSeedState(new Date("2026-08-30T09:30:00.000Z"))));
    saved.planning = { ...saved.planning, awaitingRecalculation: true };
    const jsonOf = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
    let statusCalls = 0;
    let answerOldPoll!: () => void;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        if (init?.method === "POST") return jsonOf({ state: saved });
        if (url === "/api/planning/status") {
          statusCalls += 1;
          // The second poll is the one that read the plan before the save and is slow to answer.
          if (statusCalls === 2)
            return new Promise<Response>((resolve) => {
              answerOldPoll = () => resolve({ ok: true, json: () => Promise.resolve(settled) } as Response);
            });
          return jsonOf(settled);
        }
        return okState();
      })
    );
    const portal = mount();
    await waitFor(() => expect(portal().planHealth).not.toBeNull());

    // A freshness check in a new minute starts the poll that will answer late.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5 * 60_000);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(statusCalls).toBe(2));

    await act(async () => {
      await portal().recalculate();
    });
    expect(portal().planHealth?.updating).toBe(true);

    await act(async () => {
      answerOldPoll();
    });
    expect(portal().planHealth?.updating).toBe(true);
  });
});
