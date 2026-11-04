// @vitest-environment jsdom
import "@/test/example-calendar-sources";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@/test/render";
import type { EventSourceLike } from "@/state/live-updates";
import {
  refreshCalendarReviewCount,
  resetCalendarReviewCount,
  useCalendarReviewCount,
  useCalendarReviewCountRefresh
} from "./calendar-review-count";

function respond(body: unknown, ok = true) {
  return vi.fn(() => Promise.resolve({ ok, json: () => Promise.resolve(body) }));
}

const factory = () => source;

function Probe() {
  useCalendarReviewCountRefresh(factory);
  const review = useCalendarReviewCount();
  return <p>total {review.total}</p>;
}

let source: EventSourceLike & { emit: (type: string, data?: unknown) => void };

beforeEach(() => {
  resetCalendarReviewCount();
  const listeners = new Map<string, (event: MessageEvent) => void>();
  source = {
    close: vi.fn(),
    onerror: null,
    addEventListener: (type, listener) => void listeners.set(type, listener),
    emit: (type, data) => listeners.get(type)?.({ data: JSON.stringify(data ?? {}) } as MessageEvent)
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("calendar review count", () => {
  it("reads the per-provider counts and held batch ids", async () => {
    vi.stubGlobal(
      "fetch",
      respond({
        counts: { google_calendar: 3, example_shared: 1 },
        batchIds: { google_calendar: "b1", example_shared: "b2" },
        total: 4
      })
    );
    render(<Probe />);
    expect(await screen.findByText("total 4")).toBeTruthy();
  });

  it("keeps the last known count when a refresh fails", async () => {
    vi.stubGlobal("fetch", respond({ counts: { google_calendar: 2, example_shared: 0 }, batchIds: {}, total: 2 }));
    render(<Probe />);
    await screen.findByText("total 2");
    vi.stubGlobal("fetch", respond({ error: "down" }, false));
    await act(() => refreshCalendarReviewCount());
    expect(screen.getByText("total 2")).toBeTruthy();
  });

  it("refreshes when a live event arrives", async () => {
    vi.useFakeTimers();
    const fetchMock = respond({ counts: { google_calendar: 0, example_shared: 0 }, batchIds: {}, total: 0 });
    vi.stubGlobal("fetch", fetchMock);
    render(<Probe />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const before = fetchMock.mock.calls.length;
    fetchMock.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            counts: { google_calendar: 5, example_shared: 0 },
            batchIds: { google_calendar: "b" },
            total: 5
          })
      })
    );
    await act(async () => {
      source.emit("changed", { kind: "state", at: "now" });
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(fetchMock.mock.calls.length).toBe(before + 1);
    expect(screen.getByText("total 5")).toBeTruthy();
  });

  it("does not refetch on a focus within a minute of the last fetch", async () => {
    const fetchMock = respond({ counts: { google_calendar: 0, example_shared: 0 }, batchIds: {}, total: 0 });
    vi.stubGlobal("fetch", fetchMock);
    render(<Probe />);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
