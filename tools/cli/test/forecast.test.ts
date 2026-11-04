import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/errors.js";
import { fakeFetch } from "./fake-fetch.js";
import { fixtureActiveSession, fixtureNow, fixtureRawState } from "./fixture-state.js";

/** `forecast` reads the stored planning result's per-project forecasts and says what the plan rests on. */

const forecast = (projectId: string, extra: Record<string, unknown> = {}) => ({
  projectId,
  health: "on_track",
  expectedMarginMinutes: 300,
  pessimisticMarginMinutes: 100,
  requiredPaceMinutesPerWeek: 60,
  confidence: "medium",
  forecastBand: "detailed",
  reasons: [],
  ...extra
});

const forecasts = [
  forecast("project-garden"),
  forecast("project-thesis", {
    health: "behind",
    expectedMarginMinutes: -120,
    pessimisticMarginMinutes: -240,
    requiredPaceMinutesPerWeek: 600,
    internalDeadlineAt: "2026-09-10T17:00:00+10:00",
    reasons: ["Needs 10 hours a week; 6 are free."],
    interventions: [
      { kind: "clarify_estimate", actionIds: ["action-draft"], minutes: 30, reason: "Check the estimate." },
      { kind: "add_time", actionIds: ["action-draft"], minutes: 120, reason: "Add 2 hours this week." }
    ]
  }),
  forecast("project-late", {
    health: "behind",
    overdue: true,
    expectedMarginMinutes: -900,
    proposal: { kind: "move_deadline", deadlineOwner: "internal", reason: "Passed." }
  }),
  forecast("project-risky", { health: "at_risk", expectedMarginMinutes: -10 }),
  // Maintenance: `health` stays unknown and the adherence says how it is going.
  forecast("project-habit", {
    health: "unknown",
    healthBasis: "adherence",
    adherence: { health: "behind", ratio: 0.4, actions: [] }
  }),
  forecast("project-fine-habit", {
    health: "unknown",
    healthBasis: "adherence",
    adherence: { health: "on_track", ratio: 1, actions: [] }
  }),
  forecast("project-dated", { health: "unknown", internalDeadlineAt: "2026-10-01T17:00:00+10:00" }),
  forecast("project-undated", { health: "unknown" })
];

const edge = (source: string) => ({
  fromLocationId: "ctx-home",
  toLocationId: "ctx-gym",
  minutes: 15,
  typicalMinutes: 15,
  source,
  sampleCount: 0
});

const timeline = (id: string, before?: string, after?: string) => ({
  id,
  setupStartsAt: "2026-09-03T16:30:00+10:00",
  arriveBy: "2026-09-03T16:55:00+10:00",
  startsAt: "2026-09-03T17:00:00+10:00",
  endsAt: "2026-09-03T18:00:00+10:00",
  effectiveEndsAt: "2026-09-03T18:00:00+10:00",
  freeAt: "2026-09-03T18:00:00+10:00",
  protectedUntil: "2026-09-03T18:00:00+10:00",
  overtime: false,
  latenessMatters: true,
  ...(before ? { journeyBefore: edge(before) } : {}),
  ...(after ? { journeyAfter: edge(after) } : {})
});

function rich(
  list: unknown[] = forecasts,
  extra: Record<string, unknown> = {},
  settingsExtra: Record<string, unknown> = {}
): Record<string, unknown> {
  const raw = fixtureRawState();
  const planning = raw.planning as { result: Record<string, unknown> };
  return {
    ...raw,
    ...extra,
    settings: { ...(raw.settings as object), lastWokeAt: "2026-09-03T06:30:00+10:00", ...settingsExtra },
    currentSituation: { locationId: "ctx-home", locationSetAt: "2026-09-03T09:00:00+10:00" },
    planning: {
      ...planning,
      result: {
        ...planning.result,
        schedule: { forecasts: list },
        weekOutlook: {
          startsAt: "2026-09-03T09:30:00+10:00",
          endsAt: "2026-09-10T09:30:00+10:00",
          capacityMinutes: 1800,
          reservedMinutes: 1500,
          freeMinutes: 300,
          projects: [
            { projectId: "project-thesis", reservedMinutes: 360, paceShortfallMinutes: 240, health: "behind" }
          ],
          underPacedProjectIds: ["project-thesis"],
          areas: []
        },
        derivedState: {
          ...(planning.result.derivedState as object),
          commitmentTimelines: [
            timeline("commitment-gym", "assumed", "fallback"),
            timeline("commitment-other", "live", "typical")
          ]
        }
      }
    }
  };
}

async function run(argv: string[], state: Record<string, unknown> = rich()) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(argv, {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    fetchImpl: fakeFetch({ "/api/state": { body: { state } } })
  });
  return { exitCode, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

describe("forecast", () => {
  it("lists only projects needing attention, worst first, and counts the rest", async () => {
    const { exitCode, stdout } = await run(["forecast", "--json"]);
    expect(exitCode).toBe(0);
    const json = JSON.parse(stdout);
    // Overdue first, then behind (the thesis, then the habit by adherence), then at risk, then unknown with a date.
    expect(json.projects.map((item: { id: string }) => item.id)).toEqual([
      "project-late",
      "project-thesis",
      "project-habit",
      "project-risky",
      "project-dated"
    ]);
    expect(json.leftOut).toBe(3);
    const thesis = json.projects[1];
    expect(thesis).toMatchObject({
      title: "Thesis",
      health: "behind",
      marginMinutes: -120,
      pessimisticMinutes: -240,
      paceMinutesPerWeek: 600,
      paceShortfallMinutes: 240,
      confidence: "medium",
      band: "detailed",
      deadlineAt: "2026-09-10T17:00:00+10:00",
      reasons: ["Needs 10 hours a week; 6 are free."]
    });
    expect(thesis.interventions.map((item: { kind: string }) => item.kind)).toEqual(["clarify_estimate", "add_time"]);
    expect(json.projects[0]).toMatchObject({ lapsed: true, title: "project-late" });
    // A lapsed self-set date is not also called overdue.
    expect(json.projects[0]).not.toHaveProperty("overdue");
    expect(json.projects[2]).toMatchObject({ id: "project-habit", health: "behind" });
    expect(json.week).toEqual({ capacityMinutes: 1800, reservedMinutes: 1500, freeMinutes: 300 });
  });

  it("--all adds the projects that are on track, ahead or undated", async () => {
    const json = JSON.parse((await run(["forecast", "--all", "--json"])).stdout);
    expect(json.projects).toHaveLength(8);
    expect(json.leftOut).toBe(0);
    expect(json.projects.map((item: { id: string }) => item.id)).toEqual(
      expect.arrayContaining(["project-garden", "project-fine-habit", "project-undated"])
    );
  });

  it("--project narrows to one project, whatever its health, and refuses one with no forecast", async () => {
    const json = JSON.parse((await run(["forecast", "--project", "project-garden", "--json"])).stdout);
    expect(json.projects.map((item: { id: string }) => item.id)).toEqual(["project-garden"]);
    expect(json.leftOut).toBe(0);
    const missing = await run(["forecast", "--project", "project-nope"]);
    expect(missing.exitCode).toBe(EXIT.usage);
    expect(missing.stderr).toContain("No forecast for project");
  });

  it("says what the plan rests on, with ages and the same stale verdict as status", async () => {
    const json = JSON.parse((await run(["forecast", "--json"], rich(forecasts, fixtureActiveSession()))).stdout);
    expect(json.assumptions).toEqual({
      planStatus: "current",
      calculatedAt: "2026-09-03T09:12:00+10:00",
      validUntil: "2026-09-03T10:12:00+10:00",
      awaitingRecalculation: false,
      engineVersion: "1.4.0",
      inputs: [
        {
          input: "wake",
          stale: false,
          at: "2026-09-03T06:30:00+10:00",
          ageMinutes: 180,
          staleAt: "2026-09-04T01:30:00+10:00"
        },
        // Never dated, so stale: the same call Now makes.
        { input: "energy", stale: true },
        {
          input: "location",
          stale: false,
          at: "2026-09-03T09:00:00+10:00",
          ageMinutes: 30,
          staleAt: "2026-09-03T17:00:00.001+10:00"
        },
        {
          input: "openSession",
          stale: false,
          at: "2026-09-03T09:05:00+10:00",
          ageMinutes: 25,
          staleAt: "2026-09-03T10:50:00+10:00"
        }
      ],
      agedEstimates: [],
      assumedTravel: 2
    });
  });

  it("names an input the state has no time for without inventing an age", async () => {
    const raw = rich();
    const bare = {
      ...raw,
      settings: { ...(raw.settings as object), lastWokeAt: undefined },
      currentSituation: { locationId: "ctx-home" }
    };
    const json = JSON.parse((await run(["forecast", "--json"], bare)).stdout);
    expect(json.assumptions.inputs).toEqual([
      { input: "wake", stale: false },
      { input: "energy", stale: true },
      { input: "location", stale: false }
    ]);
  });

  it("lists the old time-left estimates the forecast aged, on the project row and in the assumptions", async () => {
    const raw = rich([
      forecast("project-thesis", {
        health: "behind",
        confidence: "low",
        agedInputs: [{ actionId: "action-draft", title: "Draft chapter", setAt: "2026-08-01T09:00:00+10:00" }]
      })
    ]);
    const actions = (raw.actions as Record<string, unknown>[]).map((action) =>
      action.id === "action-draft" ? { ...action, remainingSetAt: "2026-08-01T09:00:00+10:00" } : action
    );
    const json = JSON.parse((await run(["forecast", "--json"], { ...raw, actions })).stdout);
    expect(json.projects[0].agedInputs).toEqual([
      { actionId: "action-draft", title: "Draft chapter", setAt: "2026-08-01T09:00:00+10:00" }
    ]);
    expect(json.assumptions.agedEstimates).toEqual([
      expect.objectContaining({ actionId: "action-draft", projectId: "project-thesis", stale: true })
    ]);
  });

  it("answers with no projects before the engine has run", async () => {
    const raw = fixtureRawState();
    const json = JSON.parse((await run(["forecast", "--json"], { ...raw, planning: undefined })).stdout);
    expect(json.projects).toEqual([]);
    expect(json.assumptions).toMatchObject({ planStatus: "unavailable", calculatedAt: null, engineVersion: null });
  });

  it("prints one line per project in the table", async () => {
    const { stdout } = await run(["forecast"]);
    expect(stdout).toContain("project-late");
    expect(stdout.split("\n").filter((line) => line.includes("Thesis"))).toHaveLength(1);
    expect(stdout).toContain("lapsed");
    expect(stdout).toContain("3 more on track, ahead or undated (--all).");
    expect(stdout).toContain("wake: 180 min old");
    expect(stdout).toContain("2 travel figure(s) assumed or fallback.");
  });

  it("keeps thirty projects under 12 KB of JSON", async () => {
    const projects = Array.from({ length: 30 }, (_, index) => ({
      id: `project-${String(index).padStart(2, "0")}`,
      title: `Project ${index} thesis`
    }));
    const many = projects.map((project, index) =>
      forecast(project.id, {
        health: index % 2 ? "behind" : "at_risk",
        expectedMarginMinutes: -index * 10,
        internalDeadlineAt: "2026-09-10T17:00:00+10:00",
        reasons: ["Needs 10 hours a week; 6 are free."],
        interventions: [
          { kind: "add_time", actionIds: ["action-draft"], minutes: 120, reason: "Add 2 hours this week." }
        ]
      })
    );
    const base = rich(many);
    const template = (base.projects as Record<string, unknown>[])[0]!;
    const { stdout } = await run(["forecast", "--json"], {
      ...base,
      projects: projects.map((project) => ({ ...template, ...project }))
    });
    expect(JSON.parse(stdout).projects).toHaveLength(30);
    expect(JSON.parse(stdout).projects[0].title).toMatch(/^Project \d+ thesis$/);
    expect(Buffer.byteLength(stdout)).toBeLessThan(12 * 1024);
  });
});
