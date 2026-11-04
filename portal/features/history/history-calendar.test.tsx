// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@/test/render";
import type { PortalState } from "@/state/portal-state";
import { OLDER_THAN_WINDOW_NOTICE } from "./calendar-model";
import { HistoryCalendar } from "./history-calendar";

const TZ = "Australia/Melbourne";
// Monday 5 Oct 2026, 13:00 in Melbourne. The 30-day session window therefore starts on 2026-09-05.
const NOW = new Date("2026-10-05T02:00:00Z");

const stateWith = (patch: Partial<PortalState> = {}): PortalState =>
  ({
    completedToday: [],
    sleepPlans: [],
    occurrences: [],
    spans: [],
    actions: [],
    settings: { timezone: TZ },
    ...patch
  }) as unknown as PortalState;

const session = (id: string, endedAt: string, actionTitle: string) =>
  ({
    id,
    actionId: "a1",
    actionTitle,
    result: "completed",
    startedAt: endedAt,
    endedAt,
    plannedMinutes: 30,
    activeMinutes: 25,
    remainingBeforeMinutes: 0,
    remainingAfterMinutes: 0
  }) as PortalState["completedToday"][number];

const days = () => screen.getAllByRole("listitem").filter((li) => li.classList.contains("history-cal-day"));

beforeEach(() => {
  // Only Date is faked: Testing Library's timers and React's scheduling stay real.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("HistoryCalendar", () => {
  it("starts on the current week, and the Week/Month toggle swaps the grid and aria-pressed", () => {
    render(<HistoryCalendar state={stateWith()} />);
    const week = screen.getByRole("button", { name: "Week" });
    const month = screen.getByRole("button", { name: "Month" });
    expect(week.getAttribute("aria-pressed")).toBe("true");
    expect(month.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("5 Oct – 11 Oct 2026")).toBeTruthy();
    expect(days()).toHaveLength(7);
    expect(document.querySelector(".history-cal-grid.week")).not.toBeNull();

    fireEvent.click(month);
    expect(month.getAttribute("aria-pressed")).toBe("true");
    expect(week.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("October 2026")).toBeTruthy();
    expect(days()).toHaveLength(35);
    expect(document.querySelector(".history-cal-grid.month")).not.toBeNull();

    fireEvent.click(week);
    expect(week.getAttribute("aria-pressed")).toBe("true");
    expect(days()).toHaveLength(7);
  });

  it("marks today's cell", () => {
    render(<HistoryCalendar state={stateWith()} />);
    const today = days().filter((li) => li.classList.contains("today"));
    expect(today).toHaveLength(1);
    expect(today[0]!.getAttribute("aria-label")).toBe("Monday 5 October");
  });

  it("moves the period with Previous and Next, and Today returns to the current one", () => {
    render(<HistoryCalendar state={stateWith()} />);
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(screen.getByText(/^28 Sept? – 4 Oct 2026$/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("12 Oct – 18 Oct 2026")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(screen.getByText("5 Oct – 11 Oct 2026")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Month" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("November 2026")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(screen.getByText("September 2026")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(screen.getByText("October 2026")).toBeTruthy();
  });

  it("draws a span as a band with its title and daily window label", () => {
    render(
      <HistoryCalendar
        state={stateWith({
          spans: [
            {
              id: "trip",
              title: "Conference",
              startDate: "2026-10-06",
              endDate: "2026-10-08",
              window: { localStartTime: "09:00", localEndTime: "17:30" }
            }
          ] as PortalState["spans"]
        })}
      />
    );
    const bands = screen.getByRole("list", { name: "Spans" });
    const band = within(bands).getAllByRole("listitem")[0]!;
    expect(band.className).toContain("history-cal-band");
    expect(within(band).getByText("Conference")).toBeTruthy();
    expect(band.textContent).toContain("09:00–17:30");
    // Tuesday to Thursday: grid columns 2 to 4, i.e. "2 / 5".
    expect(band.style.gridColumn).toBe("2 / 5");
    expect(screen.getByRole("list", { name: "Spans in view" }).textContent).toContain(
      "Conference: 2026-10-06 to 2026-10-08, 09:00–17:30 each day"
    );
  });

  it("shows a night logged by hand as sleep with its hours on the day it ended", () => {
    render(
      <HistoryCalendar
        state={stateWith({
          sleepPlans: [
            {
              id: "n1",
              status: "completed",
              manual: true,
              actualStartAt: "2026-10-05T11:00:00Z",
              actualWakeAt: "2026-10-05T18:42:00Z"
            }
          ] as PortalState["sleepPlans"]
        })}
      />
    );
    const tuesday = days().find((li) => li.getAttribute("aria-label") === "Tuesday 6 October")!;
    expect(within(tuesday).getByText("Slept 7.7h · logged by hand")).toBeTruthy();
    expect(tuesday.textContent).toContain("Sleep: ");
  });

  it("draws no band area for a span outside the viewed week", () => {
    render(
      <HistoryCalendar
        state={stateWith({
          spans: [
            { id: "later", title: "Later trip", startDate: "2026-10-20", endDate: "2026-10-21" }
          ] as PortalState["spans"]
        })}
      />
    );
    expect(screen.queryByRole("list", { name: "Spans" })).toBeNull();
    expect(screen.queryByText("Later trip")).toBeNull();
  });

  it("shows no older-than-window notice or Not kept labels inside the 30-day window", () => {
    render(<HistoryCalendar state={stateWith()} />);
    expect(screen.queryByText(`${OLDER_THAN_WINDOW_NOTICE}.`)).toBeNull();
    expect(screen.queryByText("Not kept")).toBeNull();
  });

  it("says old sessions are not kept and labels each empty in-range day before the window", () => {
    render(<HistoryCalendar state={stateWith()} />);
    fireEvent.click(screen.getByRole("button", { name: "Month" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(screen.getByText("September 2026")).toBeTruthy();
    expect(screen.getByText("Sessions older than 30 days are not kept in this view.")).toBeTruthy();
    // 1-4 Sep are in September and before the window (which starts 5 Sep); padded 31 Aug is out of range.
    expect(screen.getAllByText("Not kept")).toHaveLength(4);
    const first = days().find((li) => li.getAttribute("aria-label") === "Tuesday 1 September")!;
    expect(within(first).getByText("Not kept")).toBeTruthy();
    const kept = days().find((li) => li.getAttribute("aria-label") === "Saturday 5 September")!;
    expect(within(kept).queryByText("Not kept")).toBeNull();
    const padding = days().find((li) => li.getAttribute("aria-label") === "Monday 31 August")!;
    expect(padding.classList.contains("outside")).toBe(true);
    expect(within(padding).queryByText("Not kept")).toBeNull();
  });

  it("does not label a day before the window as Not kept when it still has an entry", () => {
    render(
      <HistoryCalendar
        state={stateWith({
          occurrences: [
            { id: "o1", actionId: "a1", windowName: "Morning", localDate: "2026-09-02", status: "completed" }
          ] as PortalState["occurrences"],
          actions: [{ id: "a1", title: "Stretch" }] as PortalState["actions"]
        })}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Month" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    const day = days().find((li) => li.getAttribute("aria-label") === "Wednesday 2 September")!;
    expect(within(day).queryByText("Not kept")).toBeNull();
    expect(day.textContent).toContain("Stretch · Morning");
    expect(screen.getAllByText("Not kept")).toHaveLength(3);
  });

  it("shows a session on the day it ended, in the person's timezone", () => {
    // 2026-10-06T23:30Z is 10:30 on Wednesday 7 Oct in Melbourne (UTC+11).
    render(
      <HistoryCalendar
        state={stateWith({
          completedToday: [session("s1", "2026-10-06T23:30:00Z", "Write report")]
        })}
      />
    );
    const day = days().find((li) => li.getAttribute("aria-label") === "Wednesday 7 October")!;
    const entry = within(day).getByText("Write report");
    expect(entry.className).toContain("session");
    expect(entry.textContent).toContain("Session: ");
    expect(entry.getAttribute("title")).toBe("25 min · completed · ends 10:30 am");
    expect(within(day).queryByText("Not kept")).toBeNull();
    expect(screen.getAllByText("Write report")).toHaveLength(1);
  });
});
