import { describe, expect, it } from "vitest";
import { runCli } from "@openrhen/cli/in-process";
import type { PlanForecastResponse } from "@openrhen/contracts";
import { createSeedState, type PortalState, type StoredSleepPlan } from "@/state/portal-state";
import { buildNowModel, type NowRecommendation } from "./now-model";

/**
 * One planning run, two surfaces: what the Now page shows and what `rhen status` tells an agent
 * must be the same answer. The trust review (2026-10-27, lane B) found agents reading the whole state
 * because status said less than Now; both now read `planning/recommendation-answer.ts`, and this
 * runs the real CLI command against the same state the page model reads.
 */

const now = new Date("2026-08-18T10:00:00.000Z");
const iso = (minutesFromNow: number) => new Date(now.getTime() + minutesFromNow * 60_000).toISOString();

const recommendation = {
  primary: {
    action: { id: "action-a", title: "Write the report", projectId: "project-a" },
    eligible: true,
    exclusionReasons: [],
    recommendedMinutes: 40,
    recommendedWallClockMinutes: 48,
    totalScore: 3,
    scoreComponents: {}
  },
  alternatives: [
    {
      action: { id: "action-b", title: "Answer the email", projectId: "project-a" },
      eligible: true,
      exclusionReasons: [],
      recommendedMinutes: 15,
      totalScore: 2,
      scoreComponents: {}
    }
  ],
  candidates: [],
  headline: "Write the report",
  explanation: "Due Friday and nothing else is behind.",
  evidence: ["Due Friday"],
  why: {
    because: null,
    whyNot: {
      targetId: "action-b",
      title: "Answer the email",
      tier: "ordinary",
      tierLabel: "Ordinary",
      reason: "It can wait until after lunch.",
      decidingFactor: "deadline"
    },
    wouldChangeIf: []
  },
  needsAnswer: [],
  reachable: []
};

const night: StoredSleepPlan = {
  id: "sleep-tonight",
  plannedStartAt: iso(60),
  plannedWakeAt: iso(540),
  desiredMinutes: 480,
  allowedMinutes: 480,
  sleepDeficitMinutes: 0,
  anchorDeviationMinutes: 0,
  hardErrors: ["Sleep is shorter than the configured minimum."],
  explanation: "Protected sleep.",
  status: "planned"
};

const stayUpOffer = {
  nightId: "sleep-tonight",
  projectId: "project-a",
  projectTitle: "Report",
  actionId: "action-a",
  actionTitle: "Write the report",
  minutesBehind: 90,
  opensAt: iso(-30),
  closesAt: iso(30),
  choices: [{ minutes: 30, bedtimeAt: iso(20), wakeAt: iso(500), sleepMinutes: 480 }]
};

function state(sleep: StoredSleepPlan = night): PortalState {
  const result: PlanForecastResponse = {
    contractVersion: "1",
    requestId: "8fe5bba7-e436-429d-8011-67467b3ec55e",
    inputVersion: "abc123",
    engineVersion: "1.5.0",
    calculatedAt: now.toISOString(),
    validUntil: iso(60),
    derivedState: { sleepPlans: [], occurrences: [], routineSteps: [], commitmentRepeats: [], stepPlacements: [] },
    schedule: {},
    recommendation,
    currentDirective: { kind: "action", targetId: "action-a", title: "Write the report", recommendedMinutes: 40 },
    upcomingDirectives: [],
    continuation: null,
    softPlacements: [],
    stayUpOffer
  };
  return {
    ...createSeedState(now),
    sleepPlans: [sleep],
    planning: { status: "current", lastSuccessfulAt: now.toISOString(), validUntil: iso(60), result }
  } as PortalState;
}

async function statusJson(portalState: PortalState) {
  const stdout: string[] = [];
  const exitCode = await runCli(["status", "--json"], {
    stdout: (text) => stdout.push(text),
    stderr: () => undefined,
    env: { OPENRHEN_URL: "http://openrhen.localhost" } as unknown as NodeJS.ProcessEnv,
    readConfigFile: () => null,
    now: () => now,
    fetchImpl: async (input) => {
      const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
      if (path === "/api/state") return Response.json({ state: portalState });
      if (path === "/api/check-ins/current") return Response.json({ checkIn: null });
      return Response.json({ error: "not here" }, { status: 404 });
    }
  });
  expect(exitCode).toBe(0);
  return JSON.parse(stdout.join("\n"));
}

describe("Now and status give one answer", () => {
  it("agrees on the planned end, why not, runner-up, sleep errors and the stay-up offer", async () => {
    const portalState = state();
    const page = buildNowModel({
      state: portalState,
      recommendation: recommendation as unknown as NowRecommendation,
      forecasts: [],
      currentDirective: portalState.planning?.result?.currentDirective ?? null,
      now,
      manualBedtime: false
    });
    const status = await statusJson(portalState);

    // The page's kicker reads "until <plannedEnd>"; status must name the same minute.
    expect(new Date(status.recommendation.plannedEnd).getTime()).toBe(page.plannedEnd.getTime());
    expect(page.plannedEnd.toISOString()).toBe(iso(48));
    expect(status.recommendation.whyNot).toEqual(page.recommendationAnswer.whyNot);
    expect(status.recommendation.whyNot.title).toBe(recommendation.why.whyNot.title);
    expect(status.recommendation.runnerUp.targetId).toBe(recommendation.alternatives[0]!.action.id);
    expect(status.recommendation.sleep.hardErrors).toEqual(page.upcomingSleep?.hardErrors);
    expect(status.recommendation.stayUpOffer.nightId).toBe(page.stayUpOffer?.nightId);
    expect(status.recommendation.stayUpOffer.choices).toHaveLength(page.stayUpOffer?.choices.length ?? -1);
    expect(status.directive.targetId).toBe(page.primary?.action.id);
  });

  it("agrees when there is no plan yet: no headline, no end, no runner-up on either", async () => {
    const portalState = { ...createSeedState(now), planning: { status: "unavailable" } } as PortalState;
    const page = buildNowModel({
      state: portalState,
      // The provider's own placeholder while no result exists.
      recommendation: {
        primary: null,
        alternatives: [],
        candidates: [],
        headline: "No plan yet",
        explanation: "The planner hasn't produced a recommendation yet.",
        evidence: []
      },
      forecasts: [],
      currentDirective: null,
      now,
      manualBedtime: false
    });
    const status = await statusJson(portalState);
    expect(page.recommendationAnswer).toMatchObject({
      headline: null,
      explanation: null,
      runnerUp: null,
      whyNot: null
    });
    expect(status.recommendation).toMatchObject({ headline: null, explanation: null, runnerUp: null, whyNot: null });
    expect(status.recommendation.plannedEnd).toBeNull();
    expect(status.recommendation.plannedEnd).toBe(page.recommendationAnswer.plannedEnd);
  });

  it("gives no end for the ranked work when bedtime, not that work, is what Now shows", async () => {
    const portalState = state({ ...night, plannedStartAt: iso(-10), plannedWakeAt: iso(470) });
    const page = buildNowModel({
      state: portalState,
      recommendation: recommendation as unknown as NowRecommendation,
      forecasts: [],
      currentDirective: portalState.planning?.result?.currentDirective ?? null,
      now,
      manualBedtime: false
    });
    const status = await statusJson(portalState);
    // The page's kicker reads "Bedtime" here, never "until <the primary's end>".
    expect(page.sleepDue?.id).toBe("sleep-tonight");
    expect(page.recommendationAnswer.plannedEnd).toBeNull();
    expect(status.recommendation).toMatchObject({ plannedEnd: null, fitsBefore: null });
    expect(status.recommendation.sleep.hardErrors).toEqual(page.sleepDue?.hardErrors);
  });
});
