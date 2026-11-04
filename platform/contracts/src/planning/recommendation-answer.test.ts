import { describe, expect, it } from "vitest";
import { currentDirectiveSchema } from "./plan-forecast.js";
import {
  buildDay,
  buildRecommendationAnswer,
  buildRisks,
  type RecommendationAnswerInput
} from "./recommendation-answer.js";

const now = new Date("2026-10-28T09:00:00+10:00");

function input(result: RecommendationAnswerInput["result"], overrides: Record<string, unknown> = {}) {
  return {
    state: {
      activeSession: null,
      commitments: [],
      routineSteps: [],
      sleepPlans: [],
      conditionDefinitions: [],
      currentSituation: { locationId: null },
      projects: [
        { id: "p-thesis", title: "Thesis" },
        { id: "p-tax", title: "Tax" },
        { id: "p-gym", title: "Gym" }
      ],
      settings: { timezone: "Australia/Brisbane" },
      ...overrides
    } as unknown as RecommendationAnswerInput["state"],
    result,
    now
  };
}

const forecast = (projectId: string, health: string, extra: Record<string, unknown> = {}) => ({
  projectId,
  health,
  expectedMarginMinutes: 0,
  requiredPaceMinutesPerWeek: null,
  reasons: [],
  ...extra
});

describe("buildRecommendationAnswer", () => {
  it("answers nothing, not something invented, before the engine's first run", () => {
    const answer = buildRecommendationAnswer(input(undefined));
    expect(answer).toMatchObject({ headline: null, primary: null, plannedEnd: null, runnerUp: null, sleep: null });
    expect(answer.gates).toEqual({ lateCommitmentStepsRun: false, locationStale: false });
  });

  it("counts the planned end from the end of a break the pick waits out", () => {
    const answer = buildRecommendationAnswer(
      input({
        recommendation: {
          primary: { action: { id: "a", title: "A" }, recommendedMinutes: 30, recommendedWallClockMinutes: 30 }
        },
        currentDirective: {
          kind: "action",
          targetId: "a",
          title: "A",
          recommendedMinutes: 30,
          notBefore: "2026-10-28T09:15:00+10:00"
        }
      })
    );
    expect(answer.plannedEnd).toBe(new Date("2026-10-28T09:45:00+10:00").toISOString());
  });

  it("parses a work directive with and without a notBefore", () => {
    const base = { kind: "action", targetId: "a", title: "A", recommendedMinutes: 30 };
    expect(currentDirectiveSchema.parse(base)).toEqual(base);
    const waiting = { ...base, notBefore: "2026-10-28T09:15:00+10:00" };
    expect(currentDirectiveSchema.parse(waiting)).toEqual(waiting);
    expect(currentDirectiveSchema.parse({ ...waiting, kind: "deliverable" })).toMatchObject({
      notBefore: waiting.notBefore
    });
  });

  it("ends a running session at its own planned end, not at the primary's minutes", () => {
    const answer = buildRecommendationAnswer(
      input(
        { recommendation: { primary: { action: { id: "a", title: "A" }, recommendedMinutes: 30 } } },
        {
          activeSession: {
            id: "s",
            actionId: "a",
            status: "running",
            startedAt: "2026-10-28T08:50:00+10:00",
            plannedEndAt: "2026-10-28T09:40:00+10:00",
            plannedMinutes: 50,
            activeElapsedSeconds: 600
          }
        }
      )
    );
    expect(answer.plannedEnd).toBe("2026-10-28T09:40:00+10:00");
  });

  it("names the next commitment the work fits before, with negative spare when it does not", () => {
    const answer = buildRecommendationAnswer(
      input(
        { recommendation: { primary: { action: { id: "a", title: "A" }, recommendedMinutes: 60 } } },
        {
          commitments: [
            {
              id: "c",
              title: "Class",
              status: "confirmed",
              startsAt: "2026-10-28T09:45:00+10:00",
              endsAt: "2026-10-28T11:00:00+10:00"
            }
          ]
        }
      )
    );
    expect(answer.fitsBefore).toEqual({
      commitmentId: "c",
      title: "Class",
      startsAt: "2026-10-28T09:45:00+10:00",
      spareMinutes: -15
    });
  });

  it("names a deliverable candidate by the deliverable, which is what activity start takes", () => {
    const answer = buildRecommendationAnswer(
      input({
        recommendation: {
          primary: {
            action: { id: "deliverable:d1", title: "Essay", deliverableId: "d1" },
            recommendedMinutes: 30
          },
          alternatives: [{ action: { id: "a2", title: "Email" }, recommendedMinutes: 10 }]
        }
      })
    );
    expect(answer.primary).toMatchObject({ kind: "deliverable", targetId: "d1" });
    expect(answer.runnerUp).toMatchObject({ kind: "action", targetId: "a2" });
  });

  it("reads a maintenance project's health from its adherence", () => {
    const answer = buildRecommendationAnswer(
      input({
        recommendation: { primary: { action: { id: "a", title: "A", projectId: "p-gym" }, recommendedMinutes: 30 } },
        schedule: {
          forecasts: [forecast("p-gym", "unknown", { healthBasis: "adherence", adherence: { health: "behind" } })]
        }
      })
    );
    expect(answer.projectHealth).toMatchObject({ projectId: "p-gym", health: "behind" });
  });
});

describe("buildRisks", () => {
  it("orders by severity across kinds: overdue, prep behind, missed steps, at risk, then steps due soon", () => {
    const risks = buildRisks(
      input({
        schedule: {
          forecasts: [
            forecast("p-thesis", "at_risk"),
            forecast("p-gym", "on_track"),
            forecast("p-tax", "behind", { overdue: true, proposal: { deadlineOwner: "external" } })
          ]
        },
        startByWarnings: [
          { stepId: "s1", anchorTitle: "Class", title: "Pack", startBy: "2026-10-28T09:10:00+10:00", status: "soon" },
          {
            stepId: "s2",
            anchorTitle: "Class",
            title: "Shower",
            startBy: "2026-10-28T08:50:00+10:00",
            status: "missed"
          }
        ],
        prepPace: {
          commitmentId: "c",
          commitmentTitle: "Class",
          commitmentStartsAt: "2026-10-28T09:45:00+10:00",
          requiredMinutes: 40,
          availableMinutes: 30,
          minutesBehind: 10,
          status: "behind"
        }
      })
    );
    expect(
      risks.map((risk) => ("projectId" in risk ? risk.projectId : "stepId" in risk ? risk.stepId : risk.kind))
    ).toEqual(["p-tax", "prep_pace", "s2", "p-thesis", "s1"]);
  });

  it("calls a passed self-set date lapsed, not overdue", () => {
    const [risk] = buildRisks(
      input({
        schedule: {
          forecasts: [forecast("p-thesis", "unknown", { overdue: true, proposal: { deadlineOwner: "internal" } })]
        }
      })
    );
    expect(risk).toMatchObject({ kind: "project", lapsed: true, overdue: true });
  });
});

describe("buildDay", () => {
  it("keeps what is running and what starts today, in the planning timezone", () => {
    const block = (startsAt: string, endsAt: string, title: string) => ({
      startsAt,
      endsAt,
      kind: "action" as const,
      targetId: title,
      title,
      focusedMinutes: 30,
      wallClockMinutes: 30,
      reason: "",
      confidence: "firm" as const
    });
    const day = buildDay(
      input({
        dayPlan: {
          through: "2026-10-29T09:00:00+10:00",
          mode: "policy_replay",
          truncated: false,
          displaced: [],
          locations: [],
          blocks: [
            block("2026-10-28T08:00:00+10:00", "2026-10-28T08:30:00+10:00", "done already"),
            block("2026-10-28T08:45:00+10:00", "2026-10-28T09:15:00+10:00", "running"),
            block("2026-10-28T23:30:00+10:00", "2026-10-29T00:30:00+10:00", "late tonight"),
            block("2026-10-29T08:00:00+10:00", "2026-10-29T08:30:00+10:00", "tomorrow")
          ]
        }
      })
    );
    expect(day.map((entry) => entry.title)).toEqual(["running", "late tonight"]);
  });
});
