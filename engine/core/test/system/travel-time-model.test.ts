import { describe, expect, it } from "vitest";
import {
  PLAN_FORECAST_CONTRACT_VERSION,
  planForecastRequestSchema,
  portalStateSchema,
  type PlanForecastRequest,
  type PlanForecastResponse
} from "@openrhen/contracts";
import { calculatePlanAndForecast } from "../../src/index.js";
import { compactDayPlan } from "../model/day-plan-harness.js";
import leaveByAllowsForVariability from "../snapshot-replay/leave-by-allows-for-variability.json" with { type: "json" };

/**
 * The journey store end to end: the assumed origin, the
 * caution/lateness switch, mode precedence, travel off, and the two flags for a commitment with no
 * usable place. Each `it` here is one bullet of the plan's "Engine" testing line; `journey.test.ts`
 * (contracts) already covers the lookup's tiers and arithmetic in isolation, and `travel.ts`/
 * `situation-projection.ts` already have their own suites for the policy and the projection this
 * reuses — these tests hold only what only a whole request can prove.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** A Wednesday, so weekday bands agree with the fixture's commitments. */
const now = new Date("2026-08-19T00:00:00.000Z");
const iso = (offsetMs: number) => new Date(now.getTime() + offsetMs).toISOString();
/** No samples at all: the journey store's padding on top of a stored figure, rounded up. */
const padded = (minutes: number) => Math.ceil(minutes + Math.max(3, 0.15 * minutes));

interface CommitmentSpec {
  id: string;
  startHour: number;
  endHour: number;
  locationId?: string;
  location?: string;
  transitionAfterMinutes?: number;
  setupBeforeMinutes?: number;
  latenessMatters?: boolean;
  transportMode?: "car" | "bike" | "walk";
  attendance?: "in_person" | "remote";
  preferredLocationId?: string;
}

interface Shape {
  commitments?: CommitmentSpec[];
  travelMinutes?: Record<string, number>;
  usualTransportMode?: Record<string, "car" | "bike" | "walk">;
  transportModes?: Array<"car" | "bike" | "walk">;
  defaultTransportMode?: "car" | "bike" | "walk";
  locationId?: string | null;
  locationSetAtOffsetMs?: number;
  homeLocationId?: string | null;
  travelOff?: boolean;
  sleepPlans?: Array<{ id: string; plannedStartAt: string; plannedWakeAt: string }>;
  measured?: Record<string, { minutes: number; mode: "car" | "bike" | "walk" }>;
  /** An errand only worth doing at `at`, so a directed trip is possible at all when the origin allows. */
  errandAt?: string;
}

const LOCATIONS = ["home", "campus", "shops"];

function fixture(shape: Shape = {}): PlanForecastRequest {
  const travelMinutes = { campus: 30, shops: 10, ...shape.travelMinutes } as Record<string, number>;
  const usual = shape.usualTransportMode ?? {};
  const conditionDefinitions = LOCATIONS.map((id) => ({
    id,
    name: id,
    kind: "location" as const,
    status: "active" as const,
    grants: [],
    ...(travelMinutes[id] !== undefined ? { travelMinutes: travelMinutes[id] } : {}),
    ...(usual[id] ? { usualTransportMode: usual[id] } : {})
  }));
  const commitments = (shape.commitments ?? []).map((item) => ({
    id: item.id,
    title: item.id,
    status: "confirmed" as const,
    startsAt: iso(item.startHour * HOUR),
    endsAt: iso(item.endHour * HOUR),
    setupBeforeMinutes: item.setupBeforeMinutes ?? 0,
    transitionAfterMinutes: item.transitionAfterMinutes ?? 0,
    ...(item.locationId ? { locationId: item.locationId } : {}),
    ...(item.location ? { location: item.location } : {}),
    ...(item.latenessMatters !== undefined ? { latenessMatters: item.latenessMatters } : {}),
    ...(item.transportMode ? { transportMode: item.transportMode } : {}),
    ...(item.attendance ? { attendance: item.attendance } : {}),
    ...(item.preferredLocationId ? { preferredLocationId: item.preferredLocationId } : {})
  }));
  const homeLocationId = shape.homeLocationId === undefined ? "home" : shape.homeLocationId;
  const state = portalStateSchema.parse({
    settings: {
      timezone: "UTC",
      planningHorizonEnd: "22:00",
      defaultUsableFraction: 1,
      defaultSetupBufferMinutes: 0,
      defaultTransitionBufferMinutes: 0,
      submissionBufferMinutes: 0,
      submissionBufferPercent: 0,
      energyMeanings: { high: "high", medium: "medium", low: "low", recovery: "recovery" },
      estimateBucketsMinutes: [15, 30, 60],
      conditionCatalog: LOCATIONS,
      preferredBedtime: "23:00",
      preferredWakeTime: "07:00",
      desiredSleepMinutes: 480,
      minimumSleepMinutes: 420,
      maxAwakeHours: 16,
      lastWokeAt: iso(-1 * HOUR),
      ...(homeLocationId ? { homeLocationId } : {}),
      ...(shape.defaultTransportMode ? { defaultTransportMode: shape.defaultTransportMode } : {})
    },
    areas: [{ id: "area", name: "Everything", status: "active", sortOrder: 0 }],
    outcomes: [
      { id: "outcome", areaId: "area", title: "Outcome", definitionOfDone: "Done.", value: 3, status: "active" }
    ],
    projects: shape.errandAt
      ? [
          {
            id: "proj",
            title: "proj",
            area: "Everything",
            outcomeId: "outcome",
            status: "active" as const,
            uncertainty: "known" as const,
            value: 3,
            consequence: 3,
            internalDeadlineAt: iso(60 * DAY)
          }
        ]
      : [],
    actions: shape.errandAt
      ? [
          {
            id: "errand",
            projectId: "proj",
            title: "errand",
            status: "active" as const,
            optimisticMinutes: 30,
            expectedMinutes: 30,
            pessimisticMinutes: 30,
            remainingMinutes: 30,
            energy: "medium" as const,
            minimumSessionMinutes: 15,
            maximumSessionMinutes: 30,
            importance: 3,
            consequence: 3,
            contexts: [],
            requirementPathways: [{ id: "errand:at", contextIds: [shape.errandAt] }],
            dependencyIds: [],
            splittable: true,
            setupMinutes: 0
          }
        ]
      : [],
    commitments,
    conditionDefinitions,
    currentSituation: {
      locationId: shape.locationId === undefined ? "home" : shape.locationId,
      locationSetAt: iso(shape.locationSetAtOffsetMs ?? 0),
      transportModes: shape.transportModes ?? ["car"],
      ...(shape.travelOff !== undefined ? { travelOff: shape.travelOff } : {})
    },
    routineSteps: [],
    sleepPlans: shape.sleepPlans ?? [],
    captures: [],
    completedToday: [],
    assertedConditions: [],
    currentEnergy: "medium",
    horizonEnd: iso(30 * DAY),
    activeSession: null
  });
  const originId = shape.locationId === undefined ? "home" : shape.locationId;
  return planForecastRequestSchema.parse({
    contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
    requestId: "00000000-0000-4000-8000-00000000fe22",
    inputVersion: "travel-time-model-fixture",
    calculatedAt: now.toISOString(),
    horizonEnd: iso(30 * DAY),
    state,
    journeys: {
      cells: [],
      latest:
        originId === null
          ? []
          : Object.entries(shape.measured ?? {}).map(([id, item]) => ({
              fromLocationId: originId,
              toLocationId: id,
              mode: item.mode,
              minutes: item.minutes,
              departedAt: now.toISOString(),
              observedAt: now.toISOString()
            }))
    }
  });
}

const timelineFor = (response: PlanForecastResponse, id: string) =>
  (
    response.derivedState.commitmentTimelines as Array<{
      id: string;
      leaveBy?: string;
      arriveBy: string;
      journeyBefore?: {
        mode?: string;
        minutes: number;
        typicalMinutes: number;
        sampleCount: number;
        originAssumed?: boolean;
      };
      travelGap?: "no_place" | "no_estimate";
    }>
  ).find((item) => item.id === id)!;

describe("a remote commitment (CONTEXT.md 'Attendance')", () => {
  it("plans no travel to it and no leave-by, even when it names a place", () => {
    const inPerson = calculatePlanAndForecast(
      fixture({ commitments: [{ id: "class", startHour: 4, endHour: 5, locationId: "campus" }] })
    );
    // Control: the same commitment in person does get a journey and a leave-by.
    expect(timelineFor(inPerson, "class").journeyBefore).toBeDefined();
    expect(timelineFor(inPerson, "class").leaveBy).toBeDefined();

    const remote = calculatePlanAndForecast(
      fixture({
        commitments: [{ id: "class", startHour: 4, endHour: 5, locationId: "campus", attendance: "remote" }]
      })
    );
    const timeline = timelineFor(remote, "class");
    expect(timeline.journeyBefore).toBeUndefined();
    expect(timeline.leaveBy).toBeUndefined();
    expect(response_hasTravelBlock(remote)).toBe(false);
  });

  it("does not need its preferred location: the preference plans no leg and raises no gap", () => {
    const response = calculatePlanAndForecast(
      fixture({
        commitments: [
          {
            id: "webinar",
            startHour: 4,
            endHour: 5,
            location: "Zoom",
            attendance: "remote",
            preferredLocationId: "campus"
          }
        ]
      })
    );
    const timeline = timelineFor(response, "webinar");
    expect(timeline.journeyBefore).toBeUndefined();
    expect(timeline.leaveBy).toBeUndefined();
    // An in-person commitment with free text and no place is flagged; a remote one has nowhere to be.
    expect(timeline.travelGap).toBeUndefined();
    expect(response_hasTravelBlock(response)).toBe(false);
  });

  it("leaves the return leg to a later in-person commitment alone", () => {
    const response = calculatePlanAndForecast(
      fixture({
        commitments: [
          { id: "webinar", startHour: 2, endHour: 3, locationId: "shops", attendance: "remote" },
          { id: "work", startHour: 6, endHour: 7, locationId: "campus" }
        ]
      })
    );
    expect(timelineFor(response, "webinar").journeyBefore).toBeUndefined();
    expect((timelineFor(response, "webinar") as { homeAt?: string }).homeAt).toBeUndefined();
    expect(timelineFor(response, "work").journeyBefore).toMatchObject({ toLocationId: "campus" });
  });
});

function response_hasTravelBlock(response: PlanForecastResponse): boolean {
  return response.dayPlan!.blocks.some((block) => block.kind === "travel");
}

describe("the journey store, end to end", () => {
  it("plans a stale morning's commute from an assumed home, and marks the leg", () => {
    // Nothing was ever asserted at all: `locationId` is null, so there is no "last asserted place" to
    // carry forward, and the walk falls all the way back to home.
    const response = calculatePlanAndForecast(
      fixture({
        locationId: null,
        commitments: [{ id: "work", startHour: 4, endHour: 5, locationId: "campus" }]
      })
    );
    const work = timelineFor(response, "work");
    expect(work.journeyBefore).toMatchObject({ originAssumed: true, typicalMinutes: 30 });
    // The day plan still draws the leg, because a plan-required journey to a commitment is planned
    // from the assumed origin same as any other.
    expect(response.dayPlan!.blocks.some((block) => block.kind === "travel" && block.toLocationId === "campus")).toBe(
      true
    );
  });

  it("never lets an assumed origin satisfy a location condition or direct a trip", () => {
    // The same stale morning, but now there is somewhere to go for its own sake (an errand only
    // workable at campus), which the same fixture directs happily once the origin is asserted (see the
    // `withJourneys`-free control immediately below): the trip must not be offered, and the errand must
    // not read as already satisfied, while the origin is only assumed.
    const assumed = calculatePlanAndForecast(
      fixture({
        locationId: null,
        locationSetAtOffsetMs: -10 * HOUR,
        errandAt: "campus"
      })
    );
    expect(assumed.currentDirective.kind).not.toBe("travel");
    const candidates = (assumed.recommendation as { candidates: Array<{ action: { id: string }; trip?: unknown }> })
      .candidates;
    expect(candidates.find((item) => item.action.id === "errand")?.trip).toBeUndefined();

    // Control: the same errand, asserted at campus outright, is satisfied with no trip at all — proving
    // the fixture itself is capable of the thing the assumed-origin case must not do.
    const asserted = calculatePlanAndForecast(fixture({ locationId: "campus", errandAt: "campus" }));
    expect(
      (asserted.recommendation as { candidates: Array<{ action: { id: string }; eligible: boolean }> }).candidates.find(
        (item) => item.action.id === "errand"
      )?.eligible
    ).toBe(true);
  });

  it("uses the allowing (padded) minutes for leave-by, not the typical figure", () => {
    const response = calculatePlanAndForecast(
      fixture({ commitments: [{ id: "work", startHour: 4, endHour: 5, locationId: "campus" }] })
    );
    const work = timelineFor(response, "work");
    const allowing = Math.round((new Date(work.arriveBy).getTime() - new Date(work.leaveBy!).getTime()) / MINUTE);
    // High caution is the default (`latenessMatters` unset means true), so the leg is padded to at
    // least typical + max(3, 0.15 × typical) at this sample count (0): the p95 tier is moot with no
    // samples, but the padding floor still applies and must show up here, not the bare 30.
    expect(allowing).toBe(padded(30));
    expect(allowing).not.toBe(30);
  });

  it("loosens to the 80th percentile once lateness stops mattering", () => {
    // Ten samples (the padding floor's own shrink point, so padding contributes nothing and the
    // percentile alone decides): p95 = 30, p80 = 24, median (typical) = 20. An any-time cell, so the
    // departure band cannot move which row is read.
    const anyTimeCell = {
      fromLocationId: "home",
      toLocationId: "campus",
      mode: "car" as const,
      dayType: null,
      band: null,
      pooled: { count: 10, median: 20, p80: 24, p95: 30 },
      own: { count: 0, median: 0, p80: 0, p95: 0 }
    };
    const withJourneys = (latenessMatters?: boolean) =>
      calculatePlanAndForecast(
        planForecastRequestSchema.parse({
          ...fixture({
            commitments: [
              {
                id: "work",
                startHour: 4,
                endHour: 5,
                locationId: "campus",
                ...(latenessMatters !== undefined ? { latenessMatters } : {})
              }
            ]
          }),
          journeys: { cells: [anyTimeCell], latest: [] }
        })
      );
    const mattersOn = withJourneys();
    const mattersOff = withJourneys(false);
    expect(timelineFor(mattersOn, "work").journeyBefore).toMatchObject({ minutes: 30, typicalMinutes: 20 });
    expect(timelineFor(mattersOff, "work").journeyBefore).toMatchObject({ minutes: 24, typicalMinutes: 20 });
  });

  it("prefers the commitment's own mode over the place's usual mode", () => {
    const response = calculatePlanAndForecast(
      fixture({
        commitments: [{ id: "work", startHour: 4, endHour: 5, locationId: "campus", transportMode: "bike" }],
        usualTransportMode: { campus: "walk" },
        transportModes: ["car", "bike", "walk"]
      })
    );
    expect(timelineFor(response, "work").journeyBefore).toMatchObject({ mode: "bike" });
  });

  it("falls to the place's usual mode, then the user default, when the commitment names none", () => {
    const usual = calculatePlanAndForecast(
      fixture({
        commitments: [{ id: "work", startHour: 4, endHour: 5, locationId: "campus" }],
        usualTransportMode: { campus: "walk" },
        transportModes: ["car", "bike", "walk"]
      })
    );
    expect(timelineFor(usual, "work").journeyBefore).toMatchObject({ mode: "walk" });

    const byDefault = calculatePlanAndForecast(
      fixture({
        commitments: [{ id: "work", startHour: 4, endHour: 5, locationId: "campus" }],
        transportModes: ["car", "bike", "walk"],
        defaultTransportMode: "bike"
      })
    );
    expect(timelineFor(byDefault, "work").journeyBefore).toMatchObject({ mode: "bike" });
  });

  it("keeps a commitment's own legs but drops directed trips when travel is off", () => {
    const response = calculatePlanAndForecast(
      fixture({
        travelOff: true,
        commitments: [{ id: "work", startHour: 4, endHour: 5, locationId: "campus" }],
        errandAt: "shops"
      })
    );
    // The commitment's own journey is still planned and protected.
    expect(response.dayPlan!.blocks.some((block) => block.kind === "travel" && block.toLocationId === "campus")).toBe(
      true
    );
    // But the errand at the shops, which nothing else sends the day to, is offered no trip.
    const candidates = (response.recommendation as { candidates: Array<{ action: { id: string }; trip?: unknown }> })
      .candidates;
    expect(candidates.find((item) => item.action.id === "errand")?.trip).toBeUndefined();

    // Control: with travel on, the same shape does direct the errand's trip.
    const travelOn = calculatePlanAndForecast(
      fixture({
        commitments: [{ id: "work", startHour: 4, endHour: 5, locationId: "campus" }],
        errandAt: "shops"
      })
    );
    expect(
      (travelOn.recommendation as { candidates: Array<{ action: { id: string }; trip?: unknown }> }).candidates.find(
        (item) => item.action.id === "errand"
      )?.trip
    ).toBeDefined();
  });

  it("marks a free-text-only commitment `no_place`", () => {
    const response = calculatePlanAndForecast(
      fixture({
        commitments: [{ id: "dentist", startHour: 4, endHour: 5, location: "Dr Lee's office" }]
      })
    );
    expect(timelineFor(response, "dentist").travelGap).toBe("no_place");
  });

  it("picks the 8:00 band over the 14:00 band for the same pair", () => {
    // Two identical trips to campus, one arriving 25 minutes into the 08:00 band (band 16, 08:00-08:30)
    // and one 25 minutes into the 14:00 band (band 28, 14:00-14:30), each fed a single cell sample that
    // only agrees with its own band, and each figure kept well clear of the band's edges so the
    // two-pass lookup's own drift cannot walk it into the neighbouring band: the 08:00 commitment must
    // read the 08:00 cell's figure, not the 14:00 one, proving the lookup keys on the departure band
    // rather than picking whichever cell exists.
    const dayType = "weekday" as const;
    const cell = (band: number, median: number) => ({
      fromLocationId: "home",
      toLocationId: "campus",
      mode: "car" as const,
      dayType,
      band,
      pooled: { count: 5, median, p80: median + 2, p95: median + 4 },
      own: { count: 0, median: 0, p80: 0, p95: 0 }
    });
    const cells = [cell(16, 5), cell(28, 15)];
    const early = calculatePlanAndForecast(
      planForecastRequestSchema.parse({
        ...fixture({
          travelMinutes: { campus: 5 },
          commitments: [{ id: "work", startHour: 8 + 25 / 60, endHour: 9, locationId: "campus" }]
        }),
        journeys: { cells, latest: [] }
      })
    );
    const late = calculatePlanAndForecast(
      planForecastRequestSchema.parse({
        ...fixture({
          travelMinutes: { campus: 5 },
          commitments: [{ id: "work", startHour: 14 + 25 / 60, endHour: 15, locationId: "campus" }]
        }),
        journeys: { cells, latest: [] }
      })
    );
    expect(timelineFor(early, "work").journeyBefore!.typicalMinutes).toBe(5);
    expect(timelineFor(late, "work").journeyBefore!.typicalMinutes).toBe(15);
  });
});

describe("an unknown origin with no home", () => {
  it("keeps an asserted condition across the day plan until the person actually moves", () => {
    const base = fixture({ locationId: null, homeLocationId: null });
    const state = {
      ...base.state,
      conditionDefinitions: [
        ...base.state.conditionDefinitions,
        { id: "printer", name: "printer", kind: "capability", status: "active", grants: [] }
      ],
      currentSituation: { ...base.state.currentSituation, overrides: { printer: "available" } },
      projects: [
        {
          id: "proj",
          title: "proj",
          area: "Everything",
          outcomeId: "outcome",
          status: "active",
          uncertainty: "known",
          value: 3,
          consequence: 3,
          internalDeadlineAt: iso(60 * DAY)
        }
      ],
      actions: [
        {
          id: "print",
          projectId: "proj",
          title: "print",
          status: "active",
          optimisticMinutes: 180,
          expectedMinutes: 180,
          pessimisticMinutes: 180,
          remainingMinutes: 180,
          energy: "medium",
          minimumSessionMinutes: 30,
          maximumSessionMinutes: 60,
          importance: 3,
          consequence: 3,
          contexts: [],
          requirementPathways: [{ id: "print:printer", contextIds: ["printer"] }],
          dependencyIds: [],
          splittable: true,
          setupMinutes: 0
        }
      ]
    };
    const response = calculatePlanAndForecast(planForecastRequestSchema.parse({ ...base, state }));
    // Nothing moves the person all day, so the printer they said is here stays here after the first block.
    const blocks = response.dayPlan!.blocks.filter((block) => block.kind === "action" && block.targetId === "print");
    expect(blocks.length).toBeGreaterThan(1);
  });
});

describe("promoted fixture: leave-by-allows-for-variability.json", () => {
  interface Fixture {
    request: unknown;
    expect: { currentDirective: unknown; primaryActionId: string | null; dayPlan: string[] };
  }

  it("leave-by, and the live directive, read the padded allowing minutes, not the bare typical", () => {
    const fixture = leaveByAllowsForVariability as Fixture;
    const request = planForecastRequestSchema.parse(fixture.request);
    const response = calculatePlanAndForecast(request);
    expect(response.currentDirective).toEqual(fixture.expect.currentDirective);
    expect((response.recommendation as { primary: { action: { id: string } } | null }).primary?.action.id ?? null).toBe(
      fixture.expect.primaryActionId
    );
    expect(response.dayPlan, "day plan present").toBeDefined();
    expect(compactDayPlan(response.dayPlan!)).toEqual(fixture.expect.dayPlan);
  });
});
