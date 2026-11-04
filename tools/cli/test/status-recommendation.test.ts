import { buildRecommendationAnswer, buildRisks } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { localiseInstants } from "../src/output.js";
import { fakeFetch } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState, fixtureState, fixtureTimeZone } from "./fixture-state.js";

/**
 * `status` carries the engine's whole answer, from the same builder the Now page reads
 * (`planning/recommendation-answer.ts`), so an agent asking "why" or "what is at risk" no longer needs
 * `rhen_state` (trust review 2026-10-27, lane B: 2.6 MB read for five questions).
 */

const recommendation = {
  primary: {
    action: { id: "action-draft", title: "Draft chapter 3", projectId: "project-thesis" },
    recommendedMinutes: 45,
    recommendedWallClockMinutes: 50,
    criticalTier: "behind_internal",
    criticalReason: "Behind its own date by 2 hours."
  },
  alternatives: [
    { action: { id: "action-cite", title: "Fix citations", projectId: "project-thesis" }, recommendedMinutes: 30 }
  ],
  candidates: [],
  headline: "Draft chapter 3 for 45 minutes",
  explanation: "It is the only chapter still unwritten.",
  evidence: ["Due in 7 days", "Laptop available"],
  why: {
    because: {
      targetId: "action-draft",
      title: "Draft chapter 3",
      tier: "behind_internal",
      tierLabel: "Behind",
      reason: "Behind its own date."
    },
    whyNot: {
      targetId: "action-cite",
      title: "Fix citations",
      tier: "ordinary",
      tierLabel: "Ordinary",
      reason: "Nothing depends on it this week.",
      decidingFactor: "critical_tier"
    },
    wouldChangeIf: [
      {
        condition: "energy_high",
        description: "With high energy",
        thenPrimary: { targetId: "action-cite", title: "Fix citations", recommendedMinutes: 30 }
      }
    ]
  },
  needsAnswer: [],
  reachable: []
};

const forecasts = [
  {
    projectId: "project-thesis",
    health: "behind",
    expectedMarginMinutes: -120,
    requiredPaceMinutesPerWeek: 600,
    reasons: ["Needs 10 hours a week; 6 are free."],
    interventions: [{ kind: "add_time", actionIds: ["action-draft"], minutes: 120, reason: "Add 2 hours this week." }]
  },
  {
    projectId: "project-garden",
    health: "on_track",
    expectedMarginMinutes: 300,
    requiredPaceMinutesPerWeek: 60,
    reasons: []
  }
];

function richState(raw: Record<string, unknown>): Record<string, unknown> {
  const planning = raw.planning as { result: Record<string, unknown> };
  return {
    ...raw,
    planning: {
      ...planning,
      result: {
        ...planning.result,
        recommendation,
        schedule: { forecasts },
        prepPace: {
          commitmentId: "commitment-gym",
          commitmentTitle: "Gym session",
          commitmentStartsAt: "2026-09-03T17:00:00+10:00",
          requiredMinutes: 30,
          availableMinutes: 20,
          minutesBehind: 10,
          status: "behind"
        }
      }
    }
  };
}

async function status(argv: readonly string[], state: Record<string, unknown>) {
  const stdout: string[] = [];
  const exitCode = await runCli(argv, {
    stdout: (text) => stdout.push(text),
    stderr: () => undefined,
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    fetchImpl: fakeFetch({
      "/api/state": { body: { state } },
      "/api/check-ins/current": { body: { checkIn: null } }
    })
  });
  return { exitCode, stdout: stdout.join("\n") };
}

describe("status carries the engine's whole recommendation", () => {
  it("prints exactly what the shared builder gives the Now page, localised", async () => {
    const raw = richState(fixtureRawState());
    const { exitCode, stdout } = await status(["status", "--json"], raw);
    expect(exitCode).toBe(0);
    const json = JSON.parse(stdout);
    const state = fixtureState({ planning: raw.planning });
    const expected = buildRecommendationAnswer({ state, result: state.planning?.result, now: fixtureNow });
    expect(json.recommendation).toEqual(localiseInstants(expected, fixtureTimeZone));
    expect(json.risks).toEqual(
      localiseInstants(buildRisks({ state, result: state.planning?.result }), fixtureTimeZone)
    );
    expect(json.recommendation.whyNot).toMatchObject({ title: "Fix citations", decidingFactor: "critical_tier" });
    expect(json.recommendation.runnerUp).toMatchObject({ targetId: "action-cite", recommendedMinutes: 30 });
    // 09:30 plus the primary's 50 wall-clock minutes, as the Now kicker says it.
    expect(json.recommendation.plannedEnd).toBe("2026-09-03T10:20:00+10:00");
    expect(json.risks.map((risk: { kind: string }) => risk.kind)).toEqual(["prep_pace", "project"]);
    expect(json.risks[1]).toMatchObject({ projectId: "project-thesis", health: "behind", marginMinutes: -120 });
    expect(json.day.map((entry: { title: string }) => entry.title)).toEqual(["Draft chapter 3", "Gym session"]);
    expect(json.day[0].startsAt).toBe("2026-09-03T09:30:00+10:00");
  });

  it("renders why not, what would change it, the end, the runner-up, risks and the day in the table", async () => {
    const { stdout } = await status(["status"], richState(fixtureRawState()));
    expect(stdout).toContain("Why not");
    expect(stdout).toContain("Fix citations: Nothing depends on it this week. (decided by critical tier)");
    expect(stdout).toContain("With high energy: Fix citations for 30 min");
    expect(stdout).toContain("Runner-up");
    expect(stdout).toMatch(/Ends\s+10:20/);
    expect(stdout).toContain("Prep for Gym session · behind, 10 min behind");
    expect(stdout).toContain("smallest fix: Add 2 hours this week.");
    expect(stdout).toMatch(/Day\s+09:30–10:15 · Draft chapter 3/);
  });

  it("says a break before the work only while the break is still running", async () => {
    const withBreakUntil = (notBefore: string) => {
      const raw = fixtureRawState();
      const result = (raw.planning as { result: Record<string, unknown> }).result;
      result.currentDirective = { ...(result.currentDirective as Record<string, unknown>), notBefore };
      return raw;
    };
    const running = await status(["status"], withBreakUntil("2026-09-03T09:45:00+10:00"));
    expect(running.stdout).toMatch(/Draft chapter 3 .*after a break until/);
    // A cached plan that has outlived its break no longer says it.
    const over = await status(["status"], withBreakUntil("2026-09-03T09:15:00+10:00"));
    expect(over.stdout).toContain("Draft chapter 3");
    expect(over.stdout).not.toContain("after a break until");
  });

  it("keeps a stored result with no recommendation readable", async () => {
    const { exitCode, stdout } = await status(["status", "--json"], fixtureRawState());
    expect(exitCode).toBe(0);
    const json = JSON.parse(stdout);
    expect(json.recommendation).toMatchObject({ headline: null, primary: null, whyNot: null, runnerUp: null });
    expect(json.risks).toEqual([]);
  });

  it("promises no end or fit from a plan that is not current", async () => {
    const raw = richState(fixtureRawState());
    (raw.planning as Record<string, unknown>).validUntil = "2026-09-03T09:20:00+10:00";
    const json = JSON.parse((await status(["status", "--json"], raw)).stdout);
    expect(json.recommendation).toMatchObject({ plannedEnd: null, fitsBefore: null });
    expect(json.recommendation.whyNot).not.toBeNull();
    const brief = JSON.parse((await status(["status", "--brief", "--json"], raw)).stdout);
    expect(brief.plannedEnd).toBeNull();
    expect((await status(["status"], raw)).stdout).not.toMatch(/^Ends/m);
  });

  it("says in the brief when the plan is still catching up with a write", async () => {
    const raw = richState(fixtureRawState());
    (raw.planning as Record<string, unknown>).awaitingRecalculation = true;
    const brief = JSON.parse((await status(["status", "--brief", "--json"], raw)).stdout);
    expect(brief).toMatchObject({
      plan: "current",
      awaitingRecalculation: true,
      calculatedAt: "2026-09-03T09:12:00+10:00",
      headline: "Draft chapter 3 for 45 minutes",
      risks: 2
    });
    expect((await status(["status", "--brief"], raw)).stdout).toContain("current · awaiting recalculation");
  });
});

describe("status stays small", () => {
  /** A heavy day: 30 projects at risk, 40 day blocks, 10 late steps. The answer must still fit a small context. */
  function busy(): Record<string, unknown> {
    const raw = richState(fixtureRawState());
    const result = (raw.planning as { result: Record<string, unknown> }).result;
    result.schedule = {
      forecasts: Array.from({ length: 30 }, (_, index) => ({
        projectId: `project-${index}`,
        health: index % 2 ? "behind" : "at_risk",
        expectedMarginMinutes: -index * 10,
        requiredPaceMinutesPerWeek: 300,
        reasons: ["Needs more time than is free before the date."],
        interventions: [{ kind: "split_work", actionIds: [], minutes: 60, reason: "Split the largest action." }]
      }))
    };
    result.startByWarnings = Array.from({ length: 10 }, (_, index) => ({
      stepId: `step-${index}`,
      anchorId: "commitment-gym",
      anchorTitle: "Gym session",
      title: `Step ${index}`,
      startBy: "2026-09-03T16:00:00+10:00",
      status: "soon"
    }));
    const start = new Date("2026-09-03T09:30:00+10:00").getTime();
    (result.dayPlan as { blocks: unknown[] }).blocks = Array.from({ length: 40 }, (_, index) => ({
      startsAt: new Date(start + index * 20 * 60_000).toISOString(),
      endsAt: new Date(start + (index + 1) * 20 * 60_000).toISOString(),
      kind: "action",
      targetId: `action-${index}`,
      title: `A piece of work number ${index}`,
      focusedMinutes: 20,
      wallClockMinutes: 20,
      reason: "Fits here.",
      confidence: "projected"
    }));
    const rec = result.recommendation as Record<string, unknown>;
    rec.evidence = Array.from({ length: 20 }, (_, index) => `Evidence line ${index} about why this work comes first.`);
    (rec.why as Record<string, unknown>).wouldChangeIf = ["at_location", "energy_high", "longer_session"].map(
      (condition) => ({
        condition,
        description: `If ${condition}`,
        thenPrimary: { targetId: "action-cite", title: "Fix citations", recommendedMinutes: 30 }
      })
    );
    result.stayUpOffer = {
      nightId: "sleep-tonight",
      projectId: "project-thesis",
      projectTitle: "Thesis",
      actionId: "action-draft",
      actionTitle: "Draft chapter 3",
      minutesBehind: 120,
      opensAt: "2026-09-03T09:00:00+10:00",
      closesAt: "2026-09-03T23:00:00+10:00",
      choices: [30, 60, 90].map((minutes) => ({
        minutes,
        bedtimeAt: "2026-09-03T23:30:00+10:00",
        wakeAt: "2026-09-04T07:30:00+10:00",
        sleepMinutes: 480
      }))
    };
    raw.completedToday = Array.from({ length: 30 }, (_, index) => ({
      id: `session-${index}`,
      actionId: "action-done",
      actionTitle: `Finished piece ${index}`,
      result: "completed",
      startedAt: "2026-09-03T06:00:00+10:00",
      endedAt: "2026-09-03T06:15:00+10:00",
      plannedMinutes: 15,
      activeMinutes: 15,
      remainingBeforeMinutes: 15,
      remainingAfterMinutes: 0
    }));
    return raw;
  }

  it("keeps the worst risks when it has to leave some out", async () => {
    const json = JSON.parse((await status(["status", "--json"], busy())).stdout);
    const kinds = json.risks.map((risk: { kind: string; status?: string; health?: string }) =>
      risk.kind === "project" ? risk.health : `${risk.kind}:${risk.status}`
    );
    // Prep behind, then the 15 behind projects fill the rest; the ten steps due soon are what is left out.
    expect(kinds[0]).toBe("prep_pace:behind");
    expect(kinds.slice(1)).toEqual(Array(9).fill("behind"));
  });

  it("keeps the full answer under 17 KB and the brief under 3 KB", async () => {
    const full = (await status(["status", "--json"], busy())).stdout;
    const brief = (await status(["status", "--brief", "--json"], busy())).stdout;
    const json = JSON.parse(full);
    expect(json).toMatchObject({ risksOmitted: 31, dayOmitted: 24, doneTodayOmitted: 20 });
    expect(json.recommendation.evidence).toHaveLength(5);
    expect(json.doneToday).toHaveLength(10);
    // 16 KB before the needs list; each stale fact adds one need of a few hundred bytes (here undated energy), and
    // there are at most four of them, so the full answer still fits a small context. Raised from 16.5 KB on 2026-11-04 (F3-01): each need now carries its exact tool call, `answer.call`, about 200 bytes: 16,611 with the undated-energy need.
    expect(json.needs.map((need: { fact: string }) => need.fact)).toEqual(["energy"]);
    expect(new TextEncoder().encode(full).length).toBeLessThan(17_000);
    expect(new TextEncoder().encode(brief).length).toBeLessThan(3_000);
  });
});

describe("status gives one answer to say", () => {
  it("is the directive when the directive is the ranked pick", async () => {
    const json = JSON.parse((await status(["status", "--json"], richState(fixtureRawState()))).stdout);
    expect(typeof json.answer).toBe("string");
    expect(json.answer).toContain("Draft chapter 3");
    expect(json.answer).not.toContain("ranked task list");
    const brief = JSON.parse((await status(["status", "--brief", "--json"], richState(fixtureRawState()))).stdout);
    expect(brief.answer).toBe(json.answer);
  });

  it("says what the directive is and that the headline speaks only for the ranked task list when they differ", async () => {
    const raw = richState(fixtureRawState());
    const result = (raw.planning as { result: Record<string, unknown> }).result;
    result.currentDirective = {
      ...(result.currentDirective as Record<string, unknown>),
      kind: "routine_step",
      title: "Shower and dress"
    };
    result.recommendation = {
      ...(result.recommendation as Record<string, unknown>),
      headline: "Nothing fits until the calendar protection ends"
    };
    const json = JSON.parse((await status(["status", "--json"], raw)).stdout);
    expect(json.answer).toContain("Shower and dress");
    expect(json.answer).toContain("ranked task list");
    expect(json.answer).toContain("Nothing fits until the calendar protection ends");
  });

  it("also says it when the directive is an action that is not the ranked pick", async () => {
    const raw = richState(fixtureRawState());
    const result = (raw.planning as { result: Record<string, unknown> }).result;
    result.currentDirective = {
      ...(result.currentDirective as Record<string, unknown>),
      targetId: "action-cite",
      title: "Fix citations"
    };
    const json = JSON.parse((await status(["status", "--json"], raw)).stdout);
    expect(json.answer).toContain("Fix citations");
    expect(json.answer).toContain("ranked task list");
    expect(json.answer).toContain("Draft chapter 3 for 45 minutes");
  });

  it("names places in the evidence instead of printing their ids", async () => {
    const raw = richState(fixtureRawState());
    const state = raw as {
      conditionDefinitions?: { id: string; name: string }[];
      planning: { result: Record<string, unknown> };
    };
    const place = state.conditionDefinitions?.[0];
    if (!place) throw new Error("fixture has no condition definition");
    state.planning.result.recommendation = {
      ...(state.planning.result.recommendation as Record<string, unknown>),
      evidence: [`Missing context: ${place.id}.`]
    };
    const json = JSON.parse((await status(["status", "--json"], raw)).stdout);
    expect(json.recommendation.evidence[0]).toContain(place.name);
    expect(json.recommendation.evidence[0]).not.toContain(place.id);
  });
});
