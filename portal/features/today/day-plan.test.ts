import { describe, expect, it } from "vitest";
import { createSeedState, type PortalState } from "@/state/portal-state";
import type { ClientAllocation, ClientRecommendation, ClientSlot } from "@/state/portal-provider";
import { buildDayPlan, groupCrampedRuns, type DayPlanInput, type DayPlanItem } from "./day-plan";

// Wednesday 19 August 2026 in the seed zone runs 2026-08-18T14:00Z to 2026-08-19T14:00Z. `now` is 10:00 local.
const NOW = new Date("2026-08-19T00:00:00.000Z");
const TZ = "Australia/Sydney";
const DAY = "2026-08-19";
const at = (value: string) => new Date(value);

function baseState(overrides: Partial<PortalState> = {}): PortalState {
  const state = createSeedState(NOW);
  return {
    ...state,
    commitments: [],
    routineSteps: [],
    routinePresets: [],
    sleepPlans: [],
    occurrences: [],
    completedToday: [],
    activeSession: null,
    planning: { status: "current" },
    ...overrides
  };
}

function build(overrides: Partial<DayPlanInput> = {}) {
  return buildDayPlan({
    state: baseState(),
    slots: [],
    allocations: [],
    recommendation: null,
    currentDirective: null,
    upcomingDirectives: [],
    dayKey: DAY,
    now: NOW,
    timezone: TZ,
    ...overrides
  });
}

type EngineDayPlan = NonNullable<DayPlanInput["dayPlan"]>;
type EngineBlock = EngineDayPlan["blocks"][number];

const engineBlock = (
  overrides: Partial<EngineBlock> & Pick<EngineBlock, "startsAt" | "endsAt" | "kind">
): EngineBlock => ({
  targetId: null,
  title: "Block",
  focusedMinutes: 0,
  wallClockMinutes: 0,
  reason: "The engine's reason.",
  confidence: "projected",
  ...overrides
});

const workBlock = (
  startsAt: string,
  endsAt: string,
  targetId: string,
  overrides: Partial<EngineBlock> = {}
): EngineBlock =>
  engineBlock({
    startsAt,
    endsAt,
    kind: "action",
    targetId,
    title: `Work on ${targetId}`,
    projectId: "p1",
    focusedMinutes: Math.round((new Date(endsAt).getTime() - new Date(startsAt).getTime()) / 60_000),
    wallClockMinutes: Math.round((new Date(endsAt).getTime() - new Date(startsAt).getTime()) / 60_000),
    ...overrides
  });

const enginePlan = (blocks: EngineBlock[], overrides: Partial<EngineDayPlan> = {}): EngineDayPlan => ({
  through: "2026-08-19T12:00:00.000Z",
  mode: "policy_replay",
  blocks,
  truncated: false,
  displaced: [],
  locations: [],
  ...overrides
});

const commitment = (id: string, startsAt: string, endsAt: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Commitment ${id}`,
  startsAt,
  endsAt,
  status: "confirmed" as const,
  setupBeforeMinutes: 0,
  transitionAfterMinutes: 0,
  ...extra
});

describe("buildDayPlan", () => {
  it("bounds the day in the planning zone and marks now only when now is on that day", () => {
    const plan = build();
    expect(plan.bounds.startsAt.toISOString()).toBe("2026-08-18T14:00:00.000Z");
    expect(plan.bounds.endsAt.toISOString()).toBe("2026-08-19T14:00:00.000Z");
    expect(plan.nowAt).toEqual(NOW);
    expect(build({ dayKey: "2026-08-20" }).nowAt).toBeNull();
  });

  it("dims the elapsed part of today and the whole of a past day, nothing of a future day", () => {
    const elapsed = build().backgrounds.find((band) => band.kind === "elapsed")!;
    expect(elapsed.startsAt.toISOString()).toBe("2026-08-18T14:00:00.000Z");
    expect(elapsed.endsAt).toEqual(NOW);
    const yesterday = build({ dayKey: "2026-08-18" }).backgrounds.find((band) => band.kind === "elapsed")!;
    expect(yesterday.endsAt.toISOString()).toBe("2026-08-18T14:00:00.000Z");
    expect(build({ dayKey: "2026-08-20" }).backgrounds.find((band) => band.kind === "elapsed")).toBeUndefined();
  });

  it("draws the daily horizon at the settings wall time on that day", () => {
    const horizon = build().lines.find((line) => line.kind === "horizon")!;
    expect(horizon.at.toISOString()).toBe("2026-08-19T12:00:00.000Z");
    expect(horizon.label).toBe("Daily horizon");
  });

  it("places commitments, marks tentative ones and drops cancelled ones", () => {
    const plan = build({
      state: baseState({
        commitments: [
          commitment("dentist", "2026-08-19T04:00:00.000Z", "2026-08-19T05:00:00.000Z", {
            setupBeforeMinutes: 15,
            transitionAfterMinutes: 30,
            location: "Town"
          }),
          commitment("maybe", "2026-08-19T06:00:00.000Z", "2026-08-19T07:00:00.000Z", { status: "tentative" }),
          commitment("gone", "2026-08-19T08:00:00.000Z", "2026-08-19T09:00:00.000Z", { status: "cancelled" }),
          commitment("tomorrow", "2026-08-20T01:00:00.000Z", "2026-08-20T02:00:00.000Z")
        ]
      })
    });
    const commitments = plan.items.filter((item) => item.kind === "commitment");
    expect(commitments.map((item) => item.entityId)).toEqual(["dentist", "maybe"]);
    const dentist = commitments[0]!;
    expect(dentist.source).toBe("fixed");
    expect(dentist.subtitle).toBe("Town");
    // Invariant 5: no matching (or moved) commitment timeline entry means no halos at all.
    expect(dentist.halos).toEqual([]);
    expect(commitments[1]!.tentative).toBe(true);
    expect(commitments[1]!.subtitle).toBe("Tentative");
  });

  it("draws halos from the commitment timeline (setup, arrival margin, transition/overtime)", () => {
    const plan = build({
      state: baseState({
        commitments: [commitment("dentist", "2026-08-19T04:00:00.000Z", "2026-08-19T05:00:00.000Z")],
        planning: {
          status: "current",
          result: {
            derivedState: {
              commitmentTimelines: [
                {
                  id: "dentist",
                  setupStartsAt: "2026-08-19T03:30:00.000Z",
                  leaveBy: "2026-08-19T03:38:00.000Z",
                  arriveBy: "2026-08-19T03:55:00.000Z",
                  startsAt: "2026-08-19T04:00:00.000Z",
                  endsAt: "2026-08-19T05:00:00.000Z",
                  effectiveEndsAt: "2026-08-19T05:20:00.000Z",
                  freeAt: "2026-08-19T05:50:00.000Z",
                  overtime: true,
                  latenessMatters: true,
                  journeyBefore: {
                    fromLocationId: "home",
                    toLocationId: "dentist",
                    mode: "car",
                    minutes: 22,
                    typicalMinutes: 18,
                    source: "typical",
                    sampleCount: 5
                  }
                }
              ]
            }
          }
        } as NonNullable<PortalState["planning"]>
      })
    });
    const dentist = plan.items.find((item) => item.entityId === "dentist" && item.kind === "commitment")!;
    expect(dentist.halos).toEqual([
      { startsAt: at("2026-08-19T03:30:00.000Z"), endsAt: at("2026-08-19T03:38:00.000Z") },
      { startsAt: at("2026-08-19T03:55:00.000Z"), endsAt: at("2026-08-19T04:00:00.000Z") },
      { startsAt: at("2026-08-19T05:20:00.000Z"), endsAt: at("2026-08-19T05:50:00.000Z") }
    ]);
    // Overtime: the block itself ends at the timeline's own `effectiveEndsAt`, not the stored `endsAt`.
    expect(dentist.endsAt).toEqual(at("2026-08-19T05:20:00.000Z"));
    const leaveByMarker = plan.items.find((item) => item.kind === "leave_by")!;
    expect(leaveByMarker.title).toBe("Leave by 1:38 pm for Commitment dentist");
  });

  it("carries a commitment's travelGap from the latest stored timeline, and leaves it off a resolved one", () => {
    const plan = build({
      state: baseState({
        commitments: [
          commitment("dentist", "2026-08-19T04:00:00.000Z", "2026-08-19T05:00:00.000Z"),
          commitment("college", "2026-08-19T06:00:00.000Z", "2026-08-19T07:00:00.000Z")
        ],
        planning: {
          status: "current",
          result: {
            derivedState: {
              commitmentTimelines: [
                {
                  id: "dentist",
                  startsAt: "2026-08-19T04:00:00.000Z",
                  setupStartsAt: "2026-08-19T04:00:00.000Z",
                  arriveBy: "2026-08-19T04:00:00.000Z",
                  endsAt: "2026-08-19T05:00:00.000Z",
                  effectiveEndsAt: "2026-08-19T05:00:00.000Z",
                  freeAt: "2026-08-19T05:00:00.000Z",
                  overtime: false,
                  latenessMatters: true,
                  travelGap: "no_place"
                },
                {
                  id: "college",
                  startsAt: "2026-08-19T06:00:00.000Z",
                  setupStartsAt: "2026-08-19T06:00:00.000Z",
                  arriveBy: "2026-08-19T06:00:00.000Z",
                  endsAt: "2026-08-19T07:00:00.000Z",
                  effectiveEndsAt: "2026-08-19T07:00:00.000Z",
                  freeAt: "2026-08-19T07:00:00.000Z",
                  overtime: false,
                  latenessMatters: true
                }
              ]
            }
          }
        } as NonNullable<PortalState["planning"]>
      })
    });
    const commitments = plan.items.filter((item) => item.kind === "commitment");
    expect(commitments.find((item) => item.entityId === "dentist")!.travelGap).toBe("no_place");
    expect(commitments.find((item) => item.entityId === "college")!.travelGap).toBeUndefined();
  });

  it("gives no halos and no leave-by marker for a moved commitment (timeline startsAt out of date)", () => {
    const plan = build({
      state: baseState({
        commitments: [commitment("dentist", "2026-08-19T04:00:00.000Z", "2026-08-19T05:00:00.000Z")],
        planning: {
          status: "current",
          result: {
            derivedState: {
              commitmentTimelines: [
                {
                  id: "dentist",
                  // A stale entry: the commitment has since moved to 04:00, this entry still says 03:00.
                  startsAt: "2026-08-19T03:00:00.000Z",
                  setupStartsAt: "2026-08-19T02:30:00.000Z",
                  leaveBy: "2026-08-19T02:38:00.000Z",
                  arriveBy: "2026-08-19T02:55:00.000Z",
                  endsAt: "2026-08-19T04:00:00.000Z",
                  effectiveEndsAt: "2026-08-19T04:00:00.000Z",
                  freeAt: "2026-08-19T04:00:00.000Z",
                  overtime: false,
                  latenessMatters: true,
                  journeyBefore: {
                    fromLocationId: "home",
                    toLocationId: "dentist",
                    mode: "car",
                    minutes: 22,
                    typicalMinutes: 18,
                    source: "typical",
                    sampleCount: 5
                  }
                }
              ]
            }
          }
        } as NonNullable<PortalState["planning"]>
      })
    });
    const dentist = plan.items.find((item) => item.entityId === "dentist" && item.kind === "commitment")!;
    expect(dentist.halos).toEqual([]);
    expect(plan.items.some((item) => item.kind === "leave_by")).toBe(false);
  });

  it("leave-by caption carries assumed origin, relaxed lateness and staleness", () => {
    const timelineEntry = {
      id: "dentist",
      startsAt: "2026-08-19T04:00:00.000Z",
      setupStartsAt: "2026-08-19T03:30:00.000Z",
      leaveBy: "2026-08-19T03:38:00.000Z",
      arriveBy: "2026-08-19T03:55:00.000Z",
      endsAt: "2026-08-19T05:00:00.000Z",
      effectiveEndsAt: "2026-08-19T05:00:00.000Z",
      freeAt: "2026-08-19T05:00:00.000Z",
      overtime: false,
      latenessMatters: false,
      journeyBefore: {
        fromLocationId: "home",
        toLocationId: "dentist",
        mode: "car",
        minutes: 22,
        typicalMinutes: 18,
        source: "typical",
        sampleCount: 5,
        originAssumed: true
      }
    };
    const plan = build({
      state: baseState({
        commitments: [commitment("dentist", "2026-08-19T04:00:00.000Z", "2026-08-19T05:00:00.000Z")],
        planning: {
          status: "current",
          result: { derivedState: { commitmentTimelines: [timelineEntry] } }
        } as NonNullable<PortalState["planning"]>
      })
    });
    const marker = plan.items.find((item) => item.kind === "leave_by")!;
    expect(marker.subtitle).toBe("usually 18 min · allowing 22 · assuming you're at home · lateness relaxed");
    expect(marker.stale).toBe(false);

    const stalePlan = build({
      state: baseState({
        commitments: [commitment("dentist", "2026-08-19T04:00:00.000Z", "2026-08-19T05:00:00.000Z")],
        planning: {
          status: "stale",
          result: { derivedState: { commitmentTimelines: [timelineEntry] } }
        } as NonNullable<PortalState["planning"]>
      })
    });
    expect(stalePlan.items.find((item) => item.kind === "leave_by")!.stale).toBe(true);
  });

  it("carries a commitment's presence onto its block, calling one that says nothing blocking", () => {
    const plan = build({
      state: baseState({
        commitments: [
          commitment("anchored", "2026-08-19T04:00:00.000Z", "2026-08-19T05:00:00.000Z", { presence: "anchor" }),
          commitment("walled", "2026-08-19T06:00:00.000Z", "2026-08-19T07:00:00.000Z", { presence: "blocking" }),
          commitment("silent", "2026-08-19T08:00:00.000Z", "2026-08-19T09:00:00.000Z")
        ]
      })
    });
    const presence = plan.items
      .filter((item) => item.kind === "commitment")
      .map((item) => [item.entityId, item.presence]);
    expect(presence).toEqual([
      ["anchored", "anchor"],
      ["walled", "blocking"],
      ["silent", "blocking"]
    ]);
  });

  it("clips a span across local midnight and says which end was cut", () => {
    const plan = build({
      state: baseState({
        sleepPlans: [
          {
            id: "last-night",
            plannedStartAt: "2026-08-18T12:30:00.000Z",
            plannedWakeAt: "2026-08-18T20:00:00.000Z",
            desiredMinutes: 480,
            allowedMinutes: 450,
            sleepDeficitMinutes: 0,
            anchorDeviationMinutes: 0,
            hardErrors: [],
            explanation: "",
            status: "completed",
            actualStartAt: "2026-08-18T12:45:00.000Z",
            actualWakeAt: "2026-08-18T20:10:00.000Z"
          },
          {
            id: "tonight",
            plannedStartAt: "2026-08-19T12:00:00.000Z",
            plannedWakeAt: "2026-08-19T20:00:00.000Z",
            desiredMinutes: 480,
            allowedMinutes: 480,
            sleepDeficitMinutes: 0,
            anchorDeviationMinutes: 0,
            hardErrors: [],
            explanation: "",
            status: "planned"
          }
        ]
      })
    });
    const sleeps = plan.items.filter((item) => item.kind === "sleep");
    expect(sleeps).toHaveLength(2);
    const [lastNight, tonight] = sleeps;
    // Actual times win over planned ones once they exist.
    expect(lastNight).toMatchObject({
      startsAt: plan.bounds.startsAt,
      endsAt: at("2026-08-18T20:10:00.000Z"),
      clippedStart: true,
      clippedEnd: false,
      source: "recorded",
      title: "Slept"
    });
    expect(tonight).toMatchObject({
      startsAt: at("2026-08-19T12:00:00.000Z"),
      endsAt: plan.bounds.endsAt,
      clippedStart: false,
      clippedEnd: true,
      source: "fixed",
      title: "Sleep"
    });
    expect(plan.backgrounds.filter((band) => band.kind === "sleep")).toHaveLength(2);
  });

  it("places pending preparation, strips completed and cancelled steps, and sends unplaced ones to the untimed strip", () => {
    const plan = build({
      state: baseState({
        commitments: [commitment("college", "2026-08-19T04:00:00.000Z", "2026-08-19T06:00:00.000Z")],
        routineSteps: [
          {
            id: "drive",
            commitmentId: "college",
            anchorType: "commitment",
            title: "Drive to College",
            durationMinutes: 30,
            sequence: 0,
            timingRule: "contiguous",
            energy: "low",
            contexts: [],
            dependencyIds: [],
            phase: "before",
            status: "pending",
            scheduledStartAt: "2026-08-19T03:30:00.000Z",
            scheduledEndAt: "2026-08-19T04:00:00.000Z"
          },
          {
            id: "pack",
            commitmentId: "college",
            anchorType: "commitment",
            title: "Pack bag",
            durationMinutes: 10,
            sequence: 1,
            timingRule: "flexible",
            energy: "low",
            contexts: [],
            dependencyIds: [],
            phase: "before",
            status: "pending"
          },
          {
            id: "old",
            commitmentId: "college",
            anchorType: "commitment",
            title: "Cancelled step",
            durationMinutes: 10,
            sequence: 2,
            timingRule: "flexible",
            energy: "low",
            contexts: [],
            dependencyIds: [],
            phase: "before",
            status: "cancelled",
            scheduledStartAt: "2026-08-19T03:00:00.000Z",
            scheduledEndAt: "2026-08-19T03:10:00.000Z"
          },
          {
            id: "done",
            commitmentId: "college",
            anchorType: "commitment",
            title: "Ticked off by hand",
            durationMinutes: 10,
            sequence: 3,
            timingRule: "flexible",
            energy: "low",
            contexts: [],
            dependencyIds: [],
            phase: "before",
            status: "completed",
            scheduledStartAt: "2026-08-19T03:10:00.000Z",
            scheduledEndAt: "2026-08-19T03:20:00.000Z"
          },
          {
            id: "done-unplaced",
            commitmentId: "college",
            anchorType: "commitment",
            title: "Ticked off before it was placed",
            durationMinutes: 10,
            sequence: 4,
            timingRule: "flexible",
            energy: "low",
            contexts: [],
            dependencyIds: [],
            phase: "before",
            status: "completed"
          }
        ]
      })
    });
    const steps = plan.items.filter((item) => item.kind === "routine_step");
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      entityId: "drive",
      parentId: "college",
      subtitle: "Before Commitment college · 30 min",
      startsAt: at("2026-08-19T03:30:00.000Z")
    });
    expect(plan.untimed).toEqual([
      {
        id: "routine_step:pack",
        kind: "routine_step",
        title: "Pack bag",
        minutes: 10,
        reason: "Not yet placed · before Commitment college"
      }
    ]);
  });

  // a bedtime/wake step is a `routine_steps` row now, already carrying its own real
  // `scheduledStartAt`/`scheduledEndAt` — this canvas draws each one as its own block, exactly like a
  // commitment's own preparation step, rather than deriving a sequence from one bundled instance's
  // span and listing it as a nested `.steps` array.
  const bedtimeStep = (
    overrides: Partial<PortalState["routineSteps"][number]> = {}
  ): PortalState["routineSteps"][number] => ({
    id: "teeth",
    version: 1,
    anchorType: "sleep_plan",
    anchorId: "tonight",
    purpose: "bedtime",
    title: "Brush teeth",
    durationMinutes: 10,
    sequence: 0,
    timingRule: "contiguous",
    energy: "low",
    contexts: [],
    dependencyIds: [],
    phase: "before",
    status: "pending",
    scheduledStartAt: "2026-08-19T11:30:00.000Z",
    scheduledEndAt: "2026-08-19T11:40:00.000Z",
    ...overrides
  });

  it("draws each bedtime routine step as its own block, in sequence", () => {
    const plan = build({
      state: baseState({
        routineSteps: [
          bedtimeStep(),
          bedtimeStep({
            id: "read",
            title: "Read",
            durationMinutes: 20,
            sequence: 1,
            scheduledStartAt: "2026-08-19T11:40:00.000Z",
            scheduledEndAt: "2026-08-19T12:00:00.000Z"
          })
        ]
      })
    });
    const steps = plan.items.filter((item) => item.kind === "routine_step" && item.parentId === "tonight");
    expect(steps.map((item) => item.title)).toEqual(["Brush teeth", "Read"]);
    expect(steps[0]!.subtitle).toBe("Bedtime routine · 10 min");
    expect(steps[0]!.startsAt).toEqual(at("2026-08-19T11:30:00.000Z"));
    expect(steps[1]!.endsAt).toEqual(at("2026-08-19T12:00:00.000Z"));
  });

  it("draws every wake routine step regardless of phase, labelled 'Wake routine'", () => {
    const plan = build({
      state: baseState({
        routineSteps: [
          {
            id: "stretch",
            version: 1,
            anchorType: "sleep_plan",
            anchorId: "this-morning",
            purpose: "wake",
            title: "Stretch",
            durationMinutes: 10,
            sequence: 0,
            timingRule: "contiguous",
            energy: "low",
            contexts: [],
            dependencyIds: [],
            phase: "before",
            status: "pending",
            // Within the day's window (2026-08-18T14:00Z to 2026-08-19T14:00Z per the file header).
            scheduledStartAt: "2026-08-19T05:00:00.000Z",
            scheduledEndAt: "2026-08-19T05:10:00.000Z"
          },
          {
            id: "shower",
            version: 1,
            anchorType: "sleep_plan",
            anchorId: "this-morning",
            purpose: "wake",
            title: "Shower",
            durationMinutes: 15,
            sequence: 1,
            timingRule: "contiguous",
            energy: "low",
            contexts: [],
            dependencyIds: [],
            // "after"-phase, still drawn — phase is not consulted for a wake routine.
            phase: "after",
            status: "pending",
            scheduledStartAt: "2026-08-19T05:10:00.000Z",
            scheduledEndAt: "2026-08-19T05:25:00.000Z"
          }
        ]
      })
    });
    const steps = plan.items.filter((item) => item.kind === "routine_step" && item.parentId === "this-morning");
    expect(steps.map((item) => item.title)).toEqual(["Stretch", "Shower"]);
    expect(steps.every((item) => item.subtitle?.startsWith("Wake routine"))).toBe(true);
    expect(steps[0]!.startsAt).toEqual(at("2026-08-19T05:00:00.000Z"));
    expect(steps[1]!.endsAt).toEqual(at("2026-08-19T05:25:00.000Z"));
  });

  const washStep = (
    overrides: Partial<PortalState["routineSteps"][number]> = {}
  ): PortalState["routineSteps"][number] => ({
    id: "wash",
    version: 1,
    commitmentId: "work",
    anchorType: "commitment",
    anchorId: "work",
    title: "Wash",
    durationMinutes: 5,
    sequence: 0,
    timingRule: "flexible",
    energy: "low",
    contexts: [],
    dependencyIds: [],
    phase: "before",
    status: "pending",
    waitAfterMinutes: 90,
    preferredBands: ["evening"],
    scheduledStartAt: "2026-08-19T09:00:00.000Z",
    scheduledEndAt: "2026-08-19T09:05:00.000Z",
    ...overrides
  });

  it("names the band a preferred-time step landed in, and says so when none fit", () => {
    const withBand = build({
      state: baseState({
        commitments: [commitment("work", "2026-08-19T23:00:00.000Z", "2026-08-20T00:00:00.000Z")],
        routineSteps: [washStep()],
        planning: {
          status: "current",
          result: {
            derivedState: {
              stepPlacements: [
                {
                  stepId: "wash",
                  anchorKind: "commitment",
                  anchorId: "work",
                  placedStartAt: "2026-08-19T09:00:00.000Z",
                  placedEndAt: "2026-08-19T09:05:00.000Z",
                  bandId: "evening"
                }
              ]
            }
          }
        } as NonNullable<PortalState["planning"]>
      })
    });
    const washItem = withBand.items.find((item) => item.entityId === "wash" && !item.window)!;
    expect(washItem.subtitle).toContain("Evening slot");

    const noFit = build({
      state: baseState({
        commitments: [commitment("work", "2026-08-19T23:00:00.000Z", "2026-08-20T00:00:00.000Z")],
        routineSteps: [washStep()]
        // No matching stepPlacements entry at all: the step names bands but landed in none.
      })
    });
    const noFitItem = noFit.items.find((item) => item.entityId === "wash" && !item.window)!;
    expect(noFitItem.subtitle).toContain("No Evening slot fits · latest slot");
  });

  it("draws a can-start window when a flexible step's earliestAt is before its placed start", () => {
    const plan = build({
      state: baseState({
        commitments: [commitment("work", "2026-08-19T23:00:00.000Z", "2026-08-20T00:00:00.000Z")],
        routineSteps: [washStep()],
        planning: {
          status: "current",
          result: {
            derivedState: {
              stepPlacements: [
                {
                  stepId: "wash",
                  anchorKind: "commitment",
                  anchorId: "work",
                  placedStartAt: "2026-08-19T09:00:00.000Z",
                  placedEndAt: "2026-08-19T09:05:00.000Z",
                  earliestAt: "2026-08-19T05:00:00.000Z",
                  bandId: "evening"
                }
              ]
            }
          }
        } as NonNullable<PortalState["planning"]>
      })
    });
    const window = plan.items.find((item) => item.entityId === "wash" && item.window)!;
    expect(window).toBeDefined();
    expect(window.startsAt).toEqual(at("2026-08-19T05:00:00.000Z"));
    expect(window.endsAt).toEqual(at("2026-08-19T09:00:00.000Z"));
    expect(window.title).toContain("Can start from");
  });

  it("marks a pending step's start-by marker soon or missed, from startByWarnings", () => {
    const step = washStep({
      scheduledStartAt: "2026-08-19T09:00:00.000Z",
      scheduledEndAt: "2026-08-19T09:05:00.000Z"
    });
    const plan = build({
      state: baseState({
        commitments: [commitment("work", "2026-08-19T23:00:00.000Z", "2026-08-20T00:00:00.000Z")],
        routineSteps: [step],
        planning: {
          status: "current",
          result: {
            derivedState: {
              stepPlacements: [
                {
                  stepId: "wash",
                  anchorKind: "commitment",
                  anchorId: "work",
                  placedStartAt: "2026-08-19T09:00:00.000Z",
                  placedEndAt: "2026-08-19T09:05:00.000Z",
                  startBy: "2026-08-19T10:00:00.000Z"
                }
              ]
            },
            startByWarnings: [
              {
                stepId: "wash",
                anchorId: "work",
                anchorTitle: "Work",
                title: "Wash",
                startBy: "2026-08-19T10:00:00.000Z",
                status: "soon"
              }
            ]
          }
        } as NonNullable<PortalState["planning"]>
      })
    });
    const marker = plan.items.find((item) => item.kind === "start_by")!;
    expect(marker.title).toBe("Start Wash by 8:00 pm");
    expect(marker.urgency).toBe("soon");
  });

  it("marks a pending step's start-by marker missed once its time has passed, with no startByWarnings entry needed", () => {
    // NOW is 2026-08-19T00:00:00.000Z; a startBy before it is missed regardless of what
    // startByWarnings says, the same rule the Now banner uses.
    const step = washStep({
      scheduledStartAt: "2026-08-18T22:30:00.000Z",
      scheduledEndAt: "2026-08-18T22:35:00.000Z"
    });
    const plan = build({
      state: baseState({
        commitments: [commitment("work", "2026-08-19T23:00:00.000Z", "2026-08-20T00:00:00.000Z")],
        routineSteps: [step],
        planning: {
          status: "current",
          result: {
            derivedState: {
              stepPlacements: [
                {
                  stepId: "wash",
                  anchorKind: "commitment",
                  anchorId: "work",
                  placedStartAt: "2026-08-18T22:30:00.000Z",
                  placedEndAt: "2026-08-18T22:35:00.000Z",
                  startBy: "2026-08-18T23:00:00.000Z"
                }
              ]
            }
          }
        } as NonNullable<PortalState["planning"]>
      })
    });
    const marker = plan.items.find((item) => item.kind === "start_by")!;
    expect(marker.urgency).toBe("missed");
  });

  it("collects waits from stepPlacements: running for a completed step, projected for a pending one, clipped to the day", () => {
    const plan = build({
      state: baseState({
        commitments: [commitment("work", "2026-08-19T23:00:00.000Z", "2026-08-20T00:00:00.000Z")],
        routineSteps: [
          washStep({ id: "wash-done", status: "completed", completedAt: "2026-08-19T09:05:00.000Z" }),
          washStep({ id: "wash-pending" })
        ],
        planning: {
          status: "current",
          result: {
            derivedState: {
              stepPlacements: [
                {
                  stepId: "wash-done",
                  anchorKind: "commitment",
                  anchorId: "work",
                  waitStartsAt: "2026-08-19T09:05:00.000Z",
                  waitEndsAt: "2026-08-19T10:35:00.000Z"
                },
                {
                  stepId: "wash-pending",
                  anchorKind: "commitment",
                  anchorId: "work",
                  placedStartAt: "2026-08-19T09:00:00.000Z",
                  placedEndAt: "2026-08-19T09:05:00.000Z",
                  waitStartsAt: "2026-08-19T09:05:00.000Z",
                  waitEndsAt: "2026-08-19T10:35:00.000Z"
                }
              ]
            }
          }
        } as NonNullable<PortalState["planning"]>
      })
    });
    expect(plan.waits).toHaveLength(2);
    const running = plan.waits.find((wait) => wait.stepId === "wash-done")!;
    expect(running.running).toBe(true);
    const projected = plan.waits.find((wait) => wait.stepId === "wash-pending")!;
    expect(projected.running).toBe(false);
    expect(plan.waits.every((wait) => wait.startsAt >= plan.bounds.startsAt && wait.endsAt <= plan.bounds.endsAt)).toBe(
      true
    );
  });

  it("never occupies a column of the timed lane: a wait is not among `items`", () => {
    const plan = build({
      state: baseState({
        commitments: [commitment("work", "2026-08-19T23:00:00.000Z", "2026-08-20T00:00:00.000Z")],
        routineSteps: [washStep({ id: "wash-done", status: "completed", completedAt: "2026-08-19T09:05:00.000Z" })],
        planning: {
          status: "current",
          result: {
            derivedState: {
              stepPlacements: [
                {
                  stepId: "wash-done",
                  anchorKind: "commitment",
                  anchorId: "work",
                  waitStartsAt: "2026-08-19T09:05:00.000Z",
                  waitEndsAt: "2026-08-19T10:35:00.000Z"
                }
              ]
            }
          }
        } as NonNullable<PortalState["planning"]>
      })
    });
    expect(plan.waits).toHaveLength(1);
    expect(plan.items.some((item) => item.id.startsWith("wait:"))).toBe(false);
  });

  it("caps the waits strip at two sub-columns: a third overlapping wait folds into 'N waits'", () => {
    const waitOf = (stepId: string, startsAt: string, endsAt: string) => ({
      stepId,
      anchorKind: "commitment" as const,
      anchorId: "work",
      waitStartsAt: startsAt,
      waitEndsAt: endsAt
    });
    const plan = build({
      state: baseState({
        commitments: [commitment("work", "2026-08-19T23:00:00.000Z", "2026-08-20T00:00:00.000Z")],
        routineSteps: [
          washStep({ id: "wash-a", status: "completed", completedAt: "2026-08-19T09:00:00.000Z" }),
          washStep({ id: "wash-b" }),
          washStep({ id: "wash-c" })
        ],
        planning: {
          status: "current",
          result: {
            derivedState: {
              stepPlacements: [
                // a and b overlap; c then overlaps both, so c folds into whichever of a/b ends first (a).
                waitOf("wash-a", "2026-08-19T09:00:00.000Z", "2026-08-19T10:40:00.000Z"),
                waitOf("wash-b", "2026-08-19T09:10:00.000Z", "2026-08-19T10:50:00.000Z"),
                waitOf("wash-c", "2026-08-19T09:20:00.000Z", "2026-08-19T11:00:00.000Z")
              ]
            }
          }
        } as NonNullable<PortalState["planning"]>
      })
    });
    // Never more than two segments at once, regardless of how many waits overlap.
    expect(plan.waits).toHaveLength(2);
    const fold = plan.waits.find((wait) => wait.foldedCount);
    const plain = plan.waits.find((wait) => !wait.foldedCount);
    expect(fold).toBeDefined();
    expect(plain).toBeDefined();
    // The fold absorbed the earliest-ending slot's occupant (a) and the third overlap (c).
    expect(fold!.foldedCount).toBe(2);
    expect(fold!.stepId).toBe("wash-a");
    expect(fold!.title).toBe("2 waits");
    expect(fold!.endsAt).toEqual(new Date("2026-08-19T11:00:00.000Z"));
    // b never folded: it kept its own segment.
    expect(plain!.stepId).toBe("wash-b");
    expect(plain!.foldedCount).toBeUndefined();
  });

  it("soft placements land only in `reserved`, only from now, never in allocations or untimed", () => {
    const plan = build({
      state: baseState({
        actions: [{ ...createSeedState(NOW).actions[0], id: "gym", title: "Gym", projectId: "p1" } as never],
        planning: {
          status: "current",
          result: {
            softPlacements: [
              // Before now: entirely dropped.
              {
                actionId: "gym",
                startsAt: "2026-08-18T23:00:00.000Z",
                endsAt: "2026-08-18T23:30:00.000Z",
                minutes: 30
              },
              { actionId: "gym", startsAt: "2026-08-19T02:00:00.000Z", endsAt: "2026-08-19T02:30:00.000Z", minutes: 30 }
            ],
            weekOutlook: { cadence: { actions: [{ actionId: "gym", expectedOccurrences: 3, fittingOccurrences: 2 }] } }
          }
        } as unknown as NonNullable<PortalState["planning"]>
      })
    });
    const softItems = plan.reserved.filter((item) => item.kind === "soft");
    expect(softItems).toHaveLength(1);
    expect(softItems[0]!.subtitle).toBe("2 of 3 fit this week");
    expect(plan.items.some((item) => item.kind === "soft")).toBe(false);
    expect(plan.untimed.some((item) => item.id.includes("gym"))).toBe(false);
  });

  // portal-consistency half: a cadence-gated-out step with no prior persisted row is dropped
  // from the engine's own derived list entirely now — there is no `skippedStepIds` array
  // for this canvas to filter against; the gated-out step simply never becomes a row to draw, and the
  // remaining steps' own `scheduledStartAt`/`scheduledEndAt` already lay out contiguously around it.
  it("never sees a cadence-gated-out step at all, and draws the remaining steps contiguously", () => {
    const plan = build({
      state: baseState({
        routineSteps: [
          {
            id: "stretch",
            version: 1,
            anchorType: "sleep_plan",
            anchorId: "this-morning",
            purpose: "wake",
            title: "Stretch",
            durationMinutes: 10,
            sequence: 0,
            timingRule: "contiguous",
            energy: "low",
            contexts: [],
            dependencyIds: [],
            phase: "before",
            status: "pending",
            scheduledStartAt: "2026-08-19T05:00:00.000Z",
            scheduledEndAt: "2026-08-19T05:10:00.000Z"
          },
          {
            id: "shower",
            version: 1,
            anchorType: "sleep_plan",
            anchorId: "this-morning",
            purpose: "wake",
            title: "Shower",
            durationMinutes: 15,
            sequence: 2,
            timingRule: "contiguous",
            energy: "low",
            contexts: [],
            dependencyIds: [],
            phase: "after",
            status: "pending",
            // 05:10, not 05:20 — "piano" reserved none of this window; there is no gap to lay out around.
            scheduledStartAt: "2026-08-19T05:10:00.000Z",
            scheduledEndAt: "2026-08-19T05:25:00.000Z"
          }
        ]
      })
    });
    const steps = plan.items.filter((item) => item.kind === "routine_step" && item.parentId === "this-morning");
    expect(steps.map((item) => item.title)).toEqual(["Stretch", "Shower"]);
    expect(steps[0]!.endsAt).toEqual(steps[1]!.startsAt);
  });

  it("drops a completed or skipped bedtime step, leaving its recorded session to say it happened", () => {
    expect(
      build({ state: baseState({ routineSteps: [bedtimeStep({ status: "pending" })] }) }).items.filter(
        (item) => item.kind === "routine_step" && item.parentId === "tonight"
      )
    ).toHaveLength(1);
    expect(
      build({ state: baseState({ routineSteps: [bedtimeStep({ status: "completed" })] }) }).items.filter(
        (item) => item.kind === "routine_step" && item.parentId === "tonight"
      )
    ).toHaveLength(0);
  });

  it("outlines recurring windows on the day unless a routine already covers them", () => {
    const state = baseState();
    const action = state.actions[0]!;
    const plan = build({
      state: {
        ...state,
        occurrences: [
          {
            id: "occ-1",
            actionId: action.id,
            recurrenceRuleId: "rule",
            windowId: "morning",
            windowName: "Morning",
            localDate: DAY,
            windowStartsAt: "2026-08-18T21:00:00.000Z",
            windowEndsAt: "2026-08-18T22:00:00.000Z",
            anchorSource: "preferred_wake",
            status: "pending"
          },
          {
            id: "occ-2",
            actionId: action.id,
            recurrenceRuleId: "rule",
            windowId: "night",
            windowName: "Night",
            localDate: DAY,
            windowStartsAt: "2026-08-19T11:00:00.000Z",
            windowEndsAt: "2026-08-19T11:30:00.000Z",
            anchorSource: "planned_sleep",
            status: "pending",
            routineCovered: true
          }
        ]
      }
    });
    const windows = plan.items.filter((item) => item.kind === "occurrence");
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ entityId: "occ-1", parentId: action.id, window: true, title: action.title });
    expect(windows[0]!.subtitle).toBe("Morning window · pending");
    expect(windows[0]!.coveredBy).toBeUndefined();
  });

  it("names the routine step a window is linked to, so the two do not read as separate demands", () => {
    const state = baseState();
    const action = state.actions[0]!;
    const preset = (status: "active" | "archived") => ({
      id: "bed",
      name: "Bedtime",
      activityName: "Wind down",
      status,
      replacesWakeRoutine: false,
      steps: [
        {
          id: "teeth",
          title: "Brush teeth",
          durationMinutes: 10,
          sequence: 0,
          timingRule: "contiguous" as const,
          energy: "low" as const,
          contexts: [],
          dependencyIds: [],
          phase: "before" as const,
          actionWindowId: "morning"
        }
      ]
    });
    const occurrence = {
      id: "occ-1",
      actionId: action.id,
      recurrenceRuleId: "rule",
      windowId: "morning",
      windowName: "Morning",
      localDate: DAY,
      windowStartsAt: "2026-08-18T21:00:00.000Z",
      windowEndsAt: "2026-08-18T22:00:00.000Z",
      anchorSource: "preferred_wake" as const,
      status: "pending" as const
    };
    const linked = build({ state: { ...state, occurrences: [occurrence], routinePresets: [preset("active")] } });
    const window = linked.items.find((item) => item.kind === "occurrence")!;
    expect(window.coveredBy).toBe("Brush teeth · Wind down");
    expect(window.subtitle).toBe("Morning window · covered by Brush teeth · Wind down");
    // An archived tile is not a claim on today, so the window is back to standing on its own.
    const archived = build({ state: { ...state, occurrences: [occurrence], routinePresets: [preset("archived")] } });
    expect(archived.items.find((item) => item.kind === "occurrence")!.subtitle).toBe("Morning window · pending");
  });

  it("names the commitment preparation step a window is linked to", () => {
    const state = baseState();
    const action = state.actions[0]!;
    const plan = build({
      state: {
        ...state,
        commitments: [commitment("work", "2026-08-19T04:00:00.000Z", "2026-08-19T06:00:00.000Z")],
        routineSteps: [
          {
            id: "teeth",
            commitmentId: "work",
            anchorType: "commitment",
            title: "Brush Teeth",
            durationMinutes: 10,
            sequence: 0,
            timingRule: "contiguous",
            energy: "low",
            contexts: [],
            dependencyIds: [],
            phase: "before",
            status: "pending",
            actionWindowId: "morning",
            scheduledStartAt: "2026-08-19T03:50:00.000Z",
            scheduledEndAt: "2026-08-19T04:00:00.000Z"
          }
        ],
        occurrences: [
          {
            id: "occ-1",
            actionId: action.id,
            recurrenceRuleId: "rule",
            windowId: "morning",
            windowName: "Morning",
            localDate: DAY,
            windowStartsAt: "2026-08-18T21:00:00.000Z",
            windowEndsAt: "2026-08-18T22:00:00.000Z",
            anchorSource: "preferred_wake",
            status: "pending"
          }
        ]
      }
    });
    const window = plan.items.find((item) => item.kind === "occurrence")!;
    expect(window.coveredBy).toBe("Brush Teeth · Commitment work");
    expect(window.subtitle).toBe("Morning window · covered by Brush Teeth · Commitment work");
  });

  it("records finished sessions and the running one as recorded facts", () => {
    const plan = build({
      state: baseState({
        completedToday: [
          {
            id: "s1",
            actionId: "a1",
            actionTitle: "Draft the report",
            result: "completed",
            startedAt: "2026-08-18T22:00:00.000Z",
            endedAt: "2026-08-18T22:45:00.000Z",
            plannedMinutes: 45,
            activeMinutes: 42,
            remainingBeforeMinutes: 60,
            remainingAfterMinutes: 0
          }
        ],
        activeSession: {
          id: "run",
          actionId: "a2",
          status: "running",
          targetTitle: "Read chapter 3",
          startedAt: "2026-08-18T23:40:00.000Z",
          plannedEndAt: "2026-08-19T00:20:00.000Z",
          plannedMinutes: 40,
          remainingBeforeMinutes: 90,
          activeElapsedSeconds: 1200
        }
      })
    });
    const session = plan.items.find((item) => item.kind === "session")!;
    expect(session).toMatchObject({
      source: "recorded",
      title: "Draft the report",
      subtitle: "Completed · 42 active min"
    });
    const running = plan.items.find((item) => item.kind === "active_session")!;
    expect(running).toMatchObject({
      source: "recorded",
      title: "Read chapter 3",
      subtitle: "Running now",
      startsAt: at("2026-08-18T23:40:00.000Z"),
      endsAt: at("2026-08-19T00:20:00.000Z")
    });
  });

  it("draws time tracked against a commitment on the commitment, over both spans, once", () => {
    const plan = build({
      state: baseState({
        commitments: [
          commitment("work", "2026-08-18T20:00:00.000Z", "2026-08-18T23:00:00.000Z", {
            title: "Work",
            location: "Harbor Mart - Riverside"
          })
        ],
        completedToday: [
          {
            id: "s1",
            actionId: "work",
            actionTitle: "Work",
            targetType: "fixed_commitment",
            result: "completed",
            startedAt: "2026-08-18T19:52:00.000Z",
            endedAt: "2026-08-18T23:50:00.000Z",
            plannedMinutes: 180,
            activeMinutes: 237,
            remainingBeforeMinutes: 0,
            remainingAfterMinutes: 0
          }
        ]
      })
    });
    expect(plan.items.filter((item) => item.title === "Work")).toHaveLength(1);
    expect(plan.items.find((item) => item.kind === "commitment")).toMatchObject({
      source: "recorded",
      subtitle: "Harbor Mart - Riverside · Completed · 237 active min",
      startsAt: at("2026-08-18T19:52:00.000Z"),
      endsAt: at("2026-08-18T23:50:00.000Z"),
      minutes: 237,
      wallMinutes: 238
    });
    expect(plan.items.some((item) => item.kind === "session")).toBe(false);
  });

  it("keeps a short session inside a long commitment from shrinking it, and leaves other sessions alone", () => {
    const plan = build({
      state: baseState({
        commitments: [commitment("work", "2026-08-18T20:00:00.000Z", "2026-08-18T23:00:00.000Z")],
        completedToday: [
          {
            id: "s1",
            actionId: "work",
            actionTitle: "Commitment work",
            targetType: "fixed_commitment",
            result: "stopped",
            startedAt: "2026-08-18T21:00:00.000Z",
            endedAt: "2026-08-18T21:10:00.000Z",
            plannedMinutes: 10,
            activeMinutes: 10,
            remainingBeforeMinutes: 0,
            remainingAfterMinutes: 0
          },
          {
            id: "s2",
            actionId: "a1",
            actionTitle: "Draft the report",
            result: "completed",
            startedAt: "2026-08-19T01:00:00.000Z",
            endedAt: "2026-08-19T01:30:00.000Z",
            plannedMinutes: 30,
            activeMinutes: 30,
            remainingBeforeMinutes: 30,
            remainingAfterMinutes: 0
          }
        ]
      })
    });
    expect(plan.items.find((item) => item.kind === "commitment")).toMatchObject({
      startsAt: at("2026-08-18T20:00:00.000Z"),
      endsAt: at("2026-08-18T23:00:00.000Z"),
      subtitle: "Stopped · 10 active min"
    });
    expect(plan.items.filter((item) => item.kind === "session").map((item) => item.entityId)).toEqual(["s2"]);
  });

  it("draws a running commitment session as the commitment, reaching to the later of its end and now", () => {
    const plan = build({
      state: baseState({
        commitments: [commitment("work", "2026-08-18T23:00:00.000Z", "2026-08-19T02:00:00.000Z")],
        activeSession: {
          id: "run",
          actionId: "work",
          targetType: "fixed_commitment",
          targetId: "work",
          status: "running",
          targetTitle: "Commitment work",
          startedAt: "2026-08-18T23:05:00.000Z",
          plannedEndAt: "2026-08-19T02:00:00.000Z",
          plannedMinutes: 175,
          remainingBeforeMinutes: 175,
          activeElapsedSeconds: 3300
        }
      })
    });
    expect(plan.items.some((item) => item.kind === "active_session")).toBe(false);
    expect(plan.items.find((item) => item.kind === "commitment")).toMatchObject({
      source: "recorded",
      subtitle: "Running now · 55 active min",
      startsAt: at("2026-08-18T23:00:00.000Z"),
      endsAt: at("2026-08-19T02:00:00.000Z")
    });
  });

  it("leaves a commitment session drawn as a session when the commitment itself is not on this day", () => {
    const plan = build({
      state: baseState({
        commitments: [commitment("work", "2026-08-20T00:00:00.000Z", "2026-08-20T01:00:00.000Z")],
        completedToday: [
          {
            id: "s1",
            actionId: "work",
            actionTitle: "Work",
            targetType: "fixed_commitment",
            result: "completed",
            startedAt: "2026-08-19T01:00:00.000Z",
            endedAt: "2026-08-19T01:30:00.000Z",
            plannedMinutes: 30,
            activeMinutes: 30,
            remainingBeforeMinutes: 0,
            remainingAfterMinutes: 0
          }
        ]
      })
    });
    expect(plan.items.map((item) => item.kind)).toEqual(["session"]);
  });

  it("draws the current directive from now for its wall-clock length, and never when a session is running", () => {
    const recommendation = {
      primary: { recommendedMinutes: 45, recommendedWallClockMinutes: 60 }
    } as unknown as ClientRecommendation;
    const directive = { kind: "action" as const, targetId: "a1", title: "Write the intro", recommendedMinutes: 45 };
    const plan = build({ recommendation, currentDirective: directive });
    const block = plan.items.find((item) => item.kind === "directive")!;
    expect(block).toMatchObject({
      source: "engine",
      title: "Write the intro",
      subtitle: "Planned now · 45 focused min over 60",
      startsAt: NOW,
      endsAt: at("2026-08-19T01:00:00.000Z"),
      stale: false,
      minutes: 45
    });
    const withSession = build({
      recommendation,
      currentDirective: directive,
      state: baseState({
        activeSession: {
          id: "run",
          actionId: "a1",
          status: "running",
          startedAt: "2026-08-18T23:40:00.000Z",
          plannedEndAt: "2026-08-19T00:20:00.000Z",
          plannedMinutes: 40,
          remainingBeforeMinutes: 90,
          activeElapsedSeconds: 1200
        }
      })
    });
    expect(withSession.items.find((item) => item.kind === "directive")).toBeUndefined();
    // On another day there is no "now" to draw it from.
    expect(build({ recommendation, currentDirective: directive, dayKey: "2026-08-20" }).items).toHaveLength(0);
  });

  it("marks a boundary directive's boundary and its next fit, and greys engine items when the plan is stale", () => {
    const plan = build({
      state: baseState({ planning: { status: "stale" } }),
      currentDirective: {
        kind: "boundary",
        title: "Nothing fits before dinner",
        recommendedMinutes: 0,
        boundaryAt: "2026-08-19T08:00:00.000Z",
        boundaryKind: "commitment",
        boundaryTitle: "Dinner",
        nextFit: {
          kind: "action",
          targetId: "a9",
          title: "Reconcile receipts",
          recommendedMinutes: 30,
          at: "2026-08-19T09:00:00.000Z"
        }
      }
    });
    expect(plan.lines.find((line) => line.kind === "boundary")).toMatchObject({
      at: at("2026-08-19T08:00:00.000Z"),
      label: "Dinner"
    });
    const marker = plan.items.find((item) => item.kind === "next_fit")!;
    expect(marker).toMatchObject({
      marker: true,
      source: "engine",
      title: "Next fit: Reconcile receipts",
      startsAt: at("2026-08-19T09:00:00.000Z"),
      stale: true
    });
  });

  it("turns upcoming directives into untimed chips rather than timed blocks", () => {
    const plan = build({
      upcomingDirectives: [
        { kind: "action", targetId: "a2", title: "Read chapter 3", recommendedMinutes: 30 },
        { kind: "commitment", targetId: "dinner", title: "Dinner", recommendedMinutes: 60 }
      ]
    });
    expect(plan.items).toHaveLength(0);
    expect(plan.untimed.map((chip) => [chip.kind, chip.title, chip.minutes])).toEqual([
      ["action", "Read chapter 3", 30],
      ["commitment", "Dinner", 60]
    ]);
  });

  it("merges the engine's slots into availability bands from the calculation time forward", () => {
    const slot = (start: string, end: string, availability: ClientSlot["availability"]): ClientSlot => ({
      id: start,
      startsAt: at(start),
      endsAt: at(end),
      availability,
      energy: "medium",
      capacityMinutes: availability === "free" ? 15 : 0
    });
    const plan = build({
      slots: [
        slot("2026-08-19T00:00:00.000Z", "2026-08-19T00:15:00.000Z", "free"),
        slot("2026-08-19T00:15:00.000Z", "2026-08-19T00:30:00.000Z", "free"),
        slot("2026-08-19T00:30:00.000Z", "2026-08-19T00:45:00.000Z", "fixed"),
        slot("2026-08-19T00:45:00.000Z", "2026-08-19T01:00:00.000Z", "free"),
        slot("2026-08-19T13:45:00.000Z", "2026-08-19T14:15:00.000Z", "unavailable"),
        slot("2026-08-20T01:00:00.000Z", "2026-08-20T01:15:00.000Z", "free")
      ]
    });
    const bands = plan.backgrounds.filter((band) => band.kind !== "elapsed");
    expect(bands.map((band) => [band.kind, band.startsAt.toISOString(), band.endsAt.toISOString()])).toEqual([
      ["free", "2026-08-19T00:00:00.000Z", "2026-08-19T00:30:00.000Z"],
      ["fixed", "2026-08-19T00:30:00.000Z", "2026-08-19T00:45:00.000Z"],
      ["free", "2026-08-19T00:45:00.000Z", "2026-08-19T01:00:00.000Z"],
      ["unavailable", "2026-08-19T13:45:00.000Z", "2026-08-19T14:00:00.000Z"]
    ]);
  });

  it("keeps latest-safe reservations apart from the plan, merged and labelled by their deadline", () => {
    const state = baseState();
    const action = state.actions[0]!;
    const allocation = (start: string, end: string, actionId = action.id): ClientAllocation => ({
      actionId,
      projectId: action.projectId,
      slotId: start,
      startsAt: at(start),
      endsAt: at(end),
      minutes: 15
    });
    const plan = build({
      state: { ...state, actions: [{ ...action, deadlineAt: "2026-08-21T06:00:00.000Z" }] },
      allocations: [
        allocation("2026-08-19T05:00:00.000Z", "2026-08-19T05:15:00.000Z"),
        allocation("2026-08-19T05:15:00.000Z", "2026-08-19T05:30:00.000Z"),
        allocation("2026-08-19T07:00:00.000Z", "2026-08-19T07:15:00.000Z", "deliverable:missing")
      ]
    });
    expect(plan.items).toHaveLength(0);
    expect(plan.reserved).toHaveLength(2);
    expect(plan.reserved[0]).toMatchObject({
      kind: "reserved",
      source: "reserved",
      title: action.title,
      subtitle: "Reserved by deadline",
      deadlineAt: at("2026-08-21T06:00:00.000Z"),
      startsAt: at("2026-08-19T05:00:00.000Z"),
      endsAt: at("2026-08-19T05:30:00.000Z"),
      minutes: 30
    });
    expect(plan.reserved[1]).toMatchObject({ title: "Deliverable", subtitle: "Reserved" });
  });

  it("draws the engine's projected day: block 0 as the directive, later work as projections", () => {
    const plan = build({
      currentDirective: { kind: "action", targetId: "a1", title: "Write the intro", recommendedMinutes: 45 },
      dayPlan: enginePlan([
        workBlock("2026-08-19T00:00:00.000Z", "2026-08-19T01:00:00.000Z", "a1", {
          title: "Write the intro",
          focusedMinutes: 45,
          confidence: "firm",
          tier: "behind_external",
          reason: "Behind its external deadline."
        }),
        engineBlock({
          startsAt: "2026-08-19T01:00:00.000Z",
          endsAt: "2026-08-19T01:30:00.000Z",
          kind: "gap",
          title: "Nothing fits before the dentist",
          gapKind: "boundary",
          boundaryKind: "commitment",
          wallClockMinutes: 30
        }),
        engineBlock({
          startsAt: "2026-08-19T01:30:00.000Z",
          endsAt: "2026-08-19T02:30:00.000Z",
          kind: "commitment",
          targetId: "dentist",
          title: "Dentist",
          confidence: "firm",
          wallClockMinutes: 60
        }),
        engineBlock({
          startsAt: "2026-08-19T02:30:00.000Z",
          endsAt: "2026-08-19T03:30:00.000Z",
          kind: "deliverable",
          targetId: "d1",
          title: "Ship the deck",
          projectId: "p2",
          focusedMinutes: 45,
          wallClockMinutes: 60,
          tier: "at_risk_internal",
          reason: "Its margin is thin."
        })
      ])
    });
    // The commitment block is skipped: a commitment is drawn from the stored commitment, once.
    expect(plan.items.map((item) => [item.kind, item.id])).toEqual([
      ["directive", "directive:action:a1"],
      ["planned", "plan:d1:2026-08-19T02:30:00.000Z"]
    ]);
    expect(plan.items[0]).toMatchObject({
      source: "engine",
      title: "Write the intro",
      subtitle: "Planned now · 45 focused min over 60 · Behind · external deadline",
      entityId: "a1",
      parentId: "p1",
      minutes: 45,
      wallMinutes: 60,
      tier: "Behind · external deadline",
      reason: "Behind its external deadline.",
      projected: false,
      startsAt: NOW,
      endsAt: at("2026-08-19T01:00:00.000Z")
    });
    expect(plan.items[1]).toMatchObject({
      kind: "planned",
      source: "engine",
      title: "Ship the deck",
      subtitle: "45 focused min over 60 · At risk · self-set deadline",
      entityId: "d1",
      parentId: "p2",
      projected: true,
      reason: "Its margin is thin."
    });
    // A gap is a light label, never a block.
    expect(plan.lines.filter((line) => line.kind === "gap")).toEqual([
      {
        id: "gap:2026-08-19T01:00:00.000Z",
        kind: "gap",
        at: at("2026-08-19T01:00:00.000Z"),
        label: "Nothing fits · Nothing fits before the dentist"
      }
    ]);
  });

  it("draws a leg as its own block in wall clock, names what it is for, and only claims a source for the live one", () => {
    const plan = build({
      state: baseState({
        commitments: [
          commitment("assessment", "2026-08-19T01:00:00.000Z", "2026-08-19T02:30:00.000Z", { title: "Assessment 2" })
        ]
      }),
      currentDirective: {
        kind: "travel",
        toLocationId: "ctx-campus",
        title: "Drive to Campus",
        recommendedMinutes: 18,
        mode: "car",
        source: "measured",
        // oxlint-disable-next-line unicorn/no-thenable -- `then` is a domain field of the travel directive, not a promise continuation
        then: { kind: "commitment", targetId: "assessment", title: "Assessment 2", recommendedMinutes: 90 }
      },
      dayPlan: enginePlan([
        engineBlock({
          startsAt: "2026-08-19T00:00:00.000Z",
          endsAt: "2026-08-19T00:18:00.000Z",
          kind: "travel",
          targetId: "assessment",
          title: "Drive to Campus",
          toLocationId: "ctx-campus",
          mode: "car",
          wallClockMinutes: 18,
          confidence: "firm",
          reason: "The journey is protected like the commitment's buffer."
        }),
        engineBlock({
          startsAt: "2026-08-19T02:30:00.000Z",
          endsAt: "2026-08-19T02:55:00.000Z",
          kind: "travel",
          targetId: null,
          title: "Drive home",
          toLocationId: "ctx-home",
          wallClockMinutes: 25,
          reason: "Nothing else is at Campus today."
        })
      ])
    });
    const legs = plan.items.filter((item) => item.kind === "travel");
    expect(legs.map((item) => item.id)).toEqual([
      "directive:travel:ctx-campus",
      "plan:travel:2026-08-19T02:30:00.000Z"
    ]);
    expect(legs[0]).toMatchObject({
      source: "engine",
      title: "Drive to Campus",
      subtitle: "18 min · then Assessment 2",
      entityId: "ctx-campus",
      toLocationId: "ctx-campus",
      mode: "car",
      travelSource: "measured",
      thenTitle: "Assessment 2",
      // Nothing about a journey is focused work, so the one figure is the time it takes.
      minutes: 18,
      projected: false
    });
    expect(legs[0]!.wallMinutes).toBeUndefined();
    // A projected leg states its minutes but not their provenance, and none is invented for it.
    expect(legs[1]).toMatchObject({ title: "Drive home", subtitle: "25 min", projected: true });
    expect(legs[1]!.travelSource).toBeUndefined();
    expect(legs[1]!.thenTitle).toBeUndefined();
  });

  it("carries the projected location band across, clipped to the day, and leaves it empty without one", () => {
    const plan = build({
      dayPlan: enginePlan([workBlock("2026-08-19T00:00:00.000Z", "2026-08-19T01:00:00.000Z", "a1")], {
        locations: [
          {
            startsAt: "2026-08-18T10:00:00.000Z",
            endsAt: "2026-08-19T03:30:00.000Z",
            locationId: "ctx-home",
            label: "Home"
          },
          {
            startsAt: "2026-08-19T03:30:00.000Z",
            endsAt: "2026-08-19T04:00:00.000Z",
            locationId: null,
            label: "In transit"
          },
          {
            startsAt: "2026-08-19T04:00:00.000Z",
            endsAt: "2026-08-19T20:00:00.000Z",
            locationId: "ctx-campus",
            label: "Campus"
          }
        ]
      })
    });
    expect(plan.locations.map((stay) => [stay.locationId, stay.label])).toEqual([
      ["ctx-home", "Home"],
      [null, "In transit"],
      ["ctx-campus", "Campus"]
    ]);
    // Parsed to dates and clipped to the day at both ends, like every other span on the canvas.
    expect(plan.locations[0]!.startsAt).toEqual(at("2026-08-18T14:00:00.000Z"));
    expect(plan.locations[0]!.endsAt).toEqual(at("2026-08-19T03:30:00.000Z"));
    expect(plan.locations[2]!.endsAt).toEqual(at("2026-08-19T14:00:00.000Z"));
    expect(build().locations).toEqual([]);
  });

  it("drops block 0 when a session is running, since the recorded session is the fact", () => {
    const dayPlan = enginePlan([
      workBlock("2026-08-19T00:00:00.000Z", "2026-08-19T01:00:00.000Z", "a1"),
      workBlock("2026-08-19T01:00:00.000Z", "2026-08-19T02:00:00.000Z", "a2")
    ]);
    const plan = build({
      dayPlan,
      state: baseState({
        activeSession: {
          id: "run",
          actionId: "a1",
          status: "running",
          targetTitle: "Work on a1",
          startedAt: "2026-08-18T23:40:00.000Z",
          plannedEndAt: "2026-08-19T00:20:00.000Z",
          plannedMinutes: 40,
          remainingBeforeMinutes: 90,
          activeElapsedSeconds: 1200
        }
      })
    });
    expect(plan.items.filter((item) => item.source === "engine").map((item) => item.id)).toEqual([
      "plan:a2:2026-08-19T01:00:00.000Z"
    ]);
    expect(plan.items.some((item) => item.kind === "active_session")).toBe(true);
  });

  it("clips a plan that began before now to now and drops what it placed entirely in the past", () => {
    const plan = build({
      dayPlan: enginePlan([
        workBlock("2026-08-18T23:00:00.000Z", "2026-08-18T23:30:00.000Z", "a0", { confidence: "firm" }),
        workBlock("2026-08-18T23:30:00.000Z", "2026-08-19T00:30:00.000Z", "a1"),
        workBlock("2026-08-19T00:30:00.000Z", "2026-08-19T01:30:00.000Z", "a2")
      ])
    });
    expect(plan.items.map((item) => [item.id, item.startsAt.toISOString(), item.endsAt.toISOString()])).toEqual([
      ["plan:a1:2026-08-18T23:30:00.000Z", "2026-08-19T00:00:00.000Z", "2026-08-19T00:30:00.000Z"],
      ["plan:a2:2026-08-19T00:30:00.000Z", "2026-08-19T00:30:00.000Z", "2026-08-19T01:30:00.000Z"]
    ]);
    // The key is the engine's own start, so clipping does not make the block look like a new one.
    expect(plan.items[0]!.minutes).toBe(60);
    expect(plan.items[0]!.wallMinutes).toBe(30);
  });

  it("merges contiguous sessions on one target and says how many they are", () => {
    const plan = build({
      dayPlan: enginePlan([
        engineBlock({
          startsAt: "2026-08-19T00:00:00.000Z",
          endsAt: "2026-08-19T00:10:00.000Z",
          kind: "gap",
          title: "Waiting on an answer",
          gapKind: "answer",
          confidence: "firm",
          wallClockMinutes: 10
        }),
        workBlock("2026-08-19T00:10:00.000Z", "2026-08-19T01:40:00.000Z", "a1"),
        workBlock("2026-08-19T01:40:00.000Z", "2026-08-19T03:10:00.000Z", "a1"),
        workBlock("2026-08-19T03:10:00.000Z", "2026-08-19T03:40:00.000Z", "a1"),
        // Separated by an hour, so the same target stays a second block.
        workBlock("2026-08-19T04:40:00.000Z", "2026-08-19T05:10:00.000Z", "a1")
      ])
    });
    // A ten-minute gap is the grain of the day, not news.
    expect(plan.lines.filter((line) => line.kind === "gap")).toHaveLength(0);
    expect(
      plan.items.map((item) => [item.id, item.subtitle, item.startsAt.toISOString(), item.endsAt.toISOString()])
    ).toEqual([
      [
        "plan:a1:2026-08-19T00:10:00.000Z",
        "210 focused min over 210 · 3 sessions",
        "2026-08-19T00:10:00.000Z",
        "2026-08-19T03:40:00.000Z"
      ],
      [
        "plan:a1:2026-08-19T04:40:00.000Z",
        "30 focused min over 30",
        "2026-08-19T04:40:00.000Z",
        "2026-08-19T05:10:00.000Z"
      ]
    ]);
  });

  it("carries displaced deadlines and marks the block that misses one", () => {
    const plan = build({
      dayPlan: enginePlan(
        [
          workBlock("2026-08-19T00:00:00.000Z", "2026-08-19T01:00:00.000Z", "a1", { confidence: "firm" }),
          workBlock("2026-08-19T01:00:00.000Z", "2026-08-19T02:00:00.000Z", "a2")
        ],
        {
          displaced: [
            {
              targetId: "a2",
              latestSafeStartAt: "2026-08-19T00:30:00.000Z",
              firstPlannedAt: "2026-08-19T01:00:00.000Z"
            }
          ]
        }
      )
    });
    expect(plan.displaced).toEqual([
      {
        targetId: "a2",
        latestSafeStartAt: at("2026-08-19T00:30:00.000Z"),
        firstPlannedAt: at("2026-08-19T01:00:00.000Z")
      }
    ]);
    expect(plan.items.find((item) => item.entityId === "a2")!.displaced).toBe(true);
    expect(plan.items.find((item) => item.entityId === "a1")!.displaced).toBeUndefined();
  });

  it("keeps chips for a result with no projected day, and greys a projected day that is stale", () => {
    const upcomingDirectives: DayPlanInput["upcomingDirectives"] = [
      { kind: "action", targetId: "a2", title: "Read chapter 3", recommendedMinutes: 30 }
    ];
    const directive = { kind: "action" as const, targetId: "a1", title: "Write the intro", recommendedMinutes: 45 };
    // No dayPlan: the older behaviour, one directive block and untimed chips.
    const fallback = build({ currentDirective: directive, upcomingDirectives });
    expect(fallback.items.map((item) => item.kind)).toEqual(["directive"]);
    expect(fallback.untimed.map((chip) => chip.title)).toEqual(["Read chapter 3"]);
    expect(fallback.calculatedAt).toBeNull();
    expect(fallback.displaced).toEqual([]);
    // With a projected day the same work is placed, so there is nothing left to leave untimed.
    const projected = build({
      state: baseState({ planning: { status: "stale" } }),
      currentDirective: directive,
      upcomingDirectives,
      dayPlan: enginePlan([
        workBlock("2026-08-19T00:00:00.000Z", "2026-08-19T01:00:00.000Z", "a1", { confidence: "firm" }),
        workBlock("2026-08-19T01:00:00.000Z", "2026-08-19T01:30:00.000Z", "a2", { title: "Read chapter 3" })
      ])
    });
    expect(projected.untimed).toEqual([]);
    expect(projected.items.map((item) => [item.kind, item.stale])).toEqual([
      ["directive", true],
      ["planned", true]
    ]);
    expect(projected.calculatedAt).toEqual(NOW);
  });

  it("leaves the next-fit marker to the plan when there is one, and draws it when there is not", () => {
    const directive = {
      kind: "boundary" as const,
      title: "Nothing fits before dinner",
      recommendedMinutes: 0 as const,
      boundaryAt: "2026-08-19T08:00:00.000Z",
      boundaryKind: "commitment" as const,
      nextFit: {
        kind: "action" as const,
        targetId: "a9",
        title: "Reconcile receipts",
        recommendedMinutes: 30,
        at: "2026-08-19T09:00:00.000Z"
      }
    };
    expect(build({ currentDirective: directive }).items.map((item) => item.kind)).toEqual(["next_fit"]);
    const withPlan = build({
      currentDirective: directive,
      dayPlan: enginePlan([
        engineBlock({
          startsAt: "2026-08-19T00:00:00.000Z",
          endsAt: "2026-08-19T09:00:00.000Z",
          kind: "gap",
          title: "Nothing fits before dinner",
          gapKind: "boundary",
          boundaryKind: "commitment",
          confidence: "firm",
          wallClockMinutes: 540
        }),
        workBlock("2026-08-19T09:00:00.000Z", "2026-08-19T09:30:00.000Z", "a9", { title: "Reconcile receipts" })
      ])
    });
    expect(withPlan.items.map((item) => item.kind)).toEqual(["planned"]);
    // The boundary the directive names is still drawn either way.
    expect(withPlan.lines.map((line) => line.kind)).toEqual(["gap", "boundary", "horizon"]);
  });

  it("orders items by start, then end, then kind, so the output is stable", () => {
    const plan = build({
      state: baseState({
        commitments: [
          commitment("b", "2026-08-19T04:00:00.000Z", "2026-08-19T05:00:00.000Z"),
          commitment("a", "2026-08-19T02:00:00.000Z", "2026-08-19T03:00:00.000Z")
        ],
        completedToday: [
          {
            id: "s",
            actionId: "x",
            actionTitle: "Early",
            result: "stopped",
            startedAt: "2026-08-19T02:00:00.000Z",
            endedAt: "2026-08-19T02:30:00.000Z",
            plannedMinutes: 30,
            activeMinutes: 30,
            remainingBeforeMinutes: 30,
            remainingAfterMinutes: 0
          }
        ]
      })
    });
    expect(plan.items.map((item) => item.id)).toEqual(["session:s", "commitment:a", "commitment:b"]);
  });
});

// The phone's scale: 48 px an hour against an 18 px minimum makes anything under 22.5 minutes
// inflated, which is the only kind of block a fold ever takes.
const PX_PER_HOUR = 48;
const MIN_PX = 18;

const step = (id: string, startMinute: number, minutes: number, overrides: Partial<DayPlanItem> = {}): DayPlanItem => ({
  id: `routine_step:${id}`,
  kind: "routine_step",
  source: "fixed",
  title: id,
  entityId: id,
  parentId: "college",
  groupTitle: "Before College",
  startsAt: new Date(NOW.getTime() + startMinute * 60_000),
  endsAt: new Date(NOW.getTime() + (startMinute + minutes) * 60_000),
  clippedStart: false,
  clippedEnd: false,
  ...overrides
});

const run = (
  count: number,
  minutes: number,
  gap = 0,
  overrides: (index: number) => Partial<DayPlanItem> = () => ({})
) => Array.from({ length: count }, (_, index) => step(`s${index}`, index * (minutes + gap), minutes, overrides(index)));

/** A block that belongs to nothing, which no fold may take. */
const orphan = (item: DayPlanItem): DayPlanItem => {
  const loose = { ...item };
  delete loose.parentId;
  return loose;
};

describe("groupCrampedRuns", () => {
  it("folds a run of three or more inflated blocks into one that spans the run and lists its members", () => {
    const folded = groupCrampedRuns(run(6, 5), PX_PER_HOUR, MIN_PX);
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({
      id: "group:routine_step:s0",
      kind: "routine_step",
      source: "fixed",
      title: "Before College · 6 steps",
      subtitle: "30 min",
      // The first member's own ids, so a tap opens the editor the run starts at.
      entityId: "s0",
      parentId: "college",
      grouped: true,
      minutes: 30,
      startsAt: NOW,
      endsAt: at("2026-08-19T00:30:00.000Z")
    });
    expect(folded[0]!.steps?.map((member) => member.title)).toEqual(["s0", "s1", "s2", "s3", "s4", "s5"]);
    expect(folded[0]!.steps?.[5]).toMatchObject({ startsAt: at("2026-08-19T00:25:00.000Z") });
  });

  it("leaves a pair alone: two blocks in a row still read as two blocks", () => {
    expect(groupCrampedRuns(run(2, 5), PX_PER_HOUR, MIN_PX).map((item) => item.id)).toEqual([
      "routine_step:s0",
      "routine_step:s1"
    ]);
  });

  it("keeps a gap too small to draw inside the run and breaks the run on one the reader could see", () => {
    // An 18 px block at 48 px an hour covers the 22.5 minutes below its own start, so steps closer
    // together than that cannot be drawn apart however much clock sits between them.
    expect(groupCrampedRuns(run(3, 5, 2), PX_PER_HOUR, MIN_PX)).toHaveLength(1);
    expect(groupCrampedRuns(run(3, 5, 10), PX_PER_HOUR, MIN_PX)).toHaveLength(1);
    expect(groupCrampedRuns(run(3, 5, 20), PX_PER_HOUR, MIN_PX)).toHaveLength(3);
  });

  it("never folds across a change of kind, source, or parent", () => {
    const mixedKind = [step("a", 0, 5), step("b", 5, 5, { kind: "occurrence" }), step("c", 10, 5)];
    expect(groupCrampedRuns(mixedKind, PX_PER_HOUR, MIN_PX)).toHaveLength(3);
    const mixedParent = [step("a", 0, 5), step("b", 5, 5, { parentId: "gym" }), step("c", 10, 5)];
    expect(groupCrampedRuns(mixedParent, PX_PER_HOUR, MIN_PX)).toHaveLength(3);
    const mixedSource = [step("a", 0, 5), step("b", 5, 5, { source: "engine" }), step("c", 10, 5)];
    expect(groupCrampedRuns(mixedSource, PX_PER_HOUR, MIN_PX)).toHaveLength(3);
  });

  it("folds a cramped run of recorded sessions across different actions into one named block", () => {
    const session = (id: string, startMinute: number, parentId: string) =>
      step(id, startMinute, 1, {
        id: `session:${id}`,
        kind: "session",
        source: "recorded",
        parentId
      });
    const folded = groupCrampedRuns(
      [session("a", 0, "bill"), session("b", 10, "gutters"), session("c", 20, "books")],
      PX_PER_HOUR,
      MIN_PX
    );
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({ title: "3 sessions", grouped: true });
    expect(folded[0]!.steps?.map((member) => member.title)).toEqual(["a", "b", "c"]);
  });

  it("leaves blocks that are drawn at their true length alone, however many of them run together", () => {
    expect(groupCrampedRuns(run(5, 30), PX_PER_HOUR, MIN_PX)).toHaveLength(5);
  });

  it("folds only a run drawn taller than it lasts, which is the boundary between cramped and merely short", () => {
    // Three 20-minute steps: 51.2 px of clock against 54 px of drawn block, so they cover each other.
    expect(groupCrampedRuns(run(3, 20, 2), PX_PER_HOUR, MIN_PX)).toHaveLength(1);
    // Three 22-minute steps: still inflated one by one, but the run has 56 px for 54 px of block.
    expect(groupCrampedRuns(run(3, 22, 2), PX_PER_HOUR, MIN_PX)).toHaveLength(3);
  });

  it("names a fold by its size when the members disagree about what the run is called", () => {
    const mixed = run(3, 5, 0, (index) => (index === 1 ? { groupTitle: "Before Gym" } : {}));
    expect(groupCrampedRuns(mixed, PX_PER_HOUR, MIN_PX)[0]).toMatchObject({ title: "3 quick blocks" });
  });

  it("keeps blocks that carry their own drawn detail, and blocks belonging to nothing, out of a fold", () => {
    const halos = run(3, 5, 0, () => ({ halos: [{ startsAt: NOW, endsAt: NOW }] }));
    expect(groupCrampedRuns(halos, PX_PER_HOUR, MIN_PX)).toHaveLength(3);
    const windows = run(3, 5, 0, () => ({ window: true }));
    expect(groupCrampedRuns(windows, PX_PER_HOUR, MIN_PX)).toHaveLength(3);
    expect(groupCrampedRuns(run(3, 5).map(orphan), PX_PER_HOUR, MIN_PX)).toHaveLength(3);
  });

  it("folds each run on its own and leaves everything around them in clock order", () => {
    const items = [
      ...run(3, 5),
      orphan(step("wide", 15, 90, { id: "commitment:college", kind: "commitment" })),
      step("late", 105, 5),
      step("later", 110, 5),
      step("latest", 115, 5)
    ];
    expect(groupCrampedRuns(items, PX_PER_HOUR, MIN_PX).map((item) => item.id)).toEqual([
      "group:routine_step:s0",
      "commitment:college",
      "group:routine_step:late"
    ]);
  });
});

describe("invariant 1: no commitment or step edge computed locally", () => {
  it("day-plan.ts no longer reads setupBeforeMinutes, transitionAfterMinutes or waitAfterMinutes", async () => {
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(new URL("./day-plan.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\.setupBeforeMinutes/);
    expect(source).not.toMatch(/\.transitionAfterMinutes/);
    expect(source).not.toMatch(/\.waitAfterMinutes/);
  });
});
