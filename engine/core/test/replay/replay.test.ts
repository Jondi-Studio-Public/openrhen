import { describe, expect, it } from "vitest";
import type { ProjectHealth } from "@openrhen/contracts";
import { cadenceEligibleFrom, localDate, planSchedule, recommend, resolvePlanningCapacity } from "../../src/index.js";
import type { Action, CapacityWindow, CriticalTier, FixedCommitment, Project } from "../../src/index.js";
import assignmentOutranksDistantHobby from "./assignment-outranks-distant-hobby.json" with { type: "json" };
import behindProjectLeads from "./behind-project-leads.json" with { type: "json" };
import externalDeadlineOutranksInternal from "./external-deadline-outranks-internal.json" with { type: "json" };
import recoveryWhenNothingFits from "./recovery-when-nothing-fits.json" with { type: "json" };
import unknownForecastDoesNotLead from "./unknown-forecast-does-not-lead.json" with { type: "json" };
import overdueSelfSetYieldsToLiveDeadlines from "./overdue-self-set-yields-to-live-deadlines.json" with { type: "json" };
import overdueExternalStaysOnTop from "./overdue-external-stays-on-top.json" with { type: "json" };
import nothingFitsBeforeDailyHorizon from "./nothing-fits-before-daily-horizon.json" with { type: "json" };
import dayEndedNextFitTomorrow from "./day-ended-next-fit-tomorrow.json" with { type: "json" };
import { holding } from "../model/situation.js";
import { compactDayPlan, dayPlanFor } from "../model/day-plan-harness.js";
import dayPlanSplitsAroundCommitment from "./day-plan-splits-around-commitment.json" with { type: "json" };
import imminentStartOutranksHigherStakes from "./imminent-start-outranks-higher-stakes.json" with { type: "json" };
import cadenceDueFillsFreeTime from "./cadence-due-fills-free-time.json" with { type: "json" };

// Fixtures are listed explicitly so this package keeps no filesystem dependency. Add new files here.
const fixtureFiles: Array<[string, unknown]> = [
  ["assignment-outranks-distant-hobby.json", assignmentOutranksDistantHobby],
  ["behind-project-leads.json", behindProjectLeads],
  ["external-deadline-outranks-internal.json", externalDeadlineOutranksInternal],
  ["recovery-when-nothing-fits.json", recoveryWhenNothingFits],
  ["unknown-forecast-does-not-lead.json", unknownForecastDoesNotLead],
  ["overdue-self-set-yields-to-live-deadlines.json", overdueSelfSetYieldsToLiveDeadlines],
  ["overdue-external-stays-on-top.json", overdueExternalStaysOnTop],
  ["nothing-fits-before-daily-horizon.json", nothingFitsBeforeDailyHorizon],
  ["day-ended-next-fit-tomorrow.json", dayEndedNextFitTomorrow],
  ["day-plan-splits-around-commitment.json", dayPlanSplitsAroundCommitment],
  ["cadence-due-fills-free-time.json", cadenceDueFillsFreeTime],
  ["imminent-start-outranks-higher-stakes.json", imminentStartOutranksHigherStakes]
];

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
interface Fixture {
  name: string;
  why: string;
  calculatedAt: string;
  horizonDays: number;
  capacity: {
    mode: "automatic" | "manual";
    usableFraction?: number;
    timezone?: string;
    dayStartTime?: string;
    dayEndTime?: string;
    windows?: Array<{
      id: string;
      startMinutes: number;
      endMinutes: number;
      energy: CapacityWindow["energy"];
      usableFraction?: number;
      contexts?: string[];
    }>;
  };
  currentEnergy?: Action["energy"];
  assertedConditions: string[];
  /** Minutes from calculatedAt to the daily planning horizon; negative when the day has already ended. */
  dailyHorizonMinutes?: number;
  projects: Array<{
    id: string;
    deadlineDays?: number;
    externalDeadlineDays?: number;
    value: number;
    consequence: number;
    uncertainty?: Project["uncertainty"];
  }>;
  actions: Array<{
    id: string;
    projectId: string;
    minutes: number;
    consequence?: number;
    importance?: number;
    energy?: Action["energy"];
    minimumSessionMinutes?: number;
    maximumSessionMinutes?: number;
    lastWorkedDaysAgo?: number;
    contexts?: string[];
    /** A cadence: suggested every `intervalDays`, last done this many days ago (absent = never). */
    cadence?: { intervalDays: number; lastDoneDaysAgo?: number };
  }>;
  commitments: Array<{ id: string; startMinutes: number; endMinutes: number }>;
  expect: {
    primaryActionId?: string | null;
    criticalRank?: number;
    criticalTier?: CriticalTier;
    /** Tier of named candidates, eligible or not, so a fixture can pin where the loser landed too. */
    candidateTiers?: Record<string, CriticalTier>;
    directiveKind?: string;
    health?: Record<string, ProjectHealth>;
    overdue?: Record<string, boolean>;
    /** Projects whose forecast must carry a proposal with a feasible date. */
    proposalFeasible?: string[];
    noFit?: { kind: "answer" | "boundary" | "none"; boundaryKind?: string; nextFitActionId?: string | null };
    /** The projected day in `compactDayPlan` form, one line per block, through the daily horizon. */
    dayPlan?: string[];
  };
}

function load(): Array<{ file: string; fixture: Fixture }> {
  return fixtureFiles.map(([file, fixture]) => ({ file, fixture: fixture as Fixture }));
}

function replay(fixture: Fixture) {
  const now = new Date(fixture.calculatedAt);
  const horizonEnd = new Date(now.getTime() + fixture.horizonDays * DAY_MS);
  const at = (minutes: number) => new Date(now.getTime() + minutes * MINUTE_MS);

  const capacityWindows: CapacityWindow[] =
    fixture.capacity.mode === "manual"
      ? (fixture.capacity.windows ?? []).map((item) => ({
          id: item.id,
          startsAt: at(item.startMinutes),
          endsAt: at(item.endMinutes),
          energy: item.energy,
          contexts: item.contexts ?? [],
          usableFraction: item.usableFraction ?? 1
        }))
      : resolvePlanningCapacity({
          now,
          horizonEnd,
          usableFraction: fixture.capacity.usableFraction ?? 0.85,
          timezone: fixture.capacity.timezone ?? "Australia/Sydney",
          dayStartTime: fixture.capacity.dayStartTime ?? "07:00",
          dayEndTime: fixture.capacity.dayEndTime ?? "22:00"
        });

  const projects: Project[] = fixture.projects.map((item) => ({
    id: item.id,
    status: "active",
    uncertainty: item.uncertainty ?? "known",
    value: item.value,
    consequence: item.consequence,
    outcomeActive: true,
    ...(item.deadlineDays === undefined
      ? {}
      : { internalDeadlineAt: new Date(now.getTime() + item.deadlineDays * DAY_MS) }),
    ...(item.externalDeadlineDays === undefined
      ? {}
      : { externalDeadlineAt: new Date(now.getTime() + item.externalDeadlineDays * DAY_MS) })
  }));

  const actions: Action[] = fixture.actions.map((item) => ({
    id: item.id,
    projectId: item.projectId,
    title: item.id,
    status: "active",
    optimisticMinutes: Math.round(item.minutes * 0.8),
    expectedMinutes: item.minutes,
    pessimisticMinutes: Math.round(item.minutes * 1.4),
    remainingMinutes: item.minutes,
    energy: item.energy ?? "high",
    minimumSessionMinutes: item.minimumSessionMinutes ?? 30,
    maximumSessionMinutes: item.maximumSessionMinutes ?? 60,
    importance: item.importance ?? 3,
    consequence: item.consequence ?? 3,
    contexts: item.contexts ?? [],
    dependenciesComplete: true,
    dependencyIds: [],
    splittable: true,
    setupMinutes: 0,
    ...(item.lastWorkedDaysAgo === undefined
      ? {}
      : { lastWorkedAt: new Date(now.getTime() - item.lastWorkedDaysAgo * DAY_MS) }),
    ...(item.cadence ? cadenceRuleOf(item.cadence, now, fixture.capacity.timezone ?? "Australia/Sydney") : {})
  }));

  const commitments: FixedCommitment[] = fixture.commitments.map((item) => ({
    id: item.id,
    startsAt: at(item.startMinutes),
    endsAt: at(item.endMinutes)
  }));
  const schedule = planSchedule({
    now,
    horizonEnd,
    projects,
    actions,
    capacityWindows,
    commitments,
    projectedDailyProtectedMinutes: 30
  });
  const args = {
    now,
    horizonEnd,
    projects,
    actions,
    planning: schedule,
    forecasts: schedule.forecasts,
    capacityWindows,
    commitments,
    ...holding(...fixture.assertedConditions),
    ...(fixture.currentEnergy ? { currentEnergy: fixture.currentEnergy } : {}),
    ...(fixture.dailyHorizonMinutes !== undefined ? { dailyHorizonEnd: at(fixture.dailyHorizonMinutes) } : {}),
    ...(fixture.capacity.timezone ? { timezone: fixture.capacity.timezone } : {})
  };
  const recommendation = recommend(args);
  return { schedule, recommendation, args };
}

describe("replay fixtures", () => {
  const fixtures = load();

  it("finds fixtures to replay", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const { file, fixture } of fixtures) {
    it(`${file}: ${fixture.name}`, () => {
      const { schedule, recommendation, args } = replay(fixture);
      const expected = fixture.expect;

      if (expected.dayPlan !== undefined) {
        expect(compactDayPlan(dayPlanFor(args))).toEqual(expected.dayPlan);
      }

      if (expected.primaryActionId !== undefined) {
        expect(recommendation.primary?.action.id ?? null).toBe(expected.primaryActionId);
      }
      if (expected.criticalRank !== undefined) {
        expect(recommendation.primary?.criticalRank).toBe(expected.criticalRank);
      }
      if (expected.criticalTier !== undefined) {
        expect(recommendation.primary?.criticalTier).toBe(expected.criticalTier);
      }
      if (expected.candidateTiers) {
        for (const [actionId, tier] of Object.entries(expected.candidateTiers)) {
          expect(
            recommendation.candidates.find((item) => item.action.id === actionId)?.criticalTier,
            `tier of ${actionId}`
          ).toBe(tier);
        }
      }
      if (expected.overdue) {
        for (const [projectId, overdue] of Object.entries(expected.overdue)) {
          expect(
            schedule.forecasts.find((item) => item.projectId === projectId)?.overdue,
            `overdue of ${projectId}`
          ).toBe(overdue);
        }
      }
      for (const projectId of expected.proposalFeasible ?? []) {
        const proposal = schedule.forecasts.find((item) => item.projectId === projectId)?.proposal;
        expect(proposal, `proposal of ${projectId}`).toBeDefined();
        expect(proposal!.earliestFeasibleAt, `feasible date of ${projectId}`).not.toBeNull();
        expect(proposal!.earliestFeasibleAt!.getTime()).toBeGreaterThan(new Date(fixture.calculatedAt).getTime());
      }
      if (expected.noFit) {
        expect(recommendation.noFit?.kind).toBe(expected.noFit.kind);
        if (expected.noFit.boundaryKind !== undefined && recommendation.noFit?.kind === "boundary") {
          expect(recommendation.noFit.boundaryKind).toBe(expected.noFit.boundaryKind);
        }
        if (expected.noFit.nextFitActionId !== undefined && recommendation.noFit?.kind === "boundary") {
          expect(recommendation.noFit.nextFit?.targetId ?? null).toBe(expected.noFit.nextFitActionId);
        }
      }
      if (expected.health) {
        for (const [projectId, health] of Object.entries(expected.health)) {
          expect(
            schedule.forecasts.find((item) => item.projectId === projectId)?.health,
            `health of ${projectId}`
          ).toBe(health);
        }
      }
      if (expected.directiveKind === "recovery") {
        // The engine's directive selection lives above this layer; assert the condition it keys on.
        expect(recommendation.primary).toBeNull();
        expect(schedule.slots.some((slot) => slot.availability === "protected")).toBe(true);
      }
    });
  }
});

/**
 * The fields the engine derives for cadence when it hydrates an action, reproduced here so a
 * fixture can state a habit in plain terms: how often, and how many days since it was last done.
 */
function cadenceRuleOf(
  cadence: { intervalDays: number; lastDoneDaysAgo?: number },
  now: Date,
  timezone: string
): Pick<Action, "schedulingMode" | "cadence" | "availableFrom"> {
  const startDate = localDate(new Date(now.getTime() - 365 * DAY_MS), timezone);
  const rule = {
    intervalDays: cadence.intervalDays,
    timezone,
    startDate,
    ...(cadence.lastDoneDaysAgo === undefined
      ? {}
      : { lastCompletedLocalDate: localDate(new Date(now.getTime() - cadence.lastDoneDaysAgo * DAY_MS), timezone) }),
    completionCount: cadence.lastDoneDaysAgo === undefined ? 0 : 1
  };
  return { schedulingMode: "cadence", cadence: rule, availableFrom: cadenceEligibleFrom(rule, now) };
}
