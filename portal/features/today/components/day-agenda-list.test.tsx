// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import type { DayPlan, DayPlanItem, DayPlanWait } from "@/features/today/day-plan";
import { zonedDayBounds } from "@/features/today/local-datetime";
import { DayAgendaList } from "./day-agenda-list";

const TZ = "Australia/Sydney";
const at = (value: string) => new Date(value);
const bounds = zonedDayBounds("2026-08-19", TZ);

const item = (overrides: Partial<DayPlanItem> & Pick<DayPlanItem, "id" | "kind" | "title">): DayPlanItem => ({
  source: "fixed",
  entityId: overrides.id,
  startsAt: at("2026-08-19T04:00:00.000Z"),
  endsAt: at("2026-08-19T05:00:00.000Z"),
  clippedStart: false,
  clippedEnd: false,
  ...overrides
});

const basePlan: DayPlan = {
  bounds,
  nowAt: null,
  items: [],
  reserved: [],
  backgrounds: [],
  lines: [],
  locations: [],
  waits: [],
  untimed: [],
  displaced: [],
  calculatedAt: at("2026-08-19T00:00:00.000Z")
};

describe("DayAgendaList", () => {
  it("names the leave-by time on a travel row, from the block's own start", () => {
    const plan: DayPlan = {
      ...basePlan,
      items: [
        item({
          id: "t",
          kind: "travel",
          source: "engine",
          title: "Drive to Campus",
          subtitle: "18 min",
          startsAt: at("2026-08-19T03:15:00.000Z"), // 1:15 pm local
          endsAt: at("2026-08-19T04:00:00.000Z") // 2:00 pm local
        })
      ]
    };
    render(<DayAgendaList plan={plan} timezone={TZ} showReserved={false} onSelect={() => {}} />);
    expect(screen.getByText("Travel · 18 min · Leave by 1:15 pm")).toBeTruthy();
  });

  it("leaves a non-travel row's subtitle exactly as it was", () => {
    const plan: DayPlan = {
      ...basePlan,
      items: [item({ id: "c", kind: "commitment", title: "Dentist", subtitle: "Town" })]
    };
    render(<DayAgendaList plan={plan} timezone={TZ} showReserved={false} onSelect={() => {}} />);
    expect(screen.getByText("Town")).toBeTruthy();
  });

  it("chips a commitment the projection could give no journey figure for", () => {
    const plan: DayPlan = {
      ...basePlan,
      items: [
        item({ id: "dentist", kind: "commitment", title: "Dentist", subtitle: "Town", travelGap: "no_place" }),
        item({ id: "college", kind: "commitment", title: "College", subtitle: "Campus", travelGap: "no_estimate" }),
        item({ id: "gym", kind: "commitment", title: "Gym", subtitle: "Home gym" })
      ]
    };
    render(<DayAgendaList plan={plan} timezone={TZ} showReserved={false} onSelect={() => {}} />);
    expect(screen.getByText("no place set")).toBeTruthy();
    expect(screen.getByText("travel time is a guess")).toBeTruthy();
    expect(screen.queryByText("Gym")?.closest("li")?.textContent).not.toContain("no travel");
  });

  it("shows each wait as its own row, styled like a window row, tappable when onSelectWait is given", () => {
    const wait: DayPlanWait = {
      id: "wait:wash",
      stepId: "wash",
      title: "Wash · ready 09:35",
      anchorTitle: "Work",
      running: false,
      startsAt: at("2026-08-19T09:05:00.000Z"),
      endsAt: at("2026-08-19T09:35:00.000Z")
    };
    const onSelectWait = vi.fn();
    render(
      <DayAgendaList
        plan={{ ...basePlan, waits: [wait] }}
        timezone={TZ}
        showReserved={false}
        onSelect={() => {}}
        onSelectWait={onSelectWait}
      />
    );
    const row = screen.getByText(/Waiting · Wash until/).closest("li")!;
    expect(row.className).toContain("day-agenda-row-window");
    expect(row.className).toContain("day-agenda-row-wait");
    fireEvent.click(screen.getByRole("button", { name: /Waiting · Wash until/ }));
    expect(onSelectWait).toHaveBeenCalledWith(wait);
  });

  it("names a running wait's own state, and renders it read-only without onSelectWait", () => {
    const wait: DayPlanWait = {
      id: "wait:wash",
      stepId: "wash",
      title: "Wash · ready 09:35",
      anchorTitle: "Work",
      running: true,
      startsAt: at("2026-08-19T09:05:00.000Z"),
      endsAt: at("2026-08-19T09:35:00.000Z")
    };
    render(
      <DayAgendaList plan={{ ...basePlan, waits: [wait] }} timezone={TZ} showReserved={false} onSelect={() => {}} />
    );
    expect(screen.getByText("running")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Waiting · Wash until/ })).toBeNull();
  });

  it("rows a leave-by marker at its own time, without a from–till range", () => {
    const marker = item({
      id: "lb",
      kind: "leave_by",
      source: "engine",
      title: "Leave by 13:38 for Dentist",
      subtitle: "usually 22 min · allowing 28",
      marker: true,
      startsAt: at("2026-08-19T03:38:00.000Z"),
      endsAt: at("2026-08-19T03:38:00.000Z")
    });
    render(
      <DayAgendaList plan={{ ...basePlan, items: [marker] }} timezone={TZ} showReserved={false} onSelect={() => {}} />
    );
    const row = screen.getByRole("button", { name: /Leave by 13:38 for Dentist/ });
    expect(row.querySelector(".day-agenda-time")!.textContent).toBe("1:38 pm");
    expect(screen.getByText("usually 22 min · allowing 28")).toBeTruthy();
  });

  it("rows a soft cadence placement as room, not a session, only when showReserved is on", () => {
    const soft = item({
      id: "soft-gym",
      kind: "soft",
      source: "engine",
      title: "Gym",
      subtitle: "2 of 3 fit this week",
      startsAt: at("2026-08-19T07:00:00.000Z"),
      endsAt: at("2026-08-19T07:30:00.000Z")
    });
    const { rerender } = render(
      <DayAgendaList plan={{ ...basePlan, reserved: [soft] }} timezone={TZ} showReserved={false} onSelect={() => {}} />
    );
    expect(screen.queryByText(/2 of 3 fit this week/)).toBeNull();
    rerender(<DayAgendaList plan={{ ...basePlan, reserved: [soft] }} timezone={TZ} showReserved onSelect={() => {}} />);
    expect(screen.getByText("2 of 3 fit this week · not held for anyone")).toBeTruthy();
  });

  it("opens the selected item's block on a click", () => {
    const onSelect = vi.fn();
    const dentist = item({ id: "c", kind: "commitment", title: "Dentist", subtitle: "Town" });
    render(
      <DayAgendaList plan={{ ...basePlan, items: [dentist] }} timezone={TZ} showReserved={false} onSelect={onSelect} />
    );
    fireEvent.click(screen.getByRole("button", { name: /Dentist/ }));
    expect(onSelect).toHaveBeenCalledWith(dentist);
  });

  describe("foldPast", () => {
    const plan: DayPlan = {
      ...basePlan,
      nowAt: at("2026-08-19T00:30:00.000Z"), // 10:30 am local
      items: [
        item({
          id: "a",
          kind: "routine_step",
          title: "Shower",
          startsAt: at("2026-08-18T20:00:00.000Z"),
          endsAt: at("2026-08-18T20:30:00.000Z")
        }),
        item({
          id: "b",
          kind: "routine_step",
          title: "Breakfast",
          startsAt: at("2026-08-18T21:00:00.000Z"),
          endsAt: at("2026-08-18T21:30:00.000Z")
        }),
        item({
          id: "c",
          kind: "commitment",
          title: "Dentist",
          startsAt: at("2026-08-19T00:00:00.000Z"),
          endsAt: at("2026-08-19T01:00:00.000Z")
        })
      ]
    };

    it("folds rows that have ended into one line and opens them on request", () => {
      render(<DayAgendaList plan={plan} timezone={TZ} showReserved={false} foldPast onSelect={() => {}} />);
      expect(screen.queryByText("Shower")).toBeNull();
      expect(screen.getByText("Dentist")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "2 earlier today" }));
      expect(screen.getByText("Shower")).toBeTruthy();
      expect(screen.getByText("Breakfast")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Hide earlier" }));
      expect(screen.queryByText("Shower")).toBeNull();
    });

    it("leaves the list whole without the flag, on another day, or for a single past row", () => {
      const { rerender } = render(<DayAgendaList plan={plan} timezone={TZ} showReserved={false} onSelect={() => {}} />);
      expect(screen.getByText("Shower")).toBeTruthy();
      rerender(
        <DayAgendaList
          plan={{ ...plan, nowAt: null }}
          timezone={TZ}
          showReserved={false}
          foldPast
          onSelect={() => {}}
        />
      );
      expect(screen.getByText("Shower")).toBeTruthy();
      rerender(
        <DayAgendaList
          plan={{ ...plan, items: [plan.items[0]!, plan.items[2]!] }}
          timezone={TZ}
          showReserved={false}
          foldPast
          onSelect={() => {}}
        />
      );
      expect(screen.getByText("Shower")).toBeTruthy();
      expect(screen.queryByText(/earlier today/)).toBeNull();
    });
  });
});
