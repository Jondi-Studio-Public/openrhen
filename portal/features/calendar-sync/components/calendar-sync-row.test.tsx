// @vitest-environment jsdom
import "@/test/example-calendar-sources";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { resetCalendarReviewCount } from "../calendar-review-count";
import { CalendarSyncRow } from "./calendar-sync-row";

afterEach(() => {
  vi.unstubAllGlobals();
  resetCalendarReviewCount();
});

const run = {
  startedAt: "2026-09-29T01:00:00.000Z",
  finishedAt: "2026-09-29T01:00:02.000Z",
  trigger: "scheduled",
  status: "needs_review",
  summary: {
    status: "needs_review",
    provider: "google_calendar",
    eventCount: 12,
    updated: 2,
    deleted: 1,
    heldForReview: 4
  }
};

describe("CalendarSyncRow", () => {
  it("shows the last run and what it held for review", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ lastRun: run }) }))
    );
    render(<CalendarSyncRow provider="google_calendar" />);
    expect(await screen.findByText(/scheduled · needs_review/)).toBeTruthy();
    expect(screen.getByText(/12 events read, 2 updated, 1 removed, 4 waiting for review/)).toBeTruthy();
  });

  it("shows a failed run's message", async () => {
    const failed = { ...run, status: "failed", summary: { status: "failed", message: "Token revoked" } };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ lastRun: failed }) }))
    );
    render(<CalendarSyncRow provider="google_calendar" />);
    expect(await screen.findByText("Token revoked")).toBeTruthy();
  });

  it("posts a manual sync to the provider's route and reloads the last run", async () => {
    const fetchMock = vi.fn((_url: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(init?.method === "POST" ? {} : { lastRun: null })
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<CalendarSyncRow provider="google_calendar" />);
    await screen.findByText(/No sync has run yet/);
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await vi.waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
      expect(String(post?.[0])).toBe("/api/connections/google_calendar/sync");
      expect(JSON.parse(String(post?.[1]?.body))).toEqual({ trigger: "manual" });
    });
  });

  it("tolerates a missing Example Shared sync route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }))
    );
    render(<CalendarSyncRow provider="example_shared" />);
    expect(await screen.findByText("Sync history is not available yet.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Sync now" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says plainly that sync is off and keeps the setting name in the code box", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ enabled: false }) }))
    );
    render(<CalendarSyncRow provider="google_calendar" />);
    const line = await screen.findByText("Sync is off for this calendar.");
    expect(line.textContent).not.toMatch(/CALENDAR_SYNC_PROVIDERS/);
    expect(screen.getByText("CALENDAR_SYNC_PROVIDERS").tagName).toBe("CODE");
    expect((screen.getByRole("button", { name: "Sync now" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables Sync now with a reason when the provider is not set up", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ lastRun: null }) }))
    );
    render(<CalendarSyncRow provider="example_shared" notSetUp />);
    expect(await screen.findByText(/Not set up yet, so there is nothing to sync/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Sync now" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
