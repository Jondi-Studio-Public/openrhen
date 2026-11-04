import { describe, expect, it } from "vitest";
import { PLAN_FORECAST_CONTRACT_VERSION, planForecastRequestSchema, portalStateSchema } from "@openrhen/contracts";
import { calculatePlanAndForecast } from "../../src/index.js";

/**
 * The routine step timing design note: the engine is now the only author of a pending routine
 * step's placement, derived fresh every run (`deriveCommitmentRoutineSteps`) and placed by
 * `scheduling/routine-placement.ts`'s `placeRoutineChains` inside both projection passes. This
 * fixture is the wash (5, wait 90) -> hang out (5, wait 240) -> pack chain the plan's own Tests
 * section names: a work commitment tomorrow at 07:00 UTC, an "office" location whose default preset
 * resolves for it ('inherit'), and an evening band (`DEFAULT_TIME_BANDS`, 17:00-22:00 local) both
 * flexible steps prefer.
 */

const now = new Date("2026-08-14T08:00:00.000Z");
const MIN = 60_000;
const HOUR = 3_600_000;
const iso = (offsetMs: number) => new Date(now.getTime() + offsetMs).toISOString();

const washPreset = {
  id: "wash-preset",
  version: 1,
  name: "Wash chain",
  activityName: "Wash chain",
  status: "active" as const,
  replacesWakeRoutine: false,
  steps: [
    {
      id: "wash-step",
      title: "Wash",
      durationMinutes: 5,
      sequence: 0,
      timingRule: "flexible" as const,
      maxLeadMinutes: 720,
      energy: "low" as const,
      contexts: [],
      dependencyIds: [],
      phase: "before" as const,
      waitAfterMinutes: 90,
      preferredBands: ["evening"]
    },
    {
      id: "hangout-step",
      title: "Hang out washing",
      durationMinutes: 5,
      sequence: 1,
      timingRule: "flexible" as const,
      maxLeadMinutes: 720,
      energy: "low" as const,
      contexts: [],
      dependencyIds: ["wash-step"],
      phase: "before" as const,
      waitAfterMinutes: 240,
      preferredBands: ["evening"]
    },
    {
      id: "pack-step",
      title: "Pack bag",
      durationMinutes: 5,
      sequence: 2,
      timingRule: "contiguous" as const,
      energy: "low" as const,
      contexts: [],
      dependencyIds: ["hangout-step"],
      phase: "before" as const
    }
  ]
};

function baseState(overrides: Record<string, unknown> = {}) {
  return portalStateSchema.parse({
    settings: {
      timezone: "UTC",
      planningHorizonEnd: "22:00",
      defaultUsableFraction: 1,
      defaultSetupBufferMinutes: 0,
      defaultTransitionBufferMinutes: 0,
      submissionBufferMinutes: 0,
      submissionBufferPercent: 0,
      energyMeanings: { high: "high", medium: "medium", low: "low", recovery: "recovery" },
      estimateBucketsMinutes: [15, 30, 60],
      conditionCatalog: ["office"],
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
    routinePresets: [washPreset],
    conditionDefinitions: [
      { id: "office", name: "Office", kind: "location", status: "active", defaultRoutinePresetId: "wash-preset" }
    ],
    occurrences: [],
    sleepPlans: [],
    captures: [],
    completedToday: [],
    assertedConditions: [],
    currentEnergy: "medium",
    horizonEnd: iso(3 * 24 * HOUR),
    activeSession: null,
    // These cases are about step timing, not travel: standing at the office means the commitment needs
    // no journey (an unlocated person with no home would otherwise be given the assumed one).
    currentSituation: { locationId: "office", locationSetAt: now.toISOString(), transportModes: [] },
    ...overrides
  });
}

function request(state: ReturnType<typeof baseState>) {
  return planForecastRequestSchema.parse({
    contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
    requestId: "00000000-0000-4000-8000-0000000000a5",
    inputVersion: "routine-step-timing-fixture",
    calculatedAt: now.toISOString(),
    horizonEnd: iso(3 * 24 * HOUR),
    state
  });
}

function routineStepsOf(response: ReturnType<typeof calculatePlanAndForecast>) {
  return response.derivedState.routineSteps as Array<Record<string, unknown>>;
}

describe("routine step timing: wash -> hang out -> pack", () => {
  it("places every pending step against the commitment's own timeline, ignoring a stale stored placement", () => {
    const state = baseState({
      commitments: [
        {
          id: "work",
          title: "Work",
          status: "confirmed",
          startsAt: iso(23 * HOUR),
          endsAt: iso(23 * HOUR + 8 * HOUR),
          locationId: "office",
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0
        }
      ],
      // A stored pending row for "wash", deliberately placed nowhere near either the commitment's
      // real timeline or the evening band — the "old scheduledStartAt is ignored" assertion.
      routineSteps: [
        {
          id: "stale-wash-row",
          commitmentId: "work",
          presetStepId: "wash-step",
          title: "Wash",
          durationMinutes: 5,
          sequence: 0,
          timingRule: "flexible",
          maxLeadMinutes: 720,
          energy: "low",
          contexts: [],
          dependencyIds: [],
          phase: "before",
          status: "pending",
          waitAfterMinutes: 90,
          preferredBands: ["evening"],
          scheduledStartAt: iso(-100 * HOUR),
          scheduledEndAt: iso(-100 * HOUR + 5 * MIN)
        }
      ]
    });
    const response = calculatePlanAndForecast(request(state));
    const steps = routineStepsOf(response).filter((step) => step.commitmentId === "work");
    expect(steps).toHaveLength(3);

    const wash = steps.find((step) => step.presetStepId === "wash-step")!;
    const hangout = steps.find((step) => step.presetStepId === "hangout-step")!;
    const pack = steps.find((step) => step.presetStepId === "pack-step")!;

    // The stored row's id survives the reconciliation match (same preset step), but the stale time
    // does not: the placer's own evening-band placement wins instead.
    expect(wash.id).toBe("stale-wash-row");
    expect(wash.scheduledStartAt).toBe(iso(12 * HOUR + 20 * MIN)); // 20:20 today
    expect(wash.scheduledEndAt).toBe(iso(12 * HOUR + 25 * MIN)); // 20:25 today

    // Hang out lands in the same evening band, immediately after wash's own 90-minute wait ends.
    expect(hangout.scheduledStartAt).toBe(iso(13 * HOUR + 55 * MIN)); // 21:55 today
    expect(hangout.scheduledEndAt).toBe(iso(14 * HOUR)); // 22:00 today

    // Pack is contiguous and un-banded: backed off from the commitment's own start by hang out's own
    // 240-minute wait plus pack's 5 minutes — tomorrow morning, immediately before work.
    expect(pack.scheduledStartAt).toBe(iso(22 * HOUR + 55 * MIN)); // 06:55 tomorrow
    expect(pack.scheduledEndAt).toBe(iso(23 * HOUR)); // 07:00 tomorrow, work's own start

    // A new inherit commitment's preset steps appear under a deterministic id: the same input run
    // twice names the very same id for the same preset step of the same commitment, which is what
    // lets the persist mirror this response's own ids the moment it commits.
    const second = calculatePlanAndForecast(request(state));
    const secondHangout = routineStepsOf(second).find(
      (step) => step.commitmentId === "work" && step.presetStepId === "hangout-step"
    )!;
    expect(secondHangout.id).toBe(hangout.id);
  });

  it("a 'none' routine source keeps only the locked row and drops the pending one", () => {
    const state = baseState({
      commitments: [
        {
          id: "trash",
          title: "Take out the trash",
          status: "confirmed",
          startsAt: iso(23 * HOUR),
          endsAt: iso(24 * HOUR),
          routineSource: "none",
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0
        }
      ],
      routineSteps: [
        {
          id: "trash-done",
          commitmentId: "trash",
          title: "Old completed step",
          durationMinutes: 5,
          sequence: 0,
          timingRule: "contiguous",
          energy: "low",
          contexts: [],
          dependencyIds: [],
          phase: "before",
          status: "completed",
          scheduledStartAt: iso(-HOUR),
          scheduledEndAt: iso(-HOUR + 5 * MIN),
          completedAt: iso(-HOUR + 5 * MIN)
        },
        {
          id: "trash-pending",
          commitmentId: "trash",
          title: "Leftover pending step",
          durationMinutes: 5,
          sequence: 1,
          timingRule: "contiguous",
          energy: "low",
          contexts: [],
          dependencyIds: [],
          phase: "before",
          status: "pending",
          scheduledStartAt: iso(22 * HOUR),
          scheduledEndAt: iso(22 * HOUR + 5 * MIN)
        }
      ]
    });
    const response = calculatePlanAndForecast(request(state));
    const steps = routineStepsOf(response).filter((step) => step.commitmentId === "trash");
    expect(steps.map((step) => step.id)).toEqual(["trash-done"]);
  });

  it("does not direct a dependent step while its completed prerequisite's own wait is still running", () => {
    const state = baseState({
      commitments: [
        {
          id: "quick",
          title: "Quick errand",
          status: "confirmed",
          presence: "anchor",
          startsAt: iso(-5 * MIN),
          endsAt: iso(HOUR),
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0
        }
      ],
      // "quick" already started, so it is not a candidate for fresh derivation (`startsAt <= now`):
      // both rows pass through exactly as given, and only the pending one is re-placed.
      routineSteps: [
        {
          id: "step-a",
          commitmentId: "quick",
          title: "Step A",
          durationMinutes: 5,
          sequence: 0,
          timingRule: "contiguous",
          energy: "low",
          contexts: [],
          dependencyIds: [],
          phase: "before",
          status: "completed",
          waitAfterMinutes: 10,
          completedAt: iso(-30_000)
        },
        {
          id: "step-b",
          commitmentId: "quick",
          title: "Step B",
          durationMinutes: 5,
          sequence: 1,
          timingRule: "contiguous",
          energy: "low",
          contexts: [],
          dependencyIds: ["step-a"],
          phase: "before",
          status: "pending"
        }
      ]
    });
    const response = calculatePlanAndForecast(request(state));
    // Step B's own window has opened (the placer backs it off from "quick"'s own start, already
    // past), and "quick" is late (its before-phase steps are not all done) so the routine-step
    // search does run — but Step A's own wait has not ended, so Step B is not directed through it.
    expect(response.currentDirective.kind).not.toBe("routine_step");
  });

  it("prep pace projects a late arrival from the forward simulation, not just the plain sum", () => {
    const state = baseState({
      commitments: [
        {
          id: "late-thing",
          title: "Late Thing",
          status: "confirmed",
          startsAt: iso(15 * MIN),
          endsAt: iso(60 * MIN),
          routineSource: "custom",
          setupBeforeMinutes: 5,
          transitionAfterMinutes: 0
        }
      ],
      // A single 30-minute custom step with no room for it before the commitment's own setup window
      // (which opens only 10 minutes from now): the backward walk places it starting 20 minutes ago.
      routineSteps: [
        {
          id: "big-step",
          commitmentId: "late-thing",
          title: "Big step",
          durationMinutes: 30,
          sequence: 0,
          timingRule: "contiguous",
          energy: "low",
          contexts: [],
          dependencyIds: [],
          phase: "before",
          status: "pending"
        }
      ]
    });
    const response = calculatePlanAndForecast(request(state));
    // readyAt = now + 30 (the step's own hands-on minutes, run from now); +5 setup (no travel) =
    // now+35. arriveBy = startsAt (no journey) = now+15, so 20 minutes late.
    expect(response.prepPace?.commitmentId).toBe("late-thing");
    expect(response.prepPace?.projectedArriveAt).toBe(iso(35 * MIN));
    expect(response.prepPace?.projectedLateMinutes).toBe(20);
  });
});

/**
 * Can do now, using the same
 * wash (5, wait 90) -> hang out (5, wait 240) -> pack chain the earlier describe block places against
 * `now = 2026-08-14T08:00:00.000Z` and a work commitment at `iso(23 * HOUR)` (2026-08-15T07:00:00.000Z):
 *   wash.earliestAt = 2026-08-14T19:00:00.000Z, wash placed 20:20-20:25
 *   hangout.earliestAt = 2026-08-14T19:00:00.000Z, hangout placed 21:55-22:00 (once wash is done)
 * `calculatedAt` moves independently of the commitment's own (fixed) `startsAt`, the same device the
 * start-by-warnings block above uses.
 */
describe("can do now", () => {
  const WASH_EARLIEST = new Date("2026-08-14T19:00:00.000Z");
  const WASH_PLACED_START = new Date("2026-08-14T20:20:00.000Z");
  const WASH_PLACED_END = new Date("2026-08-14T20:25:00.000Z");

  const workCommitment = {
    id: "work",
    title: "Work",
    status: "confirmed" as const,
    startsAt: iso(23 * HOUR),
    endsAt: iso(23 * HOUR + 8 * HOUR),
    locationId: "office",
    setupBeforeMinutes: 0,
    transitionAfterMinutes: 0
  };
  // A second, independent commitment offering one lone flexible before-step of its own (no chain, no
  // wait, no band) — a much wider lead (900 minutes) than wash's own puts its own window far enough
  // ahead that it overlaps wash's evening band, so both are offerable at once. Wash's own prepDue is
  // then far along its own (80-minute) ramp while this one is barely started along its own (much
  // longer) ramp, so wash outscores it and becomes the live directive while this one stays listed.
  const soloPreset = {
    id: "solo-preset",
    version: 1,
    name: "Solo chain",
    activityName: "Solo chain",
    status: "active" as const,
    replacesWakeRoutine: false,
    steps: [
      {
        id: "solo-step",
        title: "Solo step",
        durationMinutes: 5,
        sequence: 0,
        timingRule: "flexible" as const,
        maxLeadMinutes: 900,
        energy: "low" as const,
        contexts: [],
        dependencyIds: [],
        phase: "before" as const
      }
    ]
  };
  const workCommitment2 = {
    id: "work2",
    title: "Work 2",
    status: "confirmed" as const,
    startsAt: iso(23 * HOUR),
    endsAt: iso(23 * HOUR + 8 * HOUR),
    routineSource: "preset" as const,
    routinePresetId: "solo-preset",
    setupBeforeMinutes: 0,
    transitionAfterMinutes: 0
  };

  function requestAt(calculatedAt: Date, state: ReturnType<typeof baseState>) {
    return planForecastRequestSchema.parse({
      contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
      requestId: "00000000-0000-4000-8000-0000000000c7",
      inputVersion: "can-do-now-fixture",
      calculatedAt: calculatedAt.toISOString(),
      horizonEnd: new Date(calculatedAt.getTime() + 5 * 24 * HOUR).toISOString(),
      state
    });
  }

  function washIdOf(response: ReturnType<typeof calculatePlanAndForecast>) {
    return routineStepsOf(response).find((step) => step.commitmentId === "work" && step.presetStepId === "wash-step")!
      .id as string;
  }

  it("lists an offerable flexible step inside its band window, before its own slot", () => {
    const state = baseState({
      commitments: [workCommitment, workCommitment2],
      routinePresets: [washPreset, soloPreset]
    });
    const response = calculatePlanAndForecast(requestAt(new Date(WASH_PLACED_START.getTime() - 10 * MIN), state));
    const solo = routineStepsOf(response).find(
      (step) => step.commitmentId === "work2" && step.presetStepId === "solo-step"
    )!;
    expect(response.canDoNow?.map((item) => item.stepId)).toContain(solo.id);
    const entry = response.canDoNow!.find((item) => item.stepId === solo.id)!;
    expect(entry).toMatchObject({ commitmentId: "work2", title: "Solo step", durationMinutes: 5 });
    // Wash, offerable too and closer along its own ramp, outscores it and becomes the live directive
    // instead — excluded from Can do now for exactly that reason (the next test covers this directly).
    expect(response.currentDirective).toMatchObject({ kind: "routine_step" });
    expect(response.canDoNow?.map((item) => item.stepId)).not.toContain(washIdOf(response));
  });

  it("does not list it before its own earliestAt", () => {
    const state = baseState({ commitments: [workCommitment] });
    const response = calculatePlanAndForecast(requestAt(new Date(WASH_EARLIEST.getTime() - MIN), state));
    const washId = washIdOf(response);
    expect(response.canDoNow?.map((item) => item.stepId)).not.toContain(washId);
  });

  it("does not list a dependent whose prerequisite's wait is still running", () => {
    // Wash is stored already completed, its 90-minute wait 30 minutes in — hang out's own window has
    // opened (same earliestAt as wash, same commitment), but its prerequisite's wait has not ended.
    const calculatedAt = new Date(WASH_PLACED_END.getTime() + 30 * MIN);
    const state = baseState({
      commitments: [workCommitment],
      routineSteps: [
        {
          id: "wash-completed",
          commitmentId: "work",
          presetStepId: "wash-step",
          title: "Wash",
          durationMinutes: 5,
          sequence: 0,
          timingRule: "flexible",
          energy: "low",
          contexts: [],
          dependencyIds: [],
          phase: "before",
          status: "completed",
          waitAfterMinutes: 90,
          scheduledStartAt: WASH_PLACED_START.toISOString(),
          scheduledEndAt: WASH_PLACED_END.toISOString(),
          completedAt: WASH_PLACED_END.toISOString()
        }
      ]
    });
    const response = calculatePlanAndForecast(requestAt(calculatedAt, state));
    const hangout = routineStepsOf(response).find(
      (step) => step.commitmentId === "work" && step.presetStepId === "hangout-step"
    )!;
    expect(response.canDoNow?.map((item) => item.stepId)).not.toContain(hangout.id);
  });

  it("excludes the current directive's own step", () => {
    const calculatedAt = new Date(WASH_PLACED_START.getTime() + 5 * MIN);
    const state = baseState({ commitments: [workCommitment] });
    const response = calculatePlanAndForecast(requestAt(calculatedAt, state));
    expect(response.currentDirective.kind).toBe("routine_step");
    const targetId = (response.currentDirective as { targetId: string }).targetId;
    expect(response.canDoNow?.map((item) => item.stepId)).not.toContain(targetId);
  });

  it("never lists a routine step among recommendation.candidates", () => {
    const state = baseState({ commitments: [workCommitment] });
    const response = calculatePlanAndForecast(requestAt(new Date(WASH_PLACED_START.getTime() - 10 * MIN), state));
    const candidates = (response.recommendation as { candidates: Array<{ action: { id: string } }> }).candidates;
    expect(candidates.every((candidate) => !candidate.action.id.startsWith("routine-step:"))).toBe(true);
  });
});

/**
 * Start-by warnings, using
 * the same wash (5, wait 90) -> hang out (5, wait 240) -> pack chain, but with the commitment's own
 * `startsAt` pinned to an absolute instant decoupled from `now` — the backward walk's `startBy` never
 * reads `now` (only the band search does), so `now` can be moved freely across these cases while the
 * two steps' own latest-start figures stay fixed:
 *   wash.startBy    = START − 5h45m
 *   hangout.startBy = START − 4h10m
 */
describe("start-by warnings", () => {
  const START = new Date("2026-08-15T07:00:00.000Z");
  const washStartBy = new Date(START.getTime() - (5 * HOUR + 45 * MIN));

  function stateAt(overrides: Record<string, unknown> = {}) {
    return portalStateSchema.parse({
      settings: {
        timezone: "UTC",
        planningHorizonEnd: "22:00",
        defaultUsableFraction: 1,
        defaultSetupBufferMinutes: 0,
        defaultTransitionBufferMinutes: 0,
        submissionBufferMinutes: 0,
        submissionBufferPercent: 0,
        energyMeanings: { high: "high", medium: "medium", low: "low", recovery: "recovery" },
        estimateBucketsMinutes: [15, 30, 60],
        conditionCatalog: ["office"],
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
      commitments: [
        {
          id: "work",
          title: "Work",
          status: "confirmed",
          startsAt: START.toISOString(),
          endsAt: new Date(START.getTime() + 8 * HOUR).toISOString(),
          locationId: "office",
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0
        }
      ],
      routineSteps: [],
      routinePresets: [washPreset],
      conditionDefinitions: [
        { id: "office", name: "Office", kind: "location", status: "active", defaultRoutinePresetId: "wash-preset" }
      ],
      occurrences: [],
      sleepPlans: [],
      captures: [],
      completedToday: [],
      assertedConditions: [],
      currentEnergy: "medium",
      horizonEnd: new Date(START.getTime() + 3 * 24 * HOUR).toISOString(),
      activeSession: null,
      // About step timing, not travel: standing at the office means no journey to plan.
      currentSituation: {
        locationId: "office",
        locationSetAt: new Date(START.getTime() - 24 * HOUR).toISOString(),
        transportModes: []
      },
      ...overrides
    });
  }

  function requestAt(calculatedAt: Date, state: ReturnType<typeof stateAt>) {
    return planForecastRequestSchema.parse({
      contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
      requestId: "00000000-0000-4000-8000-0000000000b6",
      inputVersion: "start-by-warnings-fixture",
      calculatedAt: calculatedAt.toISOString(),
      horizonEnd: new Date(calculatedAt.getTime() + 5 * 24 * HOUR).toISOString(),
      state
    });
  }

  it("appears soon exactly 30 minutes before startBy", () => {
    const calculatedAt = new Date(washStartBy.getTime() - 30 * MIN);
    const response = calculatePlanAndForecast(requestAt(calculatedAt, stateAt()));
    expect(response.startByWarnings).toHaveLength(1);
    expect(response.startByWarnings![0]).toMatchObject({
      anchorId: "work",
      anchorTitle: "Work",
      title: "Wash",
      startBy: washStartBy.toISOString(),
      status: "soon"
    });
  });

  it("does not appear 31 minutes before startBy", () => {
    const calculatedAt = new Date(washStartBy.getTime() - 31 * MIN);
    const response = calculatePlanAndForecast(requestAt(calculatedAt, stateAt()));
    expect(response.startByWarnings).toEqual([]);
  });

  it("turns missed once startBy has passed", () => {
    const calculatedAt = washStartBy;
    const response = calculatePlanAndForecast(requestAt(calculatedAt, stateAt()));
    expect(response.startByWarnings).toHaveLength(1);
    expect(response.startByWarnings![0]).toMatchObject({
      title: "Wash",
      startBy: washStartBy.toISOString(),
      status: "missed"
    });
  });

  it("disappears once the step is started", () => {
    const calculatedAt = washStartBy;
    const state = stateAt({
      routineSteps: [
        {
          id: "wash-doing",
          commitmentId: "work",
          presetStepId: "wash-step",
          title: "Wash",
          durationMinutes: 5,
          sequence: 0,
          timingRule: "flexible",
          energy: "low",
          contexts: [],
          dependencyIds: [],
          phase: "before",
          status: "doing",
          scheduledStartAt: new Date(calculatedAt.getTime() - 5 * MIN).toISOString(),
          scheduledEndAt: calculatedAt.toISOString()
        }
      ]
    });
    const response = calculatePlanAndForecast(requestAt(calculatedAt, state));
    // "doing" is a locked row: the placer never places it, so it never has a `startBy` and this run
    // never warns about it — the same reason a stale stored placement is ignored in the first test.
    expect(response.startByWarnings).toEqual([]);
  });
});

/**
 * Ported from `platform/database/src/planning/routine-inheritance.integration.test.ts` (deleted by
 * task 006, `git show HEAD:...`): the same/row-existence cases, now asserted against
 * `calculatePlanAndForecast(...).derivedState.routineSteps` instead of a Postgres fixture, since
 * `deriveCommitmentRoutineSteps` (engine.ts) is now the one place that logic lives. The travel case
 * ("chains a before-phase step outside a travel leg the caller supplies") is skipped here —
 * `test/scheduling/routine-placement.test.ts` and `test/system/routine-step-travel.test.ts` already
 * cover a travel leg's effect on placement, which is what that case actually exercised.
 */
describe("which steps a commitment has (ported from the database sync)", () => {
  const FUTURE_START = iso(26 * HOUR);
  const FUTURE_END = iso(27 * HOUR);

  const packTowelStep = {
    id: "pack-towel-step",
    title: "Pack towel",
    durationMinutes: 10,
    sequence: 0,
    timingRule: "contiguous" as const,
    energy: "low" as const,
    contexts: [],
    dependencyIds: [],
    phase: "before" as const
  };
  const fillBottleStep = {
    id: "fill-bottle-step",
    title: "Fill water bottle",
    durationMinutes: 5,
    sequence: 1,
    timingRule: "contiguous" as const,
    energy: "low" as const,
    contexts: [],
    dependencyIds: ["pack-towel-step"],
    phase: "before" as const
  };
  const hangTowelStep = {
    id: "hang-towel-step",
    title: "Hang towel",
    durationMinutes: 5,
    sequence: 2,
    timingRule: "contiguous" as const,
    energy: "low" as const,
    contexts: [],
    dependencyIds: [],
    phase: "after" as const
  };
  const poolPreset = {
    id: "pool-preset",
    version: 1,
    name: "Pool kit",
    activityName: "Pool kit",
    status: "active" as const,
    replacesWakeRoutine: false,
    steps: [packTowelStep, fillBottleStep, hangTowelStep]
  };

  function poolState(overrides: Record<string, unknown> = {}) {
    return baseState({
      routinePresets: [poolPreset],
      conditionDefinitions: [
        { id: "pool", name: "Pool", kind: "location", status: "active", defaultRoutinePresetId: "pool-preset" }
      ],
      ...overrides
    });
  }

  function poolCommitment(overrides: Record<string, unknown> = {}) {
    return {
      id: "pool-visit",
      title: "Pool visit",
      status: "confirmed" as const,
      startsAt: FUTURE_START,
      endsAt: FUTURE_END,
      locationId: "pool",
      setupBeforeMinutes: 0,
      transitionAfterMinutes: 0,
      ...overrides
    };
  }

  function stepsOf(response: ReturnType<typeof calculatePlanAndForecast>, commitmentId: string) {
    return routineStepsOf(response).filter((step) => step.commitmentId === commitmentId);
  }

  function titlesOf(steps: Array<Record<string, unknown>>) {
    return steps.map((step) => step.title);
  }

  it("gives a future commitment at a place its default routine (inherit)", () => {
    const state = poolState({ commitments: [poolCommitment()] });
    const response = calculatePlanAndForecast(request(state));
    const steps = stepsOf(response, "pool-visit");
    expect(titlesOf(steps)).toEqual(["Pack towel", "Fill water bottle", "Hang towel"]);
    expect(steps.every((step) => step.status === "pending")).toBe(true);
    // Running again with nothing stored (and nothing else changed) names the very same deterministic
    // ids for the same preset steps of the same commitment.
    const second = calculatePlanAndForecast(request(state));
    expect(stepsOf(second, "pool-visit").map((step) => step.id)).toEqual(steps.map((step) => step.id));
  });

  it("follows an edited preset on the next run", () => {
    const state = poolState({ commitments: [poolCommitment()] });
    const first = calculatePlanAndForecast(request(state));
    const stored = stepsOf(first, "pool-visit");
    const editedPreset = {
      ...poolPreset,
      steps: poolPreset.steps.map((step) => (step.id === "pack-towel-step" ? { ...step, durationMinutes: 20 } : step))
    };
    const second = calculatePlanAndForecast(
      request(poolState({ commitments: [poolCommitment()], routinePresets: [editedPreset], routineSteps: stored }))
    );
    const steps = stepsOf(second, "pool-visit");
    expect(steps.find((step) => step.title === "Pack towel")?.durationMinutes).toBe(20);
  });

  it("never rewrites a non-pending step, but still syncs its pending siblings to an edited preset", () => {
    const state = poolState({ commitments: [poolCommitment()] });
    const first = calculatePlanAndForecast(request(state));
    const stored = stepsOf(first, "pool-visit");
    const packTowel = stored.find((step) => step.title === "Pack towel")!;
    const fillBottle = stored.find((step) => step.title === "Fill water bottle")!;
    // Marking the first step done directly (as a real completion would) locks only that row, not the
    // whole commitment.
    const lockedRows = stored.map((step) =>
      step.id === packTowel.id ? { ...step, status: "completed", completedAt: iso(0) } : step
    );
    const editedPreset = {
      ...poolPreset,
      steps: poolPreset.steps.map((step) => (step.id === "fill-bottle-step" ? { ...step, durationMinutes: 12 } : step))
    };
    const second = calculatePlanAndForecast(
      request(poolState({ commitments: [poolCommitment()], routinePresets: [editedPreset], routineSteps: lockedRows }))
    );
    const steps = stepsOf(second, "pool-visit");
    expect(titlesOf(steps)).toEqual(["Pack towel", "Fill water bottle", "Hang towel"]);
    const done = steps.find((step) => step.title === "Pack towel")!;
    expect(done.status).toBe("completed");
    expect(done.durationMinutes).toBe(10); // untouched — the preset edit never reaches a done row
    expect(done.id).toBe(packTowel.id);
    const updated = steps.find((step) => step.title === "Fill water bottle")!;
    expect(updated.status).toBe("pending");
    expect(updated.durationMinutes).toBe(12); // the pending sibling still picks up the edit
    expect(updated.id).toBe(fillBottle.id); // updated in place, not deleted and reinserted
    // The dependency edge from the pending step onto the now-done one survives the reconciliation.
    expect(updated.dependencyIds).toEqual([packTowel.id]);
  });

  it("reindexes a locked mid-routine step into its true template-order position, not floated ahead of its pending siblings", () => {
    const state = poolState({ commitments: [poolCommitment()] });
    const first = calculatePlanAndForecast(request(state));
    const stored = stepsOf(first, "pool-visit");
    const fillBottle = stored.find((step) => step.title === "Fill water bottle")!;
    // Lock the *middle* before-phase step — the case the offset-based scheme got wrong: a locked
    // row's small original sequence would otherwise sort ahead of every pending row's large
    // offset-based one, regardless of true routine order.
    const lockedRows = stored.map((step) => (step.id === fillBottle.id ? { ...step, status: "completed" } : step));
    // Insert a new preset step ahead of the now-locked one, forcing its pending neighbours to
    // resequence around it.
    const grabGogglesStep = {
      id: "grab-goggles-step",
      title: "Grab goggles",
      durationMinutes: 7,
      sequence: 1,
      timingRule: "contiguous" as const,
      energy: "low" as const,
      contexts: [],
      dependencyIds: ["pack-towel-step"],
      phase: "before" as const
    };
    const editedPreset = {
      ...poolPreset,
      steps: [packTowelStep, grabGogglesStep, { ...fillBottleStep, sequence: 2 }, { ...hangTowelStep, sequence: 3 }]
    };
    const second = calculatePlanAndForecast(
      request(poolState({ commitments: [poolCommitment()], routinePresets: [editedPreset], routineSteps: lockedRows }))
    );
    const steps = stepsOf(second, "pool-visit");
    // True template order, contiguous — the locked step lands back between Grab goggles and Hang
    // towel, exactly where it belongs, not floated to the top ahead of Pack towel/Grab goggles.
    expect(titlesOf(steps)).toEqual(["Pack towel", "Grab goggles", "Fill water bottle", "Hang towel"]);
    const locked = steps.find((step) => step.title === "Fill water bottle")!;
    expect(locked.status).toBe("completed");
    expect(locked.durationMinutes).toBe(5); // content untouched — only its sequence moved
    expect(locked.id).toBe(fillBottle.id);
  });

  it("stamps presetStepId, and a mid-list preset insertion inserts rather than repurposing a linked row", () => {
    const state = poolState({ commitments: [poolCommitment()] });
    const first = calculatePlanAndForecast(request(state));
    const stored = stepsOf(first, "pool-visit");
    // Every pending row picked up its origin preset step's id on this first run.
    expect(stored.find((step) => step.title === "Pack towel")?.presetStepId).toBe("pack-towel-step");
    expect(stored.find((step) => step.title === "Fill water bottle")?.presetStepId).toBe("fill-bottle-step");
    const packTowelRowId = stored.find((step) => step.title === "Pack towel")!.id;
    const fillBottleRowId = stored.find((step) => step.title === "Fill water bottle")!.id;

    // Insert a new preset step between Pack towel and Fill water bottle: nothing here is locked.
    const grabGogglesStep = {
      id: "grab-goggles-step",
      title: "Grab goggles",
      durationMinutes: 7,
      sequence: 1,
      timingRule: "contiguous" as const,
      energy: "low" as const,
      contexts: [],
      dependencyIds: ["pack-towel-step"],
      phase: "before" as const
    };
    const editedPreset = {
      ...poolPreset,
      steps: [packTowelStep, grabGogglesStep, { ...fillBottleStep, sequence: 2 }, { ...hangTowelStep, sequence: 3 }]
    };
    const second = calculatePlanAndForecast(
      request(poolState({ commitments: [poolCommitment()], routinePresets: [editedPreset], routineSteps: stored }))
    );
    const steps = stepsOf(second, "pool-visit");
    expect(titlesOf(steps)).toEqual(["Pack towel", "Grab goggles", "Fill water bottle", "Hang towel"]);
    // Pack towel and Fill water bottle keep their own row ids — the new step was inserted, not used
    // to repurpose an existing row's content, because matching is by presetStepId now, not position.
    expect(steps.find((step) => step.title === "Pack towel")?.id).toBe(packTowelRowId);
    expect(steps.find((step) => step.title === "Fill water bottle")?.id).toBe(fillBottleRowId);
    const grabGoggles = steps.find((step) => step.title === "Grab goggles")!;
    expect(grabGoggles.id).not.toBe(fillBottleRowId);
    expect(grabGoggles.id).not.toBe(packTowelRowId);
    expect(grabGoggles.presetStepId).toBe("grab-goggles-step");
  });

  it("deletes a trailing pending step the preset dropped, without touching a done sibling", () => {
    const state = poolState({ commitments: [poolCommitment()] });
    const first = calculatePlanAndForecast(request(state));
    const stored = stepsOf(first, "pool-visit");
    const packTowel = stored.find((step) => step.title === "Pack towel")!;
    const lockedRows = stored.map((step) => (step.id === packTowel.id ? { ...step, status: "completed" } : step));
    // Drop the trailing (after-phase) preset step entirely.
    const editedPreset = { ...poolPreset, steps: [packTowelStep, fillBottleStep] };
    const second = calculatePlanAndForecast(
      request(poolState({ commitments: [poolCommitment()], routinePresets: [editedPreset], routineSteps: lockedRows }))
    );
    const steps = stepsOf(second, "pool-visit");
    expect(titlesOf(steps).sort()).toEqual(["Fill water bottle", "Pack towel"]);
    expect(steps.find((step) => step.title === "Pack towel")?.status).toBe("completed");
  });

  it("skips custom commitments entirely and removes pending steps under 'none' (keeping a locked one)", () => {
    const customStep = {
      id: "custom-step",
      commitmentId: "custom-visit",
      title: "My own prep",
      durationMinutes: 5,
      sequence: 0,
      timingRule: "contiguous" as const,
      energy: "low" as const,
      contexts: [],
      dependencyIds: [],
      phase: "before" as const,
      status: "pending" as const
    };
    const noneLockedStep = {
      id: "none-locked-step",
      commitmentId: "none-visit",
      title: "Old completed step",
      durationMinutes: 5,
      sequence: 0,
      timingRule: "contiguous" as const,
      energy: "low" as const,
      contexts: [],
      dependencyIds: [],
      phase: "before" as const,
      status: "completed" as const,
      completedAt: iso(-HOUR)
    };
    const nonePendingStep = {
      id: "none-pending-step",
      commitmentId: "none-visit",
      title: "Left-over prep",
      durationMinutes: 5,
      sequence: 1,
      timingRule: "contiguous" as const,
      energy: "low" as const,
      contexts: [],
      dependencyIds: [],
      phase: "before" as const,
      status: "pending" as const
    };
    const state = poolState({
      commitments: [
        poolCommitment({ id: "custom-visit", routineSource: "custom" }),
        poolCommitment({ id: "none-visit", routineSource: "none" })
      ],
      routineSteps: [customStep, noneLockedStep, nonePendingStep]
    });
    const response = calculatePlanAndForecast(request(state));
    expect(titlesOf(stepsOf(response, "custom-visit"))).toEqual(["My own prep"]);
    const noneSteps = stepsOf(response, "none-visit");
    expect(titlesOf(noneSteps)).toEqual(["Old completed step"]);
    expect(noneSteps[0]?.status).toBe("completed");
  });

  it("uses the named preset over the place default, and leaves steps alone when nothing resolves", () => {
    const gymPreset = {
      id: "gym-preset",
      version: 1,
      name: "Gym kit",
      activityName: "Gym kit",
      status: "active" as const,
      replacesWakeRoutine: false,
      steps: [
        {
          id: "gym-bag-step",
          title: "Pack gym bag",
          durationMinutes: 15,
          sequence: 0,
          timingRule: "contiguous" as const,
          energy: "low" as const,
          contexts: [],
          dependencyIds: [],
          phase: "before" as const
        }
      ]
    };
    const handAddedStep = {
      id: "hand-added-step",
      commitmentId: "unresolvable-visit",
      title: "Hand-added prep",
      durationMinutes: 10,
      sequence: 0,
      timingRule: "contiguous" as const,
      energy: "low" as const,
      contexts: [],
      dependencyIds: [],
      phase: "before" as const,
      status: "pending" as const
    };
    const state = poolState({
      routinePresets: [poolPreset, gymPreset],
      commitments: [
        poolCommitment({
          id: "preset-visit",
          routineSource: "preset",
          routinePresetId: "gym-preset"
        }),
        // No location, no named preset: whatever steps are there cannot be told apart from
        // hand-added ones, so nothing may be deleted or rewritten.
        poolCommitment({ id: "unresolvable-visit", locationId: undefined })
      ],
      routineSteps: [handAddedStep]
    });
    const response = calculatePlanAndForecast(request(state));
    expect(titlesOf(stepsOf(response, "preset-visit"))).toEqual(["Pack gym bag"]);
    expect(titlesOf(stepsOf(response, "unresolvable-visit"))).toEqual(["Hand-added prep"]);
  });

  it("ignores past and cancelled commitments", () => {
    const state = poolState({
      commitments: [
        poolCommitment({ id: "past-visit", startsAt: iso(-2 * HOUR), endsAt: iso(-HOUR) }),
        poolCommitment({ id: "cancelled-visit", status: "cancelled" as const })
      ]
    });
    const response = calculatePlanAndForecast(request(state));
    expect(stepsOf(response, "past-visit")).toEqual([]);
    expect(stepsOf(response, "cancelled-visit")).toEqual([]);
  });

  /**
   * Cadence-linked preset steps. Mirrors `test/system/sleep-routine-steps.test.ts`'s
   * "cadence-linked bedtime steps" fixture shape for the action/recurrence wire representation.
   */
  describe("cadence-linked preset steps", () => {
    const projectFixture = {
      areas: [{ id: "cadence-area", name: "Health", status: "active" as const, sortOrder: 0 }],
      outcomes: [
        {
          id: "cadence-outcome",
          areaId: "cadence-area",
          title: "Keep practicing",
          definitionOfDone: "Still practicing",
          value: 3,
          status: "active" as const
        }
      ],
      projects: [
        {
          id: "cadence-project",
          title: "Piano",
          area: "cadence-area",
          outcomeId: "cadence-outcome",
          status: "active" as const,
          uncertainty: "known" as const,
          value: 3,
          consequence: 3
        }
      ]
    };

    function cadenceAction(overrides: Record<string, unknown> = {}) {
      return {
        id: "practice-action",
        projectId: "cadence-project",
        title: "Practice piano",
        status: "active" as const,
        optimisticMinutes: 5,
        expectedMinutes: 10,
        pessimisticMinutes: 15,
        remainingMinutes: 10,
        splittable: false,
        setupMinutes: 0,
        energy: "low" as const,
        minimumSessionMinutes: 5,
        maximumSessionMinutes: 15,
        importance: 3,
        consequence: 3,
        contexts: [],
        dependencyIds: [],
        schedulingMode: "cadence" as const,
        recurrence: {
          id: "practice-action-rule",
          actionId: "practice-action",
          timezone: "UTC",
          startDate: "2020-01-01",
          intervalDays: 1,
          windows: [],
          completionMode: "manual" as const,
          completionCount: 1
        },
        ...overrides
      };
    }

    function poolPresetWithCadence(cadenceActionId: string | undefined) {
      return {
        ...poolPreset,
        steps: [packTowelStep, { ...fillBottleStep, cadenceActionId }, hangTowelStep]
      };
    }

    it("omits a cadence-linked step whose cadence already recorded a completion today, syncing its siblings normally", () => {
      const state = poolState({
        ...projectFixture,
        routinePresets: [poolPresetWithCadence("practice-action")],
        commitments: [poolCommitment()],
        actions: [
          cadenceAction({
            recurrence: {
              id: "practice-action-rule",
              actionId: "practice-action",
              timezone: "UTC",
              startDate: "2020-01-01",
              intervalDays: 1,
              windows: [],
              completionMode: "manual" as const,
              lastCompletedLocalDate: "2026-08-14", // the same local day as `now`
              lastCompletedAt: iso(0),
              completionCount: 1
            }
          })
        ]
      });
      const response = calculatePlanAndForecast(request(state));
      expect(titlesOf(stepsOf(response, "pool-visit"))).toEqual(["Pack towel", "Hang towel"]);
    });

    it("includes a cadence-linked step whose cadence is due today", () => {
      // Never completed, and its series started years ago: eligible from day one.
      const state = poolState({
        ...projectFixture,
        routinePresets: [poolPresetWithCadence("practice-action")],
        commitments: [poolCommitment()],
        actions: [cadenceAction()]
      });
      const response = calculatePlanAndForecast(request(state));
      const steps = stepsOf(response, "pool-visit");
      expect(titlesOf(steps)).toEqual(["Pack towel", "Fill water bottle", "Hang towel"]);
      expect(steps.find((step) => step.title === "Fill water bottle")?.status).toBe("pending");
    });

    it("deletes a pending step whose cadence link has since gated it out", () => {
      // First run: not yet linked to any cadence action, so all three steps are ordinary.
      const first = calculatePlanAndForecast(request(poolState({ commitments: [poolCommitment()] })));
      const stored = stepsOf(first, "pool-visit");
      expect(titlesOf(stored)).toEqual(["Pack towel", "Fill water bottle", "Hang towel"]);
      // Second run: the preset now links "Fill water bottle" to a cadence action that already
      // recorded a completion today, gating the step out. The engine has no channel to write back to
      // `state.commitments` at all (`derivedState` passes it through untouched,/one-write-path),
      // so "without detaching the commitment's source" is an architectural given here, not a separate
      // assertion — the deletion itself is what this case ports.
      const second = calculatePlanAndForecast(
        request(
          poolState({
            ...projectFixture,
            routinePresets: [poolPresetWithCadence("practice-action")],
            commitments: [poolCommitment()],
            routineSteps: stored,
            actions: [
              cadenceAction({
                recurrence: {
                  id: "practice-action-rule",
                  actionId: "practice-action",
                  timezone: "UTC",
                  startDate: "2020-01-01",
                  intervalDays: 1,
                  windows: [],
                  completionMode: "manual" as const,
                  lastCompletedLocalDate: "2026-08-14",
                  lastCompletedAt: iso(0),
                  completionCount: 1
                }
              })
            ]
          })
        )
      );
      expect(titlesOf(stepsOf(second, "pool-visit"))).toEqual(["Pack towel", "Hang towel"]);
    });

    it("leaves an already-completed step alone even after its cadence link gates it out", () => {
      const first = calculatePlanAndForecast(request(poolState({ commitments: [poolCommitment()] })));
      const stored = stepsOf(first, "pool-visit");
      const fillBottle = stored.find((step) => step.title === "Fill water bottle")!;
      const lockedRows = stored.map((step) => (step.id === fillBottle.id ? { ...step, status: "completed" } : step));
      const second = calculatePlanAndForecast(
        request(
          poolState({
            ...projectFixture,
            routinePresets: [poolPresetWithCadence("practice-action")],
            commitments: [poolCommitment()],
            routineSteps: lockedRows,
            actions: [
              cadenceAction({
                recurrence: {
                  id: "practice-action-rule",
                  actionId: "practice-action",
                  timezone: "UTC",
                  startDate: "2020-01-01",
                  intervalDays: 1,
                  windows: [],
                  completionMode: "manual" as const,
                  lastCompletedLocalDate: "2026-08-14",
                  lastCompletedAt: iso(0),
                  completionCount: 1
                }
              })
            ]
          })
        )
      );
      const steps = stepsOf(second, "pool-visit");
      expect(titlesOf(steps).sort()).toEqual(["Fill water bottle", "Hang towel", "Pack towel"]);
      const survivor = steps.find((step) => step.title === "Fill water bottle")!;
      expect(survivor.status).toBe("completed");
      expect(survivor.id).toBe(fillBottle.id);
    });

    it("fails closed (drops the step) when the linked action is not schedulingMode 'cadence'", () => {
      const state = poolState({
        ...projectFixture,
        routinePresets: [poolPresetWithCadence("practice-action")],
        commitments: [poolCommitment()],
        // Would gate the step out if the action were still cadence-mode, too — this asserts the
        // unevaluable-link path specifically, not merely "not due today".
        actions: [
          {
            ...cadenceAction(),
            schedulingMode: "one_off" as const,
            recurrence: undefined
          }
        ]
      });
      const response = calculatePlanAndForecast(request(state));
      // A link the gate cannot evaluate reads as not due, so it is dropped from today's template
      // exactly like any other day the cadence genuinely isn't due — never silently included forever.
      expect(titlesOf(stepsOf(response, "pool-visit"))).toEqual(["Pack towel", "Hang towel"]);
    });

    it("fails closed (drops the step) when the linked action has no recurrence rule at all", () => {
      const state = poolState({
        ...projectFixture,
        routinePresets: [poolPresetWithCadence("practice-action")],
        commitments: [poolCommitment()],
        actions: [
          {
            id: "practice-action",
            projectId: "cadence-project",
            title: "No rule",
            status: "active" as const,
            optimisticMinutes: 5,
            expectedMinutes: 10,
            pessimisticMinutes: 15,
            remainingMinutes: 10,
            splittable: false,
            setupMinutes: 0,
            energy: "low" as const,
            minimumSessionMinutes: 5,
            maximumSessionMinutes: 15,
            importance: 3,
            consequence: 3,
            contexts: [],
            dependencyIds: [],
            schedulingMode: "cadence" as const
          }
        ]
      });
      const response = calculatePlanAndForecast(request(state));
      expect(titlesOf(stepsOf(response, "pool-visit"))).toEqual(["Pack towel", "Hang towel"]);
    });
  });
});
