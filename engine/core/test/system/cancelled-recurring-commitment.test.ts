import { describe, expect, it } from "vitest";
import { PLAN_FORECAST_CONTRACT_VERSION, planForecastRequestSchema, portalStateSchema } from "@openrhen/contracts";
import { calculatePlanAndForecast } from "../../src/index.js";

const now = new Date("2026-09-03T12:00:00.000Z");

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
      // Bedtime lands 45 minutes after `now`, close enough to it that the recurring commitment
      // below (starting 2h15 after `now`) cannot be escaped by sleeping earlier: there simply is no
      // "earlier" left before `now` itself, exactly like the missed-start pressure of a cancelled occurrence.
      preferredBedtime: "22:30",
      preferredWakeTime: "07:00",
      desiredSleepMinutes: 480,
      minimumSleepMinutes: 420,
      maxAwakeHours: 16,
      lastWokeAt: "2026-09-03T00:00:00.000Z"
    },
    areas: [],
    outcomes: [],
    projects: [],
    actions: [],
    commitments: [],
    commitmentRecurrenceRules: [],
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
    requestId: "00000000-0000-4000-8000-000000000004",
    inputVersion: "cancelled-recurring-commitment-fixture",
    calculatedAt: now.toISOString(),
    horizonEnd: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
    state
  });
}

// A cancelled occurrence still shaped the plan, including a sleep cut. A recurring commitment is represented in every
// engine run by a freshly regenerated occurrence (`deriveCommitmentRepeats`), never by its own
// row in `state.commitments` — that row exists only to carry a per-occurrence override, such as a
// single date's cancellation. `protectedCommitments` used to ignore that row entirely for a recurring
// commitment (excluded by `!item.recurrenceRuleId`) and always treat the regenerated occurrence as
// `confirmed`, so cancelling one occurrence changed nothing an engine run could see: the sleep
// planner still truncated the night to protect a commitment the user had just cancelled.
describe("a cancelled occurrence of a recurring commitment", () => {
  const rule = {
    id: "22222222-2222-4222-8222-222222222222",
    title: "Cooking class",
    timezone: "Australia/Sydney",
    startDate: "2026-09-04",
    repeat: { unit: "days" as const, intervalDays: 7 },
    localStartTime: "01:00",
    // Ends close enough to `preferredWakeTime` (07:00) that sleeping *after* it can no longer reach
    // the full 480 minutes either — an "after" escape is now searched (`sleep.ts`'s alternatives gate
    // widened to trigger whenever the anchor fails to meet the minimum, not only when it deviates from
    // bedtime), so a commitment a night could simply outlast no longer proves the constraint below.
    localEndTime: "06:30",
    setupBeforeMinutes: 0,
    transitionAfterMinutes: 0,
    status: "active" as const
  };

  it("still fits the full minimum sleep, with no wake constraint left behind", () => {
    // First pass: the rule alone (no per-occurrence override) constrains tonight's sleep, same as a
    // live, non-cancelled commitment would. This also tells us the deterministic id the engine assigns
    // the regenerated occurrence, which the second pass needs to reference.
    const withoutOverride = baseState({ commitmentRecurrenceRules: [rule] });
    const firstResponse = calculatePlanAndForecast(request(withoutOverride));
    const firstSleep = firstResponse.derivedState.sleepPlans[0] as Record<string, unknown> | undefined;
    expect(firstSleep, "a sleep plan was derived").toBeDefined();
    expect(firstSleep?.wakeConstraint, "the live rule constrains sleep").toBeDefined();
    expect(firstSleep?.hardErrors).toEqual(
      expect.arrayContaining([expect.stringContaining("Minimum sleep cannot be met")])
    );
    expect(firstSleep?.allowedMinutes).toBeLessThan(420);

    const occurrence = firstResponse.derivedState.commitmentRepeats?.[0] as Record<string, unknown> | undefined;
    expect(occurrence, "the rule materialised tonight's occurrence").toBeDefined();

    // Second pass: the same rule, but the materialised occurrence for tonight now carries the
    // cancellation a user's "remove this one" action would write — same id, status flipped to
    // 'cancelled'. Nothing about the rule itself changed.
    const withCancelledOverride = baseState({
      commitmentRecurrenceRules: [rule],
      commitments: [
        {
          id: occurrence!.id,
          title: rule.title,
          startsAt: occurrence!.startsAt,
          endsAt: occurrence!.endsAt,
          status: "cancelled",
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0,
          recurrenceRuleId: rule.id,
          localDate: occurrence!.localDate
        }
      ]
    });
    const secondResponse = calculatePlanAndForecast(request(withCancelledOverride));
    const secondSleep = secondResponse.derivedState.sleepPlans[0] as Record<string, unknown> | undefined;

    expect(secondSleep, "a sleep plan was derived").toBeDefined();
    expect(secondSleep?.wakeConstraint, "the cancelled occurrence must not constrain sleep").toBeUndefined();
    expect(secondSleep?.hardErrors).toEqual([]);
    expect(secondSleep?.allowedMinutes).toBe(480);

    // The day plan must not carry a protected block for the cancelled occurrence either — the same
    // list (`protectedCommitments`) feeds both the sleep wake constraint and the day plan's commitment
    // blocks, so fixing one without the other would leave the reported "remnant" block behind.
    const dayPlanBlocks = (secondResponse.dayPlan as { blocks?: Array<Record<string, unknown>> } | null)?.blocks ?? [];
    expect(dayPlanBlocks.some((block) => block.targetId === occurrence!.id)).toBe(false);
  });
});
