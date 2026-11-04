// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import "@/test/render";
import { createSeedState } from "./portal-state";
import { PortalProvider, usePortal } from "./portal-provider";

/**
 * A snapshot replay freezes the process-wide clock (`freezeClock` has no inverse), so it lives in its
 * own file rather than leaking a frozen clock into the live-data suites in `portal-provider.test.tsx`.
 */
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/");
});

describe("PortalProvider snapshot replay", () => {
  it("leaves the replayed state alone when the browser comes back online", async () => {
    window.history.pushState({}, "", "/?snapshot=abc&source=server");
    const seed = createSeedState();
    const captured = { ...seed, settings: { ...seed.settings, timezone: "Europe/Paris" } };
    const live = { ...seed, settings: { ...seed.settings, timezone: "Asia/Tokyo" } };
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith("/api/snapshots/"))
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              id: "abc",
              description: "",
              capturedAt: new Date().toISOString(),
              warnings: [],
              client: { state: captured, observedAt: new Date().toISOString() },
              server: { state: captured }
            })
        } as Response);
      if (url === "/api/state")
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ state: live }) } as Response);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
    function Probe() {
      return <span data-testid="timezone">{usePortal().state.settings.timezone}</span>;
    }
    const view = render(
      <PortalProvider>
        <Probe />
      </PortalProvider>
    );
    await waitFor(() => expect(view.getByTestId("timezone").textContent).toBe("Europe/Paris"));

    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    expect(view.getByTestId("timezone").textContent).toBe("Europe/Paris");
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/state")).toHaveLength(0);
  });

  it("refuses a close or restore while replaying, without sending anything", async () => {
    window.history.pushState({}, "", "/?snapshot=abc&source=server");
    const seed = createSeedState();
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            url.startsWith("/api/snapshots/")
              ? {
                  id: "abc",
                  description: "",
                  capturedAt: new Date().toISOString(),
                  warnings: [],
                  client: { state: seed, observedAt: new Date().toISOString() },
                  server: { state: seed }
                }
              : {}
          )
      } as Response)
    );
    vi.stubGlobal("fetch", fetchMock);
    let latest!: ReturnType<typeof usePortal>;
    function Probe() {
      latest = usePortal();
      return <span data-testid="ready">{String(latest.ready)}</span>;
    }
    const view = render(
      <PortalProvider>
        <Probe />
      </PortalProvider>
    );
    await waitFor(() => expect(view.getByTestId("ready").textContent).toBe("true"));
    let caught: unknown;
    await act(async () => {
      caught = await latest
        .closeEntityCommand({ type: "action", id: "a1", verb: "cancel", do: "close", expectedVersion: 1 })
        .catch((error: unknown) => error);
    });
    expect((caught as Error).message).toMatch(/read-only replay/);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/commands/close")).toHaveLength(0);
  });
});
