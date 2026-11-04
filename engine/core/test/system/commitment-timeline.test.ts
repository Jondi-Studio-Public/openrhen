import { describe, expect, it } from "vitest";
import {
  PLAN_FORECAST_CONTRACT_VERSION,
  planForecastRequestSchema,
  portalStateSchema,
  type PlanForecastResponse
} from "@openrhen/contracts";
import { calculatePlanAndForecast } from "../../src/index.js";
import { compactDayPlan } from "../model/day-plan-harness.js";
// `tracked-overtime-keeps-return-leg.json` lives here rather than in
// `snapshot-replay/replay.test.ts` (not in this task's Allowed files): replayed the same way that
// file replays every other fixture, with an extra return-leg check (`commitmentTimelines`) the shared `Fixture.expect`
// shape there has no field for.
import trackedOvertimeKeepsReturnLeg from "../snapshot-replay/tracked-overtime-keeps-return-leg.json" with { type: "json" };

/**
 * the engine's overlay and tracked-end half.
 * `deriveCommitmentRepeats` folds a recurring occurrence's stored `custom` row (its own title, times,
 * place, buffers, project, lateness, transport mode and contact) onto the rule-generated occurrence
 * before the horizon filter, and resolves `trackedEndedAt` for every recurring occurrence exactly as
 * a one-off commitment's own row does. `derivedState.commitmentTimelines` carries the resulting edges
 * on the wire.
 */

const DAY = "2026-08-19";
const iso = (time: string) => `${DAY}T${time}:00.000Z`;
const HOUR = 3_600_000;

// UTC settings timezone throughout, so every clock in this file is the plain wall clock with no
// offset arithmetic to keep straight.
const TRAVEL_MINUTES = 25;
// A stored fallback carries the journey store's padding (the travel time model design note,
// "Variability"): `max(3, 0.15 × typical)` on top, rounded up, since nothing at all is sampled here.
const PADDED_TRAVEL_MINUTES = Math.ceil(TRAVEL_MINUTES + Math.max(3, 0.15 * TRAVEL_MINUTES));
const SHIFT_START = iso("15:00");
const SHIFT_END = iso("17:00");
const TRANSITION_MINUTES = 20;
// The overtime scenario: tracked 15 minutes past the scheduled end.
const TRACKED_ENDED_AT = iso("17:15");
// freeAt = trackedEndedAt + transition; homeAt = freeAt + the homeward leg (padded).
const FREE_AT = iso("17:35");
const HOME_AT = new Date(Date.parse(FREE_AT) + PADDED_TRAVEL_MINUTES * 60_000).toISOString();

function baseState(overrides: Record<string, unknown> = {}) {
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
      conditionCatalog: ["home", "work"],
      preferredBedtime: "23:30",
      preferredWakeTime: "06:00",
      desiredSleepMinutes: 480,
      minimumSleepMinutes: 420,
      maxAwakeHours: 18,
      arrivalMarginMinutes: 0,
      homeLocationId: "home",
      lastWokeAt: iso("06:00")
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
        internalDeadlineAt: new Date(new Date(iso("00:00")).getTime() + 60 * 24 * HOUR).toISOString()
      }
    ],
    // Workable everywhere (empty contexts), so a home-vs-stay choice after the commitment ends is
    // decided on the merits and a homeward leg is worth attaching, exactly as `routine-step-travel`
    // fixture relies on.
    actions: [
      {
        id: "write",
        projectId: "proj",
        title: "write",
        status: "active",
        optimisticMinutes: 240,
        expectedMinutes: 240,
        pessimisticMinutes: 240,
        remainingMinutes: 240,
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
    commitments: [],
    commitmentRecurrenceRules: [],
    routineSteps: [],
    routinePresets: [],
    occurrences: [],
    locationProfiles: [],
    sleepPlans: [],
    captures: [],
    completedToday: [],
    assertedConditions: ["work"],
    currentEnergy: "medium",
    horizonEnd: new Date(new Date(iso("00:00")).getTime() + 30 * 24 * HOUR).toISOString(),
    activeSession: null,
    conditionDefinitions: [
      { id: "home", name: "Home", kind: "location", status: "active" },
      { id: "work", name: "Work", kind: "location", status: "active", travelMinutes: TRAVEL_MINUTES }
    ],
    currentSituation: {
      // Arrived at work exactly on time (arrivalMarginMinutes: 0, so `arriveBy` is `startsAt` itself).
      locationId: "work",
      locationSetAt: SHIFT_START,
      overrides: {},
      carrying: {},
      transportModes: ["car"],
      travel: {}
    },
    ...overrides
  });
}

function run(overrides: Record<string, unknown>, at: string) {
  const state = baseState(overrides);
  return calculatePlanAndForecast(
    planForecastRequestSchema.parse({
      contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
      requestId: "00000000-0000-4000-8000-00000000c706",
      inputVersion: "commitment-timeline-fixture",
      calculatedAt: at,
      horizonEnd: new Date(new Date(iso("00:00")).getTime() + 30 * 24 * HOUR).toISOString(),
      state
    })
  );
}

const oneOffShift = {
  id: "shift",
  title: "Shift",
  status: "confirmed",
  startsAt: SHIFT_START,
  endsAt: SHIFT_END,
  locationId: "work",
  setupBeforeMinutes: 0,
  transitionAfterMinutes: TRANSITION_MINUTES,
  trackedEndedAt: TRACKED_ENDED_AT
};

/** Minutes between a commitment's `freeAt` and `homeAt` on the wire timeline: its return leg. */
function returnLegMinutes(response: PlanForecastResponse, id: string): number | undefined {
  const timeline = (response.derivedState.commitmentTimelines ?? []).find((item) => item.id === id);
  return timeline?.homeAt ? (Date.parse(timeline.homeAt) - Date.parse(timeline.freeAt)) / 60_000 : undefined;
}

describe("tracked overtime keeps the return leg, one-off commitment", () => {
  it("still protects the commitment one minute before the effective free-at", () => {
    const response = run({ commitments: [oneOffShift] }, iso("17:34"));
    expect(response.currentDirective.kind).toBe("none");
  });

  it("the return directive starts exactly at the effective free-at (17:35)", () => {
    const response = run({ commitments: [oneOffShift] }, FREE_AT);
    expect(response.currentDirective).toMatchObject({ kind: "travel", toLocationId: "home" });
  });

  it("the leg and the timeline's return leg are still present at 17:40, mid-journey", () => {
    const response = run({ commitments: [oneOffShift] }, iso("17:40"));
    expect(returnLegMinutes(response, "shift")).toBe(PADDED_TRAVEL_MINUTES);
    expect(response.currentDirective).toMatchObject({ kind: "travel", toLocationId: "home" });
  });

  it("commitmentTimelines carries the same overtime edges, sorted by id", () => {
    const response = run({ commitments: [oneOffShift] }, iso("17:40"));
    expect(response.derivedState.commitmentTimelines).toEqual([
      expect.objectContaining({
        id: "shift",
        startsAt: SHIFT_START,
        endsAt: SHIFT_END,
        effectiveEndsAt: TRACKED_ENDED_AT,
        overtime: true,
        freeAt: FREE_AT,
        homeAt: HOME_AT,
        protectedUntil: HOME_AT,
        latenessMatters: true
      })
    ]);
  });

  describe("a live session against the shift", () => {
    const { trackedEndedAt: _tracked, ...untrackedShift } = oneOffShift;
    const liveSession = (startedAt: string) => ({
      id: "session-1",
      actionId: "shift",
      targetType: "fixed_commitment",
      targetId: "shift",
      startedAt,
      plannedEndAt: iso("17:30"),
      plannedMinutes: 20,
      remainingBeforeMinutes: 0,
      activeElapsedSeconds: 300,
      status: "running"
    });
    const effectiveEnd = (response: PlanForecastResponse) =>
      response.derivedState.commitmentTimelines?.find((item) => item.id === "shift")?.effectiveEndsAt;

    it("begun before the scheduled end is overtime: the end follows the clock", () => {
      const response = run({ commitments: [untrackedShift], activeSession: liveSession(iso("16:30")) }, iso("17:10"));
      expect(effectiveEnd(response)).toBe(iso("17:10"));
    });

    it("begun after the scheduled end is the transition being tracked, and leaves the end where it was", () => {
      // "Start tracking the transition" at 17:05: counting it as overtime moved the end to now, opened
      // a fresh transition after it, and Now offered to track the transition again.
      const response = run({ commitments: [untrackedShift], activeSession: liveSession(iso("17:05")) }, iso("17:10"));
      expect(effectiveEnd(response)).toBe(SHIFT_END);
    });
  });

  it("the day plan draws the whole day, overtime included: the shift runs to 17:15, transition to 17:35, then the leg home", () => {
    const response = run({ commitments: [oneOffShift] }, SHIFT_START);
    const lines = compactDayPlan(response.dayPlan!);
    expect(lines).toContain(`17:35-18:04 travel→home 0/${PADDED_TRAVEL_MINUTES}`);
    // The commitment's own block is drawn to its effective end plus transition (17:35), not its bare
    // scheduled `endsAt` (17:00) — the day plan reads the same timeline every other consumer does.
    expect(lines.some((line) => line.startsWith("15:00-17:35 commitment shift"))).toBe(true);
  });

  it("withAnchorWindowOpened frees the anchor's own window through tracked overtime (task 003's gap)", () => {
    // 17:05: past the scheduled end (17:00) but still inside the tracked overtime (to 17:15), arrived
    // at work and no session against it — `openAnchorNow` reads this instant as free. Before this
    // task's `withAnchorWindowOpened` fix, the `:after` synthetic entry still started at the bare
    // `endsAt` (17:00), so `[17:00, 18:00]` stayed fully protected in `liveSchedule`'s planning slots
    // and no work could be ranked even though the anchor itself reports free; now `:after` starts at
    // the effective end (17:15), so only `[17:15, 18:00]` is withheld from the anchor's own slot.
    const anchorShift = { ...oneOffShift, presence: "anchor" };
    // A short enough minimum session that the 10 open minutes between 17:05 and the anchor's own
    // active-phase boundary (17:15, its effective end) are actually usable � the point under test
    // is only whether that span is open at all, not the scheduler's minimum-session rule.
    const response = run(
      {
        commitments: [anchorShift],
        actions: [
          {
            id: "write",
            projectId: "proj",
            title: "write",
            status: "active",
            optimisticMinutes: 240,
            expectedMinutes: 240,
            pessimisticMinutes: 240,
            remainingMinutes: 240,
            splittable: true,
            setupMinutes: 0,
            energy: "medium",
            minimumSessionMinutes: 5,
            maximumSessionMinutes: 60,
            importance: 3,
            consequence: 3,
            contexts: [],
            dependencyIds: [],
            schedulingMode: "one_off"
          }
        ]
      },
      iso("17:05")
    );
    const recommendation = response.recommendation as {
      primary?: { action?: { id?: string } } | null;
      openAnchor?: { id?: string };
    };
    expect(recommendation.openAnchor).toMatchObject({ id: "shift" });
    expect(recommendation.primary?.action?.id).toBe("write");
  });
});

describe("tracked overtime keeps the return leg, recurring occurrence", () => {
  const rule = {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Shift",
    timezone: "UTC",
    startDate: DAY,
    repeat: { unit: "days" as const, intervalDays: 1 },
    localStartTime: "15:00",
    localEndTime: "17:00",
    locationId: "work",
    setupBeforeMinutes: 0,
    transitionAfterMinutes: TRANSITION_MINUTES,
    status: "active" as const
  };

  it("stretches identically when the tracked end lives on the occurrence's own stored row", () => {
    // First pass: no stored row at all, just to learn the deterministic id the rule's occurrence for
    // today gets assigned (the same technique `cancelled-recurring-commitment.test.ts` uses).
    const discover = run({ commitmentRecurrenceRules: [rule] }, iso("14:00"));
    const occurrence = discover.derivedState.commitmentRepeats?.[0] as Record<string, unknown> | undefined;
    expect(occurrence, "the rule materialised today's occurrence").toBeDefined();

    // Second pass: the same rule, but the row now carries the tracked end a finished session would
    // have written — `scheduleSource` absent (`inherit`), so this is tracked end alone, no overlay.
    const response = run(
      {
        commitmentRecurrenceRules: [rule],
        commitments: [
          {
            id: occurrence!.id,
            title: "Shift",
            startsAt: occurrence!.startsAt,
            endsAt: occurrence!.endsAt,
            status: "confirmed",
            locationId: "work",
            setupBeforeMinutes: 0,
            transitionAfterMinutes: TRANSITION_MINUTES,
            recurrenceRuleId: rule.id,
            localDate: occurrence!.localDate,
            trackedEndedAt: TRACKED_ENDED_AT
          }
        ]
      },
      iso("17:40")
    );
    expect(returnLegMinutes(response, String(occurrence!.id))).toBe(PADDED_TRAVEL_MINUTES);
    expect(response.currentDirective).toMatchObject({ kind: "travel", toLocationId: "home" });
    expect(response.derivedState.commitmentTimelines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: occurrence!.id, effectiveEndsAt: TRACKED_ENDED_AT, overtime: true })
      ])
    );
    // Requirement 5 says "present and sorted": with ~29 entries (the rule repeats daily out to the
    // horizon) and ids that are not already in date order (confirmed by hand against a raw dump),
    // this is a real check, not one an already-sorted one-entry array would pass by construction.
    const ids = response.derivedState.commitmentTimelines!.map((timeline) => timeline.id);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
  });
});

describe("a custom occurrence overlay", () => {
  const rule = {
    id: "22222222-2222-4222-8222-222222222222",
    title: "Shift",
    timezone: "UTC",
    startDate: DAY,
    repeat: { unit: "days" as const, intervalDays: 1 },
    localStartTime: "15:00",
    localEndTime: "17:00",
    locationId: "work",
    setupBeforeMinutes: 0,
    transitionAfterMinutes: TRANSITION_MINUTES,
    status: "active" as const
  };

  function discoverOccurrenceId(index = 0) {
    const discover = run({ commitmentRecurrenceRules: [rule] }, iso("08:00"));
    const occurrence = discover.derivedState.commitmentRepeats?.[index] as Record<string, unknown> | undefined;
    expect(occurrence, `the rule materialised occurrence ${index}`).toBeDefined();
    return occurrence!;
  }

  it("a custom occurrence moved to 10:00-18:00 drives the day plan and capacity", () => {
    const occurrence = discoverOccurrenceId();
    const response = run(
      {
        commitmentRecurrenceRules: [rule],
        commitments: [
          {
            id: occurrence.id,
            title: "Shift (moved)",
            startsAt: iso("10:00"),
            endsAt: iso("18:00"),
            status: "confirmed",
            locationId: "work",
            setupBeforeMinutes: 0,
            transitionAfterMinutes: TRANSITION_MINUTES,
            recurrenceRuleId: rule.id,
            localDate: occurrence.localDate,
            scheduleSource: "custom"
          }
        ]
      },
      iso("08:00")
    );
    const repeat = response.derivedState.commitmentRepeats?.find(
      (item) => (item as Record<string, unknown>).id === occurrence.id
    ) as Record<string, unknown> | undefined;
    expect(repeat).toMatchObject({ title: "Shift (moved)", startsAt: iso("10:00"), endsAt: iso("18:00") });

    // Capacity/the day plan: the moved occurrence's block sits at its overlaid hours (plus its
    // transition, exactly as the plain overtime scenario draws its own block), not the rule's.
    const lines = compactDayPlan(response.dayPlan!);
    expect(lines.some((line) => line.startsWith("10:00-18:20 commitment"))).toBe(true);
    expect(lines.some((line) => line.startsWith("15:00-17:00 commitment"))).toBe(false);
    expect(lines.some((line) => line.startsWith("15:00-17:20 commitment"))).toBe(false);
  });

  it("a custom occurrence moved earlier drives the sleep wake constraint", () => {
    // Tomorrow's occurrence (index 1: the rule repeats daily), moved to 04:00-12:00. The rule's own
    // 15:00 has nothing to do with tonight's sleep at all (control, below); the moved time pulls
    // tonight's plan earlier to accommodate it, proving the overlay reaches the sleep planner, which
    // reads the same `protectedCommitments()`/`commitmentRepeats` list every other consumer does.
    const tomorrow = discoverOccurrenceId(1);
    const movedStartsAt = new Date(new Date(iso("04:00")).getTime() + 24 * HOUR).toISOString();
    const movedEndsAt = new Date(new Date(iso("12:00")).getTime() + 24 * HOUR).toISOString();

    const withoutOverride = run({ commitmentRecurrenceRules: [rule] }, iso("08:00"));
    const controlSleep = withoutOverride.derivedState.sleepPlans[0] as Record<string, unknown> | undefined;
    expect(controlSleep, "a sleep plan was derived").toBeDefined();

    const response = run(
      {
        commitmentRecurrenceRules: [rule],
        commitments: [
          {
            id: tomorrow.id,
            title: "Shift (moved earlier)",
            startsAt: movedStartsAt,
            endsAt: movedEndsAt,
            status: "confirmed",
            locationId: "work",
            setupBeforeMinutes: 0,
            transitionAfterMinutes: TRANSITION_MINUTES,
            recurrenceRuleId: rule.id,
            localDate: tomorrow.localDate,
            scheduleSource: "custom"
          }
        ]
      },
      iso("08:00")
    );
    const sleepPlan = response.derivedState.sleepPlans[0] as Record<string, unknown> | undefined;
    expect(sleepPlan, "a sleep plan was derived").toBeDefined();
    // Tonight's plan now ends at or before the moved commitment's own start, and strictly earlier
    // than the unconstrained control plan — the moved occurrence, not the rule's untouched 15:00, is
    // what the sleep planner protected around.
    expect(new Date(sleepPlan!.plannedWakeAt as string).getTime()).toBeLessThanOrEqual(
      new Date(movedStartsAt).getTime()
    );
    expect(new Date(sleepPlan!.plannedWakeAt as string).getTime()).toBeLessThan(
      new Date(controlSleep!.plannedWakeAt as string).getTime()
    );
  });

  it("an override survives a series edit: the rule's times change, the custom row keeps its own", () => {
    const occurrence = discoverOccurrenceId();
    const editedRule = { ...rule, localStartTime: "09:00", localEndTime: "11:00" };
    const response = run(
      {
        commitmentRecurrenceRules: [editedRule],
        commitments: [
          {
            id: occurrence.id,
            title: "Shift (moved)",
            startsAt: iso("10:00"),
            endsAt: iso("18:00"),
            status: "confirmed",
            locationId: "work",
            setupBeforeMinutes: 0,
            transitionAfterMinutes: TRANSITION_MINUTES,
            recurrenceRuleId: rule.id,
            localDate: occurrence.localDate,
            scheduleSource: "custom"
          }
        ]
      },
      iso("08:00")
    );
    const repeat = response.derivedState.commitmentRepeats?.find(
      (item) => (item as Record<string, unknown>).id === occurrence.id
    ) as Record<string, unknown> | undefined;
    expect(repeat).toMatchObject({ startsAt: iso("10:00"), endsAt: iso("18:00") });
  });

  it("an override whose date the rule no longer produces is ignored: not emitted, not protected", () => {
    // The rule now only falls on odd local dates two days apart from its start, so tomorrow — the
    // custom row's own date — is a date the rule no longer produces.
    const narrowedRule = { ...rule, repeat: { unit: "days" as const, intervalDays: 2 } };
    const orphanDate = new Date(new Date(iso("00:00")).getTime() + 24 * HOUR).toISOString().slice(0, 10);
    const orphanId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const response = run(
      {
        commitmentRecurrenceRules: [narrowedRule],
        commitments: [
          {
            id: orphanId,
            title: "Shift (orphaned)",
            startsAt: new Date(new Date(iso("10:00")).getTime() + 24 * HOUR).toISOString(),
            endsAt: new Date(new Date(iso("18:00")).getTime() + 24 * HOUR).toISOString(),
            status: "confirmed",
            locationId: "work",
            setupBeforeMinutes: 0,
            transitionAfterMinutes: TRANSITION_MINUTES,
            recurrenceRuleId: narrowedRule.id,
            localDate: orphanDate,
            scheduleSource: "custom"
          }
        ]
      },
      iso("08:00")
    );
    expect(
      (response.derivedState.commitmentRepeats ?? []).some((item) => (item as Record<string, unknown>).id === orphanId)
    ).toBe(false);
    expect((response.derivedState.commitmentTimelines ?? []).some((item) => item.id === orphanId)).toBe(false);
    const dayPlanBlocks = (response.dayPlan as { blocks?: Array<Record<string, unknown>> } | null)?.blocks ?? [];
    expect(dayPlanBlocks.some((block) => block.targetId === orphanId)).toBe(false);
  });
});

describe("a cancelled occurrence of a recurring commitment", () => {
  const rule = {
    id: "33333333-3333-4333-8333-333333333333",
    title: "Shift",
    timezone: "UTC",
    startDate: DAY,
    repeat: { unit: "days" as const, intervalDays: 1 },
    localStartTime: "15:00",
    localEndTime: "17:00",
    locationId: "work",
    setupBeforeMinutes: 0,
    transitionAfterMinutes: TRANSITION_MINUTES,
    status: "active" as const
  };

  it("is still emitted in commitmentRepeats (the persist sweep needs its id), but not protected", () => {
    const discover = run({ commitmentRecurrenceRules: [rule] }, iso("08:00"));
    const occurrence = discover.derivedState.commitmentRepeats?.[0] as Record<string, unknown> | undefined;
    expect(occurrence, "the rule materialised today's occurrence").toBeDefined();

    const response = run(
      {
        commitmentRecurrenceRules: [rule],
        commitments: [
          {
            id: occurrence!.id,
            title: "Shift",
            startsAt: occurrence!.startsAt,
            endsAt: occurrence!.endsAt,
            status: "cancelled",
            locationId: "work",
            setupBeforeMinutes: 0,
            transitionAfterMinutes: TRANSITION_MINUTES,
            recurrenceRuleId: rule.id,
            localDate: occurrence!.localDate
          }
        ]
      },
      iso("08:00")
    );
    // The Trap: still in commitmentRepeats.
    expect(
      (response.derivedState.commitmentRepeats ?? []).some(
        (item) => (item as Record<string, unknown>).id === occurrence!.id
      )
    ).toBe(true);
    // But not protected: no block for it in the day plan.
    const dayPlanBlocks = (response.dayPlan as { blocks?: Array<Record<string, unknown>> } | null)?.blocks ?? [];
    expect(dayPlanBlocks.some((block) => block.targetId === occurrence!.id)).toBe(false);
  });
});

describe("promoted fixture: tracked-overtime-keeps-return-leg.json", () => {
  interface Fixture {
    name: string;
    why: string;
    request: unknown;
    expect: {
      currentDirective?: unknown;
      primaryActionId?: string | null;
      dayPlan?: string[];
    };
  }

  it("keeps the timeline's return leg and the return directive five minutes into the journey home", () => {
    const fixture = trackedOvertimeKeepsReturnLeg as Fixture;
    expect(
      fixture.why.startsWith("TODO"),
      "still carries the placeholder `why`; state the intended behaviour and correct `expect` to match it"
    ).toBe(false);

    const request = planForecastRequestSchema.parse(fixture.request);
    const response = calculatePlanAndForecast(request);

    expect(response.currentDirective).toEqual(fixture.expect.currentDirective);
    const recommendation = response.recommendation as { primary?: { action?: { id?: string } } } | null;
    expect(recommendation?.primary?.action?.id ?? null).toBe(fixture.expect.primaryActionId);
    expect(response.dayPlan, "day plan present").toBeDefined();
    expect(compactDayPlan(response.dayPlan!)).toEqual(fixture.expect.dayPlan);

    // The one assertion `replay.test.ts`'s shared `Fixture.expect` shape has no field for, and the
    // reason this fixture is replayed here instead: the return leg's own minutes, still outstanding
    // mid-journey.
    expect(returnLegMinutes(response, "shift")).toBe(PADDED_TRAVEL_MINUTES);
  });

  describe("overlapping running anchors", () => {
    // A recurring class and a disruption-created copy of it, both running at once, both anchors:
    // the first used to be opened alone, and the second still blocked the whole interval.
    const classA = {
      ...oneOffShift,
      id: "class-a",
      title: "College Class",
      presence: "anchor",
      startsAt: iso("08:00"),
      endsAt: iso("16:00"),
      trackedEndedAt: undefined
    };
    const classB = {
      ...classA,
      id: "class-b",
      title: "College class ABC10002",
      endsAt: iso("16:24")
    };
    const overlapping = { commitments: [classA, classB] };

    it("opens every running anchor, so work is offered while both classes run", () => {
      const response = run(overlapping, iso("10:00"));
      const recommendation = response.recommendation as {
        primary?: { action?: { id?: string } } | null;
        noFit?: unknown;
      };
      expect(recommendation.primary?.action?.id).toBe("write");
    });

    it("keeps each class's post-class tail protected: it is named, and nothing is offered inside it", () => {
      // 16:10: class A is over and in its transition tail; class B still runs and is open. Opening
      // B's window must not open A's tail, and A's tail is what holds the clock, so it is named.
      const response = run(overlapping, iso("16:10"));
      const recommendation = response.recommendation as {
        primary?: unknown;
        protectedCommitment?: { id?: string; phase?: string };
      };
      expect(recommendation.primary ?? null).toBeNull();
      expect(recommendation.protectedCommitment).toMatchObject({ id: "class-a", phase: "transition" });
    });

    it("still names a blocking appointment inside the classes, even when the anchors rank first", () => {
      // The appointment started before the classes, so the two open anchors outrank it as the
      // protected commitment; it must not vanish behind them.
      const appointment = {
        ...oneOffShift,
        id: "appointment",
        title: "Doctor",
        presence: "blocking",
        startsAt: iso("07:30"),
        endsAt: iso("11:00"),
        trackedEndedAt: undefined
      };
      const response = run({ commitments: [classA, classB, appointment] }, iso("10:00"));
      const recommendation = response.recommendation as {
        primary?: unknown;
        protectedCommitment?: { id?: string };
      };
      expect(recommendation.primary ?? null).toBeNull();
      expect(recommendation.protectedCommitment?.id).toBe("appointment");
    });

    it("names an appointment in its setup phase while the classes are open", () => {
      // 10:00: the 11:00 appointment's 90-minute setup has begun, which removes capacity from now.
      // It is not "active", but it still holds the clock, so it must be named.
      const appointment = {
        ...oneOffShift,
        id: "appointment",
        title: "Doctor",
        presence: "blocking",
        startsAt: iso("11:00"),
        endsAt: iso("12:00"),
        setupBeforeMinutes: 90,
        trackedEndedAt: undefined
      };
      const response = run({ commitments: [classA, classB, appointment] }, iso("10:00"));
      const recommendation = response.recommendation as {
        primary?: unknown;
        protectedCommitment?: { id?: string; phase?: string };
      };
      expect(recommendation.primary ?? null).toBeNull();
      expect(recommendation.protectedCommitment).toMatchObject({ id: "appointment", phase: "setup" });
    });
  });
});
