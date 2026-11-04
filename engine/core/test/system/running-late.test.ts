import { describe, expect, it } from "vitest";
import { PLAN_FORECAST_CONTRACT_VERSION, planForecastRequestSchema, portalStateSchema } from "@openrhen/contracts";
import { calculatePlanAndForecast } from "../../src/index.js";

/**
 * 56 minutes into a located `anchor` commitment, still at home with three pending
 * before-phase routine steps whose scheduled windows had all elapsed. `resolveProtectedCommitment`
 * derived phase purely from the clock, so it read "active"; `openAnchorNow` then freed the anchor's
 * window for ordinary ranking, and the directive fell through to an unrelated deliverable instead of
 * naming the overdue prerequisite.
 *
 * These are the hand-built companions to the promoted snapshot fixture
 * (`snapshot-replay/running-late-for-college-directs-pack-bag.json`, the exact captured moment): each
 * isolates one edge of `isRunningLate` (model/types.ts) that the snapshot alone does not exercise —
 * the travel sub-phase once steps are done, arrival overriding pending steps outright, and the
 * ordinary on-time path staying untouched.
 */

const now = new Date("2026-08-19T00:00:00.000Z");
const HOUR = 3_600_000;
const MIN = 60_000;
const iso = (offsetMs: number) => new Date(now.getTime() + offsetMs).toISOString();

const TRAVEL_MINUTES = 8;

function request(
  overrides: {
    routineSteps?: unknown[];
    currentLocationId?: string;
    startsAtOffset?: number;
    endsAtOffset?: number;
    setupBeforeMinutes?: number;
  } = {}
) {
  const startsAtOffset = overrides.startsAtOffset ?? -10 * MIN;
  const endsAtOffset = overrides.endsAtOffset ?? 3 * HOUR;
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
      conditionCatalog: ["home", "college"],
      preferredBedtime: "23:00",
      preferredWakeTime: "07:00",
      desiredSleepMinutes: 480,
      minimumSleepMinutes: 420,
      maxAwakeHours: 16,
      homeLocationId: "home",
      arrivalMarginMinutes: 2
    },
    areas: [{ id: "area", name: "Everything", status: "active", sortOrder: 0 }],
    outcomes: [
      { id: "outcome", areaId: "area", title: "Outcome", definitionOfDone: "Done.", value: 3, status: "active" }
    ],
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
        internalDeadlineAt: iso(60 * 24 * HOUR)
      }
    ],
    // Workable everywhere (empty contexts), so ordinary ranking has something real to offer once —
    // and only once — the anchor's window actually opens.
    actions: [
      {
        id: "write",
        projectId: "proj",
        title: "write",
        status: "active",
        optimisticMinutes: 60,
        expectedMinutes: 60,
        pessimisticMinutes: 60,
        remainingMinutes: 60,
        splittable: true,
        setupMinutes: 0,
        energy: "medium",
        minimumSessionMinutes: 15,
        maximumSessionMinutes: 60,
        importance: 3,
        consequence: 3,
        contexts: [],
        dependencyIds: [],
        schedulingMode: "one_off"
      }
    ],
    // Automatic capacity spans the whole local day; these reproduce the old manual window (now-4h
    // to now+6h) by blocking its complement across the planning horizon — local midnight up to the
    // window's start, and the window's end well past the 30-day horizon every request here asks for.
    commitments: [
      {
        id: "college-class",
        title: "College Class",
        status: "confirmed",
        startsAt: iso(startsAtOffset),
        endsAt: iso(endsAtOffset),
        locationId: "college",
        presence: "anchor",
        setupBeforeMinutes: overrides.setupBeforeMinutes ?? 0,
        transitionAfterMinutes: 0
      },
      {
        id: "before-window",
        title: "Blocked (before window)",
        status: "confirmed",
        startsAt: iso(-10 * HOUR),
        endsAt: iso(-4 * HOUR),
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0
      },
      {
        id: "after-window",
        title: "Blocked (after window)",
        status: "confirmed",
        startsAt: iso(6 * HOUR),
        endsAt: iso(35 * 24 * HOUR),
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0
      }
    ],
    routineSteps: overrides.routineSteps ?? [],
    sleepPlans: [],
    captures: [],
    completedToday: [],
    assertedConditions: ["home"],
    currentEnergy: "medium",
    horizonEnd: iso(30 * 24 * HOUR),
    activeSession: null,
    conditionDefinitions: [
      { id: "home", name: "Home", kind: "location", status: "active" },
      { id: "college", name: "College", kind: "location", status: "active", travelMinutes: TRAVEL_MINUTES }
    ],
    currentSituation: {
      locationId: overrides.currentLocationId ?? "home",
      locationSetAt: now.toISOString(),
      overrides: {},
      carrying: {},
      transportModes: ["car"],
      travel: {}
    }
  });
  return planForecastRequestSchema.parse({
    contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
    requestId: "00000000-0000-4000-8000-00000000fe22",
    inputVersion: "running-late-fixture",
    calculatedAt: now.toISOString(),
    horizonEnd: iso(30 * 24 * HOUR),
    state
  });
}

const packStep = (overrides: Record<string, unknown>) => ({
  id: "pack",
  commitmentId: "college-class",
  title: "Pack Bag",
  durationMinutes: 10,
  sequence: 0,
  timingRule: "flexible" as const,
  energy: "medium" as const,
  contexts: [],
  dependencyIds: [],
  phase: "before" as const,
  status: "pending" as const,
  ...overrides
});

describe("a located anchor running late", () => {
  it("directs the overdue prerequisite instead of the ranked deliverable, and does not free its window", () => {
    // The report's exact shape: still at home, ten minutes into the commitment by the clock, one
    // before-phase step whose own scheduled window elapsed before the commitment even started.
    const response = calculatePlanAndForecast(
      request({
        routineSteps: [packStep({ scheduledStartAt: iso(-30 * MIN), scheduledEndAt: iso(-15 * MIN) })]
      })
    );
    const recommendation = response.recommendation as unknown as {
      protectedCommitment?: { phase: string; late?: boolean };
      openAnchor?: unknown;
    };
    expect(recommendation.protectedCommitment).toMatchObject({ id: "college-class", phase: "setup", late: true });
    expect(recommendation.openAnchor).toBeUndefined();
    expect(response.currentDirective).toMatchObject({ kind: "routine_step", targetId: "pack" });
  });

  it("directs a travel leg once steps are done but arrival is unasserted, rather than freeing the window", () => {
    const response = calculatePlanAndForecast(
      request({
        routineSteps: [
          packStep({ status: "completed", scheduledStartAt: iso(-30 * MIN), scheduledEndAt: iso(-15 * MIN) })
        ]
      })
    );
    const recommendation = response.recommendation as unknown as {
      protectedCommitment?: { phase: string; late?: boolean };
      openAnchor?: unknown;
    };
    expect(recommendation.protectedCommitment).toMatchObject({ id: "college-class", phase: "travel", late: true });
    expect(recommendation.openAnchor).toBeUndefined();
    expect(response.currentDirective).toMatchObject({ kind: "travel", toLocationId: "college" });
  });

  it("frees its window once arrival is asserted, and no longer directs a leftover pending step either", () => {
    // Arrival wins: being physically there makes the commitment itself no longer late, whatever its
    // steps say — `isRunningLate` reports false outright once the located commitment's own place is
    // asserted, so `openAnchorNow` opens its window and `recommend()` runs the ordinary ranking
    // (`primary`) rather than taking the protected-commitment branch.
    //
    // The leftover "Pack Bag" step is itself still `pending` in this fixture — DB rows do not update
    // themselves — which is exactly the write-time skip's one job (`routine-step-arrival.ts`,
    // `skipMootRoutineSteps`). That write is edge-triggered on the location assertion changing, so it
    // is structurally missable: arrival recorded before the commitment's window opened, a location
    // re-confirmed rather than changed, or any other timing gap. A person already at
    // college was still told to pack a bag — the write missed, and this exact fallback search
    // (`selectCurrentDirective`, directive.ts), having no notion of arrival, kept directing the step
    // regardless. `stepMootOnArrival` closes this at the read side: a before-phase step is excluded
    // from the search the moment its own commitment's location is the asserted one, independent of
    // whatever the DB status column still says — so this can never again be a beat behind the write.
    const response = calculatePlanAndForecast(
      request({
        routineSteps: [packStep({ scheduledStartAt: iso(-30 * MIN), scheduledEndAt: iso(-15 * MIN) })],
        currentLocationId: "college"
      })
    );
    const recommendation = response.recommendation as unknown as {
      protectedCommitment?: unknown;
      openAnchor?: { phase: string; late?: boolean };
      primary?: { action: { id: string } } | null;
    };
    expect(recommendation.protectedCommitment).toBeUndefined();
    expect(recommendation.openAnchor).toMatchObject({ id: "college-class", phase: "active" });
    expect(recommendation.openAnchor?.late).toBeUndefined();
    expect(recommendation.primary?.action.id).toBe("write");
    // The point of the fix: still `pending`, still in its own scheduled window, and still not directed.
    expect(response.currentDirective).toMatchObject({ kind: "action", targetId: "write" });
  });

  it("treats a still-pending-but-arrived step exactly like an already-skipped one (skipped/arrived parity)", () => {
    // Whether the write-time skip already flipped the step to `skipped`, or arrival made it moot
    // before that write ever landed, the directive must come out identical: arrival alone is enough,
    // the DB status column is not load-bearing for what gets directed.
    const arrived = calculatePlanAndForecast(
      request({
        routineSteps: [packStep({ scheduledStartAt: iso(-30 * MIN), scheduledEndAt: iso(-15 * MIN) })],
        currentLocationId: "college"
      })
    );
    const alreadySkipped = calculatePlanAndForecast(
      request({
        routineSteps: [
          packStep({ status: "skipped", scheduledStartAt: iso(-30 * MIN), scheduledEndAt: iso(-15 * MIN) })
        ],
        currentLocationId: "college"
      })
    );
    expect(arrived.currentDirective).toEqual(alreadySkipped.currentDirective);
  });

  it("frees its window exactly as before when preparation finished ahead of time (on-time baseline)", () => {
    const response = calculatePlanAndForecast(
      request({
        routineSteps: [
          packStep({ status: "completed", scheduledStartAt: iso(-60 * MIN), scheduledEndAt: iso(-45 * MIN) })
        ],
        currentLocationId: "college"
      })
    );
    const recommendation = response.recommendation as unknown as {
      protectedCommitment?: unknown;
      openAnchor?: { phase: string; late?: boolean };
      primary?: { action: { id: string } } | null;
    };
    expect(recommendation.protectedCommitment).toBeUndefined();
    expect(recommendation.openAnchor).toMatchObject({ id: "college-class", phase: "active" });
    expect(recommendation.openAnchor?.late).toBeUndefined();
    expect(recommendation.primary?.action.id).toBe("write");
  });

  it("treats an arrival-skipped step exactly like a completed one for lateness", () => {
    // The server auto-skips a located commitment's remaining before-phase steps the moment arrival is
    // asserted (routine-step-arrival.ts) rather than leaving them `pending` forever. This is the
    // engine's side of that contract: `beforeStepsComplete`/`isRunningLate` (model/types.ts) must treat
    // a `skipped` step exactly as they already treat a `completed` one — same shape as the "on-time
    // baseline" test below, `skipped` standing in for `completed`.
    const response = calculatePlanAndForecast(
      request({
        routineSteps: [
          packStep({ status: "skipped", scheduledStartAt: iso(-30 * MIN), scheduledEndAt: iso(-15 * MIN) })
        ],
        currentLocationId: "college"
      })
    );
    const recommendation = response.recommendation as unknown as {
      protectedCommitment?: unknown;
      openAnchor?: { phase: string; late?: boolean };
      primary?: { action: { id: string } } | null;
    };
    expect(recommendation.protectedCommitment).toBeUndefined();
    expect(recommendation.openAnchor).toMatchObject({ id: "college-class", phase: "active" });
    expect(recommendation.openAnchor?.late).toBeUndefined();
    // Skipped is never directed — `directableStep` (directive.ts) already requires `pending`.
    expect(response.currentDirective.kind).not.toBe("routine_step");
    expect(recommendation.primary?.action.id).toBe("write");
  });

  it("does not gate a step behind whatever a skipped prerequisite itself depended on", () => {
    // `unmetPrerequisite`'s walk (directive.ts) stops at a `completed` edge without checking what sits
    // behind it — a finished step's own history stops mattering the moment it is done. `skipped` now
    // gets the identical short-circuit: once arrival made "Brush Teeth" moot, whatever it used to
    // depend on ("Pack Bag" — genuinely still `pending`, but its own scheduled window has not even
    // opened yet, so it is not independently directable) must not keep gating "Shower", which depends
    // only on the now-skipped "Brush Teeth". Before this fix, skipped fell through neither branch and
    // the walk kept going regardless of timing, surfacing "Pack Bag" as the directive.
    const response = calculatePlanAndForecast(
      request({
        routineSteps: [
          // `status: "blocked"`, not the default `"pending"`: the engine is now the only author of a
          // *pending* step's placement (the routine step timing design note, Invariants), so a pending
          // "pack" would be recomputed against the (late-running) commitment's real backward chain
          // instead of keeping this fixture's hand-set two-hours-out window — and a late commitment's
          // contiguous backward walk legitimately lands every pending step at or before `now`, which
          // would make "pack" itself due. `blocked` keeps the fixture's intent (not independently
          // directable) by a route `directableStep` already guarantees regardless of placement: it
          // requires `status === "pending"`, so a `blocked` step is never a directive candidate.
          packStep({ status: "blocked", scheduledStartAt: iso(2 * HOUR), scheduledEndAt: iso(2 * HOUR + 10 * MIN) }),
          {
            id: "brush",
            commitmentId: "college-class",
            title: "Brush Teeth",
            durationMinutes: 5,
            sequence: 1,
            timingRule: "flexible" as const,
            energy: "medium" as const,
            contexts: [],
            dependencyIds: ["pack"],
            phase: "before" as const,
            status: "skipped" as const,
            scheduledStartAt: iso(-30 * MIN),
            scheduledEndAt: iso(-20 * MIN)
          },
          {
            id: "shower",
            commitmentId: "college-class",
            title: "Shower",
            durationMinutes: 10,
            sequence: 2,
            timingRule: "flexible" as const,
            energy: "medium" as const,
            contexts: [],
            dependencyIds: ["brush"],
            phase: "before" as const,
            status: "pending" as const,
            scheduledStartAt: iso(-20 * MIN),
            scheduledEndAt: iso(-10 * MIN)
          }
        ]
      })
    );
    expect(response.currentDirective).toMatchObject({ kind: "routine_step", targetId: "shower" });
  });

  it("keeps a finished commitment's pending leftovers invisible (bcd354d6 regression guard)", () => {
    // The widened per-commitment bound (directableStep, directive.ts) exists precisely so a step
    // stays directable past its own elapsed window while its commitment is still running late — it
    // must not also revive a step whose commitment has actually ended. Once `now` reaches `endsAt`,
    // `isRunningLate` never fires again for this commitment either, so this is a double check: the
    // commitment is plainly over, not "late".
    const response = calculatePlanAndForecast(
      request({
        routineSteps: [packStep({ scheduledStartAt: iso(-6 * HOUR), scheduledEndAt: iso(-5.5 * HOUR) })],
        startsAtOffset: -5 * HOUR,
        endsAtOffset: -2 * HOUR
      })
    );
    const recommendation = response.recommendation as unknown as {
      protectedCommitment?: unknown;
      openAnchor?: unknown;
    };
    expect(recommendation.protectedCommitment).toBeUndefined();
    expect(recommendation.openAnchor).toBeUndefined();
    expect(response.currentDirective.kind).not.toBe("routine_step");
  });
});

/**
 * A skipped "get ready" check step. Work at 20:00Z, `setupBeforeMinutes` 10,
 * travel 6 min + arrival margin 5 ⇒ `travelStartsAt` 19:49Z; a before-phase step scheduled 19:35-19:37Z
 * was still `pending` at 19:50Z — inside the travel phase, but before the commitment's own `startsAt`.
 * `resolveProtectedCommitment`'s running-late branch only ran inside `commitment.startsAt <= now &&
 * commitment.endsAt > now`, so the pending step was invisible before the commitment started:
 * `selectCurrentDirective`'s `plannedLeg` returned the travel leg first and the step never surfaced.
 *
 * These extend the coverage above to the pre-start phases (setup, travel, arrival): the same
 * "pending step, not arrived ⇒ setup/late" rule now applies there too.
 */
describe("a located commitment running late before it even starts", () => {
  it("directs the overdue prerequisite instead of the travel leg, before the commitment starts", () => {
    // Commitment starts in 5 minutes; travel (~8 min) + arrival margin (2 min) puts travelStartsAt
    // before now, so the clock alone would read this as the travel phase. One before-phase step's own
    // scheduled window (-20 to -10 minutes) has already elapsed and it is still pending.
    const response = calculatePlanAndForecast(
      request({
        startsAtOffset: 5 * MIN,
        routineSteps: [packStep({ scheduledStartAt: iso(-20 * MIN), scheduledEndAt: iso(-10 * MIN) })]
      })
    );
    const recommendation = response.recommendation as unknown as {
      protectedCommitment?: { phase: string; late?: boolean };
    };
    expect(recommendation.protectedCommitment).toMatchObject({ id: "college-class", phase: "setup", late: true });
    expect(response.currentDirective).toMatchObject({ kind: "routine_step", targetId: "pack" });
  });

  it("leaves the travel directive unchanged once the before-phase steps are done", () => {
    const response = calculatePlanAndForecast(
      request({
        startsAtOffset: 5 * MIN,
        routineSteps: [
          packStep({ status: "completed", scheduledStartAt: iso(-20 * MIN), scheduledEndAt: iso(-10 * MIN) })
        ]
      })
    );
    const recommendation = response.recommendation as unknown as {
      protectedCommitment?: { phase: string; late?: boolean };
    };
    expect(recommendation.protectedCommitment).toMatchObject({ id: "college-class", phase: "travel" });
    expect(recommendation.protectedCommitment?.late).toBeUndefined();
    expect(response.currentDirective).toMatchObject({ kind: "travel", toLocationId: "college" });
  });

  it("leaves an early arrival's behaviour unchanged even with a step still pending", () => {
    // Arrival wins outright, exactly as it does once the commitment has started. Already being at
    // "college" collapses the journey to zero, so this exercises the setup phase instead of travel — with
    // a 15-minute setup buffer, protection starts before the commitment but the clock-only phase
    // stands as plain "setup", not late: the new pre-start check must not fire once the person has
    // actually arrived, whatever the step's own status still says.
    const response = calculatePlanAndForecast(
      request({
        startsAtOffset: 5 * MIN,
        setupBeforeMinutes: 15,
        currentLocationId: "college",
        routineSteps: [packStep({ scheduledStartAt: iso(-20 * MIN), scheduledEndAt: iso(-10 * MIN) })]
      })
    );
    const recommendation = response.recommendation as unknown as {
      protectedCommitment?: { phase: string; late?: boolean };
    };
    expect(recommendation.protectedCommitment).toMatchObject({ id: "college-class", phase: "setup" });
    expect(recommendation.protectedCommitment?.late).toBeUndefined();
  });
});
