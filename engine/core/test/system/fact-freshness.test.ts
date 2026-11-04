import { describe, expect, it } from "vitest";
import {
  PLAN_FORECAST_CONTRACT_VERSION,
  buildNowAnswer,
  planForecastRequestSchema,
  portalStateSchema,
  type PlanForecastResponse
} from "@openrhen/contracts";
import { PLAN_FORECAST_ENGINE_VERSION, calculatePlanAndForecast } from "../../src/index.js";

/**
 * A stale fact is unknown. Built from the agent-trust review's offline
 * runs on aged copies of the sandbox state: a wake three weeks old, a session left open overnight, and
 * recovery energy said before the last wake. The replay fixtures drive `recommend()` directly and cannot
 * carry a wake or a session, so these run the whole engine on a hand-built request instead.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// 12:00 on a Friday in UTC, so every clock here is the plain wall clock.
const now = new Date("2026-08-14T12:00:00.000Z");
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
const iso = (time: string) => `2026-08-14T${time}:00.000Z`;

function action(id: string, title: string) {
  return {
    id,
    projectId: "project-1",
    title,
    status: "active",
    optimisticMinutes: 45,
    expectedMinutes: 45,
    remainingMinutes: 45,
    pessimisticMinutes: 45,
    energy: "medium",
    minimumSessionMinutes: 15,
    maximumSessionMinutes: 45,
    importance: 3,
    consequence: 3,
    contexts: [],
    dependencyIds: [],
    splittable: true,
    setupMinutes: 0
  };
}

const NOTES = "Lab 7: VLAN trunking notes";

/** A person who woke two hours ago, said where they are and how they feel an hour ago, with work to do. */
function baseState(overrides: Record<string, unknown> = {}, situation: Record<string, unknown> = {}) {
  return portalStateSchema.parse({
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
      conditionCatalog: ["home"],
      preferredBedtime: "23:00",
      preferredWakeTime: "06:00",
      desiredSleepMinutes: 480,
      minimumSleepMinutes: 420,
      maxAwakeHours: 16,
      arrivalMarginMinutes: 0,
      lastWokeAt: ago(2 * HOUR)
    },
    areas: [{ id: "area-1", name: "Study", status: "active", sortOrder: 0 }],
    outcomes: [
      { id: "outcome-1", areaId: "area-1", title: "Pass", definitionOfDone: "Done", value: 3, status: "active" }
    ],
    projects: [
      {
        id: "project-1",
        title: "Networking",
        area: "area-1",
        outcomeId: "outcome-1",
        status: "active",
        uncertainty: "known",
        value: 3,
        consequence: 3,
        externalDeadlineAt: new Date(now.getTime() + 3 * DAY).toISOString()
      }
    ],
    actions: [action("action-1", NOTES), action("action-2", "Lab 8: routing")],
    commitments: [],
    routineSteps: [],
    routinePresets: [],
    occurrences: [],
    sleepPlans: [],
    captures: [],
    completedToday: [],
    assertedConditions: ["home"],
    currentEnergy: "medium",
    horizonEnd: new Date(now.getTime() + 3 * DAY).toISOString(),
    activeSession: null,
    conditionDefinitions: [{ id: "home", name: "Home", kind: "location", status: "active" }],
    currentSituation: {
      locationId: "home",
      locationSetAt: ago(HOUR),
      energySetAt: ago(HOUR),
      transportModes: ["car"],
      ...situation
    },
    ...overrides
  });
}

function run(state: ReturnType<typeof baseState>, at: Date = now) {
  return calculatePlanAndForecast(
    planForecastRequestSchema.parse({
      contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
      requestId: "00000000-0000-4000-8000-0000000fe5e5",
      inputVersion: "fact-freshness-fixture",
      calculatedAt: at.toISOString(),
      horizonEnd: new Date(at.getTime() + 3 * DAY).toISOString(),
      state
    })
  );
}

/** What Now and `status` would show for this state and plan. */
function answerFor(state: ReturnType<typeof baseState>, response: PlanForecastResponse, at: Date = now) {
  return buildNowAnswer(
    {
      state,
      currentDirective: response.currentDirective,
      dayPlan: response.dayPlan,
      recommendation: response.recommendation,
      now: at
    },
    new Map([["home", "Home"]])
  );
}

function openSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "session-1",
    actionId: "action-1",
    targetType: "action",
    targetId: "action-1",
    status: "running",
    startedAt: ago(19 * HOUR),
    plannedEndAt: ago(18 * HOUR + 15 * MINUTE),
    plannedMinutes: 45,
    remainingBeforeMinutes: 45,
    activeElapsedSeconds: 600,
    ...overrides
  };
}

const eligibleIds = (response: PlanForecastResponse) =>
  (response.recommendation as unknown as { candidates: { action: { id: string }; eligible: boolean }[] }).candidates
    .filter((candidate) => candidate.eligible)
    .map((candidate) => candidate.action.id);

describe("a fully fresh state", () => {
  it("directs work, asks nothing, and carries the new engine version", () => {
    const state = baseState();
    const response = run(state);
    expect(response.engineVersion).toBe(PLAN_FORECAST_ENGINE_VERSION);
    expect(PLAN_FORECAST_ENGINE_VERSION).toBe("1.8.1");
    expect(response.currentDirective.kind).toBe("action");
    expect(answerFor(state, response).needs).toEqual([]);
  });

  it("keeps a session that is still inside its plan, and its action leads", () => {
    const state = baseState({
      activeSession: openSession({ startedAt: ago(10 * MINUTE), plannedEndAt: ago(-35 * MINUTE) })
    });
    const response = run(state);
    expect(response.currentDirective).toMatchObject({ kind: "action", targetId: "action-1" });
    // Nothing else can be started while it runs, as before.
    expect(eligibleIds(response)).toEqual(["action-1"]);
    expect(answerFor(state, response).needs).toEqual([]);
  });
});

describe("a wake three weeks old", () => {
  const stale = () => baseState({ settings: { ...baseState().settings, lastWokeAt: ago(21 * DAY) } });
  const tonight = (state: ReturnType<typeof baseState>, at: Date = now) =>
    run(state, at).derivedState.sleepPlans[0] as {
      plannedStartAt: string;
      plannedWakeAt: string;
      hardErrors: string[];
      replannedFromMissedStart?: boolean;
      explanation: string;
    };

  it("no longer argues for sleep now, and Now asks when the person woke", () => {
    const state = stale();
    const response = run(state);
    expect(response.currentDirective.kind).toBe("action");
    const [need, ...rest] = answerFor(state, response).needs;
    // Energy was said after that wake and an hour ago, so it is still good.
    expect(rest).toEqual([]);
    expect(need).toMatchObject({
      fact: "wake",
      question: "Last woke 21 days ago. When did you wake up?",
      asOf: ago(21 * DAY),
      blocksDirective: false
    });
  });

  it("plans tonight from the sleep preferences, as a wake at the preferred time would, with no hard errors", () => {
    const fresh = tonight(baseState());
    const night = tonight(stale());
    expect(night).toMatchObject({
      plannedStartAt: fresh.plannedStartAt,
      plannedWakeAt: fresh.plannedWakeAt,
      hardErrors: [],
      replannedFromMissedStart: false
    });
    // Preferred bedtime 23:00 and wake 06:00 around an eight-hour night.
    expect(night.plannedStartAt).toBe(iso("22:30"));
    expect(night.explanation).toContain("Planned from the sleep preferences because the last wake is unknown.");
    expect(fresh.explanation).not.toContain("last wake is unknown");
  });

  it("puts no awake limit on that night, though a preferred bedtime already missed is still missed", () => {
    // 16 h 20 min after the preferred wake, past the 16 h awake limit: a guessed wake cannot make it late.
    const late = tonight(stale(), new Date(iso("22:20")));
    expect(late.hardErrors).toEqual([]);
    expect(late.plannedStartAt).toBe(iso("22:30"));
    expect(late.replannedFromMissedStart).toBe(false);
    // The same hour after a wake somebody recorded at 06:00 is past the limit.
    const recorded = baseState({ settings: { ...baseState().settings, lastWokeAt: iso("06:00") } });
    expect(tonight(recorded, new Date(iso("22:20"))).hardErrors).toContain("The awake limit has already passed.");
    // The preferences alone say bedtime has passed.
    const missed = tonight(stale(), new Date(iso("23:40")));
    expect(missed).toMatchObject({ plannedStartAt: iso("23:40"), hardErrors: [], replannedFromMissedStart: true });
  });

  it("plans no night for a wake never told, as before", () => {
    const { lastWokeAt: _lastWokeAt, ...settings } = baseState().settings;
    expect(run(baseState({ settings })).derivedState.sleepPlans).toEqual([]);
  });

  it("is a stale wake from the awake limit plus two hours on, and not a minute before", () => {
    const wakeNeed = (age: number) => {
      const state = baseState({ settings: { ...baseState().settings, lastWokeAt: ago(age) } });
      return answerFor(state, run(state)).needs.some((need) => need.fact === "wake");
    };
    expect(wakeNeed(18 * HOUR - MINUTE)).toBe(false);
    expect(wakeNeed(18 * HOUR)).toBe(true);
  });
});

describe("a session left open", () => {
  it("puts the question in place of the directive and offers no other work (18 hours, planned 45 minutes)", () => {
    const state = baseState({ activeSession: openSession() });
    const response = run(state);
    expect(response.currentDirective).toEqual({
      kind: "answer",
      title: `${NOTES} is still open`,
      recommendedMinutes: 0,
      question: "Running 19 h, planned 45 min. When did it stop?",
      contextIds: [],
      candidate: null
    });
    // Starting anything else is refused while it is open, so nothing else may be offered.
    expect(eligibleIds(response).filter((id) => id !== "action-1")).toEqual([]);
    const primary = (response.recommendation as unknown as { primary: { action: { id: string } } | null }).primary;
    expect(primary === null || primary.action.id === "action-1").toBe(true);
  });

  it("gives a session_end need that blocks the directive and says how to settle it", () => {
    const state = baseState({ activeSession: openSession() });
    const [need] = answerFor(state, run(state)).needs;
    expect(need).toMatchObject({
      fact: "session_end",
      subjectId: "session-1",
      title: NOTES,
      blocksDirective: true,
      answer: { tool: "rhen_session", action: "finish", fields: ["endedAt"] }
    });
  });

  it("stops the day plan assuming the session is still going", () => {
    const meeting = {
      id: "meeting",
      title: "Tutorial",
      status: "confirmed",
      startsAt: iso("14:00"),
      endsAt: iso("15:00"),
      setupBeforeMinutes: 0,
      transitionAfterMinutes: 0
    };
    const response = run(baseState({ commitments: [meeting], activeSession: openSession() }));
    const blocks = response.dayPlan!.blocks;
    // The question holds the clock until the next thing that changes the day, as an unanswered place does.
    expect(blocks[0]).toMatchObject({ kind: "gap", gapKind: "answer", confidence: "firm", endsAt: iso("14:00") });
    // Past it the day carries on as if the session had been closed: the meeting, then real work.
    expect(blocks[1]).toMatchObject({ kind: "commitment", targetId: "meeting" });
    expect(blocks.slice(2).some((block) => block.kind === "action")).toBe(true);
  });

  it("does not stretch the clock for a session past its plan, however it was left", () => {
    for (const status of ["running", "feedback"] as const) {
      const response = run(baseState({ activeSession: openSession({ status }) }));
      expect(response.currentDirective.kind, status).toBe("answer");
    }
  });

  it("asks about a paused session four hours after the pause, not before", () => {
    const paused = (pausedAgo: number) =>
      baseState({
        activeSession: openSession({
          status: "paused",
          startedAt: ago(10 * HOUR),
          plannedEndAt: ago(9 * HOUR),
          pausedAt: ago(pausedAgo),
          pausedRemainingSeconds: 1200
        })
      });
    expect(run(paused(3 * HOUR + 59 * MINUTE)).currentDirective).toMatchObject({ kind: "action" });
    const response = run(paused(4 * HOUR));
    expect(response.currentDirective).toMatchObject({
      kind: "answer",
      question: "Paused 4 h ago. Finish it?"
    });
  });

  it("asks before sleep and routine steps too, since none of them can be started either", () => {
    const evening = new Date("2026-08-14T23:30:00.000Z");
    const session = openSession({
      startedAt: new Date(evening.getTime() - 12 * HOUR).toISOString(),
      plannedEndAt: new Date(evening.getTime() - 11 * HOUR).toISOString(),
      plannedMinutes: 60
    });
    const state = baseState({
      activeSession: session,
      settings: { ...baseState().settings, lastWokeAt: new Date(evening.getTime() - 15 * HOUR).toISOString() }
    });
    const response = run(state, evening);
    expect(response.currentDirective.kind).toBe("answer");
  });

  it("asks before a protected commitment too, but leaves a night being slept through alone", () => {
    const commitment = {
      id: "shift",
      title: "Shift",
      status: "confirmed",
      startsAt: iso("11:00"),
      endsAt: iso("13:00"),
      setupBeforeMinutes: 0,
      transitionAfterMinutes: 0
    };
    // Starting the commitment is refused while the session is open, so it cannot be offered first.
    const during = run(baseState({ commitments: [commitment], activeSession: openSession() }));
    expect(during.currentDirective.kind).toBe("answer");

    const sleeping = {
      id: "night",
      status: "sleeping",
      plannedStartAt: ago(30 * HOUR),
      plannedWakeAt: ago(22 * HOUR),
      actualStartAt: ago(30 * HOUR),
      desiredMinutes: 480,
      allowedMinutes: 480,
      sleepDeficitMinutes: 0,
      anchorDeviationMinutes: 0,
      hardErrors: [],
      explanation: "Started on Now."
    };
    const asleep = baseState({
      settings: { ...baseState().settings, lastWokeAt: ago(48 * HOUR) },
      sleepPlans: [sleeping],
      activeSession: openSession({
        id: "session-2",
        actionId: "night",
        targetType: "sleep",
        targetId: "night",
        startedAt: ago(30 * HOUR),
        plannedEndAt: ago(22 * HOUR),
        plannedMinutes: 480
      })
    });
    // Asleep is not a forgotten session; the old wake is what is asked about.
    expect(run(asleep).currentDirective.kind).toBe("sleep");
  });

  it("stops a commitment session stretching its tracked end to now once it is stale", () => {
    const shift = {
      id: "shift",
      title: "Shift",
      status: "confirmed",
      startsAt: iso("09:00"),
      endsAt: iso("10:00"),
      presence: "anchor",
      setupBeforeMinutes: 0,
      transitionAfterMinutes: 0
    };
    const session = (plannedEndAt: string) =>
      openSession({
        actionId: "shift",
        targetType: "fixed_commitment",
        targetId: "shift",
        startedAt: iso("09:00"),
        plannedEndAt,
        plannedMinutes: 60
      });
    const effectiveEnd = (response: PlanForecastResponse) =>
      response.derivedState.commitmentTimelines?.find((item) => item.id === "shift")?.effectiveEndsAt;
    // Planned to end at 10:00, so it is four hours stale at 14:00: the end stays put.
    const stale = run(
      baseState({ commitments: [shift], activeSession: session(iso("10:00")) }),
      new Date(iso("14:00"))
    );
    expect(effectiveEnd(stale)).toBe(iso("10:00"));
    expect(stale.currentDirective.kind).toBe("answer");
    // An hour after the planned end it is still overtime: the end follows the clock, as before.
    const overtime = run(
      baseState({ commitments: [shift], activeSession: session(iso("10:00")) }),
      new Date(iso("11:00"))
    );
    expect(effectiveEnd(overtime)).toBe(iso("11:00"));
  });
});

describe("energy", () => {
  const recovery = (energySetAt: string | undefined) =>
    baseState({ currentEnergy: "recovery" }, energySetAt === undefined ? { energySetAt: undefined } : { energySetAt });

  it("limits the work to what recovery allows while it was said since the last wake", () => {
    const response = run(recovery(ago(HOUR)));
    expect(eligibleIds(response)).toEqual([]);
    expect(response.currentDirective.kind).not.toBe("action");
  });

  it("plans with the window's energy once recovery was said before the last wake", () => {
    const state = recovery(ago(3 * HOUR));
    const response = run(state);
    expect(eligibleIds(response).length).toBeGreaterThan(0);
    expect(response.currentDirective.kind).toBe("action");
    expect(answerFor(state, response).needs).toMatchObject([
      { fact: "energy", question: "You said recovery energy 3 h ago. How is it now?", blocksDirective: false }
    ]);
  });

  it("plans with the window's energy once it is more than eight hours old", () => {
    const state = baseState(
      { currentEnergy: "recovery", settings: { ...baseState().settings, lastWokeAt: ago(11 * HOUR) } },
      { energySetAt: ago(8 * HOUR + MINUTE) }
    );
    expect(run(state).currentDirective.kind).toBe("action");
  });

  it("does not trust energy nobody ever dated, and asks about it", () => {
    const state = recovery(undefined);
    const response = run(state);
    expect(response.currentDirective.kind).toBe("action");
    expect(answerFor(state, response).needs).toMatchObject([
      { fact: "energy", question: "How is your energy now?", blocksDirective: false }
    ]);
  });
});

describe("plan validity", () => {
  const minutesAhead = (response: PlanForecastResponse) => (Date.parse(response.validUntil) - now.getTime()) / MINUTE;

  it("holds for no more than the hourly ceiling while every fact is far from stale", () => {
    expect(minutesAhead(run(baseState()))).toBeLessThanOrEqual(60);
  });

  it("ends the moment a place ages out, rather than at the next ceiling", () => {
    // A place holds through its 480th minute (`resolveSituation`), so it is unknown a millisecond after.
    const response = run(baseState({}, { locationSetAt: ago(8 * HOUR - 10 * MINUTE) }));
    expect(new Date(response.validUntil).getTime()).toBe(now.getTime() + 10 * MINUTE + 1);
  });

  it("ends the moment energy ages out", () => {
    const response = run(
      baseState(
        { settings: { ...baseState().settings, lastWokeAt: ago(10 * HOUR) } },
        { energySetAt: ago(8 * HOUR - 20 * MINUTE), locationSetAt: ago(2 * HOUR) }
      )
    );
    expect(minutesAhead(response)).toBe(20);
  });

  it("ends when an action becomes available (F1-03)", () => {
    const opens = new Date(now.getTime() + 20 * MINUTE).toISOString();
    const state = baseState();
    const withLater = portalStateSchema.parse({
      ...state,
      actions: [{ ...action("action-1", NOTES), availableFrom: opens }, action("action-2", "Lab 8: routing")]
    });
    expect(minutesAhead(run(withLater))).toBe(20);
  });

  it("ends when a recurring occurrence's window closes (F1-03)", () => {
    // 11:00-12:25 today: already open at 12:00, so only the window END (25 minutes out) bounds the plan.
    // The action is available from the past, so this is the only edge that can produce 25.
    const state = baseState();
    const template = {
      ...action("standing", "Stretch"),
      schedulingMode: "recurring",
      recurrence: {
        id: "rule-standing",
        actionId: "standing",
        timezone: "UTC",
        startDate: "2026-08-01",
        endDate: "2026-12-31",
        intervalDays: 1,
        windows: [
          { id: "midday", name: "Midday", anchor: "local_time", localStartTime: "11:00", localEndTime: "12:25" }
        ]
      }
    };
    const withWindow = portalStateSchema.parse({ ...state, actions: [action("action-1", NOTES), template] });
    const response = run(withWindow);
    expect(response.recommendation).not.toBeNull();
    expect(minutesAhead(response)).toBe(25);
  });

  it("ends when a session goes stale", () => {
    // Planned to end 45 minutes ago, 60 minutes planned: stale 60 minutes after that, 15 minutes from now.
    const state = baseState({
      activeSession: openSession({ startedAt: ago(2 * HOUR), plannedEndAt: ago(45 * MINUTE), plannedMinutes: 60 })
    });
    expect(minutesAhead(run(state))).toBe(15);
  });
});
