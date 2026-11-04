// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { render, screen } from "@/test/render";
import type { ClientWeekOutlook } from "@/state/portal-provider";
import { WeekOutlookPanel } from "./week-outlook-panel";

const state = createSeedState(new Date("2026-08-18T09:00:00.000Z"));
const projectId = state.projects[0]!.id;
const otherId = state.projects[1]!.id;
const outlook: ClientWeekOutlook = {
  startsAt: new Date("2026-08-17T14:00:00.000Z"),
  endsAt: new Date("2026-08-24T14:00:00.000Z"),
  capacityMinutes: 1800,
  reservedMinutes: 900,
  freeMinutes: 900,
  projects: [
    { projectId, reservedMinutes: 300, requiredPaceMinutesPerWeek: 480, paceShortfallMinutes: 180, health: "at_risk" },
    {
      projectId: otherId,
      reservedMinutes: 600,
      requiredPaceMinutesPerWeek: null,
      paceShortfallMinutes: 0,
      health: "on_track"
    }
  ],
  underPacedProjectIds: [projectId],
  areas: [{ areaId: state.areas[0]!.id, reservedMinutes: 900 }]
};

describe("WeekOutlookPanel", () => {
  it("is a folded disclosure that flags the short-on-time count on its summary line", () => {
    const { container } = render(<WeekOutlookPanel outlook={outlook} state={state} />);
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")!.textContent).toContain("Week outlook · 18 Aug – 25 Aug");
    expect(screen.getByText("1 short on time")).toBeTruthy();
  });

  it("names the short-on-time project first, shows its pace shortfall, and lists areas as a stewardship signal", () => {
    const { container } = render(<WeekOutlookPanel outlook={outlook} state={state} />);
    const cards = container.querySelectorAll(".row-card");
    expect(cards).toHaveLength(2);
    expect(cards[0]!.textContent).toContain(state.projects[0]!.title);
    expect(cards[0]!.textContent).toContain("5 h set aside · needs 8 h a week · short by 3 h");
    expect(cards[0]!.textContent).toContain("short on time");
    expect(cards[1]!.textContent).toContain("10 h set aside · no dated pace");
    expect(screen.getByText(new RegExp(`By area: ${state.areas[0]!.name} 15 h`))).toBeTruthy();
  });

  it("drops the aggregate reserved/free figure in favor of a cross-reference to Plan's Time ahead", () => {
    const { container } = render(<WeekOutlookPanel outlook={outlook} state={state} />);
    expect(container.textContent).not.toMatch(/reserved of.*usable/);
    expect(screen.getByText("Plan’s Time ahead").getAttribute("href")).toBe("/plan");
  });

  it("says when the stored plan predates the outlook, and stays quiet about a short-on-time count", () => {
    const { container } = render(<WeekOutlookPanel outlook={null} state={state} />);
    expect(screen.getByText(/made before a week outlook was available/)).toBeTruthy();
    expect(container.querySelector(".flag-chip")).toBeNull();
    expect(screen.getByText("Plan’s Time ahead")).toBeTruthy();
  });

  it("reports how much of the cadence demand fits this week's free time, alongside what's overdue", () => {
    const actionId = state.actions[0]!.id;
    const cadenceOutlook: ClientWeekOutlook = {
      ...outlook,
      cadence: {
        demandMinutesPerWeek: 240,
        due: [{ actionId, dueLocalDate: "2026-08-19", daysOverdue: 2 }],
        softReservedMinutes: 90,
        actions: [{ actionId, expectedOccurrences: 7, fittingOccurrences: 5 }]
      }
    };
    render(<WeekOutlookPanel outlook={cadenceOutlook} state={state} />);
    expect(screen.getByText(/A cadence wants about 4 h a week from free time, not set aside/)).toBeTruthy();
    expect(screen.getByText(/about 1\.5 h of that fits this week's free time/)).toBeTruthy();
    expect(screen.getByText(/Due now:.*2 days overdue/)).toBeTruthy();
  });
});
