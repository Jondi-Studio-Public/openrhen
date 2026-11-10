import { describe, expect, it } from "vitest";
import { assessDeadlines } from "../../src/scheduling/deadline-outlook.js";
import type { DeadlineOutcomeInput, DeadlineProjectInput } from "../../src/scheduling/deadline-outlook.js";
import type { ProjectForecast } from "../../src/model/types.js";

const now = new Date("2026-09-05T09:00:00.000Z");
const future = new Date("2026-10-05T09:00:00.000Z");
const past = new Date("2026-09-01T09:00:00.000Z");

function forecast(projectId: string, overrides: Partial<ProjectForecast> = {}): ProjectForecast {
  return {
    projectId,
    health: "on_track",
    overdue: false,
    deadlineSource: "internal",
    internalDeadlineAt: future,
    protectedRemainingMinutes: 100,
    pessimisticRemainingMinutes: 120,
    compatibleCapacityMinutes: 300,
    grossCompatibleCapacityMinutes: 300,
    reservedByEarlierDeadlinesMinutes: 0,
    requiredPaceMinutesPerWeek: 30,
    forecastBand: null,
    confidence: null,
    forecastThrough: future,
    expectedMarginMinutes: 100,
    pessimisticMarginMinutes: 40,
    marginRatio: null,
    scheduleVariance: null,
    unallocatedExpectedMinutes: 0,
    blockedEffortMinutes: 0,
    schedulingBlocked: false,
    latestSafeStarts: {},
    reasons: [],
    ...overrides
  };
}

function project(id: string, overrides: Partial<DeadlineProjectInput> = {}): DeadlineProjectInput {
  return { id, title: id, outcomeId: "o1", status: "active", ...overrides };
}

const outcome = (overrides: Partial<DeadlineOutcomeInput> = {}): DeadlineOutcomeInput => ({
  id: "o1",
  title: "Outcome",
  status: "active",
  ...overrides
});

function verdictOf(f: ProjectForecast, p: Partial<DeadlineProjectInput> = {}) {
  const result = assessDeadlines({ forecasts: [f], projects: [project(f.projectId, p)], outcomes: [outcome()], now });
  return result.projects.find((row) => row.projectId === f.projectId)?.verdict ?? "none";
}

describe("assessDeadlines verdicts", () => {
  it("maps on_track and ahead to ok", () => {
    expect(verdictOf(forecast("a", { health: "on_track" }))).toBe("ok");
    expect(verdictOf(forecast("a", { health: "ahead" }))).toBe("ok");
  });
  it("maps at_risk to tight", () => {
    expect(verdictOf(forecast("a", { health: "at_risk" }))).toBe("tight");
  });
  it("maps behind with a future deadline to behind", () => {
    expect(verdictOf(forecast("a", { health: "behind", expectedMarginMinutes: -30 }))).toBe("behind");
  });
  it("maps a passed deadline to overdue", () => {
    expect(verdictOf(forecast("a", { health: "behind", overdue: true, internalDeadlineAt: past }))).toBe("overdue");
  });

  describe("internal date passed, external date ahead", () => {
    const base = { health: "behind" as const, overdue: true, internalDeadlineAt: past };
    const proposal = (earliestFeasibleAt: Date | null) => ({
      kind: "move_deadline" as const,
      deadlineOwner: "internal" as const,
      missedDeadlineAt: past,
      earliestFeasibleAt,
      reason: "x"
    });
    const external = { externalDeadlineAt: future };
    it("is tight when the work still fits by the external date", () => {
      const f = forecast("a", { ...base, proposal: proposal(new Date("2026-09-20T09:00:00.000Z")) });
      expect(verdictOf(f, external)).toBe("tight");
      expect(verdictOf(forecast("a", { ...base, proposal: proposal(future) }), external)).toBe("tight");
    });
    it("is overdue when it fits later than the external date or nowhere", () => {
      const later = forecast("a", { ...base, proposal: proposal(new Date("2026-11-01T09:00:00.000Z")) });
      expect(verdictOf(later, external)).toBe("overdue");
      expect(verdictOf(forecast("a", { ...base, proposal: proposal(null) }), external)).toBe("overdue");
    });
    it("reports earliestFeasibleAt on an overdue row", () => {
      const result = assessDeadlines({
        forecasts: [forecast("a", { ...base, proposal: proposal(null) })],
        projects: [project("a", external)],
        outcomes: [outcome()],
        now
      });
      expect(result.projects[0]?.earliestFeasibleAt).toBeNull();
      expect(result.projects[0]?.verdict).toBe("overdue");
    });
  });

  it("gives none when there is no deadline, ignoring the overdue flag", () => {
    expect(verdictOf(forecast("a", { deadlineSource: "none", overdue: true, health: "unknown" }))).toBe("none");
  });
  it("gives none for maintenance projects", () => {
    expect(verdictOf(forecast("a", { healthBasis: "adherence", health: "unknown" }))).toBe("none");
  });
  it("skips paused, done and cancelled projects and inactive outcomes", () => {
    for (const status of ["paused", "done", "cancelled"] as const)
      expect(verdictOf(forecast("a", { health: "behind", overdue: true }), { status })).toBe("none");
    const result = assessDeadlines({
      forecasts: [forecast("a", { health: "behind" })],
      projects: [project("a")],
      outcomes: [outcome({ status: "paused" })],
      now
    });
    expect(result.projects).toEqual([]);
    expect(result.outcomes).toEqual([]);
  });
});

describe("assessDeadlines rows and roll-up", () => {
  it("carries slack, pessimistic margin and the earliest latest safe start", () => {
    const early = new Date("2026-09-10T00:00:00.000Z");
    const late = new Date("2026-09-20T00:00:00.000Z");
    const result = assessDeadlines({
      forecasts: [
        forecast("a", {
          health: "at_risk",
          expectedMarginMinutes: 15,
          pessimisticMarginMinutes: -20,
          latestSafeStarts: { x: late, y: null, z: early }
        })
      ],
      projects: [project("a")],
      outcomes: [outcome()],
      now
    });
    const row = result.projects[0]!;
    expect(row.slackMinutes).toBe(15);
    expect(row.pessimisticMarginMinutes).toBe(-20);
    expect(row.latestSafeStart).toEqual(early);
    expect(row.deadlineAt).toEqual(future);
  });

  it("uses the worst child verdict and the earliest deadline for an outcome", () => {
    const earlier = new Date("2026-09-30T09:00:00.000Z");
    const result = assessDeadlines({
      forecasts: [
        forecast("a", { health: "on_track" }),
        forecast("b", { health: "behind", expectedMarginMinutes: -5, internalDeadlineAt: earlier }),
        forecast("c", { deadlineSource: "none", health: "unknown" })
      ],
      projects: [project("a"), project("b"), project("c")],
      outcomes: [outcome({ deadlineAt: new Date("2026-12-01T00:00:00.000Z") })],
      now
    });
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]).toMatchObject({ outcomeId: "o1", verdict: "behind", deadlineAt: earlier });
    expect(result.outcomes[0]?.projectIds).toEqual(["a", "b"]);
  });

  it("rolls up the worst child verdict wherever it sits in the input", () => {
    const makers: Array<(id: string) => ProjectForecast> = [
      (id) => forecast(id, { health: "behind", expectedMarginMinutes: -5 }),
      (id) => forecast(id, { health: "on_track" }),
      (id) => forecast(id, { health: "at_risk", expectedMarginMinutes: 3 })
    ];
    for (let worst = 0; worst < 3; worst++) {
      const order = makers.map((_, index) => (index === worst ? 0 : index === 0 ? worst : index));
      const forecasts = order.map((maker, position) => makers[maker]!(`p${position}`));
      const result = assessDeadlines({
        forecasts,
        projects: forecasts.map((f) => project(f.projectId)),
        outcomes: [outcome()],
        now
      });
      expect(result.outcomes[0]?.verdict).toBe("behind");
    }
  });

  it("sorts rows with no slack after rows with slack", () => {
    const result = assessDeadlines({
      forecasts: [
        forecast("a", { expectedMarginMinutes: null }),
        forecast("b", { expectedMarginMinutes: 500 }),
        forecast("c", { expectedMarginMinutes: -10, health: "behind" })
      ],
      projects: ["a", "b", "c"].map((id) => project(id)),
      outcomes: [outcome()],
      now
    });
    expect(result.projects.map((row) => row.projectId)).toEqual(["c", "b", "a"]);
  });

  it("gives none for unknown health even with a deadline", () => {
    expect(verdictOf(forecast("a", { health: "unknown" }))).toBe("none");
  });

  it("skips a forecast whose deadlineSource is undefined", () => {
    const { deadlineSource: _omitted, ...rest } = forecast("a", { health: "behind" });
    expect(verdictOf(rest as ProjectForecast)).toBe("none");
  });

  it("prefers the outcome's own deadline when it is earlier", () => {
    const own = new Date("2026-09-15T00:00:00.000Z");
    const result = assessDeadlines({
      forecasts: [forecast("a")],
      projects: [project("a")],
      outcomes: [outcome({ deadlineAt: own })],
      now
    });
    expect(result.outcomes[0]?.deadlineAt).toEqual(own);
  });

  it("sorts by slack ascending with overdue first and a stable id tie-break", () => {
    const result = assessDeadlines({
      forecasts: [
        forecast("d", { expectedMarginMinutes: 50 }),
        forecast("c", { expectedMarginMinutes: 10 }),
        forecast("b", { expectedMarginMinutes: 10 }),
        forecast("z", { health: "behind", overdue: true, internalDeadlineAt: past, expectedMarginMinutes: 500 })
      ],
      projects: ["d", "c", "b", "z"].map((id) => project(id)),
      outcomes: [outcome()],
      now
    });
    expect(result.projects.map((row) => row.projectId)).toEqual(["z", "b", "c", "d"]);
  });

  it("is deterministic regardless of input order", () => {
    const forecasts = ["a", "b", "c"].map((id, i) => forecast(id, { expectedMarginMinutes: i % 2 ? 5 : 9 }));
    const args = { projects: ["a", "b", "c"].map((id) => project(id)), outcomes: [outcome()], now };
    const one = assessDeadlines({ ...args, forecasts });
    const two = assessDeadlines({
      ...args,
      forecasts: [...forecasts].reverse(),
      projects: [...args.projects].reverse()
    });
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
    expect(JSON.stringify(assessDeadlines({ ...args, forecasts }))).toBe(JSON.stringify(one));
  });
});
