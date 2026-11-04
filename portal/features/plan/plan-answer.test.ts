import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import type { ClientForecast } from "@/state/portal-provider";
import { planAnswer } from "@/features/plan/plan-answer";

const state = createSeedState(new Date("2026-08-18T09:00:00.000Z"));
const id = state.projects[0]!.id;
const forecast = (overrides: Partial<ClientForecast>) =>
  ({ projectId: id, health: "on_track", ...overrides }) as ClientForecast;

describe("planAnswer", () => {
  it("says the math works when every dated project fits", () => {
    expect(planAnswer(state.projects, [forecast({})], 0)).toBe(
      "The math works: every dated project fits in the time you have."
    );
  });

  it("reads behind or overdue first, then at risk", () => {
    expect(planAnswer(state.projects, [forecast({ health: "behind" })], 0)).toMatch(
      /^The math does not work yet: 1 project is behind/
    );
    expect(planAnswer(state.projects, [forecast({ health: "on_track", overdue: true })], 0)).toMatch(
      /does not work yet/
    );
    expect(planAnswer(state.projects, [forecast({ health: "at_risk" })], 0)).toMatch(
      /^The math is tight: 1 project is at risk/
    );
  });

  it("does not count a lapsed self-set date against the math", () => {
    const lapsed = forecast({ overdue: true, proposal: { deadlineOwner: "internal" } as never });
    expect(planAnswer(state.projects, [lapsed], 0)).toMatch(/^The math works/);
  });

  it("ignores forecasts for projects that are not active", () => {
    const paused = state.projects.map((project) => ({ ...project, status: "paused" as const }));
    expect(planAnswer(paused, [forecast({ health: "behind" })], 0)).toMatch(/no math to check/);
  });

  it("adds how many decisions wait, one and many", () => {
    expect(planAnswer(state.projects, [forecast({})], 1)).toMatch(
      /One thing needs a decision before it can be planned\.$/
    );
    expect(planAnswer(state.projects, [forecast({})], 4)).toMatch(
      /4 things need a decision before they can be planned\.$/
    );
  });
});
