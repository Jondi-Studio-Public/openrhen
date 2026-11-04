// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { createSeedState, type PortalState, type StoredCommitmentRecurrenceRule } from "@/state/portal-state";
import { freezeClock } from "@/shared/clock";
import { zonedDayBounds } from "@/features/today/local-datetime";
import type { WeekPlan } from "@/features/schedule/week-plan";
import { dueOn, freeMinutesOn, weekAnswer, WeekPanel } from "./week-panel";
import type { StoredDeliverable } from "@/state/portal-state";

// 10:00 am Wednesday 19 August 2026 in the seed zone. The week opens on that day and pages by seven.
const NOW = new Date("2026-08-19T00:00:00.000Z");
const TZ = "Australia/Sydney";
const DAY = "2026-08-19";

let context: Record<string, unknown>;
vi.mock("@/state/portal-provider", () => ({ usePortal: () => context }));
const navigateTo = vi.fn();
vi.mock("@/shared/navigate", () => ({ navigateTo: (href: string) => navigateTo(href) }));
// The panel reads the clock from the store rather than the context, so it is frozen at the same instant.
freezeClock(NOW);

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

function panelWith(overrides: Partial<PortalState> = {}) {
  const state: PortalState = {
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
  context = {
    state,
    ready: true,
    saving: false,
    slots: [],
    allocations: [],
    recommendation: null,
    currentDirective: null,
    upcomingDirectives: []
  };
  return render(<WeekPanel />);
}

/** The date the leftmost column is showing — which is to say, where the anchor is. */
const anchorShown = (container: HTMLElement) => container.querySelector(".week-timeline-date")!.textContent;
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

beforeEach(() => {
  navigateTo.mockClear();
});

describe("WeekPanel", () => {
  it("opens on today, pages seven days either way, and comes back when Today is pressed", () => {
    const { container } = panelWith();
    expect(anchorShown(container)).toBe("19 Aug");
    click("Next week");
    expect(anchorShown(container)).toBe("26 Aug");
    click("Previous week");
    expect(anchorShown(container)).toBe("19 Aug");
    click("Previous week");
    expect(anchorShown(container)).toBe("12 Aug");
    click("This week");
    expect(anchorShown(container)).toBe("19 Aug");
    // "This week" is a state, not just a jump: it is the pressed one only while the week is this one.
    expect(screen.getByRole("button", { name: "This week" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("heading", { level: 1, name: "This week" })).toBeTruthy();
    click("Previous week");
    expect(screen.getByRole("button", { name: "This week" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/^Week of /);
  });

  it("says which occurrences are drawn from their rules once the window passes the horizon", () => {
    const { container } = panelWith({
      commitments: [
        commitment("gym-26", "2026-08-25T23:00:00.000Z", "2026-08-26T00:00:00.000Z", {
          recurrenceRuleId: "gym",
          localDate: "2026-08-26"
        })
      ],
      commitmentRecurrenceRules: [rule("gym")]
    });
    // This week ends on the 25th, still inside what the materialization job has written down.
    expect(screen.queryByText(/projected from their rules/)).toBeNull();
    click("Next week");
    expect(screen.getByText(/Occurrences after Wednesday, 26 August are projected from their rules\./)).toBeTruthy();
    // And the projections themselves are on the canvas, drawn as text rather than as controls.
    const projected = [...container.querySelectorAll<HTMLElement>("span.day-timeline-block")].filter((block) =>
      block.title.startsWith("Rule gym")
    );
    expect(projected.length).toBeGreaterThan(0);
  });

  it("does not claim a horizon when there is no active rule to project past it", () => {
    panelWith({
      commitments: [
        commitment("once", "2026-08-25T23:00:00.000Z", "2026-08-26T00:00:00.000Z", {
          recurrenceRuleId: "gym",
          localDate: "2026-08-26"
        })
      ],
      commitmentRecurrenceRules: [rule("gym", { status: "ended" })]
    });
    click("Next week");
    expect(screen.queryByText(/projected from their rules/)).toBeNull();
  });

  it("warns that a week already gone holds no forward plan", () => {
    panelWith();
    expect(screen.queryByText(/Past weeks/)).toBeNull();
    click("Previous week");
    expect(screen.getByText(/Past weeks show commitments only\./)).toBeTruthy();
    click("This week");
    expect(screen.queryByText(/Past weeks/)).toBeNull();
  });

  it("sends a tap on a stored commitment to that commitment's own page", () => {
    panelWith({ commitments: [commitment("dentist", "2026-08-19T04:00:00.000Z", "2026-08-19T05:00:00.000Z")] });
    click("Commitment dentist, 2:00 pm to 3:00 pm");
    expect(navigateTo).toHaveBeenCalledWith("/commitments/dentist");
  });
});

describe("dueOn", () => {
  const day = zonedDayBounds("2026-08-21", TZ);
  const deliverable = (id: string, title: string, extra: Partial<StoredDeliverable>) =>
    ({ id, title, status: "drafting", ...extra }) as unknown as StoredDeliverable;

  it("names each open deliverable due that day, short, in deadline order", () => {
    const due = dueOn(
      [
        deliverable("late", "Lab report (draft 2)", { externalDeadlineAt: "2026-08-21T12:00:00.000Z" }),
        deliverable("early", "Assessment 2: Network design report", {
          internalDeadlineAt: "2026-08-21T01:00:00.000Z"
        }),
        deliverable("next-day", "Essay", { externalDeadlineAt: "2026-08-22T01:00:00.000Z" }),
        deliverable("done", "Quiz", { status: "completed", externalDeadlineAt: "2026-08-21T02:00:00.000Z" }),
        deliverable("none", "Someday", {})
      ],
      day
    );
    expect(due).toEqual([
      { id: "early", label: "Assessment 2 due" },
      { id: "late", label: "Lab report due" }
    ]);
  });

  it("goes by the external deadline when there are both", () => {
    const both = deliverable("both", "Portfolio", {
      internalDeadlineAt: "2026-08-21T01:00:00.000Z",
      externalDeadlineAt: "2026-08-22T01:00:00.000Z"
    });
    expect(dueOn([both], day)).toEqual([]);
  });
});

describe("freeMinutesOn", () => {
  const today = zonedDayBounds("2026-08-19", TZ);
  const tomorrow = zonedDayBounds("2026-08-20", TZ);
  const slot = (start: string, capacityMinutes: number) => ({
    startsAt: new Date(start),
    endsAt: new Date(new Date(start).getTime() + 900_000),
    capacityMinutes
  });
  // 11:00 am Wednesday in the seed zone is 01:00Z; the later slot is 3 pm, the earlier one 9 am.
  const slots = [
    slot("2026-08-18T23:00:00.000Z", 15),
    slot("2026-08-19T05:00:00.000Z", 10),
    slot("2026-08-20T03:00:00.000Z", 12)
  ];

  it("counts what is left of today, not what has already gone", () => {
    expect(freeMinutesOn(slots, today, new Date("2026-08-19T01:00:00.000Z"), true)).toBe(10);
  });

  it("counts the whole of a later day", () => {
    expect(freeMinutesOn(slots, tomorrow, NOW, false)).toBe(12);
  });

  it("is null for a day already gone, and for a day the slots do not reach", () => {
    expect(freeMinutesOn(slots, today, new Date("2026-08-20T00:00:00.000Z"), false)).toBeNull();
    expect(freeMinutesOn(slots, zonedDayBounds("2026-08-25", TZ), NOW, false)).toBeNull();
  });
});

describe("weekAnswer", () => {
  // Seven days from Wednesday 19 August; only the start of each day's bounds is read.
  const week = {
    days: Array.from({ length: 7 }, (_, index) => ({
      dayKey: `2026-08-${19 + index}`,
      plan: { bounds: zonedDayBounds(`2026-08-${19 + index}`, TZ) }
    }))
  } as unknown as WeekPlan;

  it("states the free time across the days and names the day with the least room", () => {
    expect(weekAnswer(week, [120, 300, 45, null, 600, null, 90], TZ)).toBe(
      "19 h 15 m free across these days. Friday has the least room, 45 m."
    );
  });

  it("counts what is left of today but never names today as the tightest day", () => {
    const started = {
      days: week.days.map((day, index) =>
        index === 0 ? { ...day, plan: { ...day.plan, nowAt: new Date("2026-08-19T10:00:00.000Z") } } : day
      )
    } as unknown as WeekPlan;
    expect(weekAnswer(started, [20, 300, 45, null, 600, null, 90], TZ)).toBe(
      "17 h 35 m free across these days. Friday has the least room, 45 m."
    );
    expect(weekAnswer(started, [20, null, null, null, null, null, null], TZ)).toBe("20 m free across these days.");
  });

  it("falls back to saying what the week shows when no day has a known figure", () => {
    expect(weekAnswer(week, Array(7).fill(null), TZ)).toBe(
      "Commitments for the seven days, with recurring ones shown from their rules."
    );
  });

  it("puts the answer under the week's heading when the panel is drawn", () => {
    panelWith();
    expect(screen.getByRole("heading", { level: 1, name: "This week" }).parentElement!.textContent).toContain(
      "Commitments for the seven days"
    );
  });

  describe("on a phone", () => {
    const phone = () =>
      vi.stubGlobal("matchMedia", (query: string) => ({
        matches: query === "(max-width: 719px)",
        addEventListener: () => {},
        removeEventListener: () => {}
      }));
    afterEach(() => vi.unstubAllGlobals());

    it("lists the seven days instead of drawing the grid, and a day opens its Day page", () => {
      phone();
      const { container } = panelWith({
        commitments: [commitment("dentist", "2026-08-20T04:00:00.000Z", "2026-08-20T05:00:00.000Z")]
      });
      expect(container.querySelector(".week-timeline")).toBeNull();
      const list = screen.getByRole("list", { name: "The week, day by day" });
      expect(list.querySelectorAll("li")).toHaveLength(7);
      const thursday = screen.getByRole("link", { name: /Thu 20 Aug/ });
      expect(thursday.textContent).toMatch(/Commitment dentist/);
      expect(thursday.getAttribute("href")).toBe("/today?day=2026-08-20");
      expect(screen.getByRole("link", { name: /Wed 19 Aug/ }).getAttribute("href")).toBe("/today?day=2026-08-19");
    });

    it("does not link a day Day cannot page to", () => {
      phone();
      panelWith();
      click("Next week");
      expect(screen.queryByRole("link", { name: /Wed 26 Aug/ })).toBeNull();
      expect(screen.getByText(/Wed 26 Aug/)).toBeTruthy();
    });
  });
});
