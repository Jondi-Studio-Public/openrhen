// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { render, screen } from "@/test/render";
import type { ClientDeadlineOutlook } from "@/state/portal-provider";
import { DeadlinesPanel } from "./deadlines-panel";

const state = createSeedState(new Date("2026-08-18T09:00:00.000Z"));
const first = { id: "project-1" };
const second = { id: "project-2" };
const third = { id: "project-3" };
const fourth = { id: state.projects[0]!.id, title: state.projects[0]!.title };
const outcomeA = "outcome-a";
const outcomeB = "outcome-b";

const outlook: ClientDeadlineOutlook = {
  projects: [
    {
      projectId: first.id,
      title: "Late filing",
      outcomeId: outcomeA,
      verdict: "overdue",
      deadlineAt: new Date("2026-08-10T09:00:00.000Z"),
      slackMinutes: -300,
      pessimisticMarginMinutes: -400,
      latestSafeStart: null,
      earliestFeasibleAt: new Date("2026-08-25T09:00:00.000Z"),
      suggestion: "This deadline has passed. Ask for an extension to Tue, Aug 25, 7:00 PM."
    },
    {
      projectId: second.id,
      title: "Slipping report",
      outcomeId: outcomeB,
      verdict: "behind",
      deadlineAt: new Date("2026-08-20T09:00:00.000Z"),
      slackMinutes: -90,
      pessimisticMarginMinutes: -150,
      latestSafeStart: new Date("2026-08-18T12:20:00.000Z"),
      suggestion: "Start by 10:20 PM or this deadline becomes unreachable."
    },
    {
      projectId: third.id,
      title: "Close call",
      outcomeId: outcomeB,
      verdict: "tight",
      deadlineAt: new Date("2026-08-22T09:00:00.000Z"),
      slackMinutes: 20,
      pessimisticMarginMinutes: -10,
      latestSafeStart: new Date("2026-08-19T09:00:00.000Z"),
      suggestion: "Start by 7:00 PM or this deadline becomes unreachable."
    },
    {
      projectId: fourth.id,
      title: "Roomy",
      outcomeId: null,
      verdict: "ok",
      deadlineAt: new Date("2026-09-30T09:00:00.000Z"),
      slackMinutes: 600,
      pessimisticMarginMinutes: 300,
      latestSafeStart: null,
      suggestion: null
    }
  ],
  outcomes: [
    {
      outcomeId: outcomeA,
      title: "Taxes",
      verdict: "overdue",
      deadlineAt: new Date("2026-08-10T09:00:00.000Z"),
      slackMinutes: -300,
      latestSafeStart: null,
      projectIds: [first.id]
    },
    {
      outcomeId: outcomeB,
      title: "Work",
      verdict: "behind",
      deadlineAt: new Date("2026-08-20T09:00:00.000Z"),
      slackMinutes: -90,
      latestSafeStart: new Date("2026-08-18T12:20:00.000Z"),
      projectIds: [second.id, third.id]
    }
  ]
};

describe("DeadlinesPanel", () => {
  it("groups projects by outcome, worst group first, and puts projects with no outcome last", () => {
    render(<DeadlinesPanel outlook={outlook} state={state} />);
    const headings = screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
    expect(headings).toEqual(["Taxespast its deadline", "Workbehind", "No outcome"]);
  });

  it("sorts rows by slack inside a group and names verdict, deadline, slack and latest safe start", () => {
    const { container } = render(<DeadlinesPanel outlook={outlook} state={state} />);
    const cards = [...container.querySelectorAll(".row-card")].map((card) => card.textContent ?? "");
    expect(cards).toHaveLength(4);
    expect(cards[0]).toContain("Late filing");
    expect(cards[1]).toContain("Slipping report");
    expect(cards[2]).toContain("Close call");
    expect(cards[3]).toContain("Roomy");
    expect(cards[1]).toContain("1 h 30 min short");
    expect(cards[1]).toMatch(/Deadline .*Aug 20|Deadline .*20 Aug/);
    expect(cards[1]).toContain("latest safe start");
    expect(cards[1]).toContain("behind");
    expect(cards[0]).toContain("5 h short");
    expect(cards[0]).toContain("would fit by");
    expect(cards[2]).toContain("20 min to spare");
    expect(cards[2]).toContain("tight");
  });

  it("shows the suggestion line for each flagged row and none for a row without one", () => {
    const { container } = render(<DeadlinesPanel outlook={outlook} state={state} />);
    expect(screen.getByText("Start by 10:20 PM or this deadline becomes unreachable.")).toBeTruthy();
    expect(screen.getByText(/Ask for an extension to Tue, Aug 25/)).toBeTruthy();
    const roomy = [...container.querySelectorAll(".row-card")].find((card) => card.textContent?.includes("Roomy"))!;
    expect(roomy.querySelector(".microcopy")).toBeNull();
  });

  it("uses the existing health chip colours and summarises the counts", () => {
    const { container } = render(<DeadlinesPanel outlook={outlook} state={state} />);
    expect(container.querySelector(".row-card .health.overdue")).toBeTruthy();
    expect(container.querySelector(".row-card .health.behind")).toBeTruthy();
    expect(container.querySelector(".row-card .health.at_risk")).toBeTruthy();
    expect(container.querySelector(".row-card .health.on_track")).toBeTruthy();
    expect(screen.getByText(/1 past its deadline · 1 behind · 1 tight · 1 on plan/)).toBeTruthy();
  });

  it("says plainly that a plan stored before deadlines were tracked has none", () => {
    const { container } = render(<DeadlinesPanel outlook={null} state={state} />);
    expect(screen.getByText(/No project with a deadline is being tracked/)).toBeTruthy();
    expect(screen.getByText(/recalculated/)).toBeTruthy();
    expect(container.querySelector(".row-card")).toBeNull();
  });

  it("treats an empty outlook the same way", () => {
    render(<DeadlinesPanel outlook={{ projects: [], outcomes: [] }} state={state} />);
    expect(screen.getByText(/No project with a deadline is being tracked/)).toBeTruthy();
  });

  it("falls back to the stored project's title when the row carries none", () => {
    const row = { ...outlook.projects[3]!, title: null };
    render(<DeadlinesPanel outlook={{ projects: [row], outcomes: [] }} state={state} />);
    expect(screen.getByText(fourth.title)).toBeTruthy();
  });
});
