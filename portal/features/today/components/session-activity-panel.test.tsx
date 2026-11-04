// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { SessionHistoryItem } from "@/state/portal-state";
import { render, screen } from "@/test/render";
import { SessionActivityPanel } from "./session-activity-panel";

const session = (overrides: Partial<SessionHistoryItem>): SessionHistoryItem =>
  ({
    id: "session-one",
    actionId: "essay",
    actionTitle: "Draft the essay",
    result: "completed",
    startedAt: "2026-08-18T00:00:00.000Z",
    endedAt: "2026-08-18T00:45:00.000Z",
    plannedMinutes: 45,
    activeMinutes: 40,
    remainingBeforeMinutes: 90,
    remainingAfterMinutes: 50,
    ...overrides
  }) as unknown as SessionHistoryItem;

describe("Session activity panel", () => {
  it("says what will appear here once a session ends", () => {
    render(<SessionActivityPanel sessions={[]} />);
    expect(screen.getByText("Sessions you finish, stop or get blocked on today will show here.")).toBeTruthy();
  });

  it("reports each session's result, remaining work, and active minutes", () => {
    render(<SessionActivityPanel sessions={[session({}), session({ id: "two", result: "blocked" })]} />);
    expect(screen.getAllByText("Draft the essay")).toHaveLength(2);
    expect(screen.getByText("completed · 50 min remaining")).toBeTruthy();
    expect(screen.getByText("blocked · 50 min remaining")).toBeTruthy();
    expect(screen.getAllByText("40 active min")).toHaveLength(2);
  });

  it("says nothing about remaining work when none is left", () => {
    render(<SessionActivityPanel sessions={[session({ remainingAfterMinutes: 0 })]} />);
    expect(screen.getByText("completed")).toBeTruthy();
  });
});
