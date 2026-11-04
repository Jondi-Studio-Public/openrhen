// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import type { DayPlan, DayPlanItem } from "@/features/today/day-plan";
import { zonedDayBounds } from "@/features/today/local-datetime";
import type { TomorrowBrief } from "@/features/today/tomorrow-preview";
import { DayPlanCard } from "./day-plan-card";

const TZ = "Australia/Sydney";
const at = (value: string) => new Date(value);
const bounds = zonedDayBounds("2026-08-19", TZ);
const NOW = at("2026-08-19T00:00:00.000Z");
const block: DayPlanItem = {
  id: "c",
  kind: "commitment",
  source: "fixed",
  title: "Dentist",
  entityId: "c",
  startsAt: at("2026-08-19T04:00:00.000Z"),
  endsAt: at("2026-08-19T05:00:00.000Z"),
  clippedStart: false,
  clippedEnd: false
};
const reserved: DayPlanItem = {
  ...block,
  id: "r",
  kind: "reserved",
  source: "reserved",
  title: "Reconcile",
  entityId: "a"
};
const projected: DayPlanItem = {
  ...block,
  id: "plan:a1:2026-08-19T01:00:00.000Z",
  kind: "planned",
  source: "engine",
  title: "Write the intro",
  entityId: "a1",
  projected: true,
  startsAt: at("2026-08-19T01:00:00.000Z"),
  endsAt: at("2026-08-19T02:00:00.000Z")
};
const plan: DayPlan = {
  bounds,
  nowAt: NOW,
  items: [block],
  reserved: [reserved],
  backgrounds: [],
  lines: [],
  locations: [],
  waits: [],
  untimed: [],
  displaced: [],
  calculatedAt: null
};
// Thursday 20 August 2026 in the seed zone: 2026-08-19T14:00Z to 2026-08-20T14:00Z.
const tomorrowBounds = zonedDayBounds("2026-08-20", TZ);
const tomorrow: { plan: DayPlan; brief: TomorrowBrief } = {
  plan: {
    ...plan,
    bounds: tomorrowBounds,
    // Tomorrow never carries a now-line: now is on the day before.
    nowAt: null,
    items: [
      {
        ...block,
        id: "commitment:standup",
        title: "Standup",
        startsAt: at("2026-08-19T23:00:00.000Z"),
        endsAt: at("2026-08-20T00:00:00.000Z")
      }
    ],
    reserved: []
  },
  brief: {
    dayKey: "2026-08-20",
    bounds: tomorrowBounds,
    sleep: null,
    firstCommitment: {
      id: "standup",
      title: "Standup",
      startsAt: at("2026-08-19T23:00:00.000Z"),
      startsBeforeDay: false
    },
    commitments: 1,
    preparationSteps: 0,
    occurrences: 0,
    travel: null
  }
};

const radio = (name: string) => screen.getByRole("radio", { name });
const checked = (name: string) => radio(name).getAttribute("aria-checked") === "true";

describe("DayPlanCard", () => {
  it("is a card headed Day plan, with a Timeline/List choice that defaults to the list on a phone", () => {
    const { container } = render(<DayPlanCard plan={plan} timezone={TZ} phone onSelect={() => {}} />);
    expect(container.querySelector("details")).toBeNull();
    expect(screen.getByRole("heading", { name: "Day plan" })).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "Day plan view" })).toBeTruthy();
    expect(checked("List")).toBe(true);
    expect(checked("Timeline")).toBe(false);
    expect(container.querySelector(".day-timeline")).toBeNull();
    expect(screen.getByRole("list", { name: "Day agenda" })).toBeTruthy();
  });

  it("opens on the timeline on a desk, switches to the list and back, and does not scroll the timeline", () => {
    const { container } = render(<DayPlanCard plan={plan} timezone={TZ} phone={false} onSelect={() => {}} />);
    expect(checked("Timeline")).toBe(true);
    expect(container.querySelector(".day-timeline")).not.toBeNull();
    // The night is cropped off rather than scrolled past, so there is no scroller to land in.
    expect(container.querySelector(".day-plan-scroller")).toBeNull();
    fireEvent.click(radio("List"));
    expect(checked("List")).toBe(true);
    expect(container.querySelector(".day-timeline")).toBeNull();
    expect(screen.getByRole("list", { name: "Day agenda" })).toBeTruthy();
    fireEvent.click(radio("Timeline"));
    expect(container.querySelector(".day-timeline")).not.toBeNull();
  });

  it("draws latest-safe reservations only when the page passes showReserved, and explains them then", () => {
    const { rerender } = render(<DayPlanCard plan={plan} timezone={TZ} phone={false} onSelect={() => {}} />);
    expect(screen.queryByRole("button", { name: /Reserved: Reconcile/ })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByText(/not sessions and not when to do the work/)).toBeNull();
    rerender(<DayPlanCard plan={plan} timezone={TZ} phone={false} showReserved onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: /Reserved: Reconcile/ })).toBeTruthy();
    expect(screen.getByText(/not sessions and not when to do the work/)).toBeTruthy();
  });

  it("says when the engine plan is stale, and a tap on a block still reaches the page", () => {
    const onSelect = vi.fn();
    render(<DayPlanCard plan={plan} timezone={TZ} phone={false} planStale onSelect={onSelect} />);
    expect(screen.getByText(/This plan is out of date/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Dentist,/ }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "c" }));
  });

  it("says nothing about a replan on first sight, then names the next run and how much of it moved", () => {
    const first: DayPlan = { ...plan, items: [block, projected], calculatedAt: NOW };
    const { rerender } = render(<DayPlanCard plan={first} timezone={TZ} phone onSelect={() => {}} />);
    expect(screen.queryByText(/Plan updated/)).toBeNull();
    const moved: DayPlanItem = { ...projected, id: "plan:a1:2026-08-19T02:00:00.000Z" };
    rerender(
      <DayPlanCard
        plan={{ ...first, items: [block, moved], calculatedAt: at("2026-08-19T00:05:00.000Z") }}
        timezone={TZ}
        phone
        onSelect={() => {}}
      />
    );
    expect(screen.getByText("Plan updated 10:05 am: 1 block moved")).toBeTruthy();
    // A fresh run that placed the same blocks is still worth naming, and says so plainly.
    rerender(
      <DayPlanCard
        plan={{ ...first, items: [block, moved], calculatedAt: at("2026-08-19T00:10:00.000Z") }}
        timezone={TZ}
        phone
        onSelect={() => {}}
      />
    );
    expect(screen.getByText("Plan updated 10:10 am: nothing moved")).toBeTruthy();
  });

  it("has no day switch of its own: the page pages days, and no brief means no tomorrow summary", () => {
    render(<DayPlanCard plan={plan} timezone={TZ} phone onSelect={() => {}} />);
    expect(screen.queryByRole("group", { name: "Which day" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Tomorrow" })).toBeNull();
    expect(screen.queryByText(/^First: /)).toBeNull();
  });

  it("writes tomorrow's brief above the canvas when given one, and draws that day's blocks", () => {
    const onSelect = vi.fn();
    render(<DayPlanCard plan={tomorrow.plan} brief={tomorrow.brief} timezone={TZ} phone={false} onSelect={onSelect} />);
    expect(screen.getByText("First: Standup at 9:00 am")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Dentist,/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Standup,/ }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "commitment:standup" }));
  });

  it("fades the day in only once the page hands it another day, never on the first draw", () => {
    const { container, rerender } = render(<DayPlanCard plan={plan} timezone={TZ} phone={false} onSelect={() => {}} />);
    expect(container.querySelector("[data-day]")!.className).not.toContain("switched");
    rerender(
      <DayPlanCard plan={tomorrow.plan} brief={tomorrow.brief} timezone={TZ} phone={false} onSelect={() => {}} />
    );
    expect(container.querySelector("[data-day]")!.getAttribute("data-day")).toBe("2026-08-20");
    expect(container.querySelector("[data-day]")!.className).toContain("switched");
  });

  it("keeps the list view when the day changes, so the reader's choice of view survives the switch", () => {
    const { rerender } = render(<DayPlanCard plan={plan} timezone={TZ} phone={false} onSelect={() => {}} />);
    fireEvent.click(radio("List"));
    rerender(
      <DayPlanCard plan={tomorrow.plan} brief={tomorrow.brief} timezone={TZ} phone={false} onSelect={() => {}} />
    );
    expect(screen.getByRole("list", { name: "Day agenda" })).toBeTruthy();
    expect(screen.getByText("First: Standup at 9:00 am")).toBeTruthy();
  });

  it("warns when the projected day does not reach a deadline in time", () => {
    const displaced = (count: number) => ({
      ...plan,
      displaced: Array.from({ length: count }, (_, index) => ({
        targetId: `a${index}`,
        latestSafeStartAt: at("2026-08-19T02:00:00.000Z"),
        firstPlannedAt: null
      }))
    });
    const { rerender } = render(<DayPlanCard plan={displaced(1)} timezone={TZ} phone onSelect={() => {}} />);
    expect(screen.getByText(/One deadline is not reached in time\./)).toBeTruthy();
    rerender(<DayPlanCard plan={displaced(3)} timezone={TZ} phone onSelect={() => {}} />);
    expect(screen.getByText(/3 deadlines are not reached in time\./)).toBeTruthy();
  });
});
