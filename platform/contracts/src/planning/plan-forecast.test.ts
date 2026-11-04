import { describe, expect, it } from "vitest";
import { planForecastResponseSchema } from "./plan-forecast.js";

const REQUEST_ID = "8fe5bba7-e436-429d-8011-67467b3ec55e";

function baseResponse(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: "1",
    requestId: REQUEST_ID,
    inputVersion: "abc123",
    engineVersion: "1.2.0",
    calculatedAt: "2026-09-26T00:00:00.000Z",
    validUntil: "2026-09-26T01:00:00.000Z",
    derivedState: {
      sleepPlans: [],
      occurrences: [],
      routineSteps: [],
      commitmentRepeats: []
    },
    schedule: {},
    recommendation: {},
    currentDirective: { kind: "none", title: "Nothing to do", recommendedMinutes: 0 },
    upcomingDirectives: [],
    continuation: null,
    ...overrides
  };
}

describe("plan-forecast contract — stepPlacements / softPlacements", () => {
  it("a result stored before this plan parses, with both arrays empty", () => {
    const result = planForecastResponseSchema.parse(baseResponse());
    expect(result.derivedState.stepPlacements).toEqual([]);
    expect(result.softPlacements).toEqual([]);
  });

  it("a full entry round-trips", () => {
    // Read back from these literals directly, rather than off `raw`: `baseResponse`'s
    // `Record<string, unknown>` override parameter does not carry the new keys' shape forward onto
    // its inferred return type, so `tsc` cannot see `stepPlacements`/`softPlacements` on `raw` itself.
    const stepPlacements = [
      {
        stepId: "step-1",
        anchorKind: "commitment",
        anchorId: "commitment-1",
        placedStartAt: "2026-09-26T07:00:00.000Z",
        placedEndAt: "2026-09-26T07:05:00.000Z",
        waitStartsAt: "2026-09-26T07:05:00.000Z",
        waitEndsAt: "2026-09-26T08:35:00.000Z",
        startBy: "2026-09-26T07:30:00.000Z",
        earliestAt: "2026-09-26T06:00:00.000Z",
        bandId: "evening"
      }
    ];
    const softPlacements = [
      { actionId: "action-1", startsAt: "2026-09-26T18:00:00.000Z", endsAt: "2026-09-26T18:30:00.000Z", minutes: 30 }
    ];
    const raw = baseResponse({
      derivedState: { sleepPlans: [], occurrences: [], routineSteps: [], commitmentRepeats: [], stepPlacements },
      softPlacements
    });
    const result = planForecastResponseSchema.parse(raw);
    expect(result.derivedState.stepPlacements).toEqual(stepPlacements);
    expect(result.softPlacements).toEqual(softPlacements);
  });
});
