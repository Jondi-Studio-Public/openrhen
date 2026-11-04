import { expect } from "vitest";
import {
  planForecastRequestSchema,
  type CurrentDirective,
  type PrepPace,
  type ProjectHealth
} from "@openrhen/contracts";
import { calculatePlanAndForecast } from "../../src/index.js";
import { compactDayPlan } from "../model/day-plan-harness.js";

export interface Fixture {
  name: string;
  why: string;
  capturedAt: string;
  snapshotId?: string;
  request: unknown;
  expect: {
    currentDirective?: CurrentDirective | null;
    primaryActionId?: string | null;
    health?: Record<string, ProjectHealth>;
    /**
     * The projected day in the compact form `compactDayPlan` writes — one line per block. A changed
     * line is the record that the replayed policy moved, which is exactly what this fixture is for.
     */
    dayPlan?: string[];
    /** `null` asserts the engine reports no commitment currently being prepared for. */
    prepPace?: PrepPace | null;
    /**
     * The critical tier each named candidate carries: what a ranking fixture pins even when a gate (energy,
     * readiness) keeps that candidate from leading at the captured moment.
     */
    candidateTiers?: Record<string, string>;
  };
}

/** The assertions every snapshot-replay case runs, shared by the synthetic and the private suites. */
export function assertFixture(file: string, fixture: Fixture): void {
  // `--promote` fills `expect` from the engine's answer at capture time, which during a bug hunt
  // is the wrong answer. Failing here until `why` is written stops a fixture from quietly
  // enshrining the very behaviour it was captured to correct.
  expect(
    fixture.why.startsWith("TODO"),
    `${file} still carries the placeholder \`why\`; state the intended behaviour and correct \`expect\` to match it`
  ).toBe(false);

  const request = planForecastRequestSchema.parse(fixture.request);
  const result = calculatePlanAndForecast(request);

  if (fixture.expect.currentDirective !== undefined) {
    expect(result.currentDirective).toEqual(fixture.expect.currentDirective);
  }
  if (fixture.expect.primaryActionId !== undefined) {
    const recommendation = result.recommendation as { primary?: { action?: { id?: string } } } | null;
    expect(recommendation?.primary?.action?.id ?? null).toBe(fixture.expect.primaryActionId);
  }
  if (fixture.expect.dayPlan !== undefined) {
    expect(result.dayPlan, "day plan present").toBeDefined();
    expect(compactDayPlan(result.dayPlan!)).toEqual(fixture.expect.dayPlan);
  }
  if (fixture.expect.prepPace !== undefined) {
    expect(result.prepPace ?? null).toEqual(fixture.expect.prepPace);
  }
  if (fixture.expect.candidateTiers) {
    const candidates =
      (result.recommendation as { candidates?: Array<{ action: { id: string }; criticalTier: string }> } | null)
        ?.candidates ?? [];
    for (const [actionId, tier] of Object.entries(fixture.expect.candidateTiers)) {
      expect(candidates.find((item) => item.action.id === actionId)?.criticalTier, `tier of ${actionId}`).toBe(tier);
    }
  }
  if (fixture.expect.health) {
    const forecasts =
      (result.schedule as { forecasts?: Array<{ projectId: string; health: ProjectHealth }> } | null)?.forecasts ?? [];
    for (const [projectId, health] of Object.entries(fixture.expect.health)) {
      expect(forecasts.find((item) => item.projectId === projectId)?.health, `health of ${projectId}`).toBe(health);
    }
  }
}
