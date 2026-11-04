// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { render, screen } from "@/test/render";
import type { UpcomingDirectives } from "@/features/now/now-model";
import { UpcomingStrip } from "./upcoming-strip";

const now = new Date("2026-08-18T10:00:00.000Z");
const directives: UpcomingDirectives = [
  { kind: "action", targetId: "networking-section-one", title: "Draft section 1", recommendedMinutes: 45 },
  { kind: "action", targetId: "room-floor", title: "Sort the bedroom floor", recommendedMinutes: 20 }
];

describe("UpcomingStrip", () => {
  it("labels the head of the queue and the rest in order, with no invented clock times", () => {
    render(<UpcomingStrip directives={directives} state={createSeedState(now)} />);
    expect(screen.getByText("Next")).toBeTruthy();
    expect(screen.getByText("Then")).toBeTruthy();
    expect(screen.getByText(/45 min/)).toBeTruthy();
  });

  it("shows the project each queued action belongs to", () => {
    render(<UpcomingStrip directives={directives} state={createSeedState(now)} />);
    expect(screen.getByText(/^Submit Networking Assignment 2 · 45 min$/)).toBeTruthy();
    expect(screen.getByText(/^Reset and clean my room · 20 min$/)).toBeTruthy();
  });

  it("shows a queued leg with what the queue says it is for, and never a project", () => {
    render(
      <UpcomingStrip
        directives={[
          { kind: "travel", targetId: "ctx-campus", title: "Drive to Campus", recommendedMinutes: 18 },
          { kind: "action", targetId: "networking-section-one", title: "Draft section 1", recommendedMinutes: 45 }
        ]}
        state={createSeedState(now)}
      />
    );
    expect(screen.getByText("Drive to Campus · then Draft section 1")).toBeTruthy();
    expect(screen.getByText("Travel · 18 min")).toBeTruthy();
    // The leg's row carries "Travel" as its area; the project belongs to the action row after it.
    expect(screen.getAllByText(/^Travel/)).toHaveLength(1);
  });

  it("leaves a trailing leg saying only where it goes", () => {
    render(
      <UpcomingStrip
        directives={[{ kind: "travel", targetId: "ctx-home", title: "Drive home", recommendedMinutes: 25 }]}
        state={createSeedState(now)}
      />
    );
    expect(screen.getByText("Drive home")).toBeTruthy();
  });

  // The strip queued past a wake time can reach days out, and a tile with no day on it reads as the
  // morning just ahead — the reported case was a 4:33am Thursday step shown during Tuesday's sleep.
  const acrossSleep: UpcomingDirectives = [
    {
      kind: "routine_step",
      targetId: "morning-1",
      title: "Prepare uniform",
      recommendedMinutes: 5,
      at: "2026-09-02T18:33:00.000Z"
    }
  ];

  it("says the day and time of an item the engine put past the wake boundary", () => {
    render(<UpcomingStrip directives={acrossSleep} state={createSeedState(now)} />);
    expect(screen.getByText("Thu 4:33 am")).toBeTruthy();
  });

  it("reads the instant in the planning timezone, not the machine's", () => {
    const state = createSeedState(now);
    render(
      <UpcomingStrip directives={acrossSleep} state={{ ...state, settings: { ...state.settings, timezone: "UTC" } }} />
    );
    expect(screen.getByText("Wed 6:33 pm")).toBeTruthy();
  });

  it("says nothing about time on a tile the engine gave no instant", () => {
    render(<UpcomingStrip directives={directives} state={createSeedState(now)} />);
    // Without an instant the time column shows the place in the queue, never a clock or a day.
    expect(screen.queryByText(/\d:\d\d/)).toBeNull();
    expect(screen.queryByText(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/)).toBeNull();
  });
});
