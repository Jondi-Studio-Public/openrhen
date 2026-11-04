// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import "@/test/render";
import { EXAMPLE_SHARED } from "@/test/example-calendar-sources";
import { calendarSourceConnections, connectionManifest, primarySourceConnection } from "@openrhen/contracts";
import {
  invalidateConnectionLapses,
  LAPSES_RETRY_MS,
  LAPSES_REFRESH_MS,
  resetConnectionLapses,
  useConnectionLapses
} from "./connection-lapses";

function Probe() {
  const { lapsed, ready } = useConnectionLapses();
  return <p>{ready ? lapsed.map((item) => item.label).join(",") || "none" : "loading"}</p>;
}

// The primary (roster) source and a secondary source, whichever this build registers; one read per calendar source.
const primary = primarySourceConnection()!;
const secondary = connectionManifest(EXAMPLE_SHARED)!;
const READS = calendarSourceConnections().length;
const rosterLapse = `${primary.label} roster hasn't synced lately`;

let rosterStatus = "synced";
const defaultFetch = (url: string) =>
  Promise.resolve({
    ok: true,
    json: () =>
      Promise.resolve({
        lastRun: url.includes(`/${primary.id}/`)
          ? { status: rosterStatus, summary: { reason: "session_expired" } }
          : null
      })
  } as Response);
const fetchMock = vi.fn(defaultFetch);

beforeEach(() => {
  rosterStatus = "synced";
  fetchMock.mockClear();
  resetConnectionLapses();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockImplementation(defaultFetch);
});

describe("useConnectionLapses", () => {
  it("times the next read from when the last one completed, so request latency cannot skip a beat", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // Every answer takes 20 seconds to arrive.
      fetchMock.mockImplementation(
        (url: string) => new Promise((resolve) => setTimeout(() => resolve(defaultFetch(url)), 20_000))
      );
      render(<Probe />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(21_000);
      });
      expect(fetchMock).toHaveBeenCalledTimes(READS);
      // Completed at ~20s, so it expires at ~5m20s, not at 5m00s.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(LAPSES_REFRESH_MS - 30_000);
      });
      expect(fetchMock).toHaveBeenCalledTimes(READS);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(40_000);
      });
      expect(fetchMock).toHaveBeenCalledTimes(READS * 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tries again after a minute when part of a read failed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fetchMock.mockImplementation((url: string) =>
        url.includes(`/${secondary.id}/`) ? Promise.reject(new TypeError("down")) : defaultFetch(url)
      );
      render(<Probe />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(fetchMock).toHaveBeenCalledTimes(READS);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(LAPSES_RETRY_MS + 1000);
      });
      expect(fetchMock).toHaveBeenCalledTimes(READS * 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not lose a sync command that lands while a read is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    fetchMock.mockImplementationOnce(async (url: string) => {
      // The answer is fixed when it is given (a "synced" run), and only delivered later.
      const body = await (await defaultFetch(url)).json();
      await gate;
      return { ok: true, json: () => Promise.resolve(body) } as Response;
    });
    render(<Probe />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(READS));
    // The sync fails now; the read already in flight will answer with the old "synced" record.
    rosterStatus = "failed";
    act(() => invalidateConnectionLapses());
    await act(async () => release());
    await waitFor(() => expect(screen.getByText(rosterLapse)).toBeTruthy());
  });

  it("keeps what it knew when a refresh cannot be read, rather than reporting everything fine", async () => {
    rosterStatus = "failed";
    render(<Probe />);
    await waitFor(() => expect(screen.getByText(rosterLapse)).toBeTruthy());
    fetchMock.mockImplementation(() => Promise.reject(new TypeError("Failed to fetch")));
    act(() => invalidateConnectionLapses());
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(READS * 2));
    await act(async () => {});
    expect(screen.getByText(rosterLapse)).toBeTruthy();
  });

  it("reads the three recorded runs once for every caller on the page", async () => {
    render(
      <>
        <Probe />
        <Probe />
      </>
    );
    await waitFor(() => expect(screen.getAllByText("none")).toHaveLength(2));
    expect(fetchMock).toHaveBeenCalledTimes(READS);
  });

  it("a page left open picks up a sync that fails later, on the five-minute beat and when the tab is looked at", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<Probe />);
      await waitFor(() => expect(screen.getByText("none")).toBeTruthy());
      rosterStatus = "failed";
      await act(async () => {
        await vi.advanceTimersByTimeAsync(LAPSES_REFRESH_MS + 1000);
      });
      await waitFor(() => expect(screen.getByText(rosterLapse)).toBeTruthy());

      // Recovered since; nothing is stale yet, so only a five-minute-old read refreshes on visibility.
      rosterStatus = "synced";
      await act(async () => {
        await vi.advanceTimersByTimeAsync(LAPSES_REFRESH_MS - 1000);
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await waitFor(() => expect(screen.getByText("none")).toBeTruthy());
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads again after a sync command invalidates what it knew", async () => {
    render(<Probe />);
    await waitFor(() => expect(screen.getByText("none")).toBeTruthy());
    rosterStatus = "failed";
    act(() => invalidateConnectionLapses());
    await waitFor(() => expect(screen.getByText(rosterLapse)).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(READS * 2);
  });
});
