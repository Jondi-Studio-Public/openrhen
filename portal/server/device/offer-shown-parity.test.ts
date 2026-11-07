import { describe, expect, it } from "vitest";
import { shownTargetFor } from "@openrhen/contracts";
import { createSeedState, type PortalState } from "@/state/portal-state";
import { buildNowModel } from "@/features/now/now-model";
import { deviceShownTarget } from "./device-now";

/**
 * The same stored state must log the same `shown` target from the Now page (`buildNowModel` + `shownTargetFor`, what
 * `useOfferShown` sends) and from the handheld route (`deviceShownTarget`). Both read one `resolveNowActivity` and one
 * builder, so session ids, travel's `then` commitment and `suppressedBy` cannot drift apart.
 */
const NOW = new Date("2026-09-02T10:00:00.000Z");
const iso = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();

const primary = { action: { id: "room-floor", title: "Sort the bedroom floor" }, recommendedMinutes: 30 };
const protectedMeeting = {
  id: "meeting",
  title: "Client meeting",
  phase: "active",
  startsAt: iso(-10),
  endsAt: iso(50),
  protectedStartAt: iso(-10),
  protectedEndAt: iso(50),
  phaseStartsAt: iso(-10),
  phaseEndsAt: iso(50)
};
const meeting = {
  id: "meeting",
  title: "Client meeting",
  startsAt: iso(-10),
  endsAt: iso(50),
  status: "confirmed",
  setupBeforeMinutes: 0,
  transitionAfterMinutes: 0
};
const step = {
  id: "step-1",
  commitmentId: "meeting",
  title: "Get dressed",
  durationMinutes: 10,
  sequence: 0,
  timingRule: "contiguous",
  energy: "low",
  contexts: [],
  dependencyIds: [],
  phase: "before",
  status: "pending",
  scheduledStartAt: iso(-5),
  scheduledEndAt: iso(5)
};
const sleepPlan = {
  id: "sleep-1",
  plannedStartAt: iso(-5),
  plannedWakeAt: iso(8 * 60),
  desiredMinutes: 480,
  allowedMinutes: 480,
  sleepDeficitMinutes: 0,
  anchorDeviationMinutes: 0,
  hardErrors: [],
  explanation: "",
  status: "planned"
};
const session = {
  id: "session-1",
  actionId: "networking-section-one",
  status: "running",
  startedAt: iso(-10),
  plannedEndAt: iso(15),
  plannedMinutes: 25,
  remainingBeforeMinutes: 90,
  activeElapsedSeconds: 600
};

const noDirective = { kind: "none", title: "Nothing fits", recommendedMinutes: 0 };

function stateWith(overrides: Record<string, unknown>, directive: unknown, recommendation: unknown): PortalState {
  const seed = createSeedState(NOW);
  return {
    ...seed,
    commitments: [],
    sleepPlans: [],
    ...overrides,
    planning: {
      status: "current",
      validUntil: iso(60),
      result: { currentDirective: directive, recommendation }
    }
  } as unknown as PortalState;
}

function portalTarget(state: PortalState) {
  const result = state.planning!.result as unknown as { currentDirective: never; recommendation: never };
  const model = buildNowModel({
    state,
    recommendation: result.recommendation,
    forecasts: [],
    currentDirective: result.currentDirective,
    now: NOW,
    manualBedtime: false,
    knownLatestSuccessfulAt: null
  });
  return shownTargetFor(model.activity, model.primary);
}

const cases: Array<[string, PortalState, Record<string, unknown>]> = [
  ["recommended", stateWith({}, noDirective, { primary }), { resolutionKind: "recommended", targetId: "room-floor" }],
  [
    "session (keyed by action id, primary suppressed)",
    stateWith({ activeSession: session }, noDirective, { primary }),
    {
      resolutionKind: "session",
      targetType: "action",
      targetId: "networking-section-one",
      suppressedBy: { targetType: "action", targetId: "room-floor" }
    }
  ],
  [
    "routine_step",
    stateWith(
      { routineSteps: [step] },
      { kind: "routine_step", targetId: "step-1", title: "Get dressed", recommendedMinutes: 10 },
      { primary }
    ),
    { resolutionKind: "routine_step", targetType: "routine_step", targetId: "step-1" }
  ],
  [
    "commitment",
    stateWith({ commitments: [meeting] }, noDirective, { primary: null, protectedCommitment: protectedMeeting }),
    { resolutionKind: "commitment", targetType: "fixed_commitment", targetId: "meeting" }
  ],
  [
    "travel with a then commitment",
    stateWith(
      { commitments: [meeting] },
      {
        kind: "travel",
        toLocationId: "loc-campus",
        title: "Drive to campus",
        recommendedMinutes: 20,
        source: "measured",
        // oxlint-disable-next-line unicorn/no-thenable -- `then` is a domain field of the travel directive, not a promise continuation
        then: { kind: "commitment", targetId: "meeting", title: "Client meeting" }
      },
      { primary }
    ),
    {
      resolutionKind: "travel",
      targetType: "fixed_commitment",
      targetId: "meeting",
      suppressedBy: { targetId: "room-floor" }
    }
  ],
  [
    "travel with no then",
    stateWith(
      {},
      { kind: "travel", toLocationId: "loc-campus", title: "Drive", recommendedMinutes: 20 },
      { primary: null }
    ),
    { resolutionKind: "travel", targetType: "travel", targetId: "loc-campus" }
  ],
  [
    "sleep",
    stateWith({ sleepPlans: [sleepPlan] }, noDirective, { primary }),
    { resolutionKind: "sleep", targetType: "sleep", targetId: "sleep-1", suppressedBy: { targetId: "room-floor" } }
  ],
  [
    "free",
    stateWith({}, noDirective, { primary: null }),
    { resolutionKind: "free", targetType: "none", targetId: "free" }
  ]
];

describe("shown target parity between the Now page and the handheld", () => {
  it.each(cases)("%s", (_name, state, expected) => {
    const handheld = deviceShownTarget(state, NOW);
    expect(handheld).toMatchObject(expected);
    expect(portalTarget(state)).toEqual(handheld);
  });
});
