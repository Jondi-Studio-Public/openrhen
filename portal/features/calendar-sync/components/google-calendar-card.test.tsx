// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { resetCalendarReviewCount } from "../calendar-review-count";
import { GoogleCalendarCard } from "./google-calendar-card";

afterEach(() => {
  vi.unstubAllGlobals();
  resetCalendarReviewCount();
});

const calendars = [
  {
    calendarId: "jon@example.com",
    summary: "Jon",
    primary: true,
    accessRole: "owner",
    timezone: "Australia/Sydney",
    selected: true
  },
  {
    calendarId: "holidays",
    summary: "Holidays in Australia",
    primary: false,
    accessRole: "reader",
    timezone: "UTC",
    selected: false
  }
];

function stubFetch(overrides: Record<string, () => unknown> = {}) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const key = `${init?.method ?? "GET"} ${url}`;
    const handler = overrides[key];
    if (handler) return Promise.resolve(handler());
    if (url.endsWith("/proof"))
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ status: "connected", checkedAt: "2026-09-29T01:00:00.000Z", calendarCount: 2 })
      });
    if (url.endsWith("/calendars"))
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(init?.method === "PUT" ? { calendars } : { calendars })
      });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ lastRun: null }) });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("GoogleCalendarCard", () => {
  it("shows the proof status and the calendar list with saved ticks", async () => {
    stubFetch();
    render(<GoogleCalendarCard />);
    expect(await screen.findByText("Connected")).toBeTruthy();
    expect(((await screen.findByRole("checkbox", { name: /Jon/ })) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: /Holidays/ }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole("button", { name: "Sync now" })).toBeTruthy();
  });

  it("saves the ticked calendars with PUT", async () => {
    const fetchMock = stubFetch();
    render(<GoogleCalendarCard />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /Holidays/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save choice" }));
    await screen.findByText(/Saved\. The sync reads 2 calendars/);
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(JSON.parse(String(put[1]?.body))).toEqual({
      calendars: [
        { calendarId: "jon@example.com", summary: "Jon", selected: true },
        { calendarId: "holidays", summary: "Holidays in Australia", selected: true }
      ]
    });
  });

  it("keeps Save disabled until a choice changes", async () => {
    stubFetch();
    render(<GoogleCalendarCard />);
    await screen.findByRole("checkbox", { name: /Jon/ });
    expect((screen.getByRole("button", { name: "Save choice" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("reports a failed proof and falls back to the saved choices when Google cannot be listed", async () => {
    stubFetch({
      "GET /api/connections/google_calendar/proof": () => ({
        ok: false,
        json: () =>
          Promise.resolve({
            status: "failed",
            checkedAt: "2026-09-29T01:00:00.000Z",
            message: "Google refused the refresh token.",
            reason: "invalid_grant"
          })
      }),
      "GET /api/connections/google_calendar/calendars": () => ({
        ok: false,
        json: () => Promise.resolve({ error: "Google unreachable", calendars: [calendars[0]] })
      })
    });
    render(<GoogleCalendarCard />);
    expect(await screen.findByText("Could not connect")).toBeTruthy();
    expect(screen.getByText("Google refused the refresh token.")).toBeTruthy();
    expect(await screen.findByText(/Google unreachable Showing the calendars saved earlier/)).toBeTruthy();
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  });

  it("names the missing settings when not configured", async () => {
    stubFetch({
      "GET /api/connections/google_calendar/proof": () => ({
        ok: true,
        json: () => Promise.resolve({ status: "not_configured", missing: ["GOOGLE_CALENDAR_REFRESH_TOKEN"] })
      })
    });
    render(<GoogleCalendarCard />);
    expect(await screen.findByText("GOOGLE_CALENDAR_REFRESH_TOKEN")).toBeTruthy();
  });

  it("treats a not-configured calendars answer as a state: no error line, no list", async () => {
    stubFetch({
      "GET /api/connections/google_calendar/proof": () => ({
        ok: true,
        json: () => Promise.resolve({ status: "not_configured", missing: ["OUTBOUND_PROXY_URL"] })
      }),
      "GET /api/connections/google_calendar/calendars": () => ({
        ok: true,
        json: () => Promise.resolve({ calendars: [], notConfigured: true })
      })
    });
    render(<GoogleCalendarCard />);
    expect(await screen.findByText(/Not set up yet, so there are no calendars to choose from/)).toBeTruthy();
    expect(screen.queryByText(/Showing the calendars saved earlier/)).toBeNull();
    expect((screen.getByRole("button", { name: "Sync now" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Test again" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
