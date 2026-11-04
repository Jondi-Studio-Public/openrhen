import { describe, expect, it } from "vitest";
import type { ActiveSession } from "@/state/portal-state";
import { createSeedState } from "@/state/portal-state";
import { loggedLine, loggedMinutes, startFloor } from "./logged-session";

const now = new Date("2026-08-18T10:00:00.000Z");
const session = (overrides: Partial<ActiveSession> = {}): ActiveSession => ({
  id: "s1",
  actionId: "a1",
  status: "running",
  startedAt: "2026-08-18T09:00:00.000Z",
  plannedEndAt: "2026-08-18T10:00:00.000Z",
  plannedMinutes: 60,
  remainingBeforeMinutes: 90,
  activeElapsedSeconds: 600,
  segmentStartedAt: "2026-08-18T09:30:00.000Z",
  ...overrides
});

describe("loggedMinutes", () => {
  it("adds the open segment to the closed ones while the session runs", () => {
    // Ten minutes closed, thirty running.
    expect(loggedMinutes(session(), now)).toBe(40);
  });

  it("counts only the closed segments for a session already awaiting feedback or paused", () => {
    expect(loggedMinutes(session({ status: "feedback", segmentStartedAt: undefined }), now)).toBe(10);
    expect(loggedMinutes(session({ status: "paused", segmentStartedAt: undefined }), now)).toBe(10);
  });

  it("replaces the stretch after the checkpoint with the end the person gave", () => {
    const awaiting = session({
      status: "feedback",
      segmentStartedAt: undefined,
      feedbackRequestedAt: "2026-08-18T09:45:00.000Z"
    });
    expect(loggedMinutes(awaiting, now, "2026-08-18T09:55:00.000Z")).toBe(20);
  });

  it("never goes below zero", () => {
    expect(loggedMinutes(session({ activeElapsedSeconds: 0 }), new Date("2026-08-18T09:00:00.000Z"))).toBe(0);
  });
});

describe("loggedLine", () => {
  it("names the minutes and the task", () => {
    expect(loggedLine(42, "Write the report")).toBe("Logged 42 min on Write the report");
  });
});

describe("startFloor", () => {
  const base = createSeedState(now);
  const stateWith = (patch: {
    lastWokeAt?: string;
    ended?: string[];
    completed?: string[];
    occurrences?: { id: string; windowStartsAt: string }[];
  }) =>
    ({
      settings: {
        ...base.settings,
        ...(patch.lastWokeAt ? { lastWokeAt: patch.lastWokeAt } : { lastWokeAt: undefined })
      },
      lastEndedSessions: (patch.ended ?? []).map((endedAt) => ({ targetId: "a", endedAt, focusedMinutes: 5 })),
      completedToday: (patch.completed ?? []).map((endedAt) => ({ endedAt })) as never,
      occurrences: (patch.occurrences ?? []) as never
    }) as Parameters<typeof startFloor>[0];

  it("is nothing when nothing bounds the start", () => {
    expect(startFloor(stateWith({}))).toBeNull();
  });

  it("is the latest of the last wake and the ends of earlier sessions", () => {
    const floor = startFloor(
      stateWith({
        lastWokeAt: "2026-08-18T06:00:00.000Z",
        ended: ["2026-08-18T08:00:00.000Z", "2026-08-18T09:10:00.000Z"]
      })
    );
    expect(floor?.toISOString()).toBe("2026-08-18T09:10:00.000Z");
  });

  it("counts a routine or commitment session that ended, which lastEndedSessions leaves out", () => {
    const floor = startFloor(
      stateWith({
        lastWokeAt: "2026-08-18T06:00:00.000Z",
        ended: ["2026-08-18T08:00:00.000Z"],
        completed: ["2026-08-18T09:55:00.000Z"]
      })
    );
    expect(floor?.toISOString()).toBe("2026-08-18T09:55:00.000Z");
  });

  it("includes the window start of the recurring occurrence being started, and no other", () => {
    const state = stateWith({
      lastWokeAt: "2026-08-18T06:00:00.000Z",
      occurrences: [
        { id: "occ-1", windowStartsAt: "2026-08-18T09:30:00.000Z" },
        { id: "occ-2", windowStartsAt: "2026-08-18T09:55:00.000Z" }
      ]
    });
    expect(startFloor(state, "occ-1")?.toISOString()).toBe("2026-08-18T09:30:00.000Z");
    expect(startFloor(state, "plain-action")?.toISOString()).toBe("2026-08-18T06:00:00.000Z");
  });
});
