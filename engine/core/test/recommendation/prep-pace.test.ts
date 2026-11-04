import { describe, expect, it } from "vitest";
import type { CurrentDirective } from "@openrhen/contracts";
import { computePrepPace } from "../../src/index.js";
import type { FixedCommitment } from "../../src/index.js";

/**
 * "Behind prep pace" arithmetic (see prep-pace.ts): requiredMinutes sums the remaining pending
 * before-phase routine-step durations plus the commitment's own setupBeforeMinutes and
 * travelBeforeMinutes; availableMinutes is the clock minutes from now until the commitment's
 * startsAt, less an arrival margin that only applies when there is an actual travel leg.
 */

const now = new Date("2026-09-04T00:00:00.000Z"); // 10:00 am local

type WireRoutineStep = Parameters<typeof computePrepPace>[0]["routineSteps"][number];

const commitment = (overrides: Partial<FixedCommitment> = {}): FixedCommitment => ({
  id: "commitment:college",
  title: "College Online",
  startsAt: new Date(now.getTime() + 30 * 60_000), // 10:30
  endsAt: new Date(now.getTime() + 90 * 60_000),
  setupBeforeMinutes: 5,
  ...overrides
});

const step = (overrides: Partial<WireRoutineStep> = {}): WireRoutineStep => ({
  id: "step:pack-bag",
  version: 1,
  commitmentId: "commitment:college",
  anchorType: "commitment",
  title: "Pack bag",
  durationMinutes: 10,
  sequence: 0,
  timingRule: "contiguous",
  energy: "medium",
  contexts: [],
  dependencyIds: [],
  phase: "before",
  status: "pending",
  scheduledStartAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
  scheduledEndAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
  ...overrides
});

const routineStepDirective = (targetId: string): CurrentDirective => ({
  kind: "routine_step",
  targetId,
  title: "Pack bag",
  recommendedMinutes: 10
});

const noneDirective: CurrentDirective = { kind: "none", title: "Nothing fits", recommendedMinutes: 0 };

describe("computePrepPace", () => {
  it("reports on_track when there is plenty of time left", () => {
    const result = computePrepPace({
      commitments: [commitment({ startsAt: new Date(now.getTime() + 60 * 60_000) })],
      routineSteps: [step()],
      now,
      arrivalMarginMinutes: 2,
      currentDirective: routineStepDirective("step:pack-bag")
    });
    // required = 10 (step) + 5 (setup) = 15; available = 60 (no travel, no margin) => 45 spare
    expect(result?.status).toBe("on_track");
    expect(result?.requiredMinutes).toBe(15);
    expect(result?.availableMinutes).toBe(60);
    expect(result?.minutesBehind).toBe(0);
  });

  it("reports tight when the spare minutes drop under 5", () => {
    // required = 15; available must land in [15, 20) to be "tight" (spare < 5, not negative)
    const result = computePrepPace({
      commitments: [commitment({ startsAt: new Date(now.getTime() + 18 * 60_000) })],
      routineSteps: [step()],
      now,
      arrivalMarginMinutes: 2,
      currentDirective: routineStepDirective("step:pack-bag")
    });
    expect(result?.requiredMinutes).toBe(15);
    expect(result?.availableMinutes).toBe(18);
    expect(result?.status).toBe("tight");
    expect(result?.minutesBehind).toBe(0);
  });

  it("reports behind, with the shortfall in minutesBehind, when required exceeds available", () => {
    // required = 10 (step) + 5 (setup) + 12 (travel) = 27; boundary = startsAt - arrivalMargin (travel > 0)
    const result = computePrepPace({
      commitments: [commitment({ startsAt: new Date(now.getTime() + 20 * 60_000), travelBeforeMinutes: 12 })],
      routineSteps: [step()],
      now,
      arrivalMarginMinutes: 3,
      currentDirective: routineStepDirective("step:pack-bag")
    });
    // available = (20 - 3) = 17; required = 27; behind by 10
    expect(result?.requiredMinutes).toBe(27);
    expect(result?.availableMinutes).toBe(17);
    expect(result?.status).toBe("behind");
    expect(result?.minutesBehind).toBe(10);
    expect(result?.commitmentTitle).toBe("College Online");
    expect(result?.commitmentId).toBe("commitment:college");
  });

  it("excludes done and skipped steps from the required minutes", () => {
    const result = computePrepPace({
      commitments: [commitment({ startsAt: new Date(now.getTime() + 60 * 60_000) })],
      routineSteps: [
        step({ id: "a", status: "completed", durationMinutes: 40 }),
        step({ id: "b", status: "skipped", durationMinutes: 40 }),
        step({ id: "c", status: "pending", durationMinutes: 8 })
      ],
      now,
      arrivalMarginMinutes: 2,
      currentDirective: noneDirective
    });
    // only step "c" counts: required = 8 + 5 (setup) = 13
    expect(result?.requiredMinutes).toBe(13);
  });

  it("counts doing and blocked steps as still remaining, alongside pending", () => {
    const result = computePrepPace({
      commitments: [commitment({ startsAt: new Date(now.getTime() + 60 * 60_000), setupBeforeMinutes: 0 })],
      routineSteps: [
        step({ id: "a", status: "doing", durationMinutes: 6 }),
        step({ id: "b", status: "blocked", durationMinutes: 4 })
      ],
      now,
      arrivalMarginMinutes: 2,
      currentDirective: noneDirective
    });
    expect(result?.requiredMinutes).toBe(10);
  });

  it("ignores after-phase steps entirely", () => {
    const result = computePrepPace({
      commitments: [commitment({ startsAt: new Date(now.getTime() + 60 * 60_000), setupBeforeMinutes: 0 })],
      routineSteps: [step({ id: "unpack", phase: "after", status: "pending", durationMinutes: 50 })],
      now,
      arrivalMarginMinutes: 2,
      currentDirective: noneDirective
    });
    // no before-phase pending step, so the chain never started: absent
    expect(result).toBeUndefined();
  });

  it("is absent when there is no commitment at all", () => {
    const result = computePrepPace({
      commitments: [],
      routineSteps: [],
      now,
      arrivalMarginMinutes: 2,
      currentDirective: noneDirective
    });
    expect(result).toBeUndefined();
  });

  it("is absent when the next commitment's prep chain has not started or come due", () => {
    // The pending step's own scheduled start is still in the future, and nothing currently directs it.
    const result = computePrepPace({
      commitments: [commitment({ startsAt: new Date(now.getTime() + 120 * 60_000) })],
      routineSteps: [
        step({
          scheduledStartAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
          scheduledEndAt: new Date(now.getTime() + 70 * 60_000).toISOString()
        })
      ],
      now,
      arrivalMarginMinutes: 2,
      currentDirective: noneDirective
    });
    expect(result).toBeUndefined();
  });

  it("is emitted once the earliest pending before-step's scheduled start is due, even with no directive naming it", () => {
    const result = computePrepPace({
      commitments: [commitment({ startsAt: new Date(now.getTime() + 60 * 60_000) })],
      routineSteps: [step({ scheduledStartAt: new Date(now.getTime() - 1 * 60_000).toISOString() })],
      now,
      arrivalMarginMinutes: 2,
      // Nothing is directing the step right now (e.g. it is gated behind an unmet prerequisite), but
      // its own window has opened, which is enough to say the chain is under way.
      currentDirective: noneDirective
    });
    expect(result).toBeDefined();
    expect(result?.commitmentId).toBe("commitment:college");
  });

  it("is absent when a commitment has no pending routine steps at all", () => {
    const result = computePrepPace({
      commitments: [commitment({ startsAt: new Date(now.getTime() + 60 * 60_000) })],
      routineSteps: [step({ status: "completed" })],
      now,
      arrivalMarginMinutes: 2,
      currentDirective: noneDirective
    });
    expect(result).toBeUndefined();
  });

  it("follows the live routine_step directive even when a nearer commitment's own due step would otherwise win", () => {
    const nearer = commitment({
      id: "commitment:nearer",
      title: "Nearer thing",
      startsAt: new Date(now.getTime() + 5 * 60_000)
    });
    const later = commitment({ startsAt: new Date(now.getTime() + 60 * 60_000) });
    const result = computePrepPace({
      commitments: [nearer, later],
      routineSteps: [
        step({ id: "nearer-step", commitmentId: "commitment:nearer" }), // due, belongs to the nearer commitment
        step() // belongs to `later` (commitment:college), and is what the live directive names
      ],
      now,
      arrivalMarginMinutes: 2,
      currentDirective: routineStepDirective("step:pack-bag")
    });
    expect(result?.commitmentId).toBe("commitment:college");
  });

  it("with no waits and no doing step, projectedArriveAt/projectedLateMinutes reproduce today's figures", () => {
    const result = computePrepPace({
      commitments: [commitment({ startsAt: new Date(now.getTime() + 60 * 60_000) })],
      routineSteps: [step()],
      now,
      arrivalMarginMinutes: 2,
      currentDirective: routineStepDirective("step:pack-bag")
    });
    // required = 15 (10 step + 5 setup), no travel so margin = 0: arrive exactly on required minutes,
    // never late.
    expect(result?.projectedArriveAt).toBe(new Date(now.getTime() + 15 * 60_000).toISOString());
    expect(result?.projectedLateMinutes).toBe(0);
  });

  it("a running wait from completedAt pushes projectedArriveAt out by however much of it remains", () => {
    const result = computePrepPace({
      commitments: [commitment({ startsAt: new Date(now.getTime() + 120 * 60_000), setupBeforeMinutes: 5 })],
      routineSteps: [
        // Completed 2 minutes ago, but its own 90-minute wait is still running: a dependent may not
        // start before the wait ends, 88 minutes from now.
        step({
          id: "wash",
          status: "completed",
          completedAt: new Date(now.getTime() - 2 * 60_000).toISOString(),
          waitAfterMinutes: 90,
          dependencyIds: []
        }),
        step({ id: "pack", dependencyIds: ["wash"] })
      ],
      now,
      arrivalMarginMinutes: 2,
      currentDirective: routineStepDirective("pack")
    });
    // pack starts at now+88 (the wash's own wait end), runs 10 minutes -> readyAt = now+98; plus the
    // commitment's 5-minute setup (no travel) = now+103.
    expect(result?.projectedArriveAt).toBe(new Date(now.getTime() + 103 * 60_000).toISOString());
  });

  it("a doing step's remainder is its hands-on minutes less what the open session on it has already run", () => {
    const result = computePrepPace({
      commitments: [commitment({ startsAt: new Date(now.getTime() + 60 * 60_000), setupBeforeMinutes: 0 })],
      routineSteps: [step({ id: "shower", status: "doing", durationMinutes: 20 })],
      now,
      arrivalMarginMinutes: 2,
      currentDirective: routineStepDirective("shower"),
      activeSession: {
        id: "session:1",
        actionId: "shower",
        status: "running",
        targetType: "routine_step",
        targetId: "shower",
        startedAt: new Date(now.getTime() - 10 * 60_000).toISOString(),
        plannedEndAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
        plannedMinutes: 20,
        remainingBeforeMinutes: 10,
        activeElapsedSeconds: 600
      }
    });
    // 20 minutes hands-on less 10 already run = 10 remaining; no setup/travel (setupBeforeMinutes: 0,
    // no travel) so projectedArriveAt is exactly now+10.
    expect(result?.projectedArriveAt).toBe(new Date(now.getTime() + 10 * 60_000).toISOString());
    expect(result?.requiredMinutes).toBe(10);
  });

  it("reports projectedLateMinutes > 0 when the projected arrival falls after startsAt", () => {
    const result = computePrepPace({
      commitments: [commitment({ startsAt: new Date(now.getTime() + 20 * 60_000), travelBeforeMinutes: 12 })],
      routineSteps: [step()],
      now,
      arrivalMarginMinutes: 3,
      currentDirective: routineStepDirective("step:pack-bag")
    });
    // Same figures as "reports behind" above (required 27, available 17): projectedArriveAt (now+27)
    // - startsAt (now+20) = 7 minutes late; the 3-minute margin counts toward minutesBehind, not late.
    expect(result?.projectedLateMinutes).toBe(7);
  });
});
