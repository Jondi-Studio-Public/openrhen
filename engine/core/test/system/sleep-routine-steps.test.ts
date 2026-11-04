import { describe, expect, it } from "vitest";
import { PLAN_FORECAST_CONTRACT_VERSION, planForecastRequestSchema, portalStateSchema } from "@openrhen/contracts";
import { calculatePlanAndForecast } from "../../src/index.js";

const now = new Date("2026-08-14T04:00:00.000Z");

/** Mixed before/after steps, deliberately unlike bedtime's: a wake instance schedules every step of
 * its preset regardless of phase (§1.2 of the wake routine design note), so a preset whose steps
 *  were never hand-tagged still runs in full. */
const wakePreset = {
  id: "22222222-2222-4222-8222-222222222222",
  version: 1,
  name: "Wake",
  activityName: "Morning routine",
  status: "active" as const,
  steps: [
    {
      id: "wake-step-0",
      title: "Stretch",
      durationMinutes: 10,
      sequence: 0,
      timingRule: "contiguous" as const,
      energy: "low" as const,
      contexts: [],
      dependencyIds: [],
      phase: "before" as const
    },
    {
      id: "wake-step-1",
      title: "Shower",
      durationMinutes: 10,
      sequence: 1,
      timingRule: "contiguous" as const,
      energy: "low" as const,
      contexts: [],
      dependencyIds: [],
      phase: "after" as const
    },
    {
      id: "wake-step-2",
      title: "Get dressed",
      durationMinutes: 10,
      sequence: 2,
      timingRule: "contiguous" as const,
      energy: "low" as const,
      contexts: [],
      dependencyIds: [],
      phase: "after" as const
    }
  ]
};

/** A preset a confirmed commitment can resolve to that opts to replace the day's wake routine. */
function replacePreset(leadMinutes: number) {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    version: 1,
    name: "Quick prep",
    activityName: "Quick prep",
    status: "active" as const,
    replacesWakeRoutine: true,
    steps: [
      {
        id: "replace-step-0",
        title: "Grab bag",
        durationMinutes: leadMinutes,
        sequence: 0,
        timingRule: "contiguous" as const,
        energy: "low" as const,
        contexts: [],
        dependencyIds: [],
        phase: "before" as const
      }
    ]
  };
}

const bedtimePreset = {
  id: "11111111-1111-4111-8111-111111111111",
  version: 1,
  name: "Bedtime",
  activityName: "Sleep",
  status: "active" as const,
  steps: [
    {
      id: "before-step",
      title: "Drink water",
      durationMinutes: 10,
      sequence: 0,
      timingRule: "contiguous" as const,
      energy: "low" as const,
      contexts: [],
      dependencyIds: [],
      phase: "before" as const
    },
    {
      id: "after-step",
      title: "Air out the room",
      durationMinutes: 100,
      sequence: 0,
      timingRule: "contiguous" as const,
      energy: "low" as const,
      contexts: [],
      dependencyIds: [],
      phase: "after" as const
    }
  ]
};

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
      maxAwakeHours: 16,
      bedtimeRoutinePresetId: bedtimePreset.id,
      lastWokeAt: new Date(now.getTime() - 8 * 60 * 60_000).toISOString()
    },
    areas: [],
    outcomes: [],
    projects: [],
    actions: [],
    commitments: [],
    routineSteps: [],
    routinePresets: [bedtimePreset],
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

/** Same defaults as `baseState`, but without a bedtime preset wired up and with room to configure the
 *  wake routine — `wakeRoutinePresetId` plus whatever `routinePresets`/`commitments`/`sleepPlans` a
 *  wake-routine test needs. `settings` replaces the whole object (matching `baseState`'s own
 *  `...overrides` shape), so every wake test passes `wakeRoutinePresetId` explicitly. */
function wakeState(settingsOverrides: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
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
      maxAwakeHours: 16,
      wakeRoutinePresetId: wakePreset.id,
      lastWokeAt: new Date(now.getTime() - 8 * 60 * 60_000).toISOString(),
      ...settingsOverrides
    },
    areas: [],
    outcomes: [],
    projects: [],
    actions: [],
    commitments: [],
    routineSteps: [],
    routinePresets: [wakePreset],
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
    requestId: "00000000-0000-4000-8000-000000000003",
    inputVersion: "routine-instance-fixture",
    calculatedAt: now.toISOString(),
    horizonEnd: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
    state
  });
}

/**
 * A bedtime/wake anchor's rows — one per preset step
 * instead of the pre-migration single instance's `completedStepIds`/`skippedStepIds` arrays. Sorted by
 * `sequence` so index-based assertions read the same way the old per-instance tests did.
 */
function sleepGroup(
  response: ReturnType<typeof calculatePlanAndForecast>,
  anchorId: string,
  purpose: "bedtime" | "wake"
): Array<Record<string, unknown>> {
  return (response.derivedState.routineSteps as Array<Record<string, unknown>>)
    .filter((item) => item.anchorType === "sleep_plan" && item.anchorId === anchorId && item.purpose === purpose)
    .sort((a, b) => (a.sequence as number) - (b.sequence as number));
}

/** Total minutes an anchor's group actually reserves — every row but a truncation-dropped `"skipped"` one. */
function activeMinutes(group: Array<Record<string, unknown>>): number {
  return group
    .filter((item) => item.status !== "skipped")
    .reduce((total, item) => total + (item.durationMinutes as number), 0);
}

/** The earliest scheduled start and latest scheduled end among an anchor's non-skipped rows. */
function activeBounds(group: Array<Record<string, unknown>>): { startsAt: string; endsAt: string } {
  const active = group.filter((item) => item.status !== "skipped");
  const starts = active.map((item) => item.scheduledStartAt as string).sort();
  const ends = active.map((item) => item.scheduledEndAt as string).sort();
  return { startsAt: starts[0]!, endsAt: ends[ends.length - 1]! };
}

/** The `presetStepId`s of an anchor's rows in a given status — the closest equivalent to the old
 *  instance's `completedStepIds`/`skippedStepIds` arrays. */
function presetStepIdsWithStatus(group: Array<Record<string, unknown>>, status: string): string[] {
  return group.filter((item) => item.status === status).map((item) => item.presetStepId as string);
}

/** A recurring action with one afternoon window, so its occurrence lands after `now`. */
const brushing = {
  id: "action-brush",
  projectId: "project-1",
  title: "Brush and floss twice daily",
  status: "active",
  optimisticMinutes: 5,
  expectedMinutes: 10,
  pessimisticMinutes: 15,
  remainingMinutes: 10,
  splittable: false,
  setupMinutes: 0,
  energy: "low",
  minimumSessionMinutes: 5,
  maximumSessionMinutes: 15,
  importance: 3,
  consequence: 3,
  contexts: [],
  dependencyIds: [],
  schedulingMode: "recurring",
  recurrence: {
    id: "brush-rule",
    actionId: "action-brush",
    timezone: "Australia/Sydney",
    startDate: "2026-08-01",
    intervalDays: 1,
    completionMode: "manual",
    windows: [
      {
        id: "afternoon-window",
        name: "Afternoon",
        anchor: "local_time",
        localStartTime: "16:00",
        localEndTime: "18:00"
      }
    ]
  }
};

/** The commitment the preparation hangs off, and one step of it, optionally claiming the window. */
const workCommitment = {
  id: "commitment-work",
  title: "Work",
  startsAt: new Date(now.getTime() + 6 * 60 * 60_000).toISOString(),
  endsAt: new Date(now.getTime() + 10 * 60 * 60_000).toISOString(),
  status: "confirmed",
  setupBeforeMinutes: 0,
  transitionAfterMinutes: 0
};

function brushingStep(overrides: Record<string, unknown> = {}) {
  return {
    id: "step-brush",
    commitmentId: workCommitment.id,
    title: "Brush Teeth",
    durationMinutes: 10,
    sequence: 0,
    timingRule: "contiguous",
    energy: "low",
    contexts: [],
    dependencyIds: [],
    phase: "before",
    status: "pending",
    actionWindowId: "afternoon-window",
    // 15:00 local on 14 August: the same local day as the window, an hour before it opens.
    scheduledStartAt: new Date("2026-08-14T05:00:00.000Z").toISOString(),
    scheduledEndAt: new Date("2026-08-14T05:10:00.000Z").toISOString(),
    ...overrides
  };
}

function brushingState(step: Record<string, unknown> | null) {
  return baseState({
    areas: [{ id: "area-1", name: "Health", status: "active", sortOrder: 0 }],
    outcomes: [
      {
        id: "outcome-1",
        areaId: "area-1",
        title: "Keep my teeth",
        definitionOfDone: "Still have them",
        value: 3,
        status: "active"
      }
    ],
    projects: [
      {
        id: "project-1",
        title: "Dental care",
        area: "area-1",
        outcomeId: "outcome-1",
        status: "active",
        uncertainty: "known",
        value: 3,
        consequence: 3
      }
    ],
    actions: [brushing],
    commitments: [workCommitment],
    routineSteps: step ? [step] : []
  });
}

function afternoonOccurrence(state: ReturnType<typeof baseState>) {
  const response = calculatePlanAndForecast(request(state));
  const occurrences = response.derivedState.occurrences as Array<Record<string, unknown>>;
  const occurrence = occurrences.find(
    (item) => item.windowId === "afternoon-window" && item.localDate === "2026-08-14"
  );
  // Guarded here rather than per test: an occurrence that failed to materialise would otherwise make
  // every "not covered" assertion below pass for the wrong reason.
  if (!occurrence) throw new Error("The afternoon occurrence was not materialised.");
  return { response, occurrence };
}

describe("a commitment routine step standing in for a recurring window", () => {
  it("covers that day's occurrence and keeps it out of the plan", () => {
    const { response, occurrence } = afternoonOccurrence(brushingState(brushingStep()));
    expect(occurrence).toBeDefined();
    expect(occurrence.routineCovered).toBe(true);
    const candidates = (response.recommendation as { candidates: Array<{ action: { id: string } }> }).candidates;
    expect(candidates.some((candidate) => candidate.action.id === occurrence.id)).toBe(false);
  });

  it("covers by day rather than by overlapping minutes", () => {
    // The step runs 15:00–15:10 and the window opens at 16:00: no minute of the two coincides, and
    // brushing before work is still the afternoon brush.
    const { occurrence } = afternoonOccurrence(brushingState(brushingStep()));
    expect(new Date(occurrence.windowStartsAt as string) > new Date("2026-08-14T05:10:00.000Z")).toBe(true);
    expect(occurrence.routineCovered).toBe(true);
  });

  it("leaves the occurrence alone when the step is placed on another day", () => {
    // `status: "doing"` (not "pending"): the engine is now the only author of a *pending* step's
    // placement (the routine step timing design note, Invariants), so a pending row's own
    // `scheduledStartAt` override below would be recomputed against the commitment's real timeline —
    // which falls on the same day as the occurrence — before coverage ever saw it. A `doing` step's
    // stored interval is a fact the placer leaves untouched, which is what this test needs: a step
    // genuinely anchored on a different day from the occurrence it might otherwise cover.
    const { occurrence } = afternoonOccurrence(
      brushingState(
        brushingStep({
          status: "doing",
          scheduledStartAt: "2026-08-15T05:00:00.000Z",
          scheduledEndAt: "2026-08-15T05:10:00.000Z"
        })
      )
    );
    expect(occurrence.routineCovered).toBeUndefined();
  });

  it("stops covering once the step is done, so the occurrence answers for itself", () => {
    const { occurrence } = afternoonOccurrence(brushingState(brushingStep({ status: "completed" })));
    expect(occurrence.routineCovered).toBeUndefined();
  });

  it("leaves an unlinked step to be nothing but preparation", () => {
    const { occurrence } = afternoonOccurrence(brushingState(brushingStep({ actionWindowId: undefined })));
    expect(occurrence.routineCovered).toBeUndefined();
  });
});

describe("bedtime routine step derivation", () => {
  it("only counts before-phase steps toward the pre-sleep routine window", () => {
    const response = calculatePlanAndForecast(request(baseState()));
    const anchorId = (response.derivedState.sleepPlans[0] as Record<string, unknown>).id as string;
    const group = sleepGroup(response, anchorId, "bedtime");
    expect(group.length).toBeGreaterThan(0);
    expect(activeMinutes(group)).toBe(10);
  });

  it("carries a completed step's status forward across a recompute", () => {
    const first = calculatePlanAndForecast(request(baseState()));
    const anchorId = (first.derivedState.sleepPlans[0] as Record<string, unknown>).id as string;
    const firstGroup = sleepGroup(first, anchorId, "bedtime");
    const step = firstGroup.find((item) => item.presetStepId === "before-step")!;
    expect(step.status).toBe("pending");

    const completed = { ...step, status: "completed" };
    const second = calculatePlanAndForecast(request(baseState({ routineSteps: [completed] })));
    const secondGroup = sleepGroup(second, anchorId, "bedtime");
    const matched = secondGroup.find((item) => item.id === step.id);
    expect(matched).toBeDefined();
    expect(matched?.status).toBe("completed");
  });

  it("keeps a bedtime routine step's identity stable across rapid recomputes when bedtime has already been missed", () => {
    // preferredBedtime is hours before `now`, so day 0's sleep plan hits the "missedStart" branch
    // in planSleep, which pins plannedStartAt to the exact instant of calculation. Two recomputes
    // separated by 25 real minutes - long enough to cross more than one 15-minute step boundary,
    // matching how long a user might actually take between starting a routine step and marking it
    // done - must still resolve to the same routine instance, or the step progress recorded between
    // them gets silently discarded.
    const missedNow = new Date("2026-08-11T14:07:00Z");
    const missedBedtimeSettings = {
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
      preferredBedtime: "22:00",
      preferredWakeTime: "06:00",
      desiredSleepMinutes: 540,
      minimumSleepMinutes: 240,
      maxAwakeHours: 16,
      bedtimeRoutinePresetId: bedtimePreset.id,
      // Within the awake limit plus two hours of `missedNow`: an older wake is unknown and plans no night.
      lastWokeAt: new Date(missedNow.getTime() - 12 * 60 * 60_000).toISOString()
    };
    const firstAt = missedNow;
    const secondAt = new Date(missedNow.getTime() + 25 * 60_000);
    const first = calculatePlanAndForecast(
      planForecastRequestSchema.parse({
        contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
        requestId: "00000000-0000-4000-8000-000000000004",
        inputVersion: "missed-bedtime-fixture",
        calculatedAt: firstAt.toISOString(),
        horizonEnd: new Date(firstAt.getTime() + 24 * 60 * 60_000).toISOString(),
        state: baseState({ settings: missedBedtimeSettings })
      })
    );
    expect((first.derivedState.sleepPlans[0] as Record<string, unknown> | undefined)?.replannedFromMissedStart).toBe(
      true
    );
    const anchorId = (first.derivedState.sleepPlans[0] as Record<string, unknown>).id as string;
    const firstStep = sleepGroup(first, anchorId, "bedtime")[0]!;

    const second = calculatePlanAndForecast(
      planForecastRequestSchema.parse({
        contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
        requestId: "00000000-0000-4000-8000-000000000005",
        inputVersion: "missed-bedtime-fixture",
        calculatedAt: secondAt.toISOString(),
        horizonEnd: new Date(secondAt.getTime() + 24 * 60 * 60_000).toISOString(),
        state: baseState({
          settings: missedBedtimeSettings,
          routineSteps: [{ ...firstStep, status: "completed" }]
        })
      })
    );
    const secondStep = sleepGroup(second, anchorId, "bedtime").find((item) => item.id === firstStep.id);
    expect(secondStep).toBeDefined();
    expect(secondStep?.status).toBe("completed");
  });

  describe("cadence-linked bedtime steps", () => {
    // Mirrors "cadence-linked wake steps" above, but for `deriveBedtimeInstances` — first
    // half: a bedtime instance did not apply `cadenceStepIncludedToday` at all, so a cadence-linked
    // step in a bedtime preset was offered every night regardless of dueness.
    // `settings` replaces the whole object (matching `baseState`'s own `...overrides` shape), so this
    // needs a full settings object rather than a partial one — same reason `missedBedtimeSettings`
    // above is a full object.
    const cadenceBedtimeSettings = {
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
      bedtimeRoutinePresetId: "88888888-8888-4888-8888-888888888888",
      lastWokeAt: new Date(now.getTime() - 8 * 60 * 60_000).toISOString()
    };
    const projectFixture = {
      areas: [{ id: "area-1", name: "Health", status: "active" as const, sortOrder: 0 }],
      outcomes: [
        {
          id: "outcome-1",
          areaId: "area-1",
          title: "Keep practicing",
          definitionOfDone: "Still practicing",
          value: 3,
          status: "active" as const
        }
      ],
      projects: [
        {
          id: "project-1",
          title: "Piano",
          area: "area-1",
          outcomeId: "outcome-1",
          status: "active" as const,
          uncertainty: "known" as const,
          value: 3,
          consequence: 3
        }
      ]
    };
    // Mirrors the `cadenceAction(...)` fixture in `engine/core/test/system/cadence.test.ts`.
    const cadenceAction = (lastCompletedLocalDate: string) => ({
      id: "cadence-action-1",
      projectId: "project-1",
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
        id: "cadence-action-1-rule",
        actionId: "cadence-action-1",
        timezone: "Australia/Sydney",
        startDate: "2026-08-01",
        intervalDays: 7,
        windows: [],
        completionMode: "manual" as const,
        lastCompletedLocalDate,
        lastCompletedAt: `${lastCompletedLocalDate}T08:00:00.000Z`,
        completionCount: 1
      }
    });

    const cadenceBedtimePreset = {
      id: "88888888-8888-4888-8888-888888888888",
      version: 1,
      name: "Bedtime with practice",
      activityName: "Sleep",
      status: "active" as const,
      steps: [
        {
          id: "ordinary-step",
          title: "Drink water",
          durationMinutes: 10,
          sequence: 0,
          timingRule: "contiguous" as const,
          energy: "low" as const,
          contexts: [],
          dependencyIds: [],
          phase: "before" as const
        },
        {
          id: "cadence-step",
          title: "Practice piano",
          durationMinutes: 10,
          sequence: 1,
          timingRule: "contiguous" as const,
          energy: "low" as const,
          contexts: [],
          dependencyIds: [],
          phase: "before" as const,
          cadenceActionId: "cadence-action-1"
        },
        {
          id: "after-step",
          title: "Air out the room",
          durationMinutes: 100,
          sequence: 2,
          timingRule: "contiguous" as const,
          energy: "low" as const,
          contexts: [],
          dependencyIds: [],
          phase: "after" as const,
          cadenceActionId: "cadence-action-1"
        }
      ]
    };

    it("omits a cadence-linked bedtime step whose action is not due today entirely", () => {
      const response = calculatePlanAndForecast(
        request(
          baseState({
            settings: cadenceBedtimeSettings,
            ...projectFixture,
            routinePresets: [cadenceBedtimePreset],
            // Day-granular "not twice in one day" — already completed today (the same local day as
            // `now`, 08-14), so not eligible again until 08-15.
            actions: [cadenceAction("2026-08-14")]
          })
        )
      );
      const anchorId = (response.derivedState.sleepPlans[0] as Record<string, unknown>).id as string;
      const group = sleepGroup(response, anchorId, "bedtime");
      // Only the ordinary before-step's 10 minutes — the gated-out cadence step reserves none of the
      // window (dropped from the template entirely, same as a cadence-gated commitment step), and the
      // "after"-phase step was never a candidate for a bedtime row at all.
      expect(activeMinutes(group)).toBe(10);
      expect(group.some((item) => item.presetStepId === "cadence-step")).toBe(false);
    });

    it("includes the cadence-linked bedtime step alongside the ordinary one once its cadence is due", () => {
      const response = calculatePlanAndForecast(
        request(
          baseState({
            settings: cadenceBedtimeSettings,
            ...projectFixture,
            routinePresets: [cadenceBedtimePreset],
            // Last completed before today, so eligible again as of tonight.
            actions: [cadenceAction("2026-08-01")]
          })
        )
      );
      const anchorId = (response.derivedState.sleepPlans[0] as Record<string, unknown>).id as string;
      const group = sleepGroup(response, anchorId, "bedtime");
      expect(activeMinutes(group)).toBe(20);
      expect(group.find((item) => item.presetStepId === "cadence-step")?.status).toBe("pending");
    });

    it("fails closed (omits the step) when the linked action is no longer schedulingMode 'cadence'", () => {
      const detached = { ...cadenceAction("2026-08-10"), schedulingMode: "one_off" as const, recurrence: undefined };
      const response = calculatePlanAndForecast(
        request(
          baseState({
            settings: cadenceBedtimeSettings,
            ...projectFixture,
            routinePresets: [cadenceBedtimePreset],
            actions: [detached]
          })
        )
      );
      const anchorId = (response.derivedState.sleepPlans[0] as Record<string, unknown>).id as string;
      const group = sleepGroup(response, anchorId, "bedtime");
      // Only the ordinary before-step's 10 minutes: a link the gate cannot evaluate is not due, never
      // silently included, so the cadence step is dropped exactly as if its cadence just wasn't due.
      expect(activeMinutes(group)).toBe(10);
      expect(group.some((item) => item.presetStepId === "cadence-step")).toBe(false);
    });

    it("fails closed (omits the step) when the linked action no longer exists at all", () => {
      const response = calculatePlanAndForecast(
        request(
          baseState({
            settings: cadenceBedtimeSettings,
            ...projectFixture,
            routinePresets: [cadenceBedtimePreset],
            actions: [] // cadence-action-1, which cadence-step links to, is gone.
          })
        )
      );
      const anchorId = (response.derivedState.sleepPlans[0] as Record<string, unknown>).id as string;
      const group = sleepGroup(response, anchorId, "bedtime");
      expect(activeMinutes(group)).toBe(10);
      expect(group.some((item) => item.presetStepId === "cadence-step")).toBe(false);
    });

    it("never relitigates an already-completed cadence step even once its own completion makes the cadence no longer due", () => {
      // The step was offered and completed on a prior run, and that same completion is what updated
      // `lastCompletedLocalDate` to today — so a naive re-derivation would now see it as gated-out.
      // The persisted row stays exactly as it was: `buildSleepStep`'s own locked-row branch never
      // recomputes a non-pending row, whatever this run's cadence gate would otherwise decide.
      const priorStepId = "existing-bedtime-cadence-step";
      const response = calculatePlanAndForecast(
        request(
          baseState({
            settings: cadenceBedtimeSettings,
            ...projectFixture,
            routinePresets: [cadenceBedtimePreset],
            actions: [cadenceAction("2026-08-14")],
            sleepPlans: [
              {
                id: "sleep-1",
                plannedStartAt: new Date(now.getTime() + 8 * 60 * 60_000).toISOString(),
                plannedWakeAt: new Date(now.getTime() + 16 * 60 * 60_000).toISOString(),
                desiredMinutes: 480,
                allowedMinutes: 480,
                sleepDeficitMinutes: 0,
                anchorDeviationMinutes: 0,
                hardErrors: [],
                explanation: "test fixture",
                status: "planned" as const,
                overridden: true
              }
            ],
            routineSteps: [
              {
                id: priorStepId,
                version: 1,
                anchorType: "sleep_plan" as const,
                anchorId: "sleep-1",
                purpose: "bedtime" as const,
                title: "Practice piano",
                durationMinutes: 10,
                sequence: 1,
                timingRule: "contiguous" as const,
                energy: "low" as const,
                contexts: [],
                dependencyIds: [],
                phase: "before" as const,
                cadenceActionId: "cadence-action-1",
                presetStepId: "cadence-step",
                status: "completed" as const,
                scheduledStartAt: new Date(now.getTime() + 7 * 60 * 60_000).toISOString(),
                scheduledEndAt: new Date(now.getTime() + 7.5 * 60 * 60_000).toISOString()
              }
            ]
          })
        )
      );
      const group = sleepGroup(response, "sleep-1", "bedtime");
      const step = group.find((item) => item.presetStepId === "cadence-step");
      expect(step).toBeDefined();
      expect(step?.id).toBe(priorStepId);
      expect(step?.status).toBe("completed");
    });
  });
});

describe("wake routine step derivation", () => {
  it("produces wake-purpose rows for the forward sleep plan, using every preset step regardless of phase", () => {
    const response = calculatePlanAndForecast(request(wakeState()));
    const sleepPlans = response.derivedState.sleepPlans as Array<Record<string, unknown>>;
    // planSleep projects a rolling window of nights forward, so bedtime/wake rows are produced one
    // group per night (mirroring the existing bedtime derivation test, which only asserts the first
    // sleep plan's group for the same reason) — the assertions below hold for every one of them.
    expect(sleepPlans.length).toBeGreaterThan(0);
    for (const plan of sleepPlans) {
      const group = sleepGroup(response, plan.id as string, "wake");
      expect(group.length).toBeGreaterThan(0);
      expect(activeBounds(group).startsAt).toBe(plan.plannedWakeAt);
      // All three steps (10 minutes each), including the two "after"-phase ones — phase is not
      // consulted for a wake row (§1.2 of the wake routine design note).
      expect(activeMinutes(group)).toBe(30);
    }
  });

  it("anchors to the plan actively being woken from, once 'I'm awake' has completed it", () => {
    // Same local day as `now` (2026-08-14T04:00Z = 14:00 local).
    const actualWakeAt = new Date("2026-08-14T00:00:00.000Z");
    const completedPlan = {
      id: "44444444-4444-4444-8444-444444444444",
      plannedStartAt: new Date(actualWakeAt.getTime() - 8 * 60 * 60_000).toISOString(),
      plannedWakeAt: actualWakeAt.toISOString(),
      desiredMinutes: 480,
      allowedMinutes: 480,
      sleepDeficitMinutes: 0,
      anchorDeviationMinutes: 0,
      hardErrors: [],
      explanation: "test fixture",
      status: "completed" as const,
      actualStartAt: new Date(actualWakeAt.getTime() - 8 * 60 * 60_000).toISOString(),
      actualWakeAt: actualWakeAt.toISOString()
    };
    const response = calculatePlanAndForecast(
      request(wakeState({ lastWokeAt: undefined }, { sleepPlans: [completedPlan] }))
    );
    // A completed plan is echoed through to the wire output unmodified (`calculatePlanAndForecast`'s
    // own completed-row echo, alongside `deriveSleepPlans`) so the portal still has a row to render
    // its evidentiary fields against, but it is never part of `sleepPlans`/`nights` themselves, so it
    // can never block capacity or seed a bogus commitment.
    const derivedSleepPlans = response.derivedState.sleepPlans as Array<Record<string, unknown>>;
    expect(derivedSleepPlans.some((item) => item.id === completedPlan.id)).toBe(true);
    const group = sleepGroup(response, completedPlan.id, "wake");
    expect(group.length).toBeGreaterThan(0);
    expect(activeBounds(group).startsAt).toBe(actualWakeAt.toISOString());
  });

  describe("replacesWakeRoutine", () => {
    // A fixed "sleeping" plan (retained by `deriveSleepPlans` unmodified) so the wake instance's own
    // startsAt/endsAt are exactly known: startsAt 05:00Z, full un-truncated end 05:30Z (three 10-minute
    // steps).
    const sleepingPlan = {
      id: "sleep-truncate",
      plannedStartAt: "2026-08-14T03:00:00.000Z",
      plannedWakeAt: "2026-08-14T05:00:00.000Z",
      desiredMinutes: 480,
      allowedMinutes: 480,
      sleepDeficitMinutes: 0,
      anchorDeviationMinutes: 0,
      hardErrors: [],
      explanation: "test fixture",
      status: "sleeping" as const
    };
    function replacingCommitment(startsAt: string, leadMinutes: number) {
      return {
        id: "commitment-replaces-wake",
        title: "Early meeting",
        startsAt,
        endsAt: new Date(new Date(startsAt).getTime() + 60 * 60_000).toISOString(),
        status: "confirmed" as const,
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0,
        routineSource: "preset" as const,
        routinePresetId: replacePreset(leadMinutes).id
      };
    }

    it("skips the wake rows entirely when the commitment's own prep would need to start before the wake routine's first instant", () => {
      // leadMinutes=5, commitment at 05:03Z: prep must start at 04:58Z, at/before the wake window's
      // own startsAt (05:00Z) — no room even for the first step.
      const response = calculatePlanAndForecast(
        request(
          wakeState(
            {},
            {
              sleepPlans: [sleepingPlan],
              routinePresets: [wakePreset, replacePreset(5)],
              commitments: [replacingCommitment("2026-08-14T05:03:00.000Z", 5)]
            }
          )
        )
      );
      expect(sleepGroup(response, sleepingPlan.id, "wake")).toEqual([]);
    });

    it("leaves the wake rows untouched when the commitment starts well clear of the wake routine's full end", () => {
      // leadMinutes=5, commitment at 06:00Z: prep must start at 05:55Z, at/after the full end (05:30Z)
      // — no overlap at all.
      const response = calculatePlanAndForecast(
        request(
          wakeState(
            {},
            {
              sleepPlans: [sleepingPlan],
              routinePresets: [wakePreset, replacePreset(5)],
              commitments: [replacingCommitment("2026-08-14T06:00:00.000Z", 5)]
            }
          )
        )
      );
      const group = sleepGroup(response, sleepingPlan.id, "wake");
      expect(group.length).toBe(3);
      expect(activeBounds(group)).toEqual({ startsAt: "2026-08-14T05:00:00.000Z", endsAt: "2026-08-14T05:30:00.000Z" });
      expect(group.every((item) => item.status === "pending")).toBe(true);
    });

    it("truncates instead of skipping when the commitment's own prep would land inside the wake window, dropping only the steps that would fall past it", () => {
      // leadMinutes=5, commitment at 05:20Z: prep must start at 05:15Z, inside (05:00Z, 05:30Z) — step
      // 0 (05:00-05:10) fits, steps 1 and 2 (would run 05:10-05:20 and 05:20-05:30 back to back) don't.
      const response = calculatePlanAndForecast(
        request(
          wakeState(
            {},
            {
              sleepPlans: [sleepingPlan],
              routinePresets: [wakePreset, replacePreset(5)],
              commitments: [replacingCommitment("2026-08-14T05:20:00.000Z", 5)]
            }
          )
        )
      );
      const group = sleepGroup(response, sleepingPlan.id, "wake");
      expect(activeBounds(group)).toEqual({ startsAt: "2026-08-14T05:00:00.000Z", endsAt: "2026-08-14T05:10:00.000Z" });
      expect(presetStepIdsWithStatus(group, "skipped")).toEqual(["wake-step-1", "wake-step-2"]);
      expect(presetStepIdsWithStatus(group, "completed")).toEqual([]);
    });

    it("never relitigates an already-completed step even when it falls past the truncation cutoff", () => {
      const existingStep = {
        id: "existing-wake-step-1",
        version: 1,
        anchorType: "sleep_plan" as const,
        anchorId: sleepingPlan.id,
        purpose: "wake" as const,
        title: "Shower",
        durationMinutes: 10,
        sequence: 1,
        timingRule: "contiguous" as const,
        energy: "low" as const,
        contexts: [],
        dependencyIds: [],
        phase: "after" as const,
        presetStepId: "wake-step-1",
        status: "completed" as const,
        scheduledStartAt: "2026-08-14T05:10:00.000Z",
        scheduledEndAt: "2026-08-14T05:20:00.000Z"
      };
      const response = calculatePlanAndForecast(
        request(
          wakeState(
            {},
            {
              sleepPlans: [sleepingPlan],
              routinePresets: [wakePreset, replacePreset(5)],
              commitments: [replacingCommitment("2026-08-14T05:20:00.000Z", 5)],
              routineSteps: [existingStep]
            }
          )
        )
      );
      const group = sleepGroup(response, sleepingPlan.id, "wake");
      // wake-step-1 stays completed (a completed step is a fact, never relitigated) and its 05:10-05:20
      // slot still counts as run, so only wake-step-2 (05:20-05:30, past the 05:15Z cutoff) is dropped.
      expect(group.find((item) => item.presetStepId === "wake-step-1")?.status).toBe("completed");
      expect(presetStepIdsWithStatus(group, "skipped")).toEqual(["wake-step-2"]);
      expect(activeBounds(group).endsAt).toBe("2026-08-14T05:20:00.000Z");
      // Identity carried forward, since the persisted row is returned unchanged.
      expect(group.find((item) => item.presetStepId === "wake-step-1")?.id).toBe(existingStep.id);
    });
  });

  describe("wake step identity", () => {
    it("keeps a deterministic id stable across recomputes and never collides with a same-night bedtime step", () => {
      const state = wakeState(
        { bedtimeRoutinePresetId: bedtimePreset.id },
        { routinePresets: [bedtimePreset, wakePreset] }
      );
      const first = calculatePlanAndForecast(request(state));
      const anchorId = (first.derivedState.sleepPlans[0] as Record<string, unknown>).id as string;
      const bedtime = sleepGroup(first, anchorId, "bedtime")[0];
      const wake = sleepGroup(first, anchorId, "wake")[0];
      expect(bedtime).toBeDefined();
      expect(wake).toBeDefined();
      // Both resolve to the same forward-computed night, so they'd collide under an anchorId-only
      // key — this is exactly what `purpose` (§1.1 of the wake routine design note) exists to prevent.
      expect(bedtime!.anchorId).toBe(wake!.anchorId);
      expect(bedtime!.id).not.toBe(wake!.id);

      const second = calculatePlanAndForecast(request(state));
      const secondWake = sleepGroup(second, anchorId, "wake")[0];
      expect(secondWake?.id).toBe(wake!.id);
    });
  });

  describe("cadence-linked wake steps", () => {
    // Every action needs a real project to point at (portalStateSchema's cross-reference check).
    const projectFixture = {
      areas: [{ id: "area-1", name: "Health", status: "active" as const, sortOrder: 0 }],
      outcomes: [
        {
          id: "outcome-1",
          areaId: "area-1",
          title: "Keep practicing",
          definitionOfDone: "Still practicing",
          value: 3,
          status: "active" as const
        }
      ],
      projects: [
        {
          id: "project-1",
          title: "Piano",
          area: "area-1",
          outcomeId: "outcome-1",
          status: "active" as const,
          uncertainty: "known" as const,
          value: 3,
          consequence: 3
        }
      ]
    };
    // Mirrors the `cadenceAction(...)` fixture in `engine/core/test/system/cadence.test.ts`.
    const cadenceAction = (lastCompletedLocalDate: string) => ({
      id: "cadence-action-1",
      projectId: "project-1",
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
        id: "cadence-action-1-rule",
        actionId: "cadence-action-1",
        timezone: "Australia/Sydney",
        startDate: "2026-08-01",
        intervalDays: 7,
        windows: [],
        completionMode: "manual" as const,
        lastCompletedLocalDate,
        lastCompletedAt: `${lastCompletedLocalDate}T08:00:00.000Z`,
        completionCount: 1
      }
    });

    const cadenceWakePreset = {
      id: "77777777-7777-4777-8777-777777777777",
      version: 1,
      name: "Wake with practice",
      activityName: "Morning routine",
      status: "active" as const,
      steps: [
        {
          id: "ordinary-step",
          title: "Stretch",
          durationMinutes: 10,
          sequence: 0,
          timingRule: "contiguous" as const,
          energy: "low" as const,
          contexts: [],
          dependencyIds: [],
          phase: "before" as const
        },
        {
          id: "cadence-step",
          title: "Practice piano",
          durationMinutes: 10,
          sequence: 1,
          timingRule: "contiguous" as const,
          energy: "low" as const,
          contexts: [],
          dependencyIds: [],
          phase: "before" as const,
          cadenceActionId: "cadence-action-1"
        }
      ]
    };

    it("omits a cadence-linked step whose action is not due today entirely", () => {
      const response = calculatePlanAndForecast(
        request(
          wakeState(
            { wakeRoutinePresetId: cadenceWakePreset.id },
            {
              ...projectFixture,
              routinePresets: [cadenceWakePreset],
              // Cadence eligibility (cadenceEligibleFrom) is day-granular "not twice in one day", not
              // gated by intervalDays — already completed today (the same local day as `now`, 08-14),
              // so not eligible again until 08-15.
              actions: [cadenceAction("2026-08-14")]
            }
          )
        )
      );
      const anchorId = (response.derivedState.sleepPlans[0] as Record<string, unknown>).id as string;
      const group = sleepGroup(response, anchorId, "wake");
      expect(activeMinutes(group)).toBe(10);
      // Reserves none of the window and is dropped from the template entirely — the same rule a
      // cadence-gated-out commitment routine step follows (`routine-inheritance.ts`).
      expect(group.some((item) => item.presetStepId === "cadence-step")).toBe(false);
    });

    it("includes the cadence-linked step alongside the ordinary one once its cadence is due", () => {
      const response = calculatePlanAndForecast(
        request(
          wakeState(
            { wakeRoutinePresetId: cadenceWakePreset.id },
            {
              ...projectFixture,
              routinePresets: [cadenceWakePreset],
              // Last completed before today, so eligible again as of this morning.
              actions: [cadenceAction("2026-08-01")]
            }
          )
        )
      );
      const anchorId = (response.derivedState.sleepPlans[0] as Record<string, unknown>).id as string;
      const group = sleepGroup(response, anchorId, "wake");
      expect(activeMinutes(group)).toBe(20);
      expect(group.find((item) => item.presetStepId === "cadence-step")?.status).toBe("pending");
    });

    it("fails closed (omits the step) when the linked action is no longer schedulingMode 'cadence'", () => {
      const detached = { ...cadenceAction("2026-08-10"), schedulingMode: "one_off" as const, recurrence: undefined };
      const response = calculatePlanAndForecast(
        request(
          wakeState(
            { wakeRoutinePresetId: cadenceWakePreset.id },
            { ...projectFixture, routinePresets: [cadenceWakePreset], actions: [detached] }
          )
        )
      );
      const anchorId = (response.derivedState.sleepPlans[0] as Record<string, unknown>).id as string;
      const group = sleepGroup(response, anchorId, "wake");
      // Only the ordinary step's 10 minutes: a link the gate cannot evaluate is not due, never silently
      // included, so the cadence step is dropped exactly as if its cadence just wasn't due.
      expect(activeMinutes(group)).toBe(10);
      expect(group.some((item) => item.presetStepId === "cadence-step")).toBe(false);
    });

    it("fails closed (omits the step) when the linked action no longer exists at all", () => {
      const response = calculatePlanAndForecast(
        request(
          wakeState(
            { wakeRoutinePresetId: cadenceWakePreset.id },
            { ...projectFixture, routinePresets: [cadenceWakePreset], actions: [] }
          )
        )
      );
      const anchorId = (response.derivedState.sleepPlans[0] as Record<string, unknown>).id as string;
      const group = sleepGroup(response, anchorId, "wake");
      expect(activeMinutes(group)).toBe(10);
      expect(group.some((item) => item.presetStepId === "cadence-step")).toBe(false);
    });
  });
});
