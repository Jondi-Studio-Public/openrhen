import { describe, expect, it } from "vitest";
import {
  PLAN_FORECAST_CONTRACT_VERSION,
  planForecastRequestSchema,
  planForecastResponseSchema,
  portalStateSchema,
  type CurrentDirective,
  type PlanForecastRequest,
  type PlanForecastResponse
} from "@openrhen/contracts";

/**
 * A leg with no samples at all now carries the journey store's padding
 * `max(3, 0.15 × typical)` on top, rounded up.
 * `padded` states that arithmetic once so a test can say what it means (30 stored minutes to campus)
 * without hand-computing or repeating the padded figure.
 */
const padded = (minutes: number) => Math.ceil(minutes + Math.max(3, 0.15 * minutes));
import { ARRIVAL_MARGIN_MINUTES, calculatePlanAndForecast, selectCurrentDirective } from "../../src/index.js";
import type { PlanningResult, Recommendation, SleepPlan } from "../../src/index.js";

/**
 * The travel policy end to end (logic design §4 trip eligibility, §9 travel cost and hard precedence).
 *
 * Every case here is a whole planning request, because the policy only exists once the projection, the
 * protected windows, the ranking and the precedence chain are all in the same room. What each one
 * holds is one rule: a journey is directed when the work is worth it and there is no cheaper moment;
 * it is deferred when there is; errands share a journey; going where the plan already sends you is
 * free; you go home for the night; and without a way to travel none of it happens at all.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** 10:00 on a Wednesday in the seed zone (AEST, UTC+10). */
const now = new Date("2026-08-19T00:00:00.000Z");
const iso = (offsetMs: number) => new Date(now.getTime() + offsetMs).toISOString();

interface ActionSpec {
  id: string;
  projectId: string;
  minutes: number;
  /** The location the work needs, as a single requirement pathway. */
  at?: string;
  minSession?: number;
  maxSession?: number;
}

interface CommitmentSpec {
  id: string;
  startHour: number;
  endHour: number;
  locationId?: string;
  transitionAfterMinutes?: number;
  setupBeforeMinutes?: number;
}

interface Shape {
  actions?: ActionSpec[];
  commitments?: CommitmentSpec[];
  /** Stored fallback minutes per location; the figure the matcher uses when nothing is measured. */
  travelMinutes?: Record<string, number>;
  /** A fresh Google sample from the current place, keyed by destination (the journey store's "live"). */
  measured?: Record<string, { minutes: number; mode: "car" | "bike" | "walk" }>;
  transportModes?: Array<"car" | "bike" | "walk">;
  locationId?: string | null;
  homeLocationId?: string;
  /** No home configured at all. */
  noHome?: boolean;
  projectValues?: Record<string, number>;
}

const LOCATIONS = ["home", "campus", "shops", "cafe"];

function fixture(shape: Shape = {}): PlanForecastRequest {
  const travelMinutes = { campus: 30, shops: 10, ...shape.travelMinutes } as Record<string, number>;
  const conditionDefinitions = LOCATIONS.map((id) => ({
    id,
    name: id,
    kind: "location" as const,
    status: "active" as const,
    grants: [],
    ...(travelMinutes[id] !== undefined ? { travelMinutes: travelMinutes[id] } : {})
  }));
  const values = { alpha: 5, beta: 2, ...shape.projectValues } as Record<string, number>;
  const projects = ["alpha", "beta"].map((id) => ({
    id,
    title: id,
    area: "Everything",
    outcomeId: "outcome",
    status: "active" as const,
    uncertainty: "known" as const,
    value: values[id]!,
    consequence: values[id]!,
    internalDeadlineAt: iso(60 * DAY)
  }));
  const actions = (
    shape.actions ?? [
      { id: "lab", projectId: "alpha", minutes: 60, at: "campus" },
      { id: "tidy", projectId: "beta", minutes: 60 }
    ]
  ).map((action) => ({
    id: action.id,
    projectId: action.projectId,
    title: action.id,
    status: "active" as const,
    optimisticMinutes: action.minutes,
    expectedMinutes: action.minutes,
    pessimisticMinutes: action.minutes,
    remainingMinutes: action.minutes,
    energy: "medium" as const,
    minimumSessionMinutes: action.minSession ?? 15,
    maximumSessionMinutes: action.maxSession ?? 60,
    importance: 3,
    consequence: 3,
    contexts: [],
    ...(action.at ? { requirementPathways: [{ id: `${action.id}:at`, contextIds: [action.at] }] } : {}),
    dependencyIds: [],
    splittable: true,
    setupMinutes: 0
  }));
  const commitments = (shape.commitments ?? []).map((item) => ({
    id: item.id,
    title: item.id,
    status: "confirmed" as const,
    startsAt: iso(item.startHour * HOUR),
    endsAt: iso(item.endHour * HOUR),
    setupBeforeMinutes: item.setupBeforeMinutes ?? 0,
    transitionAfterMinutes: item.transitionAfterMinutes ?? 0,
    ...(item.locationId ? { locationId: item.locationId } : {})
  }));
  const state = portalStateSchema.parse({
    settings: {
      timezone: "Australia/Sydney",
      planningHorizonEnd: "20:00",
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
      ...(shape.noHome ? {} : { homeLocationId: shape.homeLocationId === undefined ? "home" : shape.homeLocationId })
    },
    areas: [{ id: "area", name: "Everything", status: "active", sortOrder: 0 }],
    outcomes: [
      { id: "outcome", areaId: "area", title: "Outcome", definitionOfDone: "Done.", value: 3, status: "active" }
    ],
    projects,
    actions,
    commitments,
    conditionDefinitions,
    currentSituation: {
      locationId: shape.locationId === undefined ? "home" : shape.locationId,
      locationSetAt: now.toISOString(),
      transportModes: shape.transportModes ?? ["car"]
    },
    routineSteps: [],
    sleepPlans: [],
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
    requestId: "00000000-0000-4000-8000-0000000074a1",
    inputVersion: "travel-fixture",
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

const candidate = (response: PlanForecastResponse, actionId: string) =>
  (
    response.recommendation as {
      candidates: Array<{
        action: { id: string };
        trip?: {
          toLocationId: string;
          bundleSize: number;
          avoidableMinutes: number;
          costMinutes: number;
          opportunityMinutes: number | null;
          travelMinutes: number;
          returnMinutes: number;
          returnUnknown?: boolean;
        };
        tripReason?: string;
        eligible: boolean;
        exclusionReasons: string[];
        scoreComponents: Record<string, number>;
      }>;
    }
  ).candidates.find((item) => item.action.id === actionId)!;

const primaryId = (response: PlanForecastResponse) =>
  (response.recommendation as { primary: { action: { id: string } } | null }).primary?.action.id ?? null;

describe("travel policy: when a journey is directed", () => {
  it("directs the journey when the work is worth it and no later moment is cheaper (F1)", () => {
    // A live sample with no cell to draw a real spread from is padded like any other n=0 figure.
    const liveMinutes = padded(20);
    const response = calculatePlanAndForecast(fixture({ measured: { campus: { minutes: 20, mode: "car" } } }));
    expect(primaryId(response)).toBe("lab");
    const trip = candidate(response, "lab").trip!;
    expect(trip).toMatchObject({ toLocationId: "campus", bundleSize: 1, costMinutes: liveMinutes });
    // Nothing in the projected day goes near campus again, so the journey is unavoidable and free.
    expect(trip.avoidableMinutes).toBe(0);
    expect(candidate(response, "lab").scoreComponents.travelCost).toBe(0);
    const directive = response.currentDirective;
    expect(directive).toMatchObject({
      kind: "travel",
      toLocationId: "campus",
      title: "Drive to campus",
      recommendedMinutes: liveMinutes,
      mode: "car",
      source: "live"
    });
    expect(directive.kind === "travel" && directive.then).toMatchObject({ kind: "action", targetId: "lab" });
    // The leg is drawn, and the day carries a band saying where it is.
    const plan = response.dayPlan!;
    expect(plan.blocks[0]).toMatchObject({ kind: "travel", toLocationId: "campus", focusedMinutes: 0 });
    expect(plan.blocks[1]).toMatchObject({ kind: "action", targetId: "lab" });
    expect(plan.locations[0]).toMatchObject({ locationId: null, label: "In transit" });
    expect(plan.locations[1]).toMatchObject({ locationId: "campus", label: "campus" });
    expect(planForecastResponseSchema.parse(response).dayPlan).toEqual(plan);
  });

  it("measures a resting deadline trip from when the break ends, not from now", () => {
    // Overdue work at campus, with a later commitment there bounding the destination window.
    const shape: Shape = {
      measured: { campus: { minutes: 20, mode: "car" } },
      actions: [{ id: "lab", projectId: "alpha", minutes: 240, at: "campus", maxSession: 120 }],
      commitments: [{ id: "home-call", startHour: 2, endHour: 3, locationId: "campus" }]
    };
    const request = (resting: boolean) => {
      const base = fixture(shape);
      const state = {
        ...base.state,
        projects: base.state.projects.map((project) =>
          project.id === "alpha" ? { ...project, externalDeadlineAt: iso(-1 * DAY) } : project
        ),
        settings: { ...base.state.settings, sessionBreakMinutes: 15 },
        ...(resting ? { lastEndedSessions: [{ targetId: "lab", endedAt: iso(-5 * MINUTE), focusedMinutes: 120 }] } : {})
      };
      return planForecastRequestSchema.parse({ ...base, state });
    };
    const fresh = candidate(calculatePlanAndForecast(request(false)), "lab") as unknown as {
      trip?: unknown;
      recommendedMinutes: number;
      restUntil?: string;
    };
    const resting = candidate(calculatePlanAndForecast(request(true)), "lab") as unknown as typeof fresh;
    expect(fresh.trip).toBeDefined();
    expect(resting.trip).toBeDefined();
    expect(resting.restUntil).toBeDefined();
    // The break ends 10 minutes from now; the journey starts then, so 10 fewer minutes fit at campus.
    expect(resting.recommendedMinutes).toBe(fresh.recommendedMinutes - 10);
  });

  it("rests a deadline trip, rather than offering it, while its break holds a commitment", () => {
    // Break until now + 10. Starting now would run across the call, so the work rests like ordinary work.
    const restingWith = (startHour: number, endHour: number) => {
      const base = fixture({
        measured: { campus: { minutes: 20, mode: "car" } },
        actions: [{ id: "lab", projectId: "alpha", minutes: 240, at: "campus", maxSession: 120 }],
        commitments: [{ id: "call", startHour, endHour }]
      });
      const response = calculatePlanAndForecast(
        planForecastRequestSchema.parse({
          ...base,
          state: {
            ...base.state,
            projects: base.state.projects.map((project) =>
              project.id === "alpha" ? { ...project, externalDeadlineAt: iso(-1 * DAY) } : project
            ),
            settings: { ...base.state.settings, sessionBreakMinutes: 15 },
            lastEndedSessions: [{ targetId: "lab", endedAt: iso(-5 * MINUTE), focusedMinutes: 120 }]
          }
        })
      );
      return candidate(response, "lab") as unknown as {
        eligible: boolean;
        trip?: unknown;
        restUntil?: string;
        exclusionReasons: string[];
      };
    };
    // A call wholly inside the break, and one that starts inside it and is still running at departure.
    for (const lab of [restingWith(3 / 60, 6 / 60), restingWith(5 / 60, 20 / 60)]) {
      expect(lab.eligible).toBe(false);
      expect(lab.trip).toBeUndefined();
      expect(lab.restUntil).toBeUndefined();
      expect(lab.exclusionReasons.some((item) => item.startsWith("Resting after a full session until"))).toBe(true);
    }
  });

  it("makes the journey itself wait out the break, live and in the projected day", () => {
    const base = fixture({
      measured: { campus: { minutes: 20, mode: "car" } },
      actions: [{ id: "lab", projectId: "alpha", minutes: 240, at: "campus", maxSession: 120 }]
    });
    const request = planForecastRequestSchema.parse({
      ...base,
      state: {
        ...base.state,
        projects: base.state.projects.map((project) =>
          project.id === "alpha" ? { ...project, externalDeadlineAt: iso(-1 * DAY) } : project
        ),
        settings: { ...base.state.settings, sessionBreakMinutes: 15 },
        lastEndedSessions: [{ targetId: "lab", endedAt: iso(-5 * MINUTE), focusedMinutes: 120 }]
      }
    });
    const response = calculatePlanAndForecast(request);
    const restUntil = iso(10 * MINUTE);
    const directive = response.currentDirective;
    expect(directive).toMatchObject({ kind: "travel", toLocationId: "campus", notBefore: restUntil });
    expect(directive.kind === "travel" && directive.then).toMatchObject({ kind: "action", targetId: "lab" });
    // The projected day takes the break first and only then drives.
    const [first, second] = response.dayPlan!.blocks;
    expect(first).toMatchObject({ kind: "gap", title: "Take a break", startsAt: now.toISOString(), endsAt: restUntil });
    expect(second).toMatchObject({ kind: "travel", toLocationId: "campus", startsAt: restUntil });
  });

  it("defers it instead when the projected day already goes there later (F2)", () => {
    // The shops at 13:00 pin the next few hours; campus is where a commitment takes you at 16:00. The
    // errand at campus can be done then for nothing, so doing it now is avoidable travel and is charged.
    const commitments: CommitmentSpec[] = [
      { id: "shops-run", startHour: 3, endHour: 3.5, locationId: "shops" },
      { id: "seminar", startHour: 6, endHour: 7, locationId: "campus" }
    ];
    // Close enough in value that the avoidable journey is what separates them, which is the point,
    // and enough work at home that the day never runs out of reasons to stay.
    const projectValues = { alpha: 3, beta: 2 };
    const actions: ActionSpec[] = [
      { id: "lab", projectId: "alpha", minutes: 120, at: "campus", maxSession: 60 },
      { id: "tidy", projectId: "beta", minutes: 420, maxSession: 60 }
    ];
    const deferred = calculatePlanAndForecast(fixture({ commitments, projectValues, actions }));
    const lab = candidate(deferred, "lab");
    expect(lab.trip).toMatchObject({ toLocationId: "campus", opportunityMinutes: 0 });
    expect(lab.trip!.avoidableMinutes).toBe(lab.trip!.costMinutes);
    expect(lab.scoreComponents.travelCost).toBeLessThan(0);
    expect(primaryId(deferred)).toBe("tidy");
    expect(deferred.currentDirective.kind).toBe("action");
    // And it is shown once the day has arrived at campus — never before the journey that takes it
    // there. Which journey that is stopped being fixed with the errand can now be worth an
    // early arrival after the shops run rather than waiting for the seminar's own leg, so this anchors
    // on the arrival itself rather than on the commitment that used to follow it.
    const atCampus = deferred.dayPlan!.blocks.filter((block) => block.kind === "action" && block.targetId === "lab");
    expect(atCampus.length).toBeGreaterThan(0);
    const toCampus = deferred.dayPlan!.blocks.filter(
      (block) => block.kind === "travel" && block.toLocationId === "campus"
    );
    // At least one journey, and every campus session is shown only once its own journey there has
    // finished — never before it. `lab`'s own maximum-session break (ranking-consistency) sends the
    // day briefly elsewhere between its two sessions (the shops errand fills the break), so a genuine
    // second campus trip is expected here; the original bug this pinned was a *redundant* leg to a
    // place already reached, not a second trip after really having left.
    expect(toCampus.length).toBeGreaterThanOrEqual(1);
    for (const block of atCampus) {
      const priorLeg = toCampus.filter((leg) => new Date(leg.endsAt).getTime() <= new Date(block.startsAt).getTime());
      expect(priorLeg.length).toBeGreaterThan(0);
    }

    // Without the later visit to campus nothing later is free — being at the shops afterwards only
    // shortens the journey, it does not remove it — so most of the travel is unavoidable and the same
    // errand leads from here.
    const immediate = calculatePlanAndForecast(fixture({ commitments: [commitments[0]!], projectValues, actions }));
    const shopsOnly = candidate(immediate, "lab").trip!;
    expect(shopsOnly.opportunityMinutes).toBe(padded(30));
    expect(shopsOnly.avoidableMinutes).toBe(shopsOnly.costMinutes - padded(30));
    expect(candidate(immediate, "lab").scoreComponents.travelCost).toBeGreaterThan(lab.scoreComponents.travelCost ?? 0);
    expect(primaryId(immediate)).toBe("lab");
  });

  it("charges nothing at all when the projection never goes near the place again", () => {
    const alone = calculatePlanAndForecast(
      fixture({
        projectValues: { alpha: 3, beta: 2 },
        actions: [
          { id: "lab", projectId: "alpha", minutes: 120, at: "campus", maxSession: 60 },
          { id: "tidy", projectId: "beta", minutes: 420, maxSession: 60 }
        ]
      })
    );
    expect(candidate(alone, "lab").trip).toMatchObject({ opportunityMinutes: null, avoidableMinutes: 0 });
    expect(candidate(alone, "lab").scoreComponents.travelCost).toBe(0);
    expect(primaryId(alone)).toBe("lab");
  });

  it("shares one journey between errands at the same place (F3)", () => {
    const response = calculatePlanAndForecast(
      fixture({
        actions: [
          { id: "lab", projectId: "alpha", minutes: 30, at: "campus", maxSession: 30 },
          { id: "library", projectId: "alpha", minutes: 30, at: "campus", maxSession: 30 },
          { id: "tidy", projectId: "beta", minutes: 60 }
        ],
        commitments: [
          { id: "shops-run", startHour: 3, endHour: 3.5, locationId: "shops" },
          { id: "seminar", startHour: 6, endHour: 7, locationId: "campus" }
        ]
      })
    );
    const lab = candidate(response, "lab").trip!;
    const library = candidate(response, "library").trip!;
    expect(lab.bundleSize).toBe(2);
    expect(library.bundleSize).toBe(2);
    // Two errands halve the journey each is charged for, and the cost halves with it.
    expect(lab.avoidableMinutes).toBe(Math.round(lab.costMinutes / 2));
    const alone = calculatePlanAndForecast(
      fixture({
        actions: [
          { id: "lab", projectId: "alpha", minutes: 30, at: "campus", maxSession: 30 },
          { id: "tidy", projectId: "beta", minutes: 60 }
        ],
        commitments: [
          { id: "shops-run", startHour: 3, endHour: 3.5, locationId: "shops" },
          { id: "seminar", startHour: 6, endHour: 7, locationId: "campus" }
        ]
      })
    );
    expect(candidate(alone, "lab").trip!.bundleSize).toBe(1);
    expect(Math.abs(candidate(response, "lab").scoreComponents.travelCost ?? 0)).toBeLessThan(
      Math.abs(candidate(alone, "lab").scoreComponents.travelCost ?? 0)
    );
  });

  it("goes early when the plan is sending you there anyway, at no cost (F4)", () => {
    const response = calculatePlanAndForecast(
      fixture({ commitments: [{ id: "seminar", startHour: 4, endHour: 5, locationId: "campus" }] })
    );
    const trip = candidate(response, "lab").trip!;
    // The leg is plan-required and already protected as the seminar's own travel phase, so it is free.
    expect(trip).toMatchObject({ costMinutes: 0, returnMinutes: 0, avoidableMinutes: 0 });
    expect(candidate(response, "lab").scoreComponents.travelCost).toBe(0);
    expect(primaryId(response)).toBe("lab");
    expect(response.currentDirective).toMatchObject({ kind: "travel", toLocationId: "campus" });
  });

  it("protects the journey to a located commitment, additively, and says so (T0)", () => {
    const response = calculatePlanAndForecast(
      fixture({
        actions: [{ id: "tidy", projectId: "beta", minutes: 240 }],
        commitments: [{ id: "seminar", startHour: 4, endHour: 5, locationId: "campus", setupBeforeMinutes: 10 }]
      })
    );
    const toCampus = padded(30);
    const plan = response.dayPlan!;
    const seminar = plan.blocks.filter((block) => block.kind === "commitment");
    const leg = plan.blocks.find((block) => block.kind === "travel")!;
    // Setup, then the journey, then the arrival margin: additive, never folded into the buffer.
    expect(new Date(leg.startsAt).getTime()).toBe(
      now.getTime() + 4 * HOUR - (toCampus + ARRIVAL_MARGIN_MINUTES) * MINUTE
    );
    expect(leg.wallClockMinutes).toBe(toCampus);
    expect(leg.targetId).toBe("seminar");
    // Getting ready comes first, the journey next, and the commitment picks up when it lands.
    expect(new Date(seminar[0]!.startsAt).getTime()).toBe(
      now.getTime() + 4 * HOUR - (10 + toCampus + ARRIVAL_MARGIN_MINUTES) * MINUTE
    );
    expect(seminar[0]!.endsAt).toBe(leg.startsAt);
    expect(seminar[1]!.startsAt).toBe(leg.endsAt);
    // Work stops when the whole protected run starts, not when the commitment does.
    const beforeIt = plan.blocks[plan.blocks.indexOf(seminar[0]!) - 1]!;
    // Padding shifted the setup start a few minutes earlier, so the last stretch before it is now too
    // short for a session (13 min, under the 15-min minimum) and reads as a boundary gap rather than a
    // trailing action block; either way, work (or the wait for the boundary) stops exactly when the
    // protected run starts, never when the commitment itself does.
    expect(["action", "gap"]).toContain(beforeIt.kind);
    expect(beforeIt.endsAt).toBe(seminar[0]!.startsAt);
    // And the band says where the day is: home, then nowhere, then campus.
    expect(plan.locations.map((entry) => entry.locationId)).toEqual(["home", null, "campus"]);
    for (let index = 1; index < plan.blocks.length; index += 1)
      expect(plan.blocks[index]!.startsAt).toBe(plan.blocks[index - 1]!.endsAt);
  });

  it("offers nothing elsewhere when there is no way to travel (F6)", () => {
    const response = calculatePlanAndForecast(fixture({ transportModes: [] }));
    expect(candidate(response, "lab")).toMatchObject({ eligible: false, tripReason: "no_mode" });
    expect(candidate(response, "lab").trip).toBeUndefined();
    expect(primaryId(response)).toBe("tidy");
    expect(response.currentDirective.kind).toBe("action");
    expect(response.dayPlan!.blocks.some((block) => block.kind === "travel")).toBe(false);
  });

  it("says why a reachable place is no use right now (no_window)", () => {
    // Campus is 90 minutes away and the shops run starts in two hours: arriving leaves no session.
    const response = calculatePlanAndForecast(
      fixture({
        travelMinutes: { campus: 90 },
        actions: [
          { id: "lab", projectId: "alpha", minutes: 60, at: "campus", minSession: 60 },
          { id: "tidy", projectId: "beta", minutes: 60 }
        ],
        commitments: [{ id: "shops-run", startHour: 2, endHour: 3, locationId: "shops" }]
      })
    );
    expect(candidate(response, "lab")).toMatchObject({ eligible: false, tripReason: "no_window" });
    expect(
      (response.recommendation as { reachable: Array<{ action: { id: string } }> }).reachable.map(
        (item) => item.action.id
      )
    ).toContain("lab");
    // a refused trip is refused for being somewhere else, not for the window it would
    // occupy right here — the "Only N compatible minutes"/indivisible-window checks are measured
    // against the window at the current location, which was never lab's actual constraint, and must
    // not tag along on a location-blocked, trip-refused candidate.
    expect(candidate(response, "lab").exclusionReasons.some((reason) => reason.includes("compatible minutes"))).toBe(
      false
    );
    expect(candidate(response, "lab").exclusionReasons.some((reason) => reason.includes("indivisible action"))).toBe(
      false
    );
  });

  it("is the same answer whatever order the inputs arrive in (F7)", () => {
    const request = fixture({
      actions: [
        { id: "lab", projectId: "alpha", minutes: 30, at: "campus", maxSession: 30 },
        { id: "library", projectId: "alpha", minutes: 30, at: "campus", maxSession: 30 },
        { id: "errand", projectId: "beta", minutes: 30, at: "shops", maxSession: 30 },
        { id: "tidy", projectId: "beta", minutes: 60 }
      ],
      commitments: [
        { id: "shops-run", startHour: 4, endHour: 4.5, locationId: "shops" },
        { id: "seminar", startHour: 6, endHour: 7, locationId: "campus" }
      ]
    });
    const baseline = JSON.stringify(calculatePlanAndForecast(request));
    const rotate = <T>(items: T[], by: number) => [...items.slice(by), ...items.slice(0, by)];
    for (const by of [1, 2, 3]) {
      const shuffled = planForecastRequestSchema.parse({
        ...request,
        state: {
          ...request.state,
          actions: rotate(request.state.actions, by),
          commitments: [...request.state.commitments].reverse(),
          conditionDefinitions: rotate(request.state.conditionDefinitions, by)
        }
      });
      expect(JSON.stringify(calculatePlanAndForecast(shuffled))).toBe(baseline);
    }
  });

  it("following a plan with a leg in it reproduces the rest of it (F8)", () => {
    const request = fixture({
      actions: [{ id: "tidy", projectId: "beta", minutes: 300, maxSession: 60 }],
      commitments: [{ id: "seminar", startHour: 5, endHour: 6, locationId: "campus" }]
    });
    let current = request;
    let plan = calculatePlanAndForecast(current).dayPlan!;
    expect(plan.blocks.some((block) => block.kind === "travel")).toBe(true);
    const shape = (block: (typeof plan.blocks)[number]) =>
      [block.startsAt, block.endsAt, block.kind, block.targetId, block.focusedMinutes] as const;
    for (let step = 0; step < 3; step += 1) {
      const done = plan.blocks[0]!;
      current = planForecastRequestSchema.parse({
        ...current,
        calculatedAt: done.endsAt,
        state: {
          ...current.state,
          actions: current.state.actions.map((action) =>
            done.kind === "action" && action.id === done.targetId
              ? {
                  ...action,
                  remainingMinutes: Math.max(0, action.remainingMinutes - done.focusedMinutes),
                  lastWorkedAt: done.endsAt
                }
              : action
          ),
          // A session that really ended is recorded in the break ledger too — exactly as
          // `portal/server/persistence/postgres/readers/sessions.ts` would once the world persisted it — so replanning after a full session
          // sees the same break the forward simulation already accounted for.
          lastEndedSessions:
            done.kind === "action" && done.targetId
              ? [
                  ...current.state.lastEndedSessions.filter((session) => session.targetId !== done.targetId),
                  { targetId: done.targetId, endedAt: done.endsAt, focusedMinutes: done.focusedMinutes }
                ]
              : current.state.lastEndedSessions
        }
      });
      const replanned = calculatePlanAndForecast(current).dayPlan!;
      expect(replanned.blocks.map(shape), `after ${done.kind} (step ${step})`).toEqual(plan.blocks.slice(1).map(shape));
      plan = replanned;
    }
  });
});

describe("travel policy: unknown travel is not zero", () => {
  // "cafe" has no stored minutes, no coordinates and no samples: no journey to or from it can be worked out.
  const commitments: CommitmentSpec[] = [{ id: "coffee", startHour: 3, endHour: 4, locationId: "cafe" }];

  it("assumes the way out for the journey on to a place with no figure, and says it is assumed", () => {
    const response = calculatePlanAndForecast(fixture({ commitments }));
    const lab = candidate(response, "lab");
    expect(lab.trip).toMatchObject({ toLocationId: "campus", returnUnknown: true });
    expect(lab.trip!.returnMinutes).toBe(lab.trip!.travelMinutes);
    expect(lab.trip!.returnMinutes).toBeGreaterThan(0);
    // The session is bounded by leaving in time for the assumed journey, not by running up to the commitment.
    const known = candidate(
      calculatePlanAndForecast(fixture({ commitments: [{ ...commitments[0]!, locationId: "shops" }] })),
      "lab"
    );
    expect(known.trip!.returnUnknown).toBeUndefined();
  });

  it("uses the destination's own stored minutes, not the guess, when the current place is unknown", () => {
    const response = calculatePlanAndForecast(
      fixture({ locationId: null, commitments: [{ id: "seminar", startHour: 6, endHour: 7, locationId: "campus" }] })
    );
    const timeline = response.derivedState!.commitmentTimelines!.find((item) => item.id === "seminar")!;
    expect(timeline.travelGap).toBeUndefined();
    expect(new Date(timeline.arriveBy).getTime() - new Date(timeline.leaveBy!).getTime()).toBe(padded(30) * MINUTE);
    expect(timeline.journeyBefore).toMatchObject({ source: "fallback", toLocationId: "campus" });
  });

  it("still plans a located commitment's journey with no home and no current place", () => {
    const planned = (locationId: string) =>
      calculatePlanAndForecast(
        fixture({
          locationId: null,
          noHome: true,
          commitments: [{ id: "seminar", startHour: 6, endHour: 7, locationId }]
        })
      ).derivedState!.commitmentTimelines!.find((item) => item.id === "seminar")!;
    // A figure the destination holds itself applies from anywhere; with none, the assumed figure, flagged.
    const stored = planned("campus");
    expect(stored.travelGap).toBeUndefined();
    expect(new Date(stored.arriveBy).getTime() - new Date(stored.leaveBy!).getTime()).toBe(padded(30) * MINUTE);
    const guessed = planned("cafe");
    expect(guessed.travelGap).toBe("no_estimate");
    expect(new Date(guessed.arriveBy).getTime() - new Date(guessed.leaveBy!).getTime()).toBe(30 * MINUTE);
  });

  it("gives a located commitment with no journey an assumed leave-by, flagged as unknown", () => {
    const response = calculatePlanAndForecast(fixture({ commitments }));
    const timeline = response.derivedState!.commitmentTimelines!.find((item) => item.id === "coffee")!;
    expect(timeline.travelGap).toBe("no_estimate");
    expect(timeline.leaveBy).toBeDefined();
    expect(new Date(timeline.arriveBy).getTime() - new Date(timeline.leaveBy!).getTime()).toBe(30 * MINUTE);
  });
});

describe("travel policy: going home for the night (F5)", () => {
  const emptyRecommendation: Recommendation = {
    primary: null,
    alternatives: [],
    candidates: [],
    needsAnswer: [],
    reachable: [],
    headline: "Nothing fits",
    explanation: "Nothing fits.",
    evidence: [],
    why: { because: null, whyNot: null, wouldChangeIf: [] },
    noFit: { kind: "none" }
  };
  const schedule: PlanningResult = {
    slots: [],
    allocations: [],
    capacityEnvelopes: [],
    projectEnvelopes: [],
    forecasts: [],
    dependencyOrder: [],
    dependencyErrors: []
  };
  const state = portalStateSchema.parse({
    settings: {
      timezone: "Australia/Sydney",
      planningHorizonEnd: "20:00",
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
      maxAwakeHours: 16
    },
    areas: [],
    outcomes: [],
    projects: [],
    actions: [],
    commitments: [],
    routineSteps: [],
    sleepPlans: [],
    captures: [],
    completedToday: [],
    assertedConditions: [],
    currentEnergy: "medium",
    horizonEnd: iso(DAY),
    activeSession: null
  });
  const sleep: SleepPlan = {
    id: "tonight",
    plannedStartAt: new Date(now.getTime() + 90 * MINUTE),
    plannedWakeAt: new Date(now.getTime() + 90 * MINUTE + 8 * HOUR),
    desiredMinutes: 480,
    allowedMinutes: 480,
    sleepDeficitMinutes: 0,
    anchorDeviationMinutes: 0,
    hardErrors: [],
    explanation: "Planned."
  };
  const travel = {
    currentLocationId: "campus",
    homeLocationId: "home",
    travelBetween: (_from: string | null, to: string) =>
      to === "home"
        ? {
            fromLocationId: "campus",
            toLocationId: "home",
            minutes: 25,
            typicalMinutes: 25,
            sampleCount: 0,
            mode: "car" as const,
            source: "fallback" as const
          }
        : undefined,
    locationName: (id: string) => id
  };
  const directiveAt = (minutesFromNow: number): CurrentDirective =>
    selectCurrentDirective({
      state,
      commitments: [],
      now: new Date(now.getTime() + minutesFromNow * MINUTE),
      sleepPlans: [sleep],
      recommendation: emptyRecommendation,
      schedule,
      travel
    });

  it("waits until the journey is due, then makes it the directive", () => {
    expect(directiveAt(60).kind).not.toBe("travel");
    const due = directiveAt(65);
    expect(due).toMatchObject({ kind: "travel", toLocationId: "home", recommendedMinutes: 25, mode: "car" });
    expect(due.kind === "travel" && due.then).toMatchObject({ kind: "sleep", targetId: "tonight" });
  });

  it("does nothing of the sort when you are already home", () => {
    const home = selectCurrentDirective({
      state,
      commitments: [],
      now: new Date(now.getTime() + 65 * MINUTE),
      sleepPlans: [sleep],
      recommendation: emptyRecommendation,
      schedule,
      travel: { ...travel, currentLocationId: "home" }
    });
    expect(home.kind).not.toBe("travel");
  });
});
