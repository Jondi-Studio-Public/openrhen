import { describe, expect, it } from "vitest";
import { buildNowAnswer, type JsonValue, type PlanForecastResponse, type PrepPace } from "@openrhen/contracts";
import { createSeedState, type PortalState, type StoredSleepPlan } from "@/state/portal-state";
import {
  buildNowModel,
  planStatusChip,
  recommendedActionFinished,
  visibleNeeds,
  type NowCandidate,
  type NowForecast,
  type NowRecommendation
} from "./now-model";
import { planHealthAfterSave, type PlanHealth } from "@/features/planning/planning-runtime";

const now = new Date("2026-08-18T10:00:00.000Z");
const iso = (minutesFromNow: number) => new Date(now.getTime() + minutesFromNow * 60_000).toISOString();

const emptyRecommendation = (): NowRecommendation => ({
  primary: null,
  alternatives: [],
  candidates: [],
  headline: "Nothing fits",
  explanation: "No action fits this window.",
  evidence: []
});

const sleepPlan = (overrides: Partial<StoredSleepPlan> = {}): StoredSleepPlan => ({
  id: "sleep-tonight",
  plannedStartAt: iso(240),
  plannedWakeAt: iso(240 + 480),
  desiredMinutes: 480,
  allowedMinutes: 480,
  sleepDeficitMinutes: 0,
  anchorDeviationMinutes: 0,
  hardErrors: [],
  explanation: "Protected sleep.",
  status: "planned",
  ...overrides
});

/** A minimal-but-complete engine result, matching every field `planForecastResponseSchema` requires. */
const planningResult = (prepPace?: PrepPace): PlanForecastResponse => ({
  contractVersion: "1",
  requestId: "8fe5bba7-e436-429d-8011-67467b3ec55e",
  inputVersion: "abc123",
  engineVersion: "1.5.0",
  calculatedAt: now.toISOString(),
  validUntil: iso(60),
  derivedState: {
    sleepPlans: [],
    occurrences: [],
    routineSteps: [],
    commitmentRepeats: [],
    stepPlacements: []
  },
  schedule: {},
  recommendation: {},
  currentDirective: { kind: "none", title: "Nothing fits", recommendedMinutes: 0 },
  upcomingDirectives: [],
  continuation: null,
  softPlacements: [],
  ...(prepPace ? { prepPace } : {})
});

const stateWithPlanningResult = (state: PortalState, prepPace?: PrepPace): PortalState => ({
  ...state,
  planning: {
    status: "current",
    lastSuccessfulAt: now.toISOString(),
    validUntil: iso(60),
    awaitingRecalculation: false,
    result: planningResult(prepPace)
  }
});

const model = (
  state: PortalState,
  options: {
    manualBedtime?: boolean;
    recommendation?: NowRecommendation;
    knownLatestSuccessfulAt?: string | null | undefined;
    serverClockOffsetMs?: number;
    forecasts?: NowForecast[];
  } = {}
) =>
  buildNowModel({
    state,
    recommendation: options.recommendation ?? emptyRecommendation(),
    forecasts: options.forecasts ?? [],
    currentDirective: null,
    now,
    manualBedtime: options.manualBedtime ?? false,
    knownLatestSuccessfulAt: options.knownLatestSuccessfulAt,
    ...(options.serverClockOffsetMs === undefined ? {} : { serverClockOffsetMs: options.serverClockOffsetMs })
  });

describe("buildNowModel", () => {
  it("holds sleep back until its planned start, unless the person chose to start early", () => {
    const state: PortalState = { ...createSeedState(now), sleepPlans: [sleepPlan()] };
    expect(model(state).upcomingSleep?.id).toBe("sleep-tonight");
    expect(model(state).sleepDue).toBeUndefined();
    expect(model(state, { manualBedtime: true }).sleepDue?.id).toBe("sleep-tonight");
    expect(model(state, { manualBedtime: true }).sleepPanelDue).toBe(false);
  });

  it("mirrors the wake routine's next unfinished step, every step regardless of phase", () => {
    // a bedtime/wake step is a `routine_steps` row now, not a preset cross-referenced against
    // a `routine_instances` row's `completedStepIds`/`skippedStepIds` arrays — each step already
    // carries its own status.
    const wakeSteps: PortalState["routineSteps"] = [
      {
        id: "wake-step-0",
        version: 1,
        anchorType: "sleep_plan",
        anchorId: "sleep-last-night",
        purpose: "wake",
        title: "Stretch",
        durationMinutes: 10,
        sequence: 0,
        timingRule: "contiguous",
        energy: "low",
        contexts: [],
        dependencyIds: [],
        phase: "before",
        status: "completed"
      },
      {
        id: "wake-step-1",
        version: 1,
        anchorType: "sleep_plan",
        anchorId: "sleep-last-night",
        purpose: "wake",
        title: "Shower",
        durationMinutes: 15,
        sequence: 1,
        timingRule: "contiguous",
        energy: "low",
        contexts: [],
        dependencyIds: [],
        phase: "after",
        status: "pending"
      }
    ];
    const state: PortalState = {
      ...createSeedState(now),
      routineSteps: wakeSteps,
      sleepPlans: [
        sleepPlan({
          id: "sleep-last-night",
          status: "completed",
          plannedStartAt: iso(-480),
          plannedWakeAt: iso(-30),
          actualWakeAt: iso(-30)
        })
      ]
    };
    // wake-step-0 is already completed, so the current step is wake-step-1 — an "after"-phase step,
    // still offered because phase is not consulted for a wake routine (§1.2 of the wake routine design note).
    expect(model(state).currentWakeStep?.id).toBe("wake-step-1");
  });

  // portal-consistency half: the engine folds a cadence-gated-out step into `skippedStepIds`
  // (the same field a truncation drop or a manual skip already uses), specifically so this
  // re-derivation — which has no way to evaluate cadence dueness itself — agrees with the engine on
  // what tonight's/this-morning's instance actually offers, rather than surfacing a step nobody was
  // ever going to be asked to do.
  it("skips a step already marked skipped when choosing the current wake step, same as a completed one", () => {
    // the engine writes `status: 'skipped'` straight onto the row when "Practice piano"'s
    // cadence is not due today (the old `completedStepIds`/`skippedStepIds` arrays are gone), and a
    // gated-out step with no prior persisted row is dropped from the derived list entirely — either
    // way this re-derivation only ever sees rows, not a preset it has to cross-reference itself.
    const wakeSteps: PortalState["routineSteps"] = [
      {
        id: "wake-step-0",
        version: 1,
        anchorType: "sleep_plan",
        anchorId: "sleep-last-night",
        purpose: "wake",
        title: "Stretch",
        durationMinutes: 10,
        sequence: 0,
        timingRule: "contiguous",
        energy: "low",
        contexts: [],
        dependencyIds: [],
        phase: "before",
        status: "completed"
      },
      {
        id: "wake-step-1",
        version: 1,
        anchorType: "sleep_plan",
        anchorId: "sleep-last-night",
        purpose: "wake",
        title: "Practice piano",
        durationMinutes: 10,
        sequence: 1,
        timingRule: "contiguous",
        energy: "low",
        contexts: [],
        dependencyIds: [],
        phase: "before",
        cadenceActionId: "cadence-action-1",
        status: "skipped"
      },
      {
        id: "wake-step-2",
        version: 1,
        anchorType: "sleep_plan",
        anchorId: "sleep-last-night",
        purpose: "wake",
        title: "Get dressed",
        durationMinutes: 10,
        sequence: 2,
        timingRule: "contiguous",
        energy: "low",
        contexts: [],
        dependencyIds: [],
        phase: "after",
        status: "pending"
      }
    ];
    const state: PortalState = {
      ...createSeedState(now),
      routineSteps: wakeSteps,
      sleepPlans: [
        sleepPlan({
          id: "sleep-last-night",
          status: "completed",
          plannedStartAt: iso(-480),
          plannedWakeAt: iso(-30),
          actualWakeAt: iso(-30)
        })
      ]
    };
    // wake-step-0 done, wake-step-1 gated out — the current step is wake-step-2, not the cadence one.
    expect(model(state).currentWakeStep?.id).toBe("wake-step-2");
  });

  // Mirror of the engine's sleep-directive floor: a wake-adjacent
  // replan can truncate a night to a sliver, and the page re-derives dueness from the raw row, so
  // without its own guard it showed "Time to sleep" for a 32-second block at 4:47 am.
  it("never makes a zero-minute or failing sliver sleep window due", () => {
    const zeroMinute: PortalState = {
      ...createSeedState(now),
      sleepPlans: [
        sleepPlan({
          plannedStartAt: iso(-1),
          plannedWakeAt: iso(1),
          allowedMinutes: 0,
          minimumShortfallMinutes: 300,
          hardErrors: ["Minimum sleep cannot be met for Eat Breakfast: 300 minutes short."]
        })
      ]
    };
    expect(model(zeroMinute).sleepPanelDue).toBe(false);
    const failingSliver: PortalState = {
      ...createSeedState(now),
      sleepPlans: [
        sleepPlan({
          plannedStartAt: iso(-1),
          plannedWakeAt: iso(4),
          allowedMinutes: 5,
          minimumShortfallMinutes: 295,
          hardErrors: ["Minimum sleep cannot be met for Eat Breakfast: 295 minutes short."]
        })
      ]
    };
    expect(model(failingSliver).sleepPanelDue).toBe(false);
    // A short but healthy rest, and any substantial (if constrained) night, are still due.
    const healthyRest: PortalState = {
      ...createSeedState(now),
      sleepPlans: [sleepPlan({ plannedStartAt: iso(-1), plannedWakeAt: iso(19), allowedMinutes: 20 })]
    };
    expect(model(healthyRest).sleepPanelDue).toBe(true);
    const constrainedNight: PortalState = {
      ...createSeedState(now),
      sleepPlans: [
        sleepPlan({
          plannedStartAt: iso(-1),
          plannedWakeAt: iso(239),
          allowedMinutes: 240,
          minimumShortfallMinutes: 60,
          hardErrors: ["Minimum sleep cannot be met: 60 minutes short."]
        })
      ]
    };
    expect(model(constrainedNight).sleepPanelDue).toBe(true);
  });

  it("says how early a manual start is, anchored to now rather than to the plan", () => {
    const state: PortalState = { ...createSeedState(now), sleepPlans: [sleepPlan()] };
    const early = model(state, { manualBedtime: true });
    expect(early.sleepEarlyStart).toBe(true);
    expect(early.sleepMinutesUntilPlannedStart).toBe(240);
    // Sleeping the planned 480 minutes from now ends 480 minutes from now, not at the planned wake.
    expect(early.sleepEarlyStartWakeAt).toBe(iso(480));
    // Without the manual choice nothing is early, and once the plan's own bedtime arrives the
    // planned figures describe sleeping now, so the early-start reading switches off.
    expect(model(state).sleepEarlyStart).toBe(false);
    const due: PortalState = {
      ...state,
      sleepPlans: [sleepPlan({ plannedStartAt: iso(-10), plannedWakeAt: iso(470) })]
    };
    const dueModel = model(due, { manualBedtime: true });
    expect(dueModel.sleepPanelDue).toBe(true);
    expect(dueModel.sleepEarlyStart).toBe(false);
    expect(dueModel.sleepMinutesUntilPlannedStart).toBe(0);
    expect(dueModel.sleepEarlyStartWakeAt).toBeUndefined();
  });

  it("clamps the constrained-sleep offer to the desired amount, never the raw minutes until a distant wake", () => {
    // Bedtime started at 12:42 pm against a plan whose wake constraint sits 951
    // minutes away (4:33 am the next day). Without a min() against the settings goal this offered
    // the raw 951 minutes; with it, the offer is capped at what the settings actually ask for, and
    // ends comfortably before the constraint.
    const state: PortalState = {
      ...createSeedState(now),
      sleepPlans: [
        sleepPlan({
          plannedStartAt: iso(480),
          plannedWakeAt: iso(951),
          allowedMinutes: 951 - 480,
          wakeConstraint: { commitmentId: "c-uniform", title: "Prepare uniform", protectedStartAt: iso(951) }
        })
      ]
    };
    expect(state.settings.desiredSleepMinutes).toBe(480);
    const early = model(state, { manualBedtime: true });
    expect(early.sleepEarlyStart).toBe(true);
    expect(early.sleepConstrainedMinutes).toBe(480);
    expect(early.sleepConstrainedMinutes).not.toBe(951);
  });

  it("offers only what fits before the wake constraint when that constraint is the nearer limit", () => {
    const state: PortalState = {
      ...createSeedState(now),
      sleepPlans: [
        sleepPlan({
          plannedStartAt: iso(60),
          plannedWakeAt: iso(360),
          allowedMinutes: 300,
          wakeConstraint: { commitmentId: "c-breakfast", title: "Eat Breakfast", protectedStartAt: iso(300) }
        })
      ]
    };
    const early = model(state, { manualBedtime: true });
    expect(early.sleepEarlyStart).toBe(true);
    // 300 minutes from now to the constrained wake is less than the 480 desired: the constraint binds.
    expect(early.sleepConstrainedMinutes).toBe(300);
  });

  it("offers the full desired amount when there is no wake constraint, and nothing outside an early start", () => {
    const state: PortalState = {
      ...createSeedState(now),
      sleepPlans: [sleepPlan({ plannedStartAt: iso(60), plannedWakeAt: iso(540) })]
    };
    expect(model(state, { manualBedtime: true }).sleepConstrainedMinutes).toBe(480);
    expect(model(state).sleepConstrainedMinutes).toBeUndefined();
  });

  it("defaults an early-start nap to what the last night still owes against the settings goal", () => {
    const base = createSeedState(now);
    expect(base.settings.desiredSleepMinutes).toBe(480);
    // Slept 408 minutes actually — 6:48 — so 72 minutes are owed against the 480 wanted. The row's
    // own allowedMinutes still says 480 (a live-tracked night keeps what was planned), which is
    // exactly why the actual times are measured instead.
    const state: PortalState = {
      ...base,
      sleepPlans: [
        sleepPlan(),
        sleepPlan({
          id: "sleep-last-night",
          status: "completed",
          actualStartAt: iso(-1008),
          actualWakeAt: iso(-600),
          allowedMinutes: 480,
          sleepDeficitMinutes: 0
        })
      ]
    };
    expect(model(state, { manualBedtime: true }).sleepNapTopUpMinutes).toBe(72);
    // Raising the goal raises the top-up: the setting is read now, not frozen into the old night.
    const wantsMore: PortalState = { ...state, settings: { ...state.settings, desiredSleepMinutes: 540 } };
    expect(model(wantsMore, { manualBedtime: true }).sleepNapTopUpMinutes).toBe(132);
    // Offered only where it is offered: not when sleep is genuinely due, and not for a night that
    // met the goal, where a sliver of a top-up is no rest and the panel asks for a length instead.
    expect(model(state).sleepNapTopUpMinutes).toBeUndefined();
    const met: PortalState = {
      ...state,
      sleepPlans: state.sleepPlans.map((item) =>
        item.id === "sleep-last-night" ? { ...item, actualStartAt: iso(-1080) } : item
      )
    };
    expect(model(met, { manualBedtime: true }).sleepNapTopUpMinutes).toBeUndefined();
  });

  it("treats a protected commitment as real only while the commitment itself is confirmed", () => {
    const state = createSeedState(now);
    const recommendation: NowRecommendation = {
      ...emptyRecommendation(),
      protectedCommitment: {
        id: "dinner",
        title: "Dinner and reset",
        phase: "active",
        startsAt: new Date(iso(10)),
        endsAt: new Date(iso(70)),
        protectedStartAt: new Date(iso(10)),
        protectedEndAt: new Date(iso(80)),
        phaseStartsAt: new Date(iso(10)),
        phaseEndsAt: new Date(iso(70))
      }
    };
    expect(model(state, { recommendation }).protectedCommitment?.id).toBe("dinner");
    const tentative: PortalState = {
      ...state,
      commitments: state.commitments.map((item) => ({ ...item, status: "tentative" as const }))
    };
    expect(model(tentative, { recommendation }).protectedCommitment).toBeUndefined();
  });

  it("carries an open anchor separately, leaving the ordinary suggestion flow in place", () => {
    const state = createSeedState(now);
    const anchor = {
      id: "dinner",
      title: "Dinner and reset",
      phase: "active" as const,
      startsAt: new Date(iso(-30)),
      endsAt: new Date(iso(90)),
      protectedStartAt: new Date(iso(-30)),
      protectedEndAt: new Date(iso(100)),
      phaseStartsAt: new Date(iso(-30)),
      phaseEndsAt: new Date(iso(90))
    };
    const built = model(state, { recommendation: { ...emptyRecommendation(), openAnchor: anchor } });
    expect(built.openAnchor?.id).toBe("dinner");
    expect(built.storedOpenAnchor?.id).toBe("dinner");
    // The lockout is what an open anchor is not, so nothing that keys off it may fire: sleep and
    // routine steps stay available exactly as they are on an ordinary afternoon.
    expect(built.protectedCommitment).toBeUndefined();
  });

  it("drops an open anchor whose commitment is no longer confirmed", () => {
    const state = createSeedState(now);
    const recommendation: NowRecommendation = {
      ...emptyRecommendation(),
      openAnchor: {
        id: "dinner",
        title: "Dinner and reset",
        phase: "active",
        startsAt: new Date(iso(-30)),
        endsAt: new Date(iso(90)),
        protectedStartAt: new Date(iso(-30)),
        protectedEndAt: new Date(iso(100)),
        phaseStartsAt: new Date(iso(-30)),
        phaseEndsAt: new Date(iso(90))
      }
    };
    const cancelled: PortalState = {
      ...state,
      commitments: state.commitments.map((item) => ({ ...item, status: "cancelled" as const }))
    };
    expect(model(cancelled, { recommendation }).openAnchor).toBeUndefined();
  });

  // The routine-step derivations themselves — the directive's own step, the running-late branch, the
  // in-window fallback and its prerequisite redirect — moved to `planning/now-activity.ts` in contracts with the rest
  // of the precedence chain, and are proved in `shared/now-activity.test.ts`. What stays here is the
  // wiring: that the model reads that answer and exposes it as `routineDue`.
  it("exposes the shared resolution's routine step as routineDue", () => {
    const state: PortalState = {
      ...createSeedState(now),
      routineSteps: [
        {
          id: "step-uniform",
          commitmentId: "dinner",
          anchorType: "commitment",
          title: "Prepare uniform",
          durationMinutes: 10,
          sequence: 1,
          timingRule: "flexible",
          energy: "low",
          contexts: [],
          dependencyIds: [],
          phase: "before",
          status: "pending"
        }
      ]
    };
    expect(model(state).routineDue).toBeUndefined();
    const directed = buildNowModel({
      state,
      recommendation: emptyRecommendation(),
      forecasts: [],
      currentDirective: {
        kind: "routine_step",
        targetId: "step-uniform",
        title: "Prepare uniform",
        recommendedMinutes: 10
      },
      now,
      manualBedtime: false
    });
    expect(directed.routineDue?.id).toBe("step-uniform");
    expect(directed.activity).toMatchObject({ kind: "routine_step", step: { id: "step-uniform" } });
  });

  it("offers a catch-up only against a recent completed sleep that ran a deficit", () => {
    const base = createSeedState(now);
    const withDeficit: PortalState = {
      ...base,
      sleepPlans: [
        sleepPlan({ plannedStartAt: iso(0), plannedWakeAt: iso(360), allowedMinutes: 360, targetMinutes: 480 }),
        sleepPlan({
          id: "sleep-last-night",
          status: "completed",
          actualWakeAt: iso(-600),
          sleepDeficitMinutes: 60
        })
      ]
    };
    const suggestion = model(withDeficit, { manualBedtime: true }).sleepSuggestion;
    expect(suggestion?.kind).toBe("catchup");
    expect(suggestion?.minutes).toBe(540);
    expect(suggestion?.addedMinutes).toBe(180);

    const stale: PortalState = {
      ...withDeficit,
      sleepPlans: withDeficit.sleepPlans.map((item) =>
        item.id === "sleep-last-night" ? { ...item, actualWakeAt: iso(-4 * 24 * 60) } : item
      )
    };
    expect(model(stale, { manualBedtime: true }).sleepSuggestion).toBeUndefined();
  });

  it("anchors a suggested rest to now once the planned start has passed", () => {
    const base = createSeedState(now);
    // Bedtime was an hour ago; a 360-minute rest offered now must end 360 minutes from now, not 360
    // minutes after the start that was missed.
    const state: PortalState = {
      ...base,
      sleepPlans: [
        sleepPlan({ plannedStartAt: iso(-60), plannedWakeAt: iso(420) }),
        sleepPlan({ id: "sleep-last-night", status: "completed", actualWakeAt: iso(-600), sleepDeficitMinutes: 0 })
      ]
    };
    const suggestion = model(state).sleepSuggestion;
    expect(suggestion?.kind).toBe("nap");
    expect(suggestion?.wakeAtIso).toBe(iso(base.settings.minimumSleepMinutes));
  });

  // Reported 2026-09-04: a hand-logged 20-minute nap whose sleepDeficitMinutes was left
  // stored at 0 (a since-fixed write-path bug) unconditionally offered "shorten to a 300-minute rest —
  // last sleep already met your goal", even though the nap was 460 minutes short of the desired 480.
  // sleepSuggestion must recompute the deficit from the actual timestamps, the way napTopUpMinutes
  // above it already does, rather than trust a stored figure that a bad write can zero out.
  it("does not offer to shorten rest after a short nap whose stored deficit was left at zero", () => {
    const base = createSeedState(now);
    const state: PortalState = {
      ...base,
      sleepPlans: [
        sleepPlan({ plannedStartAt: iso(-60), plannedWakeAt: iso(420) }),
        sleepPlan({
          id: "sleep-last-night",
          status: "completed",
          actualStartAt: iso(-620),
          actualWakeAt: iso(-600),
          sleepDeficitMinutes: 0
        })
      ]
    };
    const suggestion = model(state).sleepSuggestion;
    expect(suggestion?.kind).not.toBe("nap");
  });

  it("ends the previewed session by the clock, not by the focused minutes, and keeps focused as the duration", () => {
    const state = createSeedState(now);
    const primary = {
      action: state.actions[0]!,
      eligible: true,
      exclusionReasons: [],
      recommendedMinutes: 45,
      recommendedWallClockMinutes: 60,
      totalScore: 10,
      scoreComponents: {}
    };
    // The end is read from the stored result (the one `status` reads), so the primary is stored there too.
    const stored = (recommendation: NowRecommendation): PortalState => {
      const base = stateWithPlanningResult(state);
      return {
        ...base,
        planning: {
          ...base.planning!,
          result: { ...base.planning!.result!, recommendation: recommendation as unknown as JsonValue }
        }
      };
    };
    const withWallClock = { ...emptyRecommendation(), primary };
    const result = model(stored(withWallClock), { recommendation: withWallClock });
    expect(result.plannedEnd.toISOString()).toBe(iso(60));
    expect(result.plannedDuration).toBe(45);
    // A result stored before the engine reported clock minutes falls back to the focused figure.
    const { recommendedWallClockMinutes: _omitted, ...withoutWallClock } = primary;
    const olderRecommendation = { ...emptyRecommendation(), primary: withoutWallClock };
    const older = model(stored(olderRecommendation), { recommendation: olderRecommendation });
    expect(older.plannedEnd.toISOString()).toBe(iso(45));
  });

  it("maps an answer directive's contexts onto the situation model, one option per context", () => {
    const state: PortalState = {
      ...createSeedState(now),
      conditionDefinitions: [
        {
          id: "home",
          name: "Home",
          kind: "location",
          status: "active",
          pathways: [],
          portability: "fixed",
          grants: ["printer"],
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0,
          channels: []
        },
        {
          id: "laptop",
          name: "Laptop",
          kind: "capability",
          status: "active",
          pathways: [],
          portability: "portable",
          grants: [],
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0,
          channels: []
        },
        {
          id: "printer",
          name: "Printer",
          kind: "capability",
          status: "active",
          pathways: [],
          portability: "fixed",
          grants: [],
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0,
          channels: []
        }
      ]
    };
    const result = buildNowModel({
      state,
      recommendation: emptyRecommendation(),
      forecasts: [],
      currentDirective: {
        kind: "answer",
        title: "Answer a question",
        recommendedMinutes: 0,
        question: "Where are you, and is the laptop with you?",
        contextIds: ["home", "laptop", "printer", "gone"],
        candidate: null
      },
      now,
      manualBedtime: false
    });
    expect(result.answerDirective?.question).toBe("Where are you, and is the laptop with you?");
    expect(result.answerOptions).toEqual([
      { contextId: "home", name: "Home", kind: "location" },
      { contextId: "laptop", name: "Laptop", kind: "carrying" },
      { contextId: "printer", name: "Printer", kind: "override" },
      { contextId: "gone", name: "gone", kind: "override" }
    ]);
    expect(result.boundaryDirective).toBeNull();
  });

  it("reads a travel directive and names the place it goes to, without re-deciding the journey", () => {
    const state: PortalState = {
      ...createSeedState(now),
      conditionDefinitions: [
        {
          id: "ctx-campus",
          name: "Campus",
          kind: "location",
          status: "active",
          pathways: [],
          portability: "fixed",
          grants: [],
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0,
          channels: []
        }
      ]
    };
    const travel = (toLocationId: string) =>
      buildNowModel({
        state,
        recommendation: emptyRecommendation(),
        forecasts: [],
        currentDirective: {
          kind: "travel",
          toLocationId,
          title: "Drive to Campus",
          recommendedMinutes: 18,
          mode: "car",
          source: "fallback",
          // oxlint-disable-next-line unicorn/no-thenable -- `then` is a domain field of the travel directive, not a promise continuation
          then: { kind: "action", targetId: "a1", title: "Assessment 2", recommendedMinutes: 90 }
        },
        now,
        manualBedtime: false
      });
    const known = travel("ctx-campus");
    expect(known.travelDirective?.recommendedMinutes).toBe(18);
    expect(known.travelDirective?.then?.title).toBe("Assessment 2");
    expect(known.travelDestination?.name).toBe("Campus");
    expect(known.boundaryDirective).toBeNull();
    // A place defined since the plan ran is still directed to; the panel falls back to the id.
    expect(travel("ctx-gone").travelDestination).toBeUndefined();
    expect(model(state).travelDirective).toBeNull();
  });

  it("does not trust a location assertion that has aged past the staleness window (BUG 3)", () => {
    const campus: PortalState["conditionDefinitions"][number] = {
      id: "ctx-campus",
      name: "Campus",
      kind: "location",
      status: "active",
      pathways: [],
      portability: "fixed",
      grants: [],
      setupBeforeMinutes: 0,
      transitionAfterMinutes: 0,
      channels: []
    };
    const seed = createSeedState(now);
    const situationAt = (locationSetAt: string | undefined): PortalState => ({
      ...seed,
      conditionDefinitions: [campus],
      currentSituation: { ...seed.currentSituation, locationId: "ctx-campus", locationSetAt }
    });
    // Asserted 501 minutes ago — one past the 480-minute default staleness window
    // (`DEFAULT_LOCATION_STALE_AFTER_MINUTES`, context-constants.ts) — must read as untrusted, exactly
    // like the engine's and the deliverable readiness's own reads of the same constant.
    const stale = model(situationAt(iso(-501)));
    expect(stale.situationLocation?.id).toBe("ctx-campus");
    expect(stale.situationLocationTrusted).toBe(false);
    const fresh = model(situationAt(iso(-10)));
    expect(fresh.situationLocationTrusted).toBe(true);
  });

  it("splits reachable work into what the engine costed a journey for and what it refused", () => {
    const base = createSeedState(now);
    const candidate = (id: string, extra: Partial<NowCandidate>): NowCandidate => ({
      action: { ...base.actions[0]!, id, title: id },
      eligible: false,
      exclusionReasons: [],
      recommendedMinutes: null,
      totalScore: 0,
      scoreComponents: {},
      ...extra
    });
    const trip = {
      toLocationId: "ctx-campus",
      travelMinutes: 18,
      returnMinutes: 0,
      source: "measured" as const,
      bundleSize: 1,
      windowMinutes: 120,
      costMinutes: 18,
      opportunityMinutes: null,
      avoidableMinutes: 0
    };
    const result = model(base, {
      recommendation: {
        ...emptyRecommendation(),
        reachable: [
          candidate("costed", { trip, recommendedMinutes: 90 }),
          candidate("no-mode", { tripReason: "no_mode" }),
          candidate("no-window", {
            tripReason: "no_window",
            conditionMatch: {
              status: "no",
              missing: [],
              unknowns: [],
              unmetPreferences: [],
              reachableVia: { locationId: "ctx-campus", travelMinutes: 18, mode: "car" }
            }
          }),
          // A result stored before the engine directed travel: reachable, with no verdict either way.
          candidate("legacy", {
            conditionMatch: {
              status: "no",
              missing: [],
              unknowns: [],
              unmetPreferences: [],
              reachableVia: { locationId: "ctx-campus", travelMinutes: 25 }
            }
          }),
          // Nothing at all to say about it; it is not reachable work and does not belong in either list.
          candidate("unrelated", {})
        ]
      }
    });
    expect(result.worthTheTrip.map((item) => item.action.id)).toEqual(["costed"]);
    expect(result.notWorthTheTrip.map((item) => item.action.id)).toEqual(["no-mode", "no-window", "legacy"]);
    expect(result.reachable).toHaveLength(4);
  });

  it("reads a boundary directive and says whether it is today's horizon", () => {
    const state = createSeedState(now);
    const boundary = (kind: "daily_horizon" | "commitment") =>
      buildNowModel({
        state,
        recommendation: emptyRecommendation(),
        forecasts: [],
        currentDirective: {
          kind: "boundary",
          title: "Nothing fits before the boundary",
          recommendedMinutes: 0,
          boundaryAt: iso(30),
          boundaryKind: kind,
          nextFit: null
        },
        now,
        manualBedtime: false
      });
    expect(boundary("daily_horizon").boundaryIsDailyHorizon).toBe(true);
    expect(boundary("commitment").boundaryIsDailyHorizon).toBe(false);
    expect(boundary("commitment").boundaryDirective?.boundaryAt).toBe(iso(30));
    expect(boundary("commitment").answerDirective).toBeNull();
  });

  // A backgrounded tab kept showing a sleep plan the server had already replanned
  // around a commitment, and "Plan current" said nothing was wrong. `knownLatestSuccessfulAt` is the
  // freshest run a status poll on this tab has seen — when it is strictly ahead of the plan on
  // screen, that plan is known-superseded, not merely aging out on its own validity window.
  describe("planningDecisionCurrent / planningRefreshing", () => {
    const currentState = (overrides: Record<string, unknown> = {}): PortalState => ({
      ...createSeedState(now),
      planning: {
        status: "current",
        lastSuccessfulAt: iso(-30),
        validUntil: iso(30),
        ...overrides
      } as NonNullable<PortalState["planning"]>
    });

    it("reads current with no fresher run known", () => {
      const state = currentState();
      const result = model(state);
      expect(result.planningDecisionCurrent).toBe(true);
      expect(result.planningRefreshing).toBe(false);
    });

    it("stays current when the known latest run matches the plan on screen", () => {
      const state = currentState({ lastSuccessfulAt: iso(-30) });
      const result = model(state, { knownLatestSuccessfulAt: iso(-30) });
      expect(result.planningDecisionCurrent).toBe(true);
      expect(result.planningRefreshing).toBe(false);
    });

    it("reads refreshing, not current, once a status poll has seen a newer run than this tab has adopted", () => {
      const state = currentState({ lastSuccessfulAt: iso(-30) });
      const result = model(state, { knownLatestSuccessfulAt: iso(-5) });
      expect(result.planningRefreshing).toBe(true);
      expect(result.planningDecisionCurrent).toBe(false);
    });

    it("does not read refreshing when the known run is the same age or older than the plan on screen", () => {
      const state = currentState({ lastSuccessfulAt: iso(-5) });
      // A poll answered with an older timestamp than what is already on screen must never happen in
      // practice, but the signal is defined not to flag it as staleness either way.
      expect(model(state, { knownLatestSuccessfulAt: iso(-30) }).planningRefreshing).toBe(false);
      expect(model(state, { knownLatestSuccessfulAt: undefined }).planningRefreshing).toBe(false);
      expect(model(state, { knownLatestSuccessfulAt: null }).planningRefreshing).toBe(false);
    });

    it("judges validity on the server's clock, so a browser clock running ahead does not expire a plan early", () => {
      const state = currentState({ validUntil: iso(-5) });
      // On the browser's own clock the plan ended five minutes ago.
      expect(model(state).planningDecisionCurrent).toBe(false);
      // The server's clock is ten minutes behind the browser's, so it has five minutes left.
      expect(model(state, { serverClockOffsetMs: -10 * 60_000 }).planningDecisionCurrent).toBe(true);
    });

    it("a plan that is not current for its own reasons is not described as refreshing", () => {
      const state = currentState({ status: "stale", lastSuccessfulAt: iso(-90), validUntil: iso(-30) });
      const result = model(state, { knownLatestSuccessfulAt: iso(-90) });
      expect(result.planningDecisionCurrent).toBe(false);
      expect(result.planningRefreshing).toBe(false);
    });
  });

  // L5 (pre-next-stage review): an unexpired run read "Plan current" while a write waited on a newer job
  // and after that job failed. The chip now says so.
  describe("planStatusChip", () => {
    const health = (overrides: Partial<PlanHealth> = {}): PlanHealth => ({
      refresh: "current",
      graceEndsAt: null,
      unreachable: false,
      ...overrides
    });
    const chip = (overrides: Partial<Parameters<typeof planStatusChip>[0]> = {}) =>
      planStatusChip({
        saving: false,
        planningRefreshing: false,
        planningDecisionCurrent: true,
        planHealth: health(),
        ...overrides
      });

    it("says the plan is updating while a newer job is waiting, even on an unexpired plan", () => {
      expect(chip({ planHealth: health({ updating: true }) })).toBe("Updating plan…");
    });

    it("says it couldn't update when the latest job failed and nothing newer is in flight", () => {
      expect(chip({ planHealth: health({ latestJobFailed: true }) })).toBe("Couldn't update plan");
    });

    it("prefers updating over a failure when a newer job is already in flight", () => {
      expect(chip({ planHealth: health({ updating: true, latestJobFailed: true }) })).toBe("Updating plan…");
    });

    it("is unchanged otherwise", () => {
      expect(chip()).toBe("Plan current");
      expect(chip({ saving: true, planHealth: health({ updating: true }) })).toBe("Saving…");
      expect(chip({ planningRefreshing: true, planningDecisionCurrent: false })).toBe("Refreshing…");
      expect(chip({ planningDecisionCurrent: false, planHealth: health({ refresh: "refreshing" }) })).toBe(
        "Plan not current"
      );
      expect(chip({ planningDecisionCurrent: false, planHealth: null })).toBe("Plan not current");
    });

    it("keeps Plan stalled over a failure or a waiting job when the plan is also out of date", () => {
      const stalled = { planningDecisionCurrent: false } as const;
      expect(chip({ ...stalled, planHealth: health({ refresh: "stalled", latestJobFailed: true }) })).toBe(
        "Plan stalled"
      );
      expect(chip({ ...stalled, planHealth: health({ refresh: "stalled", updating: true }) })).toBe("Plan stalled");
    });

    it("reads the state's awaitingRecalculation only until the first status poll has answered", () => {
      expect(chip({ planHealth: null, stateAwaitingRecalculation: true })).toBe("Updating plan…");
      expect(chip({ planHealth: null })).toBe("Plan current");
      // Once a poll has answered it is the newer signal, whatever the loaded state still says.
      expect(chip({ planHealth: health({ updating: false }), stateAwaitingRecalculation: true })).toBe("Plan current");
    });

    it("shows Couldn't update plan when a poll reports the failure after a save adopted a waiting state", () => {
      const afterSave = planHealthAfterSave(health({ updating: false }));
      expect(chip({ planHealth: afterSave, stateAwaitingRecalculation: true })).toBe("Updating plan…");
      // The follow-up poll finds the job failed; the state was never reloaded and still says waiting.
      const failedPoll = health({ updating: false, latestJobFailed: true });
      expect(chip({ planHealth: failedPoll, stateAwaitingRecalculation: true })).toBe("Couldn't update plan");
    });

    it("shows Updating plan… for a save that follows an earlier failed poll", () => {
      const earlier = health({ updating: false, latestJobFailed: true });
      expect(chip({ planHealth: earlier, stateAwaitingRecalculation: false })).toBe("Couldn't update plan");
      expect(chip({ planHealth: planHealthAfterSave(earlier), stateAwaitingRecalculation: true })).toBe(
        "Updating plan…"
      );
    });
  });

  // The arithmetic itself lives entirely in the engine (prep-pace.ts); this only checks the mapping
  // from `state.planning.result.prepPace` onto `NowModel.prepPace` is a straight read, unconditional
  // on anything else the page derives.
  describe("prepPace", () => {
    it("reads prepPace straight off the engine result", () => {
      const prepPace: PrepPace = {
        commitmentId: "commitment-college",
        commitmentTitle: "College Online",
        commitmentStartsAt: iso(30),
        requiredMinutes: 27,
        availableMinutes: 20,
        minutesBehind: 7,
        status: "behind"
      };
      const state = stateWithPlanningResult(createSeedState(now), prepPace);
      expect(model(state).prepPace).toEqual(prepPace);
    });

    it("is undefined when the engine result carries no prepPace", () => {
      const state = stateWithPlanningResult(createSeedState(now));
      expect(model(state).prepPace).toBeUndefined();
    });

    it("is undefined when there is no planning result at all", () => {
      expect(model(createSeedState(now)).prepPace).toBeUndefined();
    });
  });
});

describe("the Now page and the shared answer (MCP status) agree", () => {
  it("names the same bedtime step and the same running anchors for one stored plan (10-06 night)", () => {
    const state: PortalState = {
      ...createSeedState(now),
      sleepPlans: [sleepPlan({ replannedFromMissedStart: true })],
      routineSteps: [
        {
          id: "step-teeth",
          anchorType: "sleep_plan",
          anchorId: "sleep-tonight",
          purpose: "bedtime",
          title: "Brush and floss teeth",
          durationMinutes: 8,
          sequence: 0,
          timingRule: "contiguous",
          energy: "low",
          contexts: [],
          dependencyIds: [],
          status: "pending"
        } as unknown as PortalState["routineSteps"][number]
      ]
    };
    const directive = {
      kind: "sleep",
      targetId: "sleep-tonight",
      title: "Time to sleep",
      recommendedMinutes: 480
    } as const;
    const page = buildNowModel({
      state,
      recommendation: emptyRecommendation(),
      forecasts: [],
      currentDirective: directive,
      now,
      manualBedtime: false
    });
    const answer = buildNowAnswer({ state, currentDirective: directive, now }, new Map());
    expect(page.currentBedtimeStep?.id).toBe("step-teeth");
    expect(answer.directive?.sleep?.currentStep?.id).toBe(page.currentBedtimeStep?.id);
  });
});

describe("the needs list", () => {
  const hours = (count: number) => count * 60;
  const home = {
    id: "ctx-home",
    kind: "location",
    name: "Home",
    status: "active",
    portability: "fixed",
    pathways: []
  } as unknown as PortalState["conditionDefinitions"][number];
  /** Every fact current at `now`: energy said an hour ago, no old wake, no session, no stale place. */
  const fresh = (): PortalState => {
    const seed = createSeedState(now);
    return { ...seed, currentSituation: { ...seed.currentSituation, energySetAt: iso(-hours(1)) } };
  };
  const forgottenSession = (): NonNullable<PortalState["activeSession"]> => ({
    id: "session-forgotten",
    actionId: createSeedState(now).actions[0]!.id,
    status: "running",
    startedAt: iso(-hours(19)),
    plannedEndAt: iso(-hours(18) - 15),
    plannedMinutes: 45,
    remainingBeforeMinutes: 90,
    activeElapsedSeconds: 0
  });

  it("is empty while every fact is current", () => {
    expect(model(fresh()).needs).toEqual([]);
  });

  it("asks for an energy that was never dated, as an ordinary need", () => {
    const [need, ...rest] = model(createSeedState(now)).needs;
    expect(rest).toEqual([]);
    expect(need).toMatchObject({ fact: "energy", blocksDirective: false });
    expect(need!.asOf).toBeUndefined();
  });

  it("lists a forgotten session first, then the place and the wake that have aged out", () => {
    const state: PortalState = {
      ...fresh(),
      conditionDefinitions: [home],
      activeSession: forgottenSession(),
      settings: { ...fresh().settings, lastWokeAt: iso(-hours(40)) },
      currentSituation: {
        ...fresh().currentSituation,
        locationId: "ctx-home",
        locationSetAt: iso(-hours(3 * 24))
      }
    };
    const needs = model(state).needs;
    expect(needs.map((need) => need.fact)).toEqual(["session_end", "location", "wake"]);
    expect(needs[0]).toMatchObject({ subjectId: "session-forgotten", blocksDirective: true });
    expect(needs[1]).toMatchObject({ title: "Home", subjectId: "ctx-home", question: "Still at Home?" });
  });

  it("is the list the shared answer gives `status` for the same state, built once", () => {
    const state: PortalState = {
      ...fresh(),
      conditionDefinitions: [home],
      activeSession: forgottenSession(),
      currentSituation: { ...fresh().currentSituation, locationId: "ctx-home", locationSetAt: iso(-hours(30)) }
    };
    const answer = buildNowAnswer({ state, currentDirective: null, now }, new Map([["ctx-home", "Home"]]));
    expect(answer.needs.length).toBeGreaterThan(0);
    expect(model(state).needs).toEqual(answer.needs);
  });

  it("asks about an old estimate on an at-risk project, as status does from the same plan", () => {
    const seed = fresh();
    const action = { ...seed.actions[0]!, status: "active" as const, remainingSetAt: iso(-hours(20 * 24)) };
    const state: PortalState = { ...seed, actions: [action, ...seed.actions.slice(1)] };
    const forecasts = [
      {
        projectId: action.projectId,
        health: "at_risk",
        agedInputs: [{ actionId: action.id, title: action.title, setAt: new Date(action.remainingSetAt) }]
      }
    ] as NowForecast[];
    const needs = model(state, { forecasts }).needs;
    expect(needs.map((need) => need.fact)).toEqual(["effort"]);
    expect(needs[0]).toMatchObject({ subjectId: action.id, blocksDirective: false });
    // The same plan read by status raises the same need; with no plan behind it, neither raises one.
    const answer = buildNowAnswer({ state, currentDirective: null, now, schedule: { forecasts } }, new Map());
    expect(needs).toEqual(answer.needs);
    expect(model(state).needs).toEqual([]);
  });

  it("leaves out what the hero already asks: the checkpoint's end time and the answer panel's place", () => {
    const state: PortalState = {
      ...fresh(),
      conditionDefinitions: [home],
      activeSession: { ...forgottenSession(), status: "feedback" },
      currentSituation: { ...fresh().currentSituation, locationId: "ctx-home", locationSetAt: iso(-hours(30)) }
    };
    const needs = model(state).needs;
    expect(needs.map((need) => need.fact)).toEqual(["session_end", "location"]);
    expect(visibleNeeds(needs, "checkpoint").map((need) => need.fact)).toEqual(["location"]);
    expect(visibleNeeds(needs, "other").map((need) => need.fact)).toEqual(["session_end", "location"]);
    // Only a place the directive itself waits on is the answer panel's question.
    const blockingPlace = needs.map((need) => (need.fact === "location" ? { ...need, blocksDirective: true } : need));
    expect(visibleNeeds(blockingPlace, "place").map((need) => need.fact)).toEqual(["session_end"]);
    expect(visibleNeeds(needs, "place").map((need) => need.fact)).toEqual(["session_end", "location"]);
  });
});

describe("recommendedActionFinished", () => {
  const candidate = (state: PortalState): NowCandidate => ({
    action: state.actions[0]!,
    eligible: true,
    exclusionReasons: [],
    recommendedMinutes: 30,
    totalScore: 1,
    scoreComponents: {}
  });

  it("is false while the action is still open", () => {
    const state = createSeedState(now);
    expect(recommendedActionFinished(state, candidate(state))).toBe(false);
    expect(recommendedActionFinished(state, null)).toBe(false);
  });

  it("is true once local state has the action done, even though the plan still names it", () => {
    const state = createSeedState(now);
    const primary = candidate(state);
    const done = { ...state, actions: state.actions.map((a, i) => (i === 0 ? { ...a, status: "done" as const } : a)) };
    expect(recommendedActionFinished(done, primary)).toBe(true);
  });

  it("is true when the recommended id is an occurrence that has completed", () => {
    const state = createSeedState(now);
    const primary = candidate(state);
    const occurrence = {
      id: primary.action.id,
      actionId: primary.action.id,
      status: "completed"
    } as PortalState["occurrences"][number];
    expect(recommendedActionFinished({ ...state, occurrences: [occurrence] }, primary)).toBe(true);
  });
});

describe("buildNowModel energy cost", () => {
  const energyCost = {
    declaredEnergy: "low",
    blockedCount: 3,
    dueSoon: [{ actionId: "act-1", title: "Unit 3 reading", deadlineAt: iso(60 * 20) }]
  };
  const withNote = (): PortalState => {
    const base = stateWithPlanningResult(createSeedState(now));
    return {
      ...base,
      planning: {
        ...base.planning!,
        result: { ...base.planning!.result!, recommendation: { energyCost } as unknown as JsonValue }
      }
    };
  };

  it("reads the note from the stored recommendation and agrees with the shared builder", () => {
    const state = withNote();
    const built = model(state);
    expect(built.energyCost?.text).toMatch(/^Low energy is holding back 3 actions, 1 due /);
    const answer = buildNowAnswer(
      {
        state,
        currentDirective: null,
        recommendation: state.planning?.result?.recommendation,
        planCalculatedAt: state.planning?.lastSuccessfulAt,
        planCurrent: true,
        now
      },
      new Map()
    );
    expect(built.energyCost).toEqual(answer.energyCost);
  });

  it("is null without a note, and hidden while the plan is not current", () => {
    expect(model(stateWithPlanningResult(createSeedState(now))).energyCost).toBeNull();
    const stale = { ...withNote(), planning: { ...withNote().planning!, validUntil: iso(-1) } };
    expect(model(stale).energyCost).toBeNull();
  });
});

describe("buildNowModel stretch", () => {
  const offer = {
    actionId: "act-1",
    title: "Unit 3 reading",
    declaredEnergy: "low",
    requiredEnergy: "high",
    energyGap: 2,
    minutes: 45,
    cappedAtMinutes: 45,
    reason: "external_within_48h",
    externalDeadlineAt: iso(60 * 20),
    latestSafeStartAt: null
  };
  const withOffer = (stretch?: PortalState["currentSituation"]["stretch"]): PortalState => {
    const base = stateWithPlanningResult(createSeedState(now));
    return {
      ...base,
      currentSituation: { ...base.currentSituation, ...(stretch ? { stretch } : {}) },
      planning: {
        ...base.planning!,
        result: { ...base.planning!.result!, recommendation: { stretchOffer: offer } as unknown as JsonValue }
      }
    };
  };

  it("reads the offer from the stored recommendation, with the one sentence", () => {
    const built = model(withOffer());
    expect(built.stretchOffer).toMatchObject({ actionId: "act-1", minutes: 45 });
    expect(built.stretchOffer?.text).toContain("Unit 3 reading");
    expect(built.stretchOffer?.text).toContain("Both are reasonable.");
    expect(built.stretch).toBeNull();
  });

  it("agrees with the shared answer builder that status calls", () => {
    const state = withOffer();
    const built = model(state);
    const answer = buildNowAnswer(
      {
        state,
        currentDirective: null,
        recommendation: state.planning?.result?.recommendation,
        planCalculatedAt: state.planning?.lastSuccessfulAt,
        planCurrent: true,
        now
      },
      new Map()
    );
    expect(built.stretchOffer).toEqual(answer.stretchOffer);
  });

  it("drops the offer once the person said no tonight, or while the plan is not current", () => {
    const declined = withOffer({ accepted: [], declined: [], declinedAllAt: iso(-5) });
    expect(model(declined).stretchOffer).toBeNull();
    const stale = { ...withOffer(), planning: { ...withOffer().planning!, validUntil: iso(-1) } };
    expect(model(stale).stretchOffer).toBeNull();
  });

  it("shows the running stretch", () => {
    const stretch = {
      accepted: [
        {
          actionId: "act-1",
          title: "Unit 3 reading",
          acceptedAt: iso(-5),
          until: iso(40),
          minutes: 45,
          by: "person" as const
        }
      ],
      declined: []
    };
    const state = withOffer(stretch);
    state.currentSituation = { ...state.currentSituation, energySetAt: iso(-30) };
    const built = model(state);
    expect(built.stretchOffer).toBeNull();
    expect(built.stretch?.active).toMatchObject({ title: "Unit 3 reading", until: iso(40) });
  });
});
