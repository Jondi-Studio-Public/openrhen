import { describe, expect, it } from "vitest";
import { planForecastRequestSchema, type PlanForecastRequest } from "@openrhen/contracts";
import { DAY_PLAN_STEP_CAP, calculatePlanAndForecast } from "../../src/index.js";

/**
 * A whole-engine benchmark at the size a real request actually arrives in.
 *
 * measured a live plan — 164 actions across 51 projects with 53 protected commitments over a
 * six-month horizon — at roughly two seconds, and close to three with a continuation simulated on top.
 * Nothing in the suite covered that shape: every other test is a handful of actions over a handful of
 * days, so a change that made the per-slot work quadratic would have stayed invisible.
 *
 * The ceiling is deliberately loose. Wall-clock timing on a shared machine is noisy, and a benchmark
 * that fails on a busy laptop gets deleted rather than investigated. What it catches is the thing
 * worth catching: a regression that puts a factor back on, not a few percent of drift.
 *
 * Each ceiling is checked against the fastest of up to three runs, and a run under it ends the
 * measurement, so an idle machine pays for one. Load from other processes only ever adds time, so
 * the minimum is the estimate least disturbed by it: a runner sharing its cores with the other gate
 * jobs (or anything else) can push one run over, but not three, while a real regression is slow
 * every time.
 *
 * The ceilings came down with the optimisations, which took this request from about a second to
 * about 140 ms, and the continuation from about 2.3 s to about 320 ms, on the machine that profiled it.
 * They keep roughly the headroom the old ceilings had, so a change that puts the lost factor back on
 * fails here instead of passing for free.
 */
const CEILING_MS = 600;
const CONTINUATION_CEILING_MS = 1_000;

const NOW = new Date("2026-08-18T09:00:00.000Z");
const DAY = 86_400_000;
const HORIZON = new Date(NOW.getTime() + 180 * DAY);
const CONTEXTS = ["desktop", "home", "laptop", "online", "outdoors", "phone", "shops", "workshop"];
const ENERGIES = ["high", "medium", "low"] as const;

/** Deterministic, so the benchmark measures the same work on every run and on every machine. */
function pseudoRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

/** A stable v4-shaped identifier, because several fields in the contract are uuid-typed. */
function id(prefix: string, index: number): string {
  let hash = 0x811c9dc5;
  for (const character of prefix) hash = Math.imul(hash ^ character.codePointAt(0)!, 16_777_619);
  const head = (hash >>> 0).toString(16).padStart(8, "0");
  const low = (index & 0xffff).toString(16).padStart(4, "0");
  const high = ((index >>> 16) & 0xfff).toString(16).padStart(3, "0");
  const salt = ((hash >>> 8) & 0xfff).toString(16).padStart(3, "0");
  return `${head}-${low}-4${high}-8${salt}-${head}${low}`;
}

const PROJECT_COUNT = 50;
const ACTION_COUNT = 160;
const COMMITMENT_COUNT = 50;
const OUTCOME_COUNT = 10;

interface Shape {
  continuation?: PlanForecastRequest["continuation"];
  usableFraction?: number;
  /**
   * Turns the whole travel policy on: real places with coordinates and fallbacks, a home base, a
   * current location, located commitments, and work that needs one of the places. Without it the
   * projection has nothing to project and every trip path is inert.
   */
  places?: boolean;
  /**
   * Gives every commitment a before-and-after routine: the directive's arrival check
   * looks up each commitment's earliest preparation step, and the projected day repeats that lookup
   * at every block, so without routine steps that path costs nothing here.
   */
  routines?: boolean;
}

const ROUTINE_STEPS_PER_COMMITMENT = 6;

const PLACES = ["home", "shops", "workshop"] as const;

function syntheticRequest(shape: Shape = {}): PlanForecastRequest {
  const next = pseudoRandom(20_260_818);
  const iso = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();
  const usableFraction = shape.usableFraction ?? 0.75;

  const areas = [{ id: id("area", 0), name: "Everything", status: "active" as const, sortOrder: 0 }];
  const outcomes = Array.from({ length: OUTCOME_COUNT }, (_, index) => ({
    id: id("outcome", index),
    areaId: areas[0]!.id,
    title: `Outcome ${index}`,
    definitionOfDone: `Outcome ${index} is finished.`,
    value: (index % 5) + 1,
    status: "active" as const
  }));
  const projects = Array.from({ length: PROJECT_COUNT }, (_, index) => ({
    id: id("project", index),
    title: `Project ${index}`,
    area: areas[0]!.name,
    outcomeId: outcomes[index % OUTCOME_COUNT]!.id,
    status: "active" as const,
    uncertainty: (["known", "some", "high"] as const)[index % 3]!,
    value: (index % 5) + 1,
    consequence: ((index * 2) % 5) + 1,
    // Deadlines fan out across the whole horizon so every confidence band is exercised, not just the
    // detailed one — the envelope arithmetic is where most of the per-project work happens.
    internalDeadlineAt: iso(Math.round((3 + index * 3.4) * DAY)),
    createdAt: iso(-30 * DAY)
  }));
  const actions = Array.from({ length: ACTION_COUNT }, (_, index) => {
    const expected = 15 * (1 + Math.floor(next() * 8));
    // A fifth of the work happens at a place other than home, which is what puts the trip evaluation
    // — destination window, next anchor, cheapest later moment, bundling — on the hot path.
    const elsewhere = shape.places && index % 5 === 1;
    const contexts = elsewhere ? [] : CONTEXTS.slice(index % 4, (index % 4) + 2);
    return {
      id: id("action", index),
      projectId: projects[index % PROJECT_COUNT]!.id,
      title: `Action ${index}`,
      status: (index % 17 === 0 ? "blocked" : "active") as "blocked" | "active",
      optimisticMinutes: Math.round(expected * 0.75),
      expectedMinutes: expected,
      pessimisticMinutes: Math.round(expected * 1.5),
      remainingMinutes: expected,
      splittable: index % 5 !== 0,
      setupMinutes: 5,
      energy: ENERGIES[index % ENERGIES.length]!,
      minimumSessionMinutes: 15,
      maximumSessionMinutes: 90,
      importance: (index % 5) + 1,
      consequence: ((index * 3) % 5) + 1,
      contexts,
      dependencyIds: [] as string[],
      // A handful of typed pathways, so the shared context evaluator is on the hot path the way it is
      // in a real request rather than short-circuited by the legacy list everywhere.
      requirementPathways: elsewhere
        ? [{ id: id("pathway", index), contextIds: [PLACES[1 + (index % 2)]!] }]
        : index % 6 === 0
          ? [
              { id: id("pathway", index), contextIds: contexts },
              { id: id("pathwayb", index), contextIds: [CONTEXTS[(index + 3) % CONTEXTS.length]!] }
            ]
          : [],
      preferences: [] as string[],
      createdAt: iso(-20 * DAY)
    };
  });
  // Every third action in a project waits on the one before it, so dependency ordering and the
  // backward allocation walk carry real work.
  for (let index = PROJECT_COUNT; index < actions.length; index += 3) {
    actions[index]!.dependencyIds = [actions[index - PROJECT_COUNT]!.id];
  }
  const commitments = Array.from({ length: COMMITMENT_COUNT }, (_, index) => {
    const startOffset = Math.round((0.5 + index * 0.7) * DAY);
    return {
      id: id("commitment", index),
      title: `Commitment ${index}`,
      startsAt: iso(startOffset),
      endsAt: iso(startOffset + (1 + (index % 4)) * 3_600_000),
      status: "confirmed" as const,
      setupBeforeMinutes: 10,
      transitionAfterMinutes: 10,
      // Every third commitment happens somewhere, so the projection has legs to work out and the
      // ranking has anchors to bound trips by.
      ...(shape.places && index % 3 === 0 ? { locationId: PLACES[index % PLACES.length]! } : {})
    };
  });
  const routineSteps = shape.routines
    ? commitments.flatMap((commitment, commitmentIndex) =>
        Array.from({ length: ROUTINE_STEPS_PER_COMMITMENT }, (_, sequence) => {
          const before = sequence < ROUTINE_STEPS_PER_COMMITMENT / 2;
          const anchor = new Date(before ? commitment.startsAt : commitment.endsAt).getTime();
          const offset = before
            ? -(ROUTINE_STEPS_PER_COMMITMENT / 2 - sequence) * 15 * 60_000
            : (sequence - ROUTINE_STEPS_PER_COMMITMENT / 2) * 15 * 60_000;
          return {
            id: id("routine", commitmentIndex * ROUTINE_STEPS_PER_COMMITMENT + sequence),
            commitmentId: commitment.id,
            anchorType: "commitment" as const,
            anchorId: commitment.id,
            title: `Step ${sequence} for ${commitment.title}`,
            durationMinutes: 15,
            sequence,
            timingRule: "contiguous" as const,
            energy: "low" as const,
            contexts: [] as string[],
            phase: before ? ("before" as const) : ("after" as const),
            status: "pending" as const,
            scheduledStartAt: new Date(anchor + offset).toISOString(),
            scheduledEndAt: new Date(anchor + offset + 15 * 60_000).toISOString()
          };
        })
      )
    : [];
  // Places carry coordinates as well as a fallback, so the haversine estimate is on the path too.
  const conditionDefinitions = shape.places
    ? PLACES.map((name, index) => ({
        id: name,
        name,
        kind: "location" as const,
        status: "active" as const,
        grants: [] as string[],
        travelMinutes: 10 + index * 8,
        latitude: -36.08 - index * 0.02,
        longitude: 146.91 + index * 0.03
      }))
    : [];

  return planForecastRequestSchema.parse({
    contractVersion: "1",
    requestId: id("request", 1),
    inputVersion: "performance-benchmark",
    calculatedAt: NOW.toISOString(),
    horizonEnd: HORIZON.toISOString(),
    state: {
      settings: {
        timezone: "Australia/Sydney",
        planningHorizonEnd: "22:00",
        defaultUsableFraction: usableFraction,
        defaultSetupBufferMinutes: 10,
        defaultTransitionBufferMinutes: 10,
        submissionBufferMinutes: 60,
        submissionBufferPercent: 0.1,
        energyMeanings: { high: "High", medium: "Medium", low: "Low", recovery: "Recovery" },
        estimateBucketsMinutes: [5, 15, 30, 60, 90, 120],
        conditionCatalog: CONTEXTS,
        preferredBedtime: "22:30",
        preferredWakeTime: "06:30",
        desiredSleepMinutes: 480,
        minimumSleepMinutes: 360,
        maxAwakeHours: 17,
        lastWokeAt: iso(-3 * 3_600_000),
        ...(shape.places ? { homeLocationId: "home" } : {})
      },
      areas,
      outcomes,
      projects,
      actions,
      commitments,
      routineSteps,
      sleepPlans: [],
      captures: [],
      completedToday: [],
      assertedConditions: ["home", "laptop", "online"],
      conditionDefinitions,
      ...(shape.places
        ? {
            currentSituation: {
              locationId: "home",
              locationSetAt: NOW.toISOString(),
              transportModes: ["car", "bike"],
              travel: { shops: { minutes: 12, mode: "car", refreshedAt: NOW.toISOString() } }
            }
          }
        : {}),
      currentEnergy: "medium",
      horizonEnd: HORIZON.toISOString(),
      activeSession: null
    },
    ...(shape.continuation ? { continuation: shape.continuation } : {})
  });
}

function timed<T>(run: () => T): { result: T; ms: number } {
  const started = performance.now();
  const result = run();
  return { result, ms: performance.now() - started };
}

const ATTEMPTS = 3;

/** The fastest of up to ATTEMPTS runs, stopping at the first under the ceiling; see the note above. */
function fastest<T>(run: () => T, ceilingMs: number): { result: T; ms: number; runs: string } {
  const times: number[] = [];
  let best = timed(run);
  times.push(best.ms);
  while (best.ms >= ceilingMs && times.length < ATTEMPTS) {
    const next = timed(run);
    times.push(next.ms);
    if (next.ms < best.ms) best = next;
  }
  return { ...best, runs: times.map((ms) => ms.toFixed(0)).join(", ") };
}

describe("whole-engine performance at live request size", () => {
  it(`plans ${ACTION_COUNT} actions over ${PROJECT_COUNT} projects within ${CEILING_MS}ms`, () => {
    const request = syntheticRequest();
    // The first call pays for module warm-up and JIT; the measurement is of a steady-state request,
    // which is what the worker actually serves.
    const warm = calculatePlanAndForecast(request);
    const { result, ms, runs } = fastest(() => calculatePlanAndForecast(request), CEILING_MS);

    // Not vacuous: the benchmark must be planning the whole request, not bailing out early.
    const forecasts = (result.schedule as { forecasts: { projectId: string }[] }).forecasts;
    expect(forecasts).toHaveLength(PROJECT_COUNT);
    expect((result.recommendation as { candidates: unknown[] }).candidates.length).toBeGreaterThan(0);
    // The projected day rides inside the same call: one ranking per block, bounded by the step cap. It
    // is measured here rather than separately so a change that made a block cost a whole re-plan shows
    // up against the same ceiling.
    expect(result.dayPlan).toBeDefined();
    expect(result.dayPlan!.blocks.length).toBeGreaterThan(1);
    expect(result.dayPlan!.blocks.length).toBeLessThanOrEqual(DAY_PLAN_STEP_CAP);
    expect(result.dayPlan!.truncated).toBe(false);

    // Identical input, identical bytes — including the run that was measured.
    expect(JSON.stringify(result)).toBe(JSON.stringify(warm));
    expect(JSON.stringify(calculatePlanAndForecast(syntheticRequest()))).toBe(JSON.stringify(result));

    // eslint-disable-next-line no-console
    console.log(
      `calculatePlanAndForecast: ${ms.toFixed(0)}ms of runs ${runs} (day plan: ${result.dayPlan!.blocks.length} blocks)`
    );
    expect
      .soft(ms, `calculatePlanAndForecast took ${ms.toFixed(0)}ms (ceiling ${CEILING_MS}ms)`)
      .toBeLessThan(CEILING_MS);
  }, 60_000);

  it(`plans the same request with places and journeys in it within ${CEILING_MS}ms`, () => {
    // The travel policy adds a projection of the day, a journey attached to every located commitment,
    // and a trip evaluation for every candidate blocked only by being elsewhere — the last of which
    // scans the destination's window and every later moment the projection offers. The cost is
    // measured against the same ceiling as the plain request, because it rides inside the same call.
    const plain = syntheticRequest();
    const request = syntheticRequest({ places: true });
    const warm = calculatePlanAndForecast(request);
    const { result, ms, runs } = fastest(() => calculatePlanAndForecast(request), CEILING_MS);
    const { ms: withoutPlaces } = timed(() => calculatePlanAndForecast(plain));

    // Not vacuous: the policy must actually have something to do.
    const recommendation = result.recommendation as {
      candidates: Array<{ trip?: unknown; tripReason?: unknown }>;
    };
    expect(recommendation.candidates.some((item) => item.trip ?? item.tripReason)).toBe(true);
    expect(result.dayPlan!.locations.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).toBe(JSON.stringify(warm));

    // eslint-disable-next-line no-console
    console.log(
      `calculatePlanAndForecast with places: ${ms.toFixed(0)}ms of runs ${runs} versus ${withoutPlaces.toFixed(0)}ms without (delta ${(ms - withoutPlaces).toFixed(0)}ms)`
    );
    expect.soft(ms, `travel-aware run took ${ms.toFixed(0)}ms (ceiling ${CEILING_MS}ms)`).toBeLessThan(CEILING_MS);
  }, 60_000);

  it(`plans the same request with a routine on every commitment within ${CEILING_MS}ms`, () => {
    // every directive the projected day replays looks up each commitment's earliest
    // preparation step. Measured against the same ceiling, because it rides inside the same call.
    const request = syntheticRequest({ routines: true });
    const warm = calculatePlanAndForecast(request);
    const { result, ms, runs } = fastest(() => calculatePlanAndForecast(request), CEILING_MS);

    // Not vacuous: the routine must reach the plan.
    expect(request.state.routineSteps).toHaveLength(COMMITMENT_COUNT * ROUTINE_STEPS_PER_COMMITMENT);
    expect(result.dayPlan!.blocks.length).toBeGreaterThan(1);
    expect(JSON.stringify(result)).toBe(JSON.stringify(warm));

    // eslint-disable-next-line no-console
    console.log(`calculatePlanAndForecast with routines: ${ms.toFixed(0)}ms of runs ${runs}`);
    expect.soft(ms, `routine run took ${ms.toFixed(0)}ms (ceiling ${CEILING_MS}ms)`).toBeLessThan(CEILING_MS);
  }, 60_000);

  it(`simulates a continuation on the same request within ${CONTINUATION_CEILING_MS}ms`, () => {
    const base = syntheticRequest();
    const actionId = (base.state.actions.find((action) => action.status === "active") ?? base.state.actions[0]!).id;
    const request = syntheticRequest({ continuation: { actionId, requestedMinutes: 60 } });
    const warm = calculatePlanAndForecast(request);
    const { result, ms, runs } = fastest(() => calculatePlanAndForecast(request), CONTINUATION_CEILING_MS);

    expect(result.continuation).not.toBeNull();
    expect(JSON.stringify(result)).toBe(JSON.stringify(warm));

    // eslint-disable-next-line no-console
    console.log(`calculatePlanAndForecast with continuation: ${ms.toFixed(0)}ms of runs ${runs}`);
    expect
      .soft(ms, `continuation run took ${ms.toFixed(0)}ms (ceiling ${CONTINUATION_CEILING_MS}ms)`)
      .toBeLessThan(CONTINUATION_CEILING_MS);
  }, 60_000);

  /**
   * The speed above comes from caches that survive between requests, so the thing worth proving is
   * that they cannot leak across one.
   *
   * They are keyed on what the slot offers — energy, availability, usable fraction and contexts,
   * joined into a signature — and on the action object itself, never on identifiers. Automatic
   * capacity gives every window the same energy and empty contexts, so the one thing left that still
   * separates two requests is the usable fraction each declares: it flows straight into the
   * synthesised windows' `usableFraction`, so a request that declares 0.8 offers slots a request
   * declaring 0.4 cannot, and the two must schedule differently. A cache keyed by id instead of by
   * that offer would hand the second request the first one's answers regardless. Interleaving them
   * and comparing each to its own undisturbed run is what catches that.
   */
  it("keeps two requests that share action ids from reading each other's cached answers", () => {
    const roomy: Shape = { usableFraction: 0.8 };
    const tight: Shape = { usableFraction: 0.4 };
    const firstAlone = calculatePlanAndForecast(syntheticRequest(roomy));
    const secondAlone = calculatePlanAndForecast(syntheticRequest(tight));

    // Not vacuous: the same actions must genuinely be answered differently by the two, or an id-keyed
    // cache would pass this by coincidence.
    expect(new Set(syntheticRequest(tight).state.actions.map((action) => action.id))).toEqual(
      new Set(syntheticRequest(roomy).state.actions.map((action) => action.id))
    );
    expect(JSON.stringify(secondAlone.schedule)).not.toBe(JSON.stringify(firstAlone.schedule));

    // Interleaved, each still answers as it did undisturbed.
    expect(JSON.stringify(calculatePlanAndForecast(syntheticRequest(roomy)))).toBe(JSON.stringify(firstAlone));
    expect(JSON.stringify(calculatePlanAndForecast(syntheticRequest(tight)))).toBe(JSON.stringify(secondAlone));
    expect(JSON.stringify(calculatePlanAndForecast(syntheticRequest(roomy)))).toBe(JSON.stringify(firstAlone));
  }, 120_000);
});
