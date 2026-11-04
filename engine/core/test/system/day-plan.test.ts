import { describe, expect, it } from "vitest";
import {
  PLAN_FORECAST_CONTRACT_VERSION,
  planForecastRequestSchema,
  planForecastResponseSchema,
  portalStateSchema,
  type DayPlan,
  type DayPlanBlock,
  type PlanForecastRequest,
  type PlanForecastResponse
} from "@openrhen/contracts";
import {
  DAY_PLAN_STEP_CAP,
  calculatePlanAndForecast,
  planSchedule,
  type Action,
  type CapacityWindow,
  type FixedCommitment,
  type Project
} from "../../src/index.js";
import { dayPlanFor } from "../model/day-plan-harness.js";
import replannedSleepStaysDirectable from "../snapshot-replay/synthetic/replanned-sleep-stays-directable.json" with { type: "json" };
import bedtimeRoutineSurvivesMidnightRollover from "../snapshot-replay/synthetic/bedtime-routine-survives-midnight-rollover.json" with { type: "json" };
import completedOverriddenSleepPlanStopsBlockingCapacity from "../snapshot-replay/synthetic/completed-overridden-sleep-plan-stops-blocking-capacity.json" with { type: "json" };

/**
 * The projected day is the current directive policy replayed forward. These tests hold it to that:
 * block 0 is the live directive, following the plan reproduces the rest of it, deviating re-simulates
 * from the new facts, and none of it depends on array order or runs away.
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
  remaining?: number;
  maxSession?: number;
  minSession?: number;
  lastWorkedAt?: string;
  status?: string;
  dependencyIds?: string[];
}

interface Shape {
  actions?: ActionSpec[];
  commitments?: Array<{ id: string; startHour: number; endHour: number }>;
  activeSession?: Record<string, unknown> | null;
  deliverables?: Record<string, unknown>[];
  calculatedAt?: string;
  currentEnergy?: string;
}

/**
 * Ample capacity, deadlines two months out, and clearly separated project values, so the projected
 * day depends on ranking and session bounds alone — never on a margin sitting at a health threshold or
 * two scores one rounding step apart, which are the forecast-drift cases policy replay does not model.
 */
function fixture(shape: Shape = {}): PlanForecastRequest {
  const calculatedAt = shape.calculatedAt ?? now.toISOString();
  const projects = [
    { id: "alpha", value: 5, consequence: 5 },
    { id: "beta", value: 3, consequence: 3 },
    { id: "gamma", value: 1, consequence: 1 }
  ].map((project) => ({
    ...project,
    title: project.id,
    area: "Everything",
    outcomeId: "outcome",
    status: "active" as const,
    uncertainty: "known" as const,
    internalDeadlineAt: iso(60 * DAY)
  }));
  const actions = (
    shape.actions ?? [
      { id: "a1", projectId: "alpha", minutes: 120 },
      // 50, not 60: single-figure estimates are now padded, and at 60 the two alpha actions tie closely enough
      // after a partial session that live and replayed ranking pick differently (the forecast-drift case).
      { id: "a2", projectId: "alpha", minutes: 50 },
      { id: "b1", projectId: "beta", minutes: 90 },
      { id: "c1", projectId: "gamma", minutes: 45 }
    ]
  ).map((action) => ({
    id: action.id,
    projectId: action.projectId,
    title: action.id,
    status: action.status ?? "active",
    optimisticMinutes: action.minutes,
    expectedMinutes: action.minutes,
    pessimisticMinutes: action.minutes,
    remainingMinutes: action.remaining ?? action.minutes,
    energy: "medium",
    minimumSessionMinutes: action.minSession ?? 15,
    maximumSessionMinutes: action.maxSession ?? 60,
    importance: 3,
    consequence: 3,
    contexts: [],
    dependencyIds: action.dependencyIds ?? [],
    splittable: true,
    setupMinutes: 0,
    ...(action.lastWorkedAt ? { lastWorkedAt: action.lastWorkedAt } : {})
  }));
  const commitments = (shape.commitments ?? [{ id: "lunch-meeting", startHour: 2, endHour: 3 }]).map((item) => ({
    id: item.id,
    title: item.id,
    status: "confirmed" as const,
    startsAt: iso(item.startHour * HOUR),
    endsAt: iso(item.endHour * HOUR),
    setupBeforeMinutes: 0,
    transitionAfterMinutes: 0
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
      conditionCatalog: ["home"],
      preferredBedtime: "23:00",
      preferredWakeTime: "07:00",
      desiredSleepMinutes: 480,
      minimumSleepMinutes: 420,
      maxAwakeHours: 16
    },
    areas: [{ id: "area", name: "Everything", status: "active", sortOrder: 0 }],
    outcomes: [
      { id: "outcome", areaId: "area", title: "Outcome", definitionOfDone: "Done.", value: 3, status: "active" }
    ],
    projects,
    actions,
    commitments,
    routineSteps: [],
    sleepPlans: [],
    captures: [],
    completedToday: [],
    assertedConditions: ["home"],
    currentEnergy: shape.currentEnergy ?? "medium",
    horizonEnd: iso(30 * DAY),
    activeSession: shape.activeSession ?? null
  });
  return planForecastRequestSchema.parse({
    contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
    requestId: "00000000-0000-4000-8000-00000000da71",
    inputVersion: "day-plan-fixture",
    calculatedAt,
    horizonEnd: iso(30 * DAY),
    state,
    ...(shape.deliverables ? { deliverables: shape.deliverables } : {})
  });
}

const projection = {
  id: "assessment",
  projectId: "alpha",
  title: "Assessment",
  status: "in_progress",
  approved: true,
  remainingMinutes: 150,
  minimumUsefulSessionMinutes: 20,
  uncertainty: "known",
  importance: 5,
  consequence: 5,
  executionOptions: [
    {
      id: "draft",
      title: "Draft it",
      optimisticMinutes: 60,
      expectedMinutes: 90,
      pessimisticMinutes: 120,
      remainingMinutes: 90,
      energy: "medium",
      minimumSessionMinutes: 20,
      maximumSessionMinutes: 60
    }
  ]
};

const shape = (block: DayPlanBlock) =>
  [block.startsAt, block.endsAt, block.kind, block.targetId, block.focusedMinutes] as const;

/**
 * The world after following one block exactly: the session's focused minutes come off remaining
 * effort, the action was last worked when the block ended, and a finished action is done — the same
 * fields the portal writes when a session ends. Time moves to the block's end. Blocks that are not
 * work only move time.
 */
function follow(request: PlanForecastRequest, block: DayPlanBlock): PlanForecastRequest {
  const state = request.state;
  const actions =
    block.kind === "action"
      ? state.actions.map((action) => {
          if (action.id !== block.targetId) return action;
          const remaining = action.remainingMinutes - block.focusedMinutes;
          return {
            ...action,
            remainingMinutes: Math.max(0, remaining),
            lastWorkedAt: block.endsAt,
            ...(remaining <= 0 ? { status: "done" as const } : {})
          };
        })
      : state.actions;
  return planForecastRequestSchema.parse({
    ...request,
    calculatedAt: block.endsAt,
    state: { ...state, actions, activeSession: null }
  });
}

/** Rolls through the plan block by block, checking after each that the rest of the plan is unchanged. */
function assertFixedPoint(request: PlanForecastRequest, steps: number) {
  let current = request;
  let plan = calculatePlanAndForecast(current).dayPlan!;
  expect(plan.blocks.length).toBeGreaterThan(steps);
  for (let step = 0; step < steps; step += 1) {
    const done = plan.blocks[0]!;
    current = follow(current, done);
    const next = calculatePlanAndForecast(current);
    const replanned = next.dayPlan!;
    expect(replanned.blocks.map(shape), `after following ${done.kind} ${done.targetId} (step ${step})`).toEqual(
      plan.blocks.slice(1).map(shape)
    );
    // The drift diagnostic: under policy replay the count of differing blocks is the divergence.
    expect(differingBlocks(plan.blocks.slice(1), replanned.blocks)).toBe(0);
    plan = replanned;
  }
  return plan;
}

function differingBlocks(simulated: DayPlanBlock[], live: DayPlanBlock[]): number {
  const length = Math.max(simulated.length, live.length);
  let differing = 0;
  for (let index = 0; index < length; index += 1) {
    const a = simulated[index];
    const b = live[index];
    if (!a || !b || JSON.stringify(shape(a)) !== JSON.stringify(shape(b))) differing += 1;
  }
  return differing;
}

/**
 * How many blocks left the shared order: the block count less the longest common subsequence of
 * (kind, target, focused minutes) between the two plans. One ranking flip early in the day shifts every
 * later start time, so the positional count above overstates what actually moved; this says how many
 * blocks would have to be lifted out for the two plans to read the same.
 */
function blocksOutOfOrder(simulated: DayPlanBlock[], live: DayPlanBlock[]): number {
  const key = (block: DayPlanBlock) => `${block.kind}|${block.targetId}|${block.focusedMinutes}`;
  const a = simulated.map(key);
  const b = live.map(key);
  const table: number[][] = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i += 1)
    for (let j = 1; j <= b.length; j += 1)
      table[i]![j] = a[i - 1] === b[j - 1] ? table[i - 1]![j - 1]! + 1 : Math.max(table[i - 1]![j]!, table[i]![j - 1]!);
  return Math.max(a.length, b.length) - table[a.length]![b.length]!;
}

function directiveTarget(response: PlanForecastResponse): string | null {
  const directive = response.currentDirective;
  return "targetId" in directive ? directive.targetId : null;
}

describe("day plan: block 0 is the live directive", () => {
  const cases: Array<[string, PlanForecastRequest]> = [
    ["fixed-point fixture", fixture()],
    ["active session at t0", fixture({ activeSession: activeSession("b1") })],
    ["deliverable unit", fixture({ deliverables: [projection] })],
    ...(
      [
        ["replanned-sleep-stays-directable.json", replannedSleepStaysDirectable],
        ["bedtime-routine-survives-midnight-rollover.json", bedtimeRoutineSurvivesMidnightRollover],
        [
          "completed-overridden-sleep-plan-stops-blocking-capacity.json",
          completedOverriddenSleepPlanStopsBlockingCapacity
        ]
      ] as Array<[string, { request: unknown }]>
    ).map(([file, raw]): [string, PlanForecastRequest] => [file, planForecastRequestSchema.parse(raw.request)])
  ];
  for (const [name, request] of cases) {
    it(`${name}`, () => {
      const response = calculatePlanAndForecast(request);
      const plan = response.dayPlan!;
      const first = plan.blocks[0]!;
      expect(planForecastResponseSchema.parse(response).dayPlan).toEqual(plan);
      expect(first.startsAt).toBe(response.calculatedAt);
      expect(first.confidence).toBe("firm");
      const directive = response.currentDirective;
      const expectedKind =
        directive.kind === "answer" || directive.kind === "boundary"
          ? "gap"
          : directive.kind === "none"
            ? (response.recommendation as { protectedCommitment?: unknown }).protectedCommitment
              ? "commitment"
              : "gap"
            : directive.kind;
      expect(first.kind).toBe(expectedKind);
      if (directive.kind === "action" || directive.kind === "deliverable") {
        expect(first.targetId).toBe(directiveTarget(response));
        expect(first.title).toBe(directive.title);
        expect(first.focusedMinutes).toBe(directive.recommendedMinutes);
        expect(first.wallClockMinutes).toBeGreaterThanOrEqual(first.focusedMinutes);
      } else if (directive.kind === "sleep" || directive.kind.startsWith("routine")) {
        expect(first.targetId).toBe(directiveTarget(response));
      }
      for (const block of plan.blocks) expect(new Date(block.endsAt) >= new Date(block.startsAt)).toBe(true);
      for (let index = 1; index < plan.blocks.length; index += 1)
        expect(plan.blocks[index]!.startsAt).toBe(plan.blocks[index - 1]!.endsAt);
    });
  }
});

function activeSession(actionId: string, minutesAgo = 20) {
  return {
    id: "session-1",
    actionId,
    status: "running",
    targetType: "action",
    targetId: actionId,
    startedAt: iso(-minutesAgo * MINUTE),
    plannedEndAt: iso(40 * MINUTE),
    plannedMinutes: 60,
    remainingBeforeMinutes: 90,
    activeElapsedSeconds: minutesAgo * 60
  };
}

describe("day plan: following it reproduces it (compliance fixed point)", () => {
  it("rolls through four blocks of the plain fixture, a commitment among them", () => {
    const plan = calculatePlanAndForecast(fixture()).dayPlan!;
    expect(plan.mode).toBe("policy_replay");
    expect(plan.truncated).toBe(false);
    // The fixture is only worth its name if it exercises work on both sides of the commitment.
    expect(plan.blocks.map((block) => block.kind)).toEqual(
      expect.arrayContaining(["action", "commitment", "gap"] as const)
    );
    const commitment = plan.blocks.find((block) => block.kind === "commitment")!;
    expect(commitment.confidence).toBe("firm");
    expect(commitment.startsAt).toBe(iso(2 * HOUR));
    expect(commitment.endsAt).toBe(iso(3 * HOUR));
    // The day closes at the daily horizon: 20:00 local is 10:00Z.
    expect(plan.through).toBe(iso(10 * HOUR));
    expect(plan.blocks.at(-1)!.endsAt).toBe(plan.through);
    assertFixedPoint(fixture(), 4);
  });

  it("holds with a session already running at t0", () => {
    const request = fixture({ activeSession: activeSession("b1") });
    const response = calculatePlanAndForecast(request);
    const first = response.dayPlan!.blocks[0]!;
    // Block 0 is the running session's action, exclusive while it runs, exactly as the directive says.
    expect(response.currentDirective).toMatchObject({ kind: "action", targetId: "b1" });
    expect(first.targetId).toBe("b1");
    assertFixedPoint(request, 3);
  });

  it("holds with a deliverable unit among the candidates", () => {
    const request = fixture({ deliverables: [projection] });
    const plan = calculatePlanAndForecast(request).dayPlan!;
    // Not vacuous: the deliverable must actually be placed, under its deliverable id.
    const placed = plan.blocks.filter((block) => block.kind === "deliverable");
    expect(placed.length).toBeGreaterThan(0);
    expect(placed[0]!.targetId).toBe("assessment");
    expect(placed[0]!.projectId).toBe("alpha");
    // Following a deliverable block is a projection change the portal makes; the fixed point is
    // asserted across the action blocks that surround it by rolling until the first deliverable block.
    const untilDeliverable = plan.blocks.findIndex((block) => block.kind === "deliverable");
    if (untilDeliverable > 0) assertFixedPoint(request, Math.min(untilDeliverable, 3));
    // And when the deliverable is worked to zero on the portal's side, the rest of the plan is the
    // remaining actions in the same order.
    const rest = calculatePlanAndForecast(
      planForecastRequestSchema.parse({
        ...request,
        calculatedAt: placed[0]!.endsAt,
        deliverables: [{ ...projection, remainingMinutes: 0, status: "ready_to_complete" }],
        state: {
          ...request.state,
          actions: request.state.actions.map((action) => {
            const earlier = plan.blocks.find(
              (block) => block.kind === "action" && block.targetId === action.id && block.endsAt <= placed[0]!.startsAt
            );
            return earlier
              ? {
                  ...action,
                  remainingMinutes: Math.max(0, action.remainingMinutes - earlier.focusedMinutes),
                  lastWorkedAt: earlier.endsAt
                }
              : action;
          })
        }
      })
    ).dayPlan!;
    expect(rest.blocks.some((block) => block.kind === "deliverable")).toBe(false);
  });
});

describe("day plan: deviation re-simulates from the new facts", () => {
  it("moves the skipped work later, keeps the rest in order, and never plans before now", () => {
    const request = fixture();
    const plan = calculatePlanAndForecast(request).dayPlan!;
    const [first, second] = plan.blocks;
    expect(first!.kind).toBe("action");
    expect(second!.kind).toBe("action");
    // Instead of block 0's action, the person did something else of the same length.
    const other = request.state.actions.find((action) => action.id !== first!.targetId && action.id !== "a2")!;
    const deviated = planForecastRequestSchema.parse({
      ...request,
      calculatedAt: first!.endsAt,
      state: {
        ...request.state,
        actions: request.state.actions.map((action) =>
          action.id === other.id
            ? {
                ...action,
                remainingMinutes: Math.max(0, action.remainingMinutes - first!.focusedMinutes),
                lastWorkedAt: first!.endsAt
              }
            : action
        )
      }
    });
    const replanned = calculatePlanAndForecast(deviated).dayPlan!;
    for (const block of replanned.blocks) expect(new Date(block.startsAt) >= new Date(first!.endsAt)).toBe(true);
    // The skipped action still has all its work; it is placed somewhere in the day.
    expect(replanned.blocks.some((block) => block.targetId === first!.targetId)).toBe(true);
    // Everything neither done nor skipped keeps its relative order.
    const order = (blocks: DayPlanBlock[]) =>
      blocks
        .filter((block) => block.kind === "action" && block.targetId !== first!.targetId && block.targetId !== other.id)
        .map((block) => block.targetId)
        .filter((id, index, all) => all.indexOf(id) === index);
    expect(order(replanned.blocks)).toEqual(order(plan.blocks.slice(1)));
  });
});

describe("day plan: determinism and bounds", () => {
  it("is identical whatever order actions, projects and commitments arrive in", () => {
    const request = fixture({
      actions: [
        { id: "a1", projectId: "alpha", minutes: 120 },
        { id: "a2", projectId: "alpha", minutes: 50 },
        { id: "b1", projectId: "beta", minutes: 90 },
        { id: "b2", projectId: "beta", minutes: 90 },
        { id: "c1", projectId: "gamma", minutes: 45 },
        { id: "c2", projectId: "gamma", minutes: 45 }
      ],
      commitments: [
        { id: "lunch-meeting", startHour: 2, endHour: 3 },
        { id: "call", startHour: 5, endHour: 5.5 }
      ]
    });
    const baseline = JSON.stringify(calculatePlanAndForecast(request).dayPlan);
    const rotate = <T>(items: T[], by: number) => [...items.slice(by), ...items.slice(0, by)];
    for (const by of [1, 2, 3]) {
      const shuffled = planForecastRequestSchema.parse({
        ...request,
        state: {
          ...request.state,
          actions: rotate(request.state.actions, by),
          projects: rotate(request.state.projects, by % 3),
          commitments: [...request.state.commitments].reverse()
        }
      });
      expect(JSON.stringify(calculatePlanAndForecast(shuffled).dayPlan)).toBe(baseline);
    }
  });

  it("stays within the step cap and always advances the clock", () => {
    // Eighty five-minute actions is more sessions than the cap allows; the cap, not the day, ends it.
    const request = fixture({
      actions: Array.from({ length: 80 }, (_, index) => ({
        id: `t${String(index).padStart(2, "0")}`,
        projectId: (["alpha", "beta", "gamma"] as const)[index % 3]!,
        minutes: 5,
        minSession: 5,
        maxSession: 5
      })),
      commitments: []
    });
    const plan = calculatePlanAndForecast(request).dayPlan!;
    expect(plan.blocks.length).toBeLessThanOrEqual(DAY_PLAN_STEP_CAP);
    expect(plan.truncated).toBe(true);
    for (let index = 1; index < plan.blocks.length; index += 1)
      expect(new Date(plan.blocks[index]!.startsAt) > new Date(plan.blocks[index - 1]!.startsAt)).toBe(true);
  });

  it("simulates more than one day when asked, each to its own horizon", () => {
    // The engine's default is one day; the knob is exercised through the exported seam over a manual
    // window that spans two local days.
    const oneDay = calculatePlanAndForecast(fixture()).dayPlan!;
    expect(new Date(oneDay.through).getTime()).toBe(now.getTime() + 10 * HOUR);
    const projects: Project[] = [
      { id: "p", status: "active", uncertainty: "known", value: 3, consequence: 3, outcomeActive: true }
    ];
    const actions: Action[] = ["x1", "x2", "x3", "x4"].map((id) => ({
      id,
      projectId: "p",
      title: id,
      status: "active",
      remainingMinutes: 240,
      pessimisticMinutes: 240,
      expectedMinutes: 240,
      energy: "high",
      minimumSessionMinutes: 30,
      maximumSessionMinutes: 120,
      importance: 3,
      consequence: 3,
      contexts: [],
      dependenciesComplete: true,
      splittable: true
    }));
    const window: CapacityWindow = {
      id: "w",
      startsAt: now,
      endsAt: new Date(now.getTime() + 2 * DAY),
      energy: "high",
      contexts: [],
      usableFraction: 1
    };
    const args = {
      now,
      horizonEnd: new Date(now.getTime() + 7 * DAY),
      projects,
      actions,
      capacityWindows: [window],
      commitments: [] as FixedCommitment[],
      timezone: "Australia/Sydney"
    };
    const planning = planSchedule(args);
    const twoDays = dayPlanFor({ ...args, planning }, { planningHorizonEnd: "20:00", dayPlanDays: 2 });
    const dayOneHorizon = now.getTime() + 10 * HOUR;
    expect(new Date(twoDays.through).getTime()).toBe(dayOneHorizon + DAY);
    expect(twoDays.truncated).toBe(false);
    const work = twoDays.blocks.filter((block) => block.kind === "action");
    // Work on both days, and none of it planned between one day's horizon and the next day.
    expect(work.some((block) => new Date(block.startsAt).getTime() < dayOneHorizon)).toBe(true);
    expect(work.some((block) => new Date(block.startsAt).getTime() >= dayOneHorizon + 4 * HOUR)).toBe(true);
    for (const block of work) {
      const start = new Date(block.startsAt).getTime();
      expect(start < dayOneHorizon || start >= dayOneHorizon + 4 * HOUR).toBe(true);
    }
    expect(twoDays.blocks.at(-1)!.endsAt).toBe(twoDays.through);
  });

  it("starts the next planning day at its wake when a multi-day replay begins after an overnight horizon has passed", () => {
    // seed-zone, 00:45 on 17 August with a 00:30 end and a 07:00 wake: the night's horizon has passed, the
    // active planning day began on the 16th, and the two-day bound reaches into the day that starts at
    // 07:00. The replay must stop at that wake rather than jump to the next midnight, which skipped
    // the whole of that day's working time.
    const at = new Date("2026-08-16T14:45:00.000Z");
    const projects: Project[] = [
      { id: "p", status: "active", uncertainty: "known", value: 3, consequence: 3, outcomeActive: true }
    ];
    const actions: Action[] = ["x1", "x2"].map((id) => ({
      id,
      projectId: "p",
      title: id,
      status: "active",
      remainingMinutes: 240,
      pessimisticMinutes: 240,
      expectedMinutes: 240,
      energy: "high",
      minimumSessionMinutes: 30,
      maximumSessionMinutes: 120,
      importance: 3,
      consequence: 3,
      contexts: [],
      dependenciesComplete: true,
      splittable: true
    }));
    const window: CapacityWindow = {
      id: "w",
      startsAt: at,
      endsAt: new Date(at.getTime() + 2 * DAY),
      energy: "high",
      contexts: [],
      usableFraction: 1
    };
    const args = {
      now: at,
      horizonEnd: new Date(at.getTime() + 7 * DAY),
      projects,
      actions,
      capacityWindows: [window],
      commitments: [] as FixedCommitment[],
      timezone: "Australia/Sydney",
      // The night's 00:30 end, already behind `at`.
      dailyHorizonEnd: new Date("2026-08-16T14:30:00.000Z")
    };
    const plan = dayPlanFor({ ...args, planning: planSchedule(args) }, { planningHorizonEnd: "00:30", dayPlanDays: 2 });
    const wake = new Date("2026-08-16T21:00:00.000Z").getTime();
    const work = plan.blocks.filter((block) => block.kind === "action");
    // Nothing between the passed horizon and wake, and real work from the wake onward on the new day.
    expect(work.every((block) => new Date(block.startsAt).getTime() >= wake)).toBe(true);
    expect(work.length).toBeGreaterThan(0);
    expect(work.some((block) => new Date(block.startsAt).getTime() < wake + 6 * HOUR)).toBe(true);
    // A block begins exactly at the wake, and the plan runs to the new day's own end (00:30 on the 18th).
    expect(plan.blocks.some((block) => new Date(block.startsAt).getTime() === wake)).toBe(true);
    expect(new Date(plan.through).getTime()).toBe(new Date("2026-08-17T14:30:00.000Z").getTime());
  });

  it("emits a displaced entry only when a latest safe start inside the plan is not reached in time", () => {
    const plan = calculatePlanAndForecast(fixture()).dayPlan!;
    // Deadlines two months out: nothing has a latest safe start today.
    expect(plan.displaced).toEqual([]);
  });
});

describe("day plan: drift diagnostic on real snapshots (reported, not enforced)", () => {
  // Policy replay keeps slots and forecasts frozen at calculation, so after block 0 is followed the
  // live recompute can differ from the simulated tail where a forecast, health or tier moved with the
  // clock. On the fixed-point fixture above that count is asserted to be zero; on captured snapshots it
  // is a measurement — the (B) caveat made visible — not a pass/fail.
  const snapshots: Array<[string, unknown]> = [
    ["replanned-sleep-stays-directable.json", replannedSleepStaysDirectable],
    ["bedtime-routine-survives-midnight-rollover.json", bedtimeRoutineSurvivesMidnightRollover],
    ["completed-overridden-sleep-plan-stops-blocking-capacity.json", completedOverriddenSleepPlanStopsBlockingCapacity]
  ];
  for (const [file, raw] of snapshots) {
    it(`${file}: reports differing blocks after following block 0`, () => {
      const request = planForecastRequestSchema.parse((raw as { request: unknown }).request);
      const plan = calculatePlanAndForecast(request).dayPlan!;
      const first = plan.blocks[0]!;
      if (first.kind !== "action") {
        // eslint-disable-next-line no-console
        console.log(`drift ${file}: block 0 is ${first.kind}; not followed`);
        return;
      }
      const replanned = calculatePlanAndForecast(follow(request, first)).dayPlan!;
      const simulated = plan.blocks.slice(1);
      const drift = differingBlocks(simulated, replanned.blocks);
      const moved = blocksOutOfOrder(simulated, replanned.blocks);
      // eslint-disable-next-line no-console
      console.log(
        `drift ${file}: ${drift} of ${simulated.length} simulated blocks differ positionally from the live recompute; ${moved} out of order`
      );
      expect(drift).toBeGreaterThanOrEqual(moved);
    });
  }
});

describe("day plan: contract", () => {
  it("parses a stored result that predates the day plan", () => {
    const response = calculatePlanAndForecast(fixture());
    const { dayPlan: _dayPlan, ...withoutDayPlan } = response;
    expect(planForecastResponseSchema.parse(withoutDayPlan).dayPlan).toBeUndefined();
    expect(planForecastResponseSchema.parse(response).dayPlan).toBeDefined();
  });

  it("emits ISO instants and integer minutes", () => {
    const plan: DayPlan = calculatePlanAndForecast(fixture()).dayPlan!;
    for (const block of plan.blocks) {
      expect(new Date(block.startsAt).toISOString()).toBe(block.startsAt);
      expect(Number.isInteger(block.focusedMinutes)).toBe(true);
      expect(Number.isInteger(block.wallClockMinutes)).toBe(true);
    }
  });
});

describe("day plan: the maximum-session break (ranking-consistency)", () => {
  it("rests the only action for exactly the break, then resumes it", () => {
    // One action, longer than one max session: the first session hits the maximum, the action is
    // ineligible for the default 15-minute break, and with nothing else to offer the replay emits a
    // plain gap of exactly that length before resuming the same action.
    const request = fixture({
      actions: [{ id: "a1", projectId: "alpha", minutes: 150, minSession: 15, maxSession: 60 }],
      commitments: []
    });
    const plan = calculatePlanAndForecast(request).dayPlan!;
    const [first, second, third] = plan.blocks;
    expect(first!.kind).toBe("action");
    expect(first!.targetId).toBe("a1");
    expect(first!.focusedMinutes).toBe(60);
    expect(second!.kind).toBe("gap");
    expect(second!.gapKind).toBe("none");
    expect(second!.startsAt).toBe(first!.endsAt);
    const breakMinutes = (new Date(second!.endsAt).getTime() - new Date(second!.startsAt).getTime()) / MINUTE;
    expect(breakMinutes).toBe(15);
    expect(third!.kind).toBe("action");
    expect(third!.targetId).toBe("a1");
    expect(third!.startsAt).toBe(second!.endsAt);
  });

  it("lets a second action fill the break the first one just earned", () => {
    // a2's whole session is exactly the length of the break a1's full session earns, so it fills the
    // rest window precisely and the plan returns to a1 the moment the break ends.
    const request = fixture({
      actions: [
        { id: "a1", projectId: "alpha", minutes: 150, minSession: 15, maxSession: 60 },
        { id: "a2", projectId: "beta", minutes: 15, minSession: 15, maxSession: 15 }
      ],
      commitments: []
    });
    const plan = calculatePlanAndForecast(request).dayPlan!;
    const [first, second, third] = plan.blocks;
    expect(first!.targetId).toBe("a1");
    expect(first!.focusedMinutes).toBe(60);
    expect(second!.kind).toBe("action");
    expect(second!.targetId).toBe("a2");
    expect(second!.focusedMinutes).toBe(15);
    expect(second!.startsAt).toBe(first!.endsAt);
    expect(third!.targetId).toBe("a1");
    expect(third!.startsAt).toBe(second!.endsAt);
  });
});
