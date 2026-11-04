import { describe, expect, it, vi } from "vitest";
import { createSeedState } from "@/state/portal-state";
import type { StoredRoutineStep } from "@/state/portal-state";
import { completeStep, doneStartedAt, nextTaskTitle, recordedUpTo } from "./wake-commands";

const now = new Date("2026-08-18T22:00:00.000Z");
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();
const step = { id: "wake-step-0", version: 2, durationMinutes: 10 } as StoredRoutineStep;

describe("doneStartedAt", () => {
  it("starts the step its planned minutes ago when nothing recorded is in the way", () => {
    expect(doneStartedAt(step, now, at(-120))).toBe(at(-10));
    expect(doneStartedAt(step, now, undefined)).toBe(at(-10));
  });

  it("never starts inside recorded time: the previous session's end wins", () => {
    expect(doneStartedAt(step, now, at(-4))).toBe(at(-4));
  });

  it("never goes below the recorded boundary, even when the clock estimate trails it", () => {
    // The offset is rounded to whole seconds, so the estimate can sit a moment before the last end.
    expect(doneStartedAt(step, now, at(2))).toBe(at(2));
    expect(doneStartedAt(step, now, new Date(now.getTime() + 500).toISOString())).toBe(
      new Date(now.getTime() + 500).toISOString()
    );
  });
});

describe("recordedUpTo", () => {
  it("is the latest of today's session ends, the per-target ends and the last wake", () => {
    const base = createSeedState(now);
    const state = {
      ...base,
      settings: { ...base.settings, lastWokeAt: at(-60) },
      completedToday: [{ endedAt: at(-30) }, { endedAt: at(-15) }],
      lastEndedSessions: [{ targetId: "a", endedAt: at(-20), focusedMinutes: 5 }]
    } as unknown as Parameters<typeof recordedUpTo>[0];
    expect(recordedUpTo(state)).toBe(at(-15));
    expect(recordedUpTo({ ...state, completedToday: [], lastEndedSessions: [] })).toBe(at(-60));
  });

  it("is undefined with nothing recorded", () => {
    const base = createSeedState(now);
    const state = { ...base, settings: { ...base.settings, lastWokeAt: undefined }, completedToday: [] };
    expect(recordedUpTo({ ...state, lastEndedSessions: [] })).toBeUndefined();
  });
});

describe("completeStep", () => {
  it("backfills the start, clamped to the record, then finishes the same session", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    await completeStep(step, run, at(-3), now);
    const [start, finish] = run.mock.calls.map((call) => call[0]);
    expect(start).toMatchObject({ type: "start_activity", plannedMinutes: 10, startedAt: at(-3) });
    expect(finish).toMatchObject({ type: "finish_activity", sessionId: start.commandId, outcome: "completed" });
  });
});

describe("nextTaskTitle", () => {
  // A queue shaped like real engine output during the wake routine: the routine's own siblings only,
  // and nothing at all on the last step. The projected day is where the work shows.
  const siblingsOnly = [{ kind: "routine_step", title: "Water" }];
  const dayPlan = [
    { kind: "routine_step", title: "Meds" },
    { kind: "gap", title: "Free" },
    { kind: "action", title: "Write the report" },
    { kind: "action", title: "Later thing" }
  ];

  it("takes the first planned work after the routine when the recommendation is null", () => {
    expect(nextTaskTitle(null, dayPlan)).toBe("Write the report");
    expect(nextTaskTitle(undefined, dayPlan)).toBe("Write the report");
  });

  it("does not mistake the routine's siblings for a task", () => {
    expect(nextTaskTitle(null, siblingsOnly)).toBeUndefined();
    expect(nextTaskTitle(null, [])).toBeUndefined();
    expect(nextTaskTitle(null, undefined)).toBeUndefined();
  });

  it("prefers the day plan so every step of the routine names the same task", () => {
    expect(nextTaskTitle({ action: { title: "Last-step pick" } }, dayPlan)).toBe("Write the report");
  });

  it("falls back to the recommendation when the day plan holds no work", () => {
    expect(nextTaskTitle({ action: { title: "Pick me" } }, siblingsOnly)).toBe("Pick me");
    expect(nextTaskTitle({ action: { title: "Pick me" } }, undefined)).toBe("Pick me");
  });
});

describe("Done against a browser clock that trails the server", () => {
  it("starts on the recorded boundary however the clock estimate sits against it", async () => {
    // The server's now is 22:00 and a session ended on the server at 21:59; the browser reads 21:57.
    // The boundary wins on either clock, so the server never sees an overlap.
    const browserNow = new Date(now.getTime() - 3 * 60_000);
    expect(doneStartedAt(step, browserNow, at(-1))).toBe(at(-1));
    expect(doneStartedAt(step, now, at(-1))).toBe(at(-1));
    const run = vi.fn().mockResolvedValue(undefined);
    await completeStep(step, run, at(-1), now);
    expect(run.mock.calls[0]![0].startedAt).toBe(at(-1));
  });
});
