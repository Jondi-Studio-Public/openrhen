import { describe, expect, it } from "vitest";
import { createSeedState, type PortalState, type StoredRoutineStep, type StoredSleepPlan } from "@/state/portal-state";
import { resolveNowActivity, type NowActivityCandidateLike, type NowActivityProtectedLike } from "@openrhen/contracts";

/**
 * The one precedence chain both the Now page and the handheld read. These tests exercise it directly
 * rather than through either consumer: the drift this module removed was two implementations of these
 * rules agreeing only by inspection, and a rule proved through one surface is proved for that surface
 * alone.
 */

const now = new Date("2026-08-18T10:00:00.000Z");
const iso = (minutesFromNow: number) => new Date(now.getTime() + minutesFromNow * 60_000).toISOString();

interface TestProtected extends NowActivityProtectedLike {
  title: string;
}
interface TestCandidate extends NowActivityCandidateLike {
  recommendedMinutes: number;
}

const candidate: TestCandidate = {
  action: { id: "room-floor", title: "Sort the bedroom floor" },
  recommendedMinutes: 30
};

const resolve = (
  state: PortalState,
  options: {
    currentDirective?: Parameters<typeof resolveNowActivity>[0]["currentDirective"];
    protectedCommitment?: TestProtected | null;
    primary?: TestCandidate | null;
    manualBedtime?: boolean;
  } = {}
) =>
  resolveNowActivity<TestCandidate, TestProtected>({
    state,
    now,
    currentDirective: options.currentDirective ?? null,
    protectedCommitment: options.protectedCommitment ?? null,
    primary: options.primary ?? null,
    manualBedtime: options.manualBedtime ?? false
  });

const step = (overrides: Partial<StoredRoutineStep> & Pick<StoredRoutineStep, "id">): StoredRoutineStep => ({
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
  status: "pending",
  ...overrides
});

const sleepPlan = (overrides: Partial<StoredSleepPlan> = {}): StoredSleepPlan => ({
  id: "sleep-tonight",
  plannedStartAt: iso(-5),
  plannedWakeAt: iso(480),
  desiredMinutes: 480,
  allowedMinutes: 480,
  sleepDeficitMinutes: 0,
  anchorDeviationMinutes: 0,
  hardErrors: [],
  explanation: "Protected sleep.",
  status: "planned",
  ...overrides
});

/** The seed's one commitment, moved to be running now so it can be protected and late. */
const runningCommitmentState = (overrides: Partial<PortalState> = {}): PortalState => {
  const seed = createSeedState(now);
  return {
    ...seed,
    commitments: seed.commitments.map((item) =>
      item.id === "dinner" ? { ...item, startsAt: iso(-10), endsAt: iso(60) } : item
    ),
    ...overrides
  } as PortalState;
};

const lateDinner: TestProtected = { id: "dinner", title: "Dinner and reset", late: true };
const onTimeDinner: TestProtected = { id: "dinner", title: "Dinner and reset" };

describe("resolveNowActivity precedence", () => {
  it("puts an active session ahead of everything else that could claim the moment", () => {
    const state = runningCommitmentState({
      sleepPlans: [sleepPlan()],
      activeSession: {
        id: "session-1",
        actionId: "networking-section-one",
        status: "running",
        startedAt: iso(-10),
        plannedEndAt: iso(15),
        plannedMinutes: 25,
        remainingBeforeMinutes: 90,
        activeElapsedSeconds: 600
      }
    } as Partial<PortalState>);
    const brain = resolve(state, { protectedCommitment: onTimeDinner, primary: candidate });
    expect(brain.resolution).toMatchObject({ kind: "session" });
    // The pieces around the session are still derived — the surfaces show lateness and arrival
    // against a commitment even while a session runs against it.
    expect(brain.protectedInfo?.commitment.id).toBe("dinner");
  });

  it("counts a paused session as on the clock, and a finished one as not", () => {
    const base = runningCommitmentState();
    const session = {
      id: "session-1",
      actionId: "networking-section-one",
      startedAt: iso(-10),
      plannedEndAt: iso(15),
      plannedMinutes: 25,
      remainingBeforeMinutes: 90,
      activeElapsedSeconds: 600
    };
    const paused = { ...base, activeSession: { ...session, status: "paused", pausedRemainingSeconds: 300 } };
    const feedback = { ...base, activeSession: { ...session, status: "feedback" } };
    expect(resolve(paused as PortalState).resolution.kind).toBe("session");
    expect(resolve(feedback as PortalState, { primary: candidate }).resolution.kind).toBe("recommended");
  });

  it("lets a directed journey come first, ahead of the commitment it is the leg to", () => {
    const state = runningCommitmentState();
    const brain = resolve(state, {
      protectedCommitment: onTimeDinner,
      currentDirective: {
        kind: "travel",
        toLocationId: "loc-campus",
        title: "Drive to campus",
        recommendedMinutes: 20,
        source: "measured"
      }
    });
    expect(brain.resolution).toMatchObject({ kind: "travel", directive: { toLocationId: "loc-campus" } });
    expect(brain.travelDirective?.toLocationId).toBe("loc-campus");
  });

  it("falls through commitment, sleep and recommendation in order as each is removed", () => {
    const withSleep = runningCommitmentState({ sleepPlans: [sleepPlan()] } as Partial<PortalState>);
    expect(resolve(withSleep, { protectedCommitment: onTimeDinner, primary: candidate }).resolution.kind).toBe(
      "commitment"
    );
    expect(resolve(withSleep, { primary: candidate }).resolution.kind).toBe("sleep");
    expect(resolve(runningCommitmentState(), { primary: candidate }).resolution.kind).toBe("recommended");
    expect(resolve(runningCommitmentState()).resolution.kind).toBe("free");
  });

  it("admits the engine's protected commitment only while it is still a confirmed row", () => {
    const cancelled = runningCommitmentState({
      commitments: runningCommitmentState().commitments.map((item) => ({ ...item, status: "cancelled" }))
    } as Partial<PortalState>);
    expect(resolve(cancelled, { protectedCommitment: onTimeDinner, primary: candidate }).protectedInfo).toBeUndefined();
    expect(resolve(cancelled, { protectedCommitment: onTimeDinner, primary: candidate }).resolution.kind).toBe(
      "recommended"
    );
  });
});

describe("resolveNowActivity routine steps", () => {
  it("takes the routine step the engine's directive names, without re-judging its schedule", () => {
    // Moved from now-model.test.ts with the derivation itself. The step has no schedule at all, so
    // only the directive can name it — nothing here re-derives a window from the commitment's lead.
    const state = runningCommitmentState({ routineSteps: [step({ id: "step-uniform" })] } as Partial<PortalState>);
    expect(resolve(state).routineDue).toBeUndefined();
    const directed = resolve(state, {
      currentDirective: {
        kind: "routine_step",
        targetId: "step-uniform",
        title: "Prepare uniform",
        recommendedMinutes: 10
      }
    });
    expect(directed.routineDue?.id).toBe("step-uniform");
    expect(directed.routineDueSource).toBe("directive");
    expect(directed.resolution).toMatchObject({ kind: "routine_step", source: "directive" });
  });

  it("still surfaces the routine step the engine names when the protected commitment is running late", () => {
    // Moved from now-model.test.ts: a `late` commitment still occupies the engine's
    // `protectedCommitment`, so the ordinary "a protected commitment answers this by itself" rule must
    // not shut out the routine-step machinery for it — the whole point of `late` is that this
    // commitment's own before-phase step is exactly what should be named. The device used to lack this
    // branch entirely and dropped to the engine's primary recommendation instead.
    const state = runningCommitmentState({ routineSteps: [step({ id: "step-uniform" })] } as Partial<PortalState>);
    const directive = {
      kind: "routine_step" as const,
      targetId: "step-uniform",
      title: "Prepare uniform",
      recommendedMinutes: 10
    };
    const late = resolve(state, { protectedCommitment: lateDinner, currentDirective: directive });
    expect(late.routineStepsRunDespiteCommitment).toBe(true);
    expect(late.routineDue?.id).toBe("step-uniform");
    expect(late.resolution).toMatchObject({ kind: "routine_step", step: { id: "step-uniform" } });
    // The commitment is still carried — its headline, lateness and arrival are still worth showing.
    expect(late.protectedInfo?.protectedCommitment.late).toBe(true);

    const onTime = resolve(state, { protectedCommitment: onTimeDinner, currentDirective: directive });
    expect(onTime.routineStepsRunDespiteCommitment).toBe(false);
    expect(onTime.routineDue).toBeUndefined();
    expect(onTime.resolution.kind).toBe("commitment");
  });

  it("redirects the fallback step to its overdue pending prerequisite, mirroring the engine", () => {
    // Moved from now-model.test.ts. No directive to lean on, so the fallback picks by time window
    // exactly as the engine does — and must apply the same walk back to the prerequisite, or it offers
    // a Start the server's dependency gate is guaranteed to refuse. The prerequisite here has no
    // window of its own, which is exactly why the in-window filter cannot see it.
    const state = runningCommitmentState({
      routineSteps: [
        step({ id: "step-uniform", sequence: 0 }),
        step({
          id: "step-shower",
          title: "Shower and get dressed",
          durationMinutes: 20,
          sequence: 3,
          timingRule: "contiguous",
          dependencyIds: ["step-uniform"],
          scheduledStartAt: iso(-5),
          scheduledEndAt: iso(25)
        })
      ]
    } as Partial<PortalState>);
    const brain = resolve(state);
    expect(brain.routineDue?.id).toBe("step-uniform");
    expect(brain.routineDueSource).toBe("prerequisite");
    expect(brain.resolution).toMatchObject({ kind: "routine_step", source: "prerequisite" });
  });

  it("offers an in-window step with no directive, and keeps offering it while its commitment runs", () => {
    const state = runningCommitmentState({
      routineSteps: [step({ id: "step-uniform", scheduledStartAt: iso(-40), scheduledEndAt: iso(-25) })]
    } as Partial<PortalState>);
    // Its own window closed 25 minutes ago, but the commitment it belongs to has not ended, so it is
    // still owed rather than being a finished commitment's stale leftover.
    expect(resolve(state).routineDue?.id).toBe("step-uniform");
    expect(resolve(state).routineDueSource).toBe("fallback");
    const ended = runningCommitmentState({
      commitments: createSeedState(now).commitments.map((item) => ({
        ...item,
        startsAt: iso(-120),
        endsAt: iso(-60)
      })),
      routineSteps: [step({ id: "step-uniform", scheduledStartAt: iso(-40), scheduledEndAt: iso(-25) })]
    } as Partial<PortalState>);
    expect(resolve(ended).routineDue).toBeUndefined();
  });

  it("does not offer a step whose context the matcher rules out", () => {
    const state = runningCommitmentState({
      conditionDefinitions: [{ id: "ctx-garage", name: "Garage", kind: "location", pathways: [] }],
      currentSituation: {
        locationId: null,
        overrides: { "ctx-garage": "unavailable" },
        carrying: {},
        transportModes: ["car"],
        travel: {}
      },
      routineSteps: [
        step({ id: "step-uniform", contexts: ["ctx-garage"], scheduledStartAt: iso(-5), scheduledEndAt: iso(25) })
      ]
    } as unknown as Partial<PortalState>);
    expect(resolve(state).routineDue).toBeUndefined();
  });
});

describe("resolveNowActivity arrival mootness", () => {
  // A person already at college was still offered "Pack Bag": the write-time skip
  // (`routine-step-arrival.ts`) missed its one edge-triggered chance, and the in-window fallback, having
  // no notion of arrival, kept re-offering the step. Checked fresh on every call, so it can never be a
  // beat behind the location assertion.
  const arrivedState = (situation: Record<string, unknown>): PortalState =>
    ({
      ...runningCommitmentState({
        commitments: createSeedState(now).commitments.map((item) =>
          item.id === "dinner" ? { ...item, startsAt: iso(-10), endsAt: iso(60), locationId: "loc-campus" } : item
        ),
        conditionDefinitions: [{ id: "loc-campus", name: "Campus", kind: "location", pathways: [] }],
        routineSteps: [
          step({ id: "step-pack", title: "Pack bag", scheduledStartAt: iso(-30), scheduledEndAt: iso(30) })
        ]
      } as unknown as Partial<PortalState>),
      currentSituation: situation
    }) as unknown as PortalState;

  const base = { overrides: {}, carrying: {}, transportModes: ["car"], travel: {} };

  it("retires a before-phase step once its commitment's location has been asserted", () => {
    const away = arrivedState({ ...base, locationId: null });
    expect(resolve(away).routineDue?.id).toBe("step-pack");
    const there = arrivedState({ ...base, locationId: "loc-campus", locationSetAt: iso(-1) });
    expect(resolve(there).routineDue).toBeUndefined();
  });

  it("keeps offering an after-phase step after arrival — only before-phase steps go moot", () => {
    const there = {
      ...arrivedState({ ...base, locationId: "loc-campus", locationSetAt: iso(-1) }),
      routineSteps: [
        step({
          id: "step-unpack",
          title: "Unpack bag",
          phase: "after",
          scheduledStartAt: iso(-5),
          scheduledEndAt: iso(30)
        })
      ]
    } as PortalState;
    expect(resolve(there).routineDue?.id).toBe("step-unpack");
  });

  it("does not retire a step on an assertion that has aged past the staleness setting", () => {
    const stale = arrivedState({ ...base, locationId: "loc-campus", locationSetAt: iso(-600) });
    expect(resolve(stale).situation.locationStale).toBe(true);
    expect(resolve(stale).routineDue?.id).toBe("step-pack");
  });

  // Finding 20: the old rule had no time bound at all, so a before-phase step of a *home-located*
  // commitment read as moot the instant the person was home — true most of the day — leaving it
  // undirected until the periodic sweep eventually skipped it unperformed. The fix (mirroring
  // `routineStepMootness`, engine/core/src/recommendation/routine-step-mootness.ts) only lets arrival
  // retire a step inside that commitment's own preparation window: once the commitment itself has
  // ended, "still at the matching place" no longer makes a leftover step moot.
  it("does not retire a step once its commitment has ended, even at the matching location within the step's own leftover window", () => {
    const state = {
      ...runningCommitmentState({
        commitments: createSeedState(now).commitments.map((item) =>
          item.id === "dinner" ? { ...item, startsAt: iso(-60), endsAt: iso(-5), locationId: "loc-campus" } : item
        ),
        conditionDefinitions: [{ id: "loc-campus", name: "Campus", kind: "location", pathways: [] }],
        routineSteps: [
          step({ id: "step-pack", title: "Pack bag", scheduledStartAt: iso(-50), scheduledEndAt: iso(30) })
        ]
      } as unknown as Partial<PortalState>),
      currentSituation: { ...base, locationId: "loc-campus", locationSetAt: iso(-1) }
    } as unknown as PortalState;
    expect(resolve(state).routineDue?.id).toBe("step-pack");
  });
});

describe("resolveNowActivity sleep dueness", () => {
  it("holds sleep back until its own window opens, and lets a hand-set bedtime bring it forward", () => {
    const later = runningCommitmentState({
      sleepPlans: [sleepPlan({ plannedStartAt: iso(240), plannedWakeAt: iso(240 + 480) })]
    } as Partial<PortalState>);
    expect(resolve(later).sleepPanelDue).toBe(false);
    expect(resolve(later).sleepDue).toBeUndefined();
    expect(resolve(later, { manualBedtime: true }).sleepDue?.id).toBe("sleep-tonight");
    // Brought forward by hand is a Now-page affordance, not something on the clock: the precedence
    // chain still says nothing is claiming the moment.
    expect(resolve(later, { manualBedtime: true }).resolution.kind).toBe("free");
  });

  it("never makes a zero-minute or failing sliver window due", () => {
    // The engine's own floor: a 32-second block at 4:47 am is a wake-adjacent
    // replan artifact, not a rest to demand.
    const sliver = (overrides: Partial<StoredSleepPlan>) =>
      resolve(runningCommitmentState({ sleepPlans: [sleepPlan(overrides)] } as Partial<PortalState>));
    expect(sliver({ allowedMinutes: 0 }).sleepPanelDue).toBe(false);
    expect(sliver({ allowedMinutes: 1, minimumShortfallMinutes: 200 }).sleepPanelDue).toBe(false);
    expect(sliver({ allowedMinutes: 1 }).sleepPanelDue).toBe(true);
    expect(sliver({ allowedMinutes: 480 }).sleepPanelDue).toBe(true);
  });

  it("suppresses sleep entirely while a protected commitment holds the clock", () => {
    const state = runningCommitmentState({ sleepPlans: [sleepPlan()] } as Partial<PortalState>);
    expect(resolve(state, { protectedCommitment: onTimeDinner }).upcomingSleep).toBeUndefined();
    expect(resolve(state, { protectedCommitment: onTimeDinner }).sleepDue).toBeUndefined();
  });

  it("opens the window early when the bedtime routine's own first step has started", () => {
    // the bedtime routine's own "started" instant is the earliest step's `scheduledStartAt`
    // now, not a bundled instance's own `startsAt`.
    const state = runningCommitmentState({
      sleepPlans: [sleepPlan({ plannedStartAt: iso(240), plannedWakeAt: iso(240 + 480) })],
      routineSteps: [
        {
          id: "bedtime-step-1",
          anchorId: "sleep-tonight",
          anchorType: "sleep_plan",
          purpose: "bedtime",
          title: "Brush teeth",
          durationMinutes: 5,
          sequence: 0,
          timingRule: "contiguous",
          energy: "low",
          contexts: [],
          dependencyIds: [],
          phase: "before",
          status: "pending",
          scheduledStartAt: iso(-5),
          scheduledEndAt: iso(0)
        }
      ]
    } as unknown as Partial<PortalState>);
    expect(resolve(state).sleepPanelDue).toBe(true);
    expect(resolve(state).currentBedtimeStep?.id).toBe("bedtime-step-1");
    expect(resolve(state).resolution.kind).toBe("sleep");
  });
});
