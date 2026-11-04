import { describe, expect, it } from "vitest";
import { PLAN_FORECAST_CONTRACT_VERSION, planForecastRequestSchema, portalStateSchema } from "@openrhen/contracts";
import { calculatePlanAndForecast } from "../../src/index.js";

const now = new Date("2026-08-14T04:00:00.000Z");

function baseState(overrides: Record<string, unknown> = {}) {
  return portalStateSchema.parse({
    settings: {
      timezone: "Australia/Sydney",
      planningHorizonEnd: "22:00",
      defaultUsableFraction: 0.85,
      defaultSetupBufferMinutes: 0,
      defaultTransitionBufferMinutes: 0,
      submissionBufferMinutes: 0,
      submissionBufferPercent: 0,
      energyMeanings: { high: "high", medium: "medium", low: "low", recovery: "recovery" },
      estimateBucketsMinutes: [15, 30, 60],
      conditionCatalog: ["home"],
      preferredBedtime: "23:00",
      preferredWakeTime: "07:00",
      desiredSleepMinutes: 480,
      minimumSleepMinutes: 420,
      maxAwakeHours: 16
    },
    areas: [],
    outcomes: [],
    projects: [],
    actions: [],
    commitments: [],
    routineSteps: [],
    routinePresets: [],
    occurrences: [],
    sleepPlans: [],
    captures: [],
    completedToday: [],
    assertedConditions: ["home"],
    currentEnergy: "medium",
    horizonEnd: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
    activeSession: null,
    ...overrides
  });
}

function request(state: ReturnType<typeof baseState>) {
  return planForecastRequestSchema.parse({
    contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
    requestId: "00000000-0000-4000-8000-000000000002",
    inputVersion: "current-directive-fixture",
    calculatedAt: now.toISOString(),
    horizonEnd: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
    state
  });
}

describe("current directive priority", () => {
  it("keeps an active recurring commitment as the directive instead of falling through to sleep", () => {
    const state = baseState({
      commitmentRecurrenceRules: [
        {
          id: "standing-meeting",
          title: "Standing meeting",
          timezone: "Australia/Sydney",
          startDate: "2026-08-01",
          repeat: { unit: "days", intervalDays: 1 },
          localStartTime: "14:00",
          localEndTime: "15:00",
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0,
          status: "active"
        }
      ],
      // A currently-active sleep session that would previously win by default once the recurring
      // commitment was (incorrectly) never recognized as a protected commitment.
      sleepPlans: [
        {
          id: "current-sleep",
          plannedStartAt: new Date(now.getTime() - 30 * 60_000).toISOString(),
          plannedWakeAt: new Date(now.getTime() + 5 * 60 * 60_000).toISOString(),
          desiredMinutes: 480,
          allowedMinutes: 480,
          sleepDeficitMinutes: 0,
          anchorDeviationMinutes: 0,
          hardErrors: [],
          explanation: "test fixture",
          status: "sleeping"
        }
      ]
    });
    const response = calculatePlanAndForecast(request(state));
    expect(response.currentDirective.kind).not.toBe("sleep");
    expect(response.currentDirective.title).toContain("Standing meeting");
  });
});

describe("upcoming directives", () => {
  it("lists the next pending routine steps in sequence after the current one", () => {
    const state = baseState({
      // The commitment starts in 30 minutes; the engine now places these flexible before-phase steps
      // itself, stacking them contiguously backward from that start (10 + 5 + 15 + 5 = 35 minutes),
      // so "Eat breakfast" (step-1) lands straddling `now` and the rest fall after it — the same shape
      // the old hand-set `scheduledStartAt`s used to assert directly.
      commitments: [
        {
          id: "morning-commitment",
          title: "Work",
          status: "confirmed",
          startsAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
          endsAt: new Date(now.getTime() + 90 * 60_000).toISOString(),
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0
        }
      ],
      routineSteps: [
        {
          id: "step-0",
          commitmentId: "morning-commitment",
          title: "Prepare uniform",
          durationMinutes: 5,
          sequence: 0,
          timingRule: "flexible",
          energy: "medium",
          contexts: [],
          status: "completed",
          scheduledStartAt: new Date(now.getTime() - 10 * 60_000).toISOString(),
          scheduledEndAt: new Date(now.getTime() - 5 * 60_000).toISOString()
        },
        {
          id: "step-1",
          commitmentId: "morning-commitment",
          title: "Eat breakfast",
          durationMinutes: 10,
          sequence: 1,
          timingRule: "flexible",
          energy: "medium",
          contexts: [],
          status: "pending"
        },
        {
          id: "step-2",
          commitmentId: "morning-commitment",
          title: "Get drink bottle",
          durationMinutes: 5,
          sequence: 2,
          timingRule: "flexible",
          energy: "medium",
          contexts: [],
          status: "pending"
        },
        {
          id: "step-3",
          commitmentId: "morning-commitment",
          title: "Shower and get dressed",
          durationMinutes: 15,
          sequence: 3,
          timingRule: "flexible",
          energy: "medium",
          contexts: [],
          status: "pending"
        },
        {
          id: "step-4",
          commitmentId: "morning-commitment",
          title: "Brush teeth",
          durationMinutes: 5,
          sequence: 4,
          timingRule: "flexible",
          energy: "medium",
          contexts: [],
          status: "pending"
        }
      ]
    });
    const response = calculatePlanAndForecast(request(state));
    expect(response.currentDirective.kind).toBe("routine_step");
    expect(response.currentDirective.title).toBe("Eat breakfast");
    expect(response.upcomingDirectives.map((item) => item.title)).toEqual([
      "Get drink bottle",
      "Shower and get dressed",
      "Brush teeth"
    ]);
    expect(response.upcomingDirectives).toHaveLength(3);
    // A sequence runs on from the current step, so there is no boundary to be ambiguous about and no
    // instant to carry.
    expect(response.upcomingDirectives.every((item) => item.at === undefined)).toBe(true);
  });

  it("falls back to the plan's next-best actions when the directive is not a routine", () => {
    const state = baseState({
      areas: [{ id: "area-1", name: "Area", status: "active", sortOrder: 0 }],
      outcomes: [
        { id: "outcome-1", areaId: "area-1", title: "Outcome", definitionOfDone: "Done", value: 3, status: "active" }
      ],
      projects: [
        {
          id: "project-1",
          title: "Project one",
          area: "area-1",
          outcomeId: "outcome-1",
          status: "active",
          uncertainty: "known",
          value: 3,
          consequence: 3
        }
      ],
      actions: [
        {
          id: "action-1",
          projectId: "project-1",
          title: "First action",
          status: "active",
          optimisticMinutes: 10,
          expectedMinutes: 15,
          remainingMinutes: 15,
          pessimisticMinutes: 30,
          energy: "medium",
          minimumSessionMinutes: 5,
          maximumSessionMinutes: 60,
          importance: 3,
          consequence: 3,
          contexts: [],
          dependencyIds: [],
          splittable: true,
          setupMinutes: 0,
          schedulingMode: "one_off"
        },
        {
          id: "action-2",
          projectId: "project-1",
          title: "Second action",
          status: "active",
          optimisticMinutes: 10,
          expectedMinutes: 15,
          remainingMinutes: 15,
          pessimisticMinutes: 30,
          energy: "medium",
          minimumSessionMinutes: 5,
          maximumSessionMinutes: 60,
          importance: 3,
          consequence: 2,
          contexts: [],
          dependencyIds: [],
          splittable: true,
          setupMinutes: 0,
          schedulingMode: "one_off"
        }
      ]
    });
    const response = calculatePlanAndForecast(request(state));
    expect(response.currentDirective.kind).toBe("action");
    expect(response.upcomingDirectives.some((item) => item.title === "Second action")).toBe(true);
  });

  it("looks past the wake time to the morning routine and next commitment while asleep", () => {
    const wakeAt = new Date(now.getTime() + 2 * 60 * 60_000);
    const state = baseState({
      sleepPlans: [
        {
          id: "sleep-1",
          plannedStartAt: new Date(now.getTime() - 30 * 60_000).toISOString(),
          plannedWakeAt: wakeAt.toISOString(),
          desiredMinutes: 480,
          allowedMinutes: 480,
          sleepDeficitMinutes: 0,
          anchorDeviationMinutes: 0,
          hardErrors: [],
          explanation: "test fixture",
          status: "sleeping"
        }
      ],
      commitments: [
        {
          id: "work",
          title: "Work",
          status: "confirmed",
          startsAt: new Date(wakeAt.getTime() + 60 * 60_000).toISOString(),
          endsAt: new Date(wakeAt.getTime() + 2 * 60 * 60_000).toISOString(),
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0
        }
      ],
      routineSteps: [
        {
          id: "morning-1",
          commitmentId: "work",
          title: "Prepare uniform",
          durationMinutes: 5,
          sequence: 0,
          timingRule: "flexible",
          energy: "medium",
          contexts: [],
          status: "pending"
        },
        {
          id: "morning-2",
          commitmentId: "work",
          title: "Eat breakfast",
          durationMinutes: 10,
          sequence: 1,
          timingRule: "flexible",
          energy: "medium",
          contexts: [],
          status: "pending"
        }
      ]
    });
    const response = calculatePlanAndForecast(request(state));
    expect(response.currentDirective.kind).toBe("sleep");
    expect(response.upcomingDirectives.map((item) => item.title)).toEqual(["Prepare uniform", "Eat breakfast", "Work"]);
    expect(response.upcomingDirectives[2]).toMatchObject({ kind: "commitment", targetId: "work" });
    // Each item keeps the instant it starts at; past the wake time it is the only thing saying which
    // day the item belongs to. The engine now places these two flexible before-phase steps itself,
    // stacking them contiguously backward from the commitment's own start (5 + 10 minutes), so they
    // land immediately before it rather than immediately after wake.
    expect(response.upcomingDirectives.map((item) => item.at)).toEqual([
      new Date(wakeAt.getTime() + 45 * 60_000).toISOString(),
      new Date(wakeAt.getTime() + 50 * 60_000).toISOString(),
      new Date(wakeAt.getTime() + 60 * 60_000).toISOString()
    ]);
  });

  // Finding 18: the "next thing after wake" lookup used to read `state.commitments` directly, which
  // never carries a recurring commitment's materialized occurrence — only literal commitments land
  // there. The test above proves the literal case works; this is the same scenario with the
  // commitment expressed as a recurring rule instead, so the only commitment in force is one whose id
  // never appears in `state.commitments` at all.
  it("looks past the wake time to a recurring commitment's repeat while asleep", () => {
    const wakeAt = new Date(now.getTime() + 2 * 60 * 60_000); // 16:00 local
    const state = baseState({
      sleepPlans: [
        {
          id: "sleep-1",
          plannedStartAt: new Date(now.getTime() - 30 * 60_000).toISOString(),
          plannedWakeAt: wakeAt.toISOString(),
          desiredMinutes: 480,
          allowedMinutes: 480,
          sleepDeficitMinutes: 0,
          anchorDeviationMinutes: 0,
          hardErrors: [],
          explanation: "test fixture",
          status: "sleeping"
        }
      ],
      // No literal commitments at all — the only commitment in force comes from the recurring rule.
      commitments: [],
      commitmentRecurrenceRules: [
        {
          id: "standing-work",
          title: "Standing work block",
          timezone: "Australia/Sydney",
          startDate: "2026-08-01",
          repeat: { unit: "days", intervalDays: 1 },
          localStartTime: "17:00",
          localEndTime: "18:00",
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0,
          status: "active"
        }
      ]
    });
    const response = calculatePlanAndForecast(request(state));
    expect(response.currentDirective.kind).toBe("sleep");
    const upcomingCommitment = response.upcomingDirectives.find((item) => item.kind === "commitment");
    expect(upcomingCommitment).toBeDefined();
    expect(upcomingCommitment?.title).toBe("Standing work block");
    // 17:00 local, an hour after the 16:00 local wake — matching the recurring rule's own clock.
    expect(upcomingCommitment?.at).toBe(new Date(wakeAt.getTime() + 60 * 60_000).toISOString());
  });

  // The "completed sleep plan still produced a sleep directive" case is covered by the promoted
  // snapshot fixture in `engine/core/test/snapshot-replay/`, not here: a hand-built plan that is not
  // `sleeping` does not survive the engine's own sleep derivation, so a synthetic fixture cannot
  // reach the branch at all. The captured request does.

  // Reported from a real snapshot: at 4:37pm the directive was "get drink bottle" — a step from that
  // morning's finished shift, left pending because it was never ticked off. With only a lower bound
  // on the schedule, a stale step stays current indefinitely.
  it("drops a routine step whose scheduled window has already passed", () => {
    const past = new Date(now.getTime() - 8 * 60 * 60_000);
    const state = baseState({
      commitments: [
        {
          id: "yesterday",
          title: "Work",
          status: "confirmed",
          startsAt: past.toISOString(),
          endsAt: new Date(past.getTime() + 3 * 60 * 60_000).toISOString(),
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0
        }
      ],
      routineSteps: [
        {
          id: "stale",
          commitmentId: "yesterday",
          title: "Get drink bottle",
          durationMinutes: 5,
          sequence: 2,
          timingRule: "flexible",
          maxLeadMinutes: 900,
          energy: "medium",
          contexts: [],
          status: "pending",
          scheduledStartAt: new Date(past.getTime() - 60 * 60_000).toISOString(),
          scheduledEndAt: new Date(past.getTime() - 55 * 60_000).toISOString()
        }
      ]
    });
    const response = calculatePlanAndForecast(request(state));
    expect(response.currentDirective.kind).not.toBe("routine_step");
  });

  it("prefers the step that is due now over a lower sequence number belonging to a later commitment", () => {
    // Sequence is per-commitment, so ordering by it alone let a lower-sequence step outrank the step
    // actually due now. Each commitment carries a single before-phase step, so the engine's own
    // backward placement pins it immediately before that commitment's own start — to make both
    // genuinely due at once (the scenario the bug needs), both commitments start within minutes of
    // `now`, "today"'s sooner than "tomorrow"'s, so "due-now"'s placed start lands earlier than
    // "later-first"'s even though its sequence number is higher.
    const state = baseState({
      commitments: [
        {
          id: "today",
          title: "Work today",
          status: "confirmed",
          startsAt: new Date(now.getTime() + 2 * 60_000).toISOString(),
          endsAt: new Date(now.getTime() + 122 * 60_000).toISOString(),
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0
        },
        {
          id: "tomorrow",
          title: "Work tomorrow",
          status: "confirmed",
          startsAt: new Date(now.getTime() + 14 * 60_000).toISOString(),
          endsAt: new Date(now.getTime() + 134 * 60_000).toISOString(),
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0
        }
      ],
      routineSteps: [
        {
          id: "due-now",
          commitmentId: "today",
          title: "Get drink bottle",
          durationMinutes: 5,
          sequence: 2,
          timingRule: "flexible",
          energy: "medium",
          contexts: [],
          status: "pending"
        },
        {
          id: "later-first",
          commitmentId: "tomorrow",
          title: "Prepare uniform",
          durationMinutes: 15,
          sequence: 0,
          timingRule: "flexible",
          maxLeadMinutes: 900,
          energy: "medium",
          contexts: [],
          status: "pending"
        }
      ]
    });
    const response = calculatePlanAndForecast(request(state));
    expect(response.currentDirective).toMatchObject({ kind: "routine_step", targetId: "due-now" });
  });
});

// Step windows are static — back-chained from the commitment start, never re-flowed when the user
// runs late. Reported from a real snapshot: at 5:29am the overdue "Prepare uniform" had
// fallen out of its window, the directive advanced to "Shower and get dressed", and the server's
// dependency gate refused the Start it offered. The directive must walk back from the in-window
// step to the earliest still-pending prerequisite, so it only ever names a step that can start.
describe("routine step prerequisites", () => {
  const step = (overrides: Record<string, unknown>) => ({
    commitmentId: "shift",
    durationMinutes: 15,
    timingRule: "flexible" as const,
    energy: "medium" as const,
    contexts: [],
    status: "pending" as const,
    ...overrides
  });
  const shiftState = (routineSteps: Record<string, unknown>[], startsInMinutes = 60) =>
    baseState({
      commitments: [
        {
          id: "shift",
          title: "Work",
          status: "confirmed",
          startsAt: new Date(now.getTime() + startsInMinutes * 60_000).toISOString(),
          endsAt: new Date(now.getTime() + (startsInMinutes + 180) * 60_000).toISOString(),
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0
        }
      ],
      routineSteps
    });

  it("directs the overdue pending prerequisite instead of the in-window step that depends on it", () => {
    // The commitment starts in 10 minutes; the engine's own backward placement stacks the two
    // 15-minute steps contiguously against that start, landing "shower" straddling `now` and
    // "prepare" (its prerequisite) entirely in the past — the in/out-of-window shape the old
    // hand-set `scheduledStartAt`s used to assert directly.
    const state = shiftState(
      [
        step({
          id: "prepare",
          title: "Prepare uniform",
          sequence: 0
        }),
        step({
          id: "shower",
          title: "Shower and get dressed",
          sequence: 3,
          dependencyIds: ["prepare"]
        })
      ],
      10
    );
    const response = calculatePlanAndForecast(request(state));
    expect(response.currentDirective).toMatchObject({ kind: "routine_step", targetId: "prepare" });
  });

  it("keeps the in-window step when its prerequisite is already completed", () => {
    // "prepare" is completed, so it takes no time in the engine's backward walk and "shower" alone
    // is stacked against the commitment's start (10 minutes out), landing it straddling `now`.
    const state = shiftState(
      [
        step({
          id: "prepare",
          title: "Prepare uniform",
          sequence: 0,
          status: "completed"
        }),
        step({
          id: "shower",
          title: "Shower and get dressed",
          sequence: 3,
          dependencyIds: ["prepare"]
        })
      ],
      10
    );
    const response = calculatePlanAndForecast(request(state));
    expect(response.currentDirective).toMatchObject({ kind: "routine_step", targetId: "shower" });
  });

  it("still excludes a finished shift's stale pending steps — no in-window step, no walk-back", () => {
    // The bcd354d6 guard: without an in-window step there is nothing to walk dependencies from, so
    // the leftover pending steps of a shift that already happened stay out of the directive.
    const past = new Date(now.getTime() - 8 * 60 * 60_000);
    const state = baseState({
      commitments: [
        {
          id: "shift",
          title: "Work",
          status: "confirmed",
          startsAt: past.toISOString(),
          endsAt: new Date(past.getTime() + 3 * 60 * 60_000).toISOString(),
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0
        }
      ],
      routineSteps: [
        step({
          id: "prepare",
          title: "Prepare uniform",
          sequence: 0,
          scheduledStartAt: new Date(past.getTime() - 60 * 60_000).toISOString(),
          scheduledEndAt: new Date(past.getTime() - 45 * 60_000).toISOString()
        }),
        step({
          id: "shower",
          title: "Shower and get dressed",
          sequence: 3,
          dependencyIds: ["prepare"],
          scheduledStartAt: new Date(past.getTime() - 45 * 60_000).toISOString(),
          scheduledEndAt: new Date(past.getTime() - 15 * 60_000).toISOString()
        })
      ]
    });
    const response = calculatePlanAndForecast(request(state));
    expect(response.currentDirective.kind).not.toBe("routine_step");
  });

  it("walks a chain of pending prerequisites and directs the earliest one", () => {
    // Three 15-minute steps chained by dependency, stacked contiguously against a commitment
    // starting in 10 minutes: "shower" straddles `now`, and both of its transitive prerequisites
    // ("drink-bottle", "prepare") are already overdue — "prepare" the earliest of the two.
    const state = shiftState(
      [
        step({
          id: "prepare",
          title: "Prepare uniform",
          sequence: 0
        }),
        step({
          id: "drink-bottle",
          title: "Get drink bottle",
          sequence: 2,
          dependencyIds: ["prepare"]
        }),
        step({
          id: "shower",
          title: "Shower and get dressed",
          sequence: 3,
          dependencyIds: ["drink-bottle"]
        })
      ],
      10
    );
    const response = calculatePlanAndForecast(request(state));
    expect(response.currentDirective).toMatchObject({ kind: "routine_step", targetId: "prepare" });
  });
});

/**
 * Finding 18: the cached plan's `validUntil` used to be bounded by commitment edges read straight
 * from `state.commitments`, which never carries a recurring commitment's materialized occurrence. A
 * stale plan could then be served straight through a recurring commitment's own start or end, since
 * nothing said the plan needed recalculating there.
 */
describe("plan validity boundary", () => {
  it("is bounded by a recurring commitment's repeat, not just literal commitments", () => {
    const state = baseState({
      // No literal commitments — the only commitment in force comes from the recurring rule, so
      // reading state.commitments alone would find no boundary here at all.
      commitments: [],
      commitmentRecurrenceRules: [
        {
          id: "standing-work",
          title: "Standing work block",
          timezone: "Australia/Sydney",
          startDate: "2026-08-01",
          repeat: { unit: "days", intervalDays: 1 },
          // now is 14:00 local; the occurrence starts 45 minutes out, inside the 60-minute default
          // validity ceiling, so it — not the ceiling — must be what binds.
          localStartTime: "14:45",
          localEndTime: "15:15",
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0,
          status: "active"
        }
      ]
    });
    const response = calculatePlanAndForecast(request(state));
    const occurrenceStartsAt = new Date(now.getTime() + 45 * 60_000);
    expect(new Date(response.validUntil).getTime()).toBe(occurrenceStartsAt.getTime());
  });
});

describe("wake-purpose routine step directive", () => {
  // Regression guard: a wake-anchored `routine_step` row is offered as the current directive
  // through the exact same `routine_step` branch a commitment-anchored or bedtime-anchored step uses —
  // `selectCurrentDirective` carries no anchor-specific special-casing at all. Nothing else pins that
  // today, so this fails loudly if that branch is ever narrowed to a particular anchor.
  it("is offered as the current directive through the same branch a bedtime step uses, with no special-casing", () => {
    const wakePreset = {
      id: "66666666-6666-4666-8666-666666666666",
      version: 1,
      name: "Wake",
      activityName: "Morning routine",
      status: "active" as const,
      steps: [
        {
          id: "wake-step",
          title: "Stretch",
          durationMinutes: 30,
          sequence: 0,
          timingRule: "contiguous" as const,
          energy: "low" as const,
          contexts: [],
          dependencyIds: [],
          phase: "before" as const
        }
      ]
    };
    // A sleep plan already marked "completed" (the "I'm awake" transition) a few minutes ago, so
    // `now` falls inside the wake instance's window but the plan itself carries no live "sleeping"
    // session that would otherwise claim the directive first (directive.ts line 175).
    const actualWakeAt = new Date(now.getTime() - 5 * 60_000);
    const state = baseState({
      settings: {
        timezone: "Australia/Sydney",
        planningHorizonEnd: "22:00",
        defaultUsableFraction: 0.85,
        defaultSetupBufferMinutes: 0,
        defaultTransitionBufferMinutes: 0,
        submissionBufferMinutes: 0,
        submissionBufferPercent: 0,
        energyMeanings: { high: "high", medium: "medium", low: "low", recovery: "recovery" },
        estimateBucketsMinutes: [15, 30, 60],
        conditionCatalog: ["home"],
        preferredBedtime: "23:00",
        preferredWakeTime: "07:00",
        desiredSleepMinutes: 480,
        minimumSleepMinutes: 420,
        maxAwakeHours: 16,
        wakeRoutinePresetId: wakePreset.id
      },
      routinePresets: [wakePreset],
      sleepPlans: [
        {
          id: "completed-sleep",
          plannedStartAt: new Date(actualWakeAt.getTime() - 8 * 60 * 60_000).toISOString(),
          plannedWakeAt: actualWakeAt.toISOString(),
          desiredMinutes: 480,
          allowedMinutes: 480,
          sleepDeficitMinutes: 0,
          anchorDeviationMinutes: 0,
          hardErrors: [],
          explanation: "test fixture",
          status: "completed",
          actualStartAt: new Date(actualWakeAt.getTime() - 8 * 60 * 60_000).toISOString(),
          actualWakeAt: actualWakeAt.toISOString()
        }
      ]
    });
    const response = calculatePlanAndForecast(request(state));
    expect(response.currentDirective.kind).toBe("routine_step");
    expect(response.currentDirective.title).toBe("Stretch");
  });
});
