import { describe, expect, it } from "vitest";
import { PLAN_FORECAST_CONTRACT_VERSION, planForecastRequestSchema, portalStateSchema } from "@openrhen/contracts";
import { calculatePlanAndForecast } from "../../src/index.js";

// 14:00 on Friday 14 August in the seed zone, with a capacity window open around it.
const now = new Date("2026-08-14T04:00:00.000Z");
const HOUR = 60 * 60_000;

function cadenceAction(
  id: string,
  title: string,
  importance: number,
  rule: { intervalDays: number; lastCompletedLocalDate?: string; startDate?: string; endDate?: string }
) {
  return {
    id,
    projectId: "project-1",
    title,
    status: "active",
    optimisticMinutes: 20,
    expectedMinutes: 30,
    remainingMinutes: 30,
    pessimisticMinutes: 45,
    energy: "medium",
    minimumSessionMinutes: 15,
    maximumSessionMinutes: 45,
    importance,
    consequence: 3,
    contexts: [],
    dependencyIds: [],
    splittable: true,
    setupMinutes: 0,
    schedulingMode: "cadence",
    recurrence: {
      id: `${id}-rule`,
      actionId: id,
      timezone: "Australia/Sydney",
      startDate: rule.startDate ?? "2026-08-01",
      ...(rule.endDate ? { endDate: rule.endDate } : {}),
      intervalDays: rule.intervalDays,
      windows: [],
      completionMode: "manual",
      ...(rule.lastCompletedLocalDate
        ? {
            lastCompletedLocalDate: rule.lastCompletedLocalDate,
            lastCompletedAt: `${rule.lastCompletedLocalDate}T08:00:00.000Z`,
            completionCount: 1
          }
        : {})
    }
  };
}

/** a period/target cadence rule, wire-shaped the way the portal reads it off the completion log. */
function periodCadenceAction(
  id: string,
  title: string,
  importance: number,
  rule: {
    period: { unit: "days"; length: number } | { unit: "month" };
    targetOccurrences: number;
    completionLocalDates?: string[];
    startDate?: string;
  }
) {
  const completions = rule.completionLocalDates ?? [];
  return {
    id,
    projectId: "project-1",
    title,
    status: "active",
    optimisticMinutes: 20,
    expectedMinutes: 30,
    remainingMinutes: 30,
    pessimisticMinutes: 45,
    energy: "medium",
    minimumSessionMinutes: 15,
    maximumSessionMinutes: 45,
    importance,
    consequence: 3,
    contexts: [],
    dependencyIds: [],
    splittable: true,
    setupMinutes: 0,
    schedulingMode: "cadence",
    recurrence: {
      id: `${id}-rule`,
      actionId: id,
      timezone: "Australia/Sydney",
      startDate: rule.startDate ?? "2026-08-01",
      intervalDays: 1,
      windows: [],
      completionMode: "manual",
      period: rule.period,
      targetOccurrences: rule.targetOccurrences,
      ...(completions.length
        ? {
            lastCompletedLocalDate: completions[completions.length - 1],
            lastCompletedAt: `${completions[completions.length - 1]}T08:00:00.000Z`,
            completionCount: completions.length,
            completionLocalDates: completions
          }
        : {})
    }
  };
}

interface StateOverrides {
  routineSteps?: unknown[];
  routinePresets?: unknown[];
}

function state(actions: unknown[], overrides: StateOverrides = {}) {
  return portalStateSchema.parse({
    settings: {
      timezone: "Australia/Sydney",
      locale: "en-AU",
      planningHorizonEnd: "22:00",
      defaultUsableFraction: 1,
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
    areas: [{ id: "area-1", name: "Learning", status: "active", sortOrder: 0 }],
    outcomes: [
      {
        id: "outcome-1",
        areaId: "area-1",
        title: "Better at maths",
        definitionOfDone: "Pass",
        value: 3,
        status: "active"
      }
    ],
    projects: [
      {
        id: "project-1",
        title: "Getting better at maths",
        area: "area-1",
        outcomeId: "outcome-1",
        status: "active",
        uncertainty: "known",
        value: 3,
        consequence: 3
      }
    ],
    actions,
    // Automatic capacity spans the whole local day, so these two fixed commitments reproduce the
    // old manual window (now-1h to now+6h) by blocking its complement — local midnight up to the window's
    // start, and the window's end through well past the 14-day horizon — leaving exactly the same
    // minutes on offer as the old manual window did.
    commitments: [
      {
        id: "before-window",
        title: "Blocked (before window)",
        status: "confirmed",
        startsAt: new Date(now.getTime() - 14 * HOUR).toISOString(),
        endsAt: new Date(now.getTime() - HOUR).toISOString(),
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0
      },
      {
        id: "after-window",
        title: "Blocked (after window)",
        status: "confirmed",
        startsAt: new Date(now.getTime() + 6 * HOUR).toISOString(),
        endsAt: new Date(now.getTime() + 15 * 24 * HOUR).toISOString(),
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0
      }
    ],
    routineSteps: overrides.routineSteps ?? [],
    routinePresets: overrides.routinePresets ?? [],
    occurrences: [],
    sleepPlans: [],
    captures: [],
    completedToday: [],
    assertedConditions: ["home"],
    currentEnergy: "medium",
    horizonEnd: new Date(now.getTime() + 14 * 24 * HOUR).toISOString(),
    activeSession: null
  });
}

/** The slice of the wire recommendation these tests read; the response carries it as plain JSON. */
interface WireRecommendation {
  primary: { action: { id: string }; criticalTier: string } | null;
  candidates: Array<{ action: { id: string }; eligible: boolean; exclusionReasons: string[] }>;
  evidence: string[];
}

function run(actions: unknown[], overrides: StateOverrides = {}) {
  const response = calculatePlanAndForecast(
    planForecastRequestSchema.parse({
      contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
      requestId: "00000000-0000-4000-8000-000000000003",
      inputVersion: "cadence-fixture",
      calculatedAt: now.toISOString(),
      horizonEnd: new Date(now.getTime() + 14 * 24 * HOUR).toISOString(),
      state: state(actions, overrides)
    })
  );
  return {
    recommendation: response.recommendation as unknown as WireRecommendation,
    weekOutlook: response.weekOutlook as
      | {
          reservedMinutes: number;
          freeMinutes: number;
          capacityMinutes: number;
          projects: unknown[];
          cadence?: { demandMinutesPerWeek: number; due: unknown[]; softReservedMinutes: number; actions: unknown[] };
        }
      | undefined
  };
}

describe("cadence through the whole engine", () => {
  it("recommends due cadence actions by importance and explains it as cadence due", () => {
    const response = run([
      cadenceAction("maths", "Maths practice", 5, { intervalDays: 1, lastCompletedLocalDate: "2026-08-13" }),
      cadenceAction("run", "Run", 2, { intervalDays: 3, lastCompletedLocalDate: "2026-08-11" })
    ]);
    expect(response.recommendation.primary?.action.id).toBe("maths");
    expect(response.recommendation.primary?.criticalTier).toBe("ordinary");
    expect(JSON.stringify(response.recommendation.evidence)).toContain("Cadence due");
  });

  it("withholds a cadence action done today until tomorrow, so the next one leads", () => {
    const response = run([
      cadenceAction("maths", "Maths practice", 5, { intervalDays: 1, lastCompletedLocalDate: "2026-08-14" }),
      cadenceAction("run", "Run", 2, { intervalDays: 3, lastCompletedLocalDate: "2026-08-11" })
    ]);
    expect(response.recommendation.primary?.action.id).toBe("run");
    const maths = response.recommendation.candidates.find((item) => item.action.id === "maths")!;
    expect(maths.eligible).toBe(false);
    // Eligible again from local midnight: 15 August 00:00 local is 14 August 14:00Z.
    expect(maths.exclusionReasons[0]).toContain("Sat, 15 Aug, 12:00 am");
  });

  it("retires a series whose end date has passed", () => {
    const response = run([
      cadenceAction("maths", "Maths practice", 5, {
        intervalDays: 1,
        lastCompletedLocalDate: "2026-08-10",
        endDate: "2026-08-12"
      })
    ]);
    const maths = response.recommendation.candidates.find((item) => item.action.id === "maths")!;
    expect(maths.eligible).toBe(false);
    expect(maths.exclusionReasons).toContain("The series ended on 2026-08-12.");
  });

  it("reports the week's cadence demand and what is already due, without reserving it", () => {
    const response = run([
      cadenceAction("maths", "Maths practice", 5, { intervalDays: 1, lastCompletedLocalDate: "2026-08-12" }),
      cadenceAction("run", "Run", 2, { intervalDays: 3, lastCompletedLocalDate: "2026-08-13" })
    ]);
    // 30 minutes daily plus 30 minutes every third day.
    expect(response.weekOutlook?.cadence?.demandMinutesPerWeek).toBe(280);
    expect(response.weekOutlook?.cadence?.due).toEqual([
      { actionId: "maths", dueLocalDate: "2026-08-13", daysOverdue: 1 }
    ]);
  });

  it("soft-fits this week's cadence demand against free minutes, without reserving it in the forecast", () => {
    const response = run([
      cadenceAction("maths", "Maths practice", 5, { intervalDays: 1, lastCompletedLocalDate: "2026-08-12" }),
      cadenceAction("run", "Run", 2, { intervalDays: 3, lastCompletedLocalDate: "2026-08-13" })
    ]);
    const cadence = response.weekOutlook?.cadence as unknown as {
      demandMinutesPerWeek: number;
      softReservedMinutes: number;
      actions: Array<{ actionId: string; expectedOccurrences: number; fittingOccurrences: number }>;
    };
    // Once daily and once every three days.
    const maths = cadence.actions.find((item) => item.actionId === "maths")!;
    const run_ = cadence.actions.find((item) => item.actionId === "run")!;
    expect(maths.expectedOccurrences).toBe(7);
    expect(run_.expectedOccurrences).toBe(2);
    // Real free capacity exists this week (the fixture's own ~7-hour daily window), so some of the
    // soft demand fits — but never all of it and its own budget, since 30 minutes × (7 + 2) exceeds
    // what one day's free window holds.
    expect(cadence.softReservedMinutes).toBeGreaterThan(0);
    expect(cadence.softReservedMinutes).toBeLessThanOrEqual(cadence.demandMinutesPerWeek);
    expect(maths.fittingOccurrences).toBeGreaterThan(0);
    expect(maths.fittingOccurrences).toBeLessThanOrEqual(maths.expectedOccurrences);
  });

  it("cadence demand never changes the forecast's own numbers (invariant 8)", () => {
    // "project-1" has no ordinary actions here — the light run — then a heavy cadence load is added
    // on the same project; the week outlook's own reserved/free minutes (schedule-derived, not the
    // cadence soft pass) must be identical either way.
    const light = run([cadenceAction("maths", "Maths practice", 5, { intervalDays: 1 })]);
    const heavy = run([
      cadenceAction("maths", "Maths practice", 5, { intervalDays: 1 }),
      cadenceAction("run", "Run", 2, { intervalDays: 1 }),
      cadenceAction("stretch", "Stretch", 3, { intervalDays: 1 }),
      cadenceAction("read", "Read", 1, { intervalDays: 1 })
    ]);
    expect(heavy.weekOutlook?.reservedMinutes).toBe(light.weekOutlook?.reservedMinutes);
    expect(heavy.weekOutlook?.freeMinutes).toBe(light.weekOutlook?.freeMinutes);
    expect(heavy.weekOutlook?.capacityMinutes).toBe(light.weekOutlook?.capacityMinutes);
    expect(heavy.weekOutlook?.projects).toEqual(light.weekOutlook?.projects);
  });
});

describe("period/target cadence through the whole engine", () => {
  it("recommends a period rule whose block is nearly over over one whose plain interval is not yet due", () => {
    const response = run([
      periodCadenceAction("stretch", "Stretch twice a week", 5, {
        period: { unit: "days", length: 7 },
        targetOccurrences: 2,
        startDate: "2026-08-01"
      }),
      cadenceAction("run", "Run", 2, { intervalDays: 7, lastCompletedLocalDate: "2026-08-13" })
    ]);
    expect(response.recommendation.primary?.action.id).toBe("stretch");
    expect(response.recommendation.primary?.criticalTier).toBe("ordinary");
    expect(JSON.stringify(response.recommendation.evidence)).toContain("Cadence due");
  });

  it("withholds a period rule once its target is met for the block, so a still-short one leads", () => {
    const response = run([
      periodCadenceAction("stretch", "Stretch twice a week", 5, {
        period: { unit: "days", length: 7 },
        targetOccurrences: 2,
        startDate: "2026-08-01",
        completionLocalDates: ["2026-08-09", "2026-08-10"]
      }),
      cadenceAction("run", "Run", 2, { intervalDays: 3, lastCompletedLocalDate: "2026-08-11" })
    ]);
    const stretch = response.recommendation.candidates.find((item) => item.action.id === "stretch")!;
    expect(stretch.eligible).toBe(false);
    expect(response.recommendation.primary?.action.id).toBe("run");
  });

  it("counts a calendar-month target against completions logged that month, however long ago the rule started", () => {
    const response = run([
      periodCadenceAction("declutter", "Declutter a room", 4, {
        period: { unit: "month" },
        targetOccurrences: 1,
        startDate: "2026-01-01",
        completionLocalDates: ["2026-07-20"]
      })
    ]);
    // Last done in July, so August's target is still unmet — due, not carried over as satisfied.
    const declutter = response.recommendation.candidates.find((item) => item.action.id === "declutter")!;
    expect(declutter.eligible).toBe(true);
    expect(response.recommendation.primary?.action.id).toBe("declutter");
  });

  it("spreads a period rule's demand across its own block length in the week outlook", () => {
    const response = run([
      periodCadenceAction("stretch", "Stretch twice a week", 5, {
        period: { unit: "days", length: 7 },
        targetOccurrences: 2,
        startDate: "2026-08-01"
      })
    ]);
    // 30-minute sessions, twice every 7 days: 30 * 7 * (2/7) = 60 minutes/week.
    expect(response.weekOutlook?.cadence?.demandMinutesPerWeek).toBe(60);
  });
});

/**
 * One preset step standing in for `cadenceActionId`, and the sleep-anchored `routine_steps` row
 * running it. `purpose` defaults to "wake" (every existing call site's assumption) but is
 * configurable so bedtime's own purpose-aware reapplication of the gate in `cadenceCoveredActionIds`
 * gets the same coverage as wake's below. `state()` never sets
 * `bedtimeRoutinePresetId`/`wakeRoutinePresetId`, so `deriveSleepRoutineSteps` passes this fabricated
 * row through unchanged rather than re-deriving it — these tests exercise `cadenceCoveredActionIds`
 * directly against exactly the row given, standing in for what a real derive run would have already
 * placed in `state.routineSteps` by the time `cadenceCoveredActionIds` sees it.
 */
function cadenceLinkedInstance(
  cadenceActionId: string,
  status: "planned" | "doing" | "completed" = "planned",
  purpose: "wake" | "bedtime" = "wake"
) {
  return {
    routinePresets: [
      {
        id: "preset-1",
        name: "Morning",
        activityName: "Morning routine",
        status: "active",
        replacesWakeRoutine: false,
        steps: [
          {
            id: "preset-step-1",
            title: "Practice maths",
            durationMinutes: 20,
            sequence: 0,
            timingRule: "contiguous",
            energy: "medium",
            contexts: [],
            dependencyIds: [],
            phase: "before",
            cadenceActionId
          }
        ]
      }
    ],
    routineSteps: [
      {
        id: "instance-step-1",
        anchorType: "sleep_plan" as const,
        anchorId: "sleep-1",
        purpose,
        title: "Practice maths",
        durationMinutes: 20,
        sequence: 0,
        timingRule: "contiguous" as const,
        energy: "medium" as const,
        contexts: [],
        dependencyIds: [],
        phase: "before" as const,
        cadenceActionId,
        presetStepId: "preset-step-1",
        status: status === "planned" ? "pending" : status,
        scheduledStartAt: new Date(now.getTime() - HOUR).toISOString(),
        scheduledEndAt: new Date(now.getTime() + HOUR).toISOString()
      }
    ]
  };
}

/** One pending commitment routine step standing in for `cadenceActionId`. */
function cadenceLinkedRoutineStep(cadenceActionId: string, status: "pending" | "doing" | "completed" = "pending") {
  return {
    routineSteps: [
      {
        id: "step-1",
        commitmentId: "commitment-1",
        title: "Practice maths",
        durationMinutes: 20,
        sequence: 0,
        timingRule: "contiguous",
        energy: "medium",
        contexts: [],
        dependencyIds: [],
        phase: "before",
        cadenceActionId,
        status
      }
    ]
  };
}

describe("Feature B: cadence-linked routine steps suppress the double prompt", () => {
  it("excludes a due cadence action covered by a still-open wake/bedtime instance step", () => {
    const response = run(
      [cadenceAction("maths", "Maths practice", 5, { intervalDays: 1, lastCompletedLocalDate: "2026-08-12" })],
      cadenceLinkedInstance("maths")
    );
    const maths = response.recommendation.candidates.find((item) => item.action.id === "maths")!;
    expect(maths.eligible).toBe(false);
    expect(maths.exclusionReasons).toContain("Covered by today's routine step.");
  });

  it("leaves the action eligible once its routine instance is no longer open (completed)", () => {
    const response = run(
      [cadenceAction("maths", "Maths practice", 5, { intervalDays: 1, lastCompletedLocalDate: "2026-08-12" })],
      cadenceLinkedInstance("maths", "completed")
    );
    const maths = response.recommendation.candidates.find((item) => item.action.id === "maths")!;
    expect(maths.eligible).toBe(true);
  });

  it("excludes a due cadence action covered by a still-pending commitment routine step", () => {
    const response = run(
      [cadenceAction("maths", "Maths practice", 5, { intervalDays: 1, lastCompletedLocalDate: "2026-08-12" })],
      cadenceLinkedRoutineStep("maths")
    );
    const maths = response.recommendation.candidates.find((item) => item.action.id === "maths")!;
    expect(maths.eligible).toBe(false);
    expect(maths.exclusionReasons).toContain("Covered by today's routine step.");
  });

  it("leaves the action eligible once its commitment routine step is completed", () => {
    const response = run(
      [cadenceAction("maths", "Maths practice", 5, { intervalDays: 1, lastCompletedLocalDate: "2026-08-12" })],
      cadenceLinkedRoutineStep("maths", "completed")
    );
    const maths = response.recommendation.candidates.find((item) => item.action.id === "maths")!;
    expect(maths.eligible).toBe(true);
  });

  it("does not exclude an unrelated action sharing no cadence link with the covered step", () => {
    const response = run(
      [
        cadenceAction("maths", "Maths practice", 5, { intervalDays: 1, lastCompletedLocalDate: "2026-08-12" }),
        cadenceAction("run", "Run", 2, { intervalDays: 1, lastCompletedLocalDate: "2026-08-12" })
      ],
      cadenceLinkedRoutineStep("maths")
    );
    const run_ = response.recommendation.candidates.find((item) => item.action.id === "run")!;
    expect(run_.eligible).toBe(true);
  });

  // first half: `cadenceCoveredActionIds` must count only steps a bedtime instance actually
  // materialises tonight (its "before"-phase steps, cadence-gated the same as `deriveBedtimeInstances`
  // itself), not every step the preset happens to carry — otherwise a step gated out as not-due would
  // still silence the ordinary suggestion nobody is standing in for tonight.
  it("excludes a due cadence action covered by a still-open bedtime instance step, same as wake", () => {
    const response = run(
      [cadenceAction("maths", "Maths practice", 5, { intervalDays: 1, lastCompletedLocalDate: "2026-08-12" })],
      cadenceLinkedInstance("maths", "planned", "bedtime")
    );
    const maths = response.recommendation.candidates.find((item) => item.action.id === "maths")!;
    expect(maths.eligible).toBe(false);
    expect(maths.exclusionReasons).toContain("Covered by today's routine step.");
  });

  it("does not attribute exclusion to routine-step coverage when the bedtime step is gated out (not due) and so was never materialised at all", () => {
    const response = run(
      // Already completed today (the same local day as `now`, 08-14) — not due again until 08-15, so
      // `cadenceStepIncludedToday` gates this step out of tonight, and a real `deriveSleepRoutineSteps`
      // run would never have created a row for it (dropped from the template entirely) — this
      // fixture mirrors exactly that outcome by giving `state.routineSteps` no row for it at all,
      // standing in for what a naive purpose-blind or gate-blind `cadenceCoveredActionIds` would have
      // wrongly counted as covered had the row existed. The action is genuinely ineligible here too —
      // "becomes available" is a real, independent reason, since a not-due cadence action is excluded
      // from ordinary ranking on its own account — so this asserts the specific attribution rather than
      // overall eligibility: nothing stood in for it tonight, so nothing should say so.
      [cadenceAction("maths", "Maths practice", 5, { intervalDays: 1, lastCompletedLocalDate: "2026-08-14" })],
      { ...cadenceLinkedInstance("maths", "planned", "bedtime"), routineSteps: [] }
    );
    const maths = response.recommendation.candidates.find((item) => item.action.id === "maths")!;
    expect(maths.eligible).toBe(false);
    expect(maths.exclusionReasons).not.toContain("Covered by today's routine step.");
  });
});
