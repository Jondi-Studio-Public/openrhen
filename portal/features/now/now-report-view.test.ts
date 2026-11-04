import { describe, expect, it } from "vitest";
import { createSeedState, type ActiveSession, type PortalState } from "@/state/portal-state";
import { buildNowModel, type NowRecommendation } from "./now-model";
import { buildNowViewBase } from "./now-report-view";

const now = new Date("2026-08-18T10:00:00.000Z");
const recommendation = (): NowRecommendation => ({
  primary: null,
  alternatives: [],
  candidates: [],
  headline: "Nothing fits",
  explanation: "No action fits this window.",
  evidence: ["Every action needs a laptop"]
});

const view = (state: PortalState) => {
  const model = buildNowModel({
    state,
    recommendation: recommendation(),
    forecasts: [],
    currentDirective: null,
    now,
    manualBedtime: false
  });
  return buildNowViewBase({ state, recommendation: recommendation(), currentDirective: null, model });
};

describe("buildNowViewBase", () => {
  it("records the reported availability and the engine's evidence, with no session running", () => {
    const base = view(createSeedState(now));
    expect(base.headline).toBe("Nothing fits");
    expect(base.session).toBeNull();
    expect(base.countdownSeconds).toBeNull();
    expect(base.assertedConditions).toEqual(["home", "laptop"]);
    expect(base.evidence).toEqual(["Every action needs a laptop"]);
    expect(base.sleepPlanId).toBeNull();
  });

  it("summarises a running session, defaulting an untyped target to the action it started from", () => {
    const session: ActiveSession = {
      id: "session-1",
      actionId: "networking-section-one",
      status: "running",
      startedAt: new Date(now.getTime() - 600_000).toISOString(),
      plannedEndAt: new Date(now.getTime() + 1_200_000).toISOString(),
      plannedMinutes: 30,
      remainingBeforeMinutes: 90,
      activeElapsedSeconds: 600
    };
    const base = view({ ...createSeedState(now), activeSession: session });
    expect(base.session).toEqual({
      id: "session-1",
      status: "running",
      targetType: "action",
      targetId: "networking-section-one",
      targetTitle: null,
      plannedMinutes: 30,
      plannedEndAt: session.plannedEndAt
    });
    expect(base.countdownSeconds).toBe(1200);
  });
});
