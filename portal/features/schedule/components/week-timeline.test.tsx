// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { createSeedState, type PortalState, type StoredCommitmentRecurrenceRule } from "@/state/portal-state";
import { buildWeekPlan, type WeekPlanState } from "@/features/schedule/week-plan";
import { WeekTimeline } from "./week-timeline";

// Wednesday 19 August 2026 in the seed zone runs 2026-08-18T14:00Z to 2026-08-19T14:00Z. `now` is 10:00 local.
const NOW = new Date("2026-08-19T00:00:00.000Z");
const TZ = "Australia/Sydney";
const DAY = "2026-08-19";
const HOUR_PX = 40;
/** A plain twenty-four-hour column at this scale, before anything is pushed past the last hour. */
const PLAIN_HEIGHT = 24 * HOUR_PX;

function baseState(overrides: Partial<PortalState> = {}): WeekPlanState {
  return {
    ...createSeedState(NOW),
    commitments: [],
    commitmentRecurrenceRules: [],
    routineSteps: [],
    routinePresets: [],
    sleepPlans: [],
    occurrences: [],
    completedToday: [],
    activeSession: null,
    planning: { status: "current" },
    ...overrides
  };
}

const commitment = (id: string, startsAt: string, endsAt: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Commitment ${id}`,
  startsAt,
  endsAt,
  status: "confirmed" as const,
  setupBeforeMinutes: 0,
  transitionAfterMinutes: 0,
  ...extra
});

const rule = (id: string, overrides: Partial<StoredCommitmentRecurrenceRule> = {}): StoredCommitmentRecurrenceRule => ({
  id,
  title: `Rule ${id}`,
  timezone: TZ,
  startDate: DAY,
  repeat: { unit: "days" as const, intervalDays: 1 },
  localStartTime: "09:00",
  localEndTime: "10:00",
  setupBeforeMinutes: 0,
  transitionAfterMinutes: 0,
  status: "active",
  ...overrides
});

function week(state: WeekPlanState, anchorDayKey = DAY) {
  return buildWeekPlan({
    state,
    slots: [],
    allocations: [],
    currentDirective: null,
    recommendation: null,
    upcomingDirectives: [],
    now: NOW,
    timezone: TZ,
    anchorDayKey
  });
}

function renderWeek(state: WeekPlanState = baseState(), anchorDayKey = DAY, onSelect = vi.fn()) {
  const result = render(
    <WeekTimeline week={week(state, anchorDayKey)} timezone={TZ} pixelsPerHour={HOUR_PX} onSelect={onSelect} />
  );
  return { ...result, onSelect };
}

const trackHeights = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>(".day-timeline-track")].map((track) => track.style.height);

describe("WeekTimeline", () => {
  it("draws seven day columns under one shared hour gutter", () => {
    const { container } = renderWeek();
    expect(container.querySelectorAll(".week-timeline-column")).toHaveLength(7);
    expect(container.querySelectorAll(".week-timeline-head")).toHaveLength(7);
    // One gutter for the week, not one per column, and the day's own hour marks inside it.
    expect(container.querySelectorAll(".week-timeline-gutter")).toHaveLength(1);
    expect(container.querySelectorAll(".week-timeline-gutter .day-timeline-hour")).toHaveLength(24);
    const headings = [...container.querySelectorAll(".week-timeline-date")].map((node) => node.textContent);
    expect(headings).toEqual(["19 Aug", "20 Aug", "21 Aug", "22 Aug", "23 Aug", "24 Aug", "25 Aug"]);
  });

  it("opens at the week's first waking hour, not at midnight, and labels each day's count", () => {
    // A daily 09:00 rule: half an hour before is 08:30, which opens on the 8 am rule.
    const { container } = renderWeek(baseState({ commitmentRecurrenceRules: [rule("daily")] }));
    expect(container.querySelector<HTMLElement>(".week-timeline-scroll")!.scrollTop).toBe(8 * HOUR_PX);
    expect(container.querySelector(".week-timeline-count")!.textContent).toBe("1 item");
  });

  it("gives every column the same height, taken from the tallest, so the hour rules line up", () => {
    const plain = renderWeek();
    expect(trackHeights(plain.container)).toEqual(Array(7).fill(`${PLAIN_HEIGHT}px`));
    plain.unmount();

    // Eight five-minute commitments from 11 pm on the Thursday. Each is inflated to the minimum
    // block height and cascaded below the one before, which carries the run past that day's midnight.
    const crowded = Array.from({ length: 8 }, (_, index) =>
      commitment(
        `late-${index}`,
        new Date(Date.UTC(2026, 7, 20, 13, index * 5)).toISOString(),
        new Date(Date.UTC(2026, 7, 20, 13, index * 5 + 5)).toISOString()
      )
    );
    const { container } = renderWeek(baseState({ commitments: crowded }));
    const heights = trackHeights(container);
    expect(new Set(heights).size).toBe(1);
    expect(Number.parseFloat(heights[0]!)).toBeGreaterThan(PLAIN_HEIGHT);
    // The gutter is stretched to the same height, or its last hour rule would leave the canvas.
    expect((container.querySelector(".week-timeline-gutter") as HTMLElement).style.height).toBe(heights[0]);
  });

  it("highlights only the column the now-line falls in, and none when the week is elsewhere", () => {
    const { container, unmount } = renderWeek();
    const heads = [...container.querySelectorAll(".week-timeline-head")];
    expect(heads.map((head) => head.className.includes("today"))).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
      false
    ]);
    // Which column is today is read from the now-line itself rather than decided a second time.
    expect(container.querySelectorAll("[data-testid='day-timeline-now']")).toHaveLength(1);
    unmount();

    const future = renderWeek(baseState(), "2026-09-16");
    expect(future.container.querySelectorAll(".week-timeline-head.today")).toHaveLength(0);
    expect(future.container.querySelectorAll("[data-testid='day-timeline-now']")).toHaveLength(0);
  });

  it("runs each column dense and without the reservation lane or the untimed strip", () => {
    const { container } = renderWeek(
      baseState({
        commitments: [
          commitment("dentist", "2026-08-19T04:00:00.000Z", "2026-08-19T05:00:00.000Z", { location: "Town" })
        ]
      })
    );
    expect(screen.getByRole("button", { name: "Commitment dentist, 2:00 pm to 3:00 pm" })).toBeTruthy();
    // An hour is 40 px here — room for a second line, which dense drops anyway.
    expect(container.querySelector(".day-timeline-block-meta")).toBeNull();
    expect(container.querySelector(".day-timeline-untimed")).toBeNull();
    expect(container.querySelector(".day-timeline-reserved")).toBeNull();
  });

  it("lets a block's title wrap onto as many lines as the block is tall", () => {
    renderWeek(
      baseState({
        commitments: [commitment("dentist", "2026-08-19T04:00:00.000Z", "2026-08-19T05:00:00.000Z")]
      })
    );
    // An hour at 40 px leaves 38 px under the block's top padding: two 16 px lines.
    const block = screen.getByRole("button", { name: "Commitment dentist, 2:00 pm to 3:00 pm" });
    expect(block.style.getPropertyValue("--dt-title-lines")).toBe("2");
  });

  it("draws a projected occurrence as text rather than as a control, and a stored one as a button", () => {
    const state = baseState({
      commitments: [commitment("real", "2026-08-19T04:00:00.000Z", "2026-08-19T05:00:00.000Z")],
      commitmentRecurrenceRules: [rule("gym", { startDate: "2026-08-21", title: "Gym" })]
    });
    const { container, onSelect } = renderWeek(state);
    const projected = [...container.querySelectorAll<HTMLElement>(".day-timeline-block")].filter((block) =>
      block.title.startsWith("Gym")
    );
    expect(projected).toHaveLength(5);
    expect(projected.every((block) => block.tagName === "SPAN")).toBe(true);
    expect(screen.queryByRole("button", { name: /^Gym/ })).toBeNull();
    // The stored commitment beside it is still a control, so the week has not simply gone inert.
    fireEvent.click(screen.getByRole("button", { name: /^Commitment real/ }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]![0].entityId).toBe("real");
  });
});
