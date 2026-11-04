// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import type { PortalState } from "@/state/portal-state";
import HistoryPage from "./page";

// Monday 5 Oct 2026, 13:00 in Melbourne.
const NOW = new Date("2026-10-05T02:00:00Z");

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
    remainingBeforeMinutes: 30,
    remainingAfterMinutes: 5
  }) as PortalState["completedToday"][number];

const state = {
  completedToday: [
    session("this-week", "2026-10-05T01:00:00Z", "Essay outline"),
    session("last-week", "2026-09-29T01:00:00Z", "Lab report")
  ],
  sleepPlans: [],
  occurrences: [],
  spans: [],
  actions: [],
  projects: [],
  deliverables: [],
  settings: { timezone: "Australia/Melbourne" }
} as unknown as PortalState;

vi.mock("@/state/portal-provider", () => ({ usePortal: () => ({ state, ready: true }) }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("HistoryPage", () => {
  it("lists the sessions of the week or month the calendar shows, and follows Previous", () => {
    render(<HistoryPage />);
    expect(screen.getByRole("heading", { name: "Essay outline" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Lab report" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(screen.getByRole("heading", { name: "Lab report" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Essay outline" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(screen.getByText(/^No sessions in 21 Sept? – 27 Sept? 2026\.$/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Month" }));
    expect(screen.getByRole("heading", { name: "Lab report" })).toBeTruthy();
  });
});
