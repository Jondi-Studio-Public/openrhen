import { describe, expect, it } from "vitest";
import { commitmentTimeline } from "../../src/model/commitment-timeline.js";
import type { FixedCommitment } from "../../src/model/types.js";
import {
  placeRoutineChains,
  type BedtimeChain,
  type CommitmentChain,
  type PlacedStep,
  type PlacementStep,
  type TimeBand,
  type WakeChain
} from "../../src/scheduling/routine-placement.js";

const minutesAfter = (base: Date, minutes: number) => new Date(base.getTime() + minutes * 60000);

/** A `PlacementStep` with sensible defaults; override only what the test cares about. */
function step(
  overrides: Partial<PlacementStep> & Pick<PlacementStep, "id" | "sequence" | "durationMinutes" | "phase">
): PlacementStep {
  return {
    status: "pending",
    timingRule: "contiguous",
    dependencyIds: [],
    contexts: [],
    ...overrides
  };
}

function commitment(
  overrides: Partial<FixedCommitment> & Pick<FixedCommitment, "startsAt" | "endsAt">
): FixedCommitment {
  return { id: "c1", setupBeforeMinutes: 0, ...overrides };
}

function commitmentChain(
  fixedCommitment: FixedCommitment,
  steps: PlacementStep[],
  extra: Partial<Omit<CommitmentChain, "kind" | "steps" | "timeline">> = {},
  arrivalMarginMinutes = 0
): CommitmentChain {
  return {
    kind: "commitment",
    anchorId: fixedCommitment.id,
    timeline: commitmentTimeline(fixedCommitment, arrivalMarginMinutes),
    steps,
    ...extra
  };
}

const noBands: TimeBand[] = [];
const evening: TimeBand = { id: "evening", name: "Evening", start: "17:00", end: "22:00" };

function place(args: {
  chains: (CommitmentChain | BedtimeChain | WakeChain)[];
  now?: Date;
  bands?: TimeBand[];
  blocked?: { startsAt: Date; endsAt: Date }[];
}): PlacedStep[] {
  return placeRoutineChains({
    now: args.now ?? new Date("2026-01-01T00:00:00.000Z"),
    timezone: "UTC",
    bands: args.bands ?? noBands,
    chains: args.chains,
    blocked: args.blocked ?? []
  });
}

function byId(placed: PlacedStep[], id: string): PlacedStep {
  const found = placed.find((item) => item.stepId === id);
  if (!found) throw new Error(`step ${id} was not placed`);
  return found;
}

describe("placeRoutineChains — parity with today's computeRoutineStepSchedule", () => {
  const endsAt = new Date("2026-09-04T09:00:00.000Z");
  const startsAt = new Date("2026-09-04T08:00:00.000Z");

  it("chains an after step from endsAt + transition when there is a transition but no travel", () => {
    const c = commitment({ startsAt, endsAt, transitionAfterMinutes: 20 });
    const chain = commitmentChain(c, [step({ id: "get-changed", sequence: 0, durationMinutes: 15, phase: "after" })]);
    const placed = byId(place({ chains: [chain] }), "get-changed");
    expect(placed.placedStartAt).toEqual(minutesAfter(endsAt, 20));
    expect(placed.placedEndAt).toEqual(minutesAfter(endsAt, 35));
  });

  it("reproduces the plain endsAt anchor when there is no transition and no travel at all", () => {
    const c = commitment({ startsAt, endsAt });
    const chain = commitmentChain(c, [step({ id: "step", sequence: 0, durationMinutes: 10, phase: "after" })]);
    const placed = byId(place({ chains: [chain] }), "step");
    expect(placed.placedStartAt).toEqual(endsAt);
    expect(placed.placedEndAt).toEqual(minutesAfter(endsAt, 10));
  });

  it("chains a venue-context after step from endsAt, and a step without the commitment's own context from the arrival-home boundary", () => {
    const c = commitment({ startsAt, endsAt, locationId: "work", transitionAfterMinutes: 20, travelAfterMinutes: 15 });
    const chain = commitmentChain(
      c,
      [
        step({ id: "log-off", sequence: 0, durationMinutes: 5, phase: "after", contexts: ["work"] }),
        step({ id: "get-changed", sequence: 1, durationMinutes: 10, phase: "after", contexts: ["home"] })
      ],
      { locationId: "work" }
    );
    const placed = place({ chains: [chain] });
    expect(byId(placed, "log-off").placedStartAt).toEqual(endsAt);
    expect(byId(placed, "log-off").placedEndAt).toEqual(minutesAfter(endsAt, 5));
    expect(byId(placed, "get-changed").placedStartAt).toEqual(minutesAfter(endsAt, 35));
    expect(byId(placed, "get-changed").placedEndAt).toEqual(minutesAfter(endsAt, 45));
  });

  it("pushes the home group's start to when the venue group actually ends, when it outlasts the transition and travel", () => {
    const c = commitment({ startsAt, endsAt, locationId: "work", transitionAfterMinutes: 5, travelAfterMinutes: 0 });
    const chain = commitmentChain(
      c,
      [
        step({ id: "wrap-up", sequence: 0, durationMinutes: 30, phase: "after", contexts: ["work"] }),
        step({ id: "unpack", sequence: 1, durationMinutes: 10, phase: "after", contexts: ["home"] })
      ],
      { locationId: "work" }
    );
    const placed = place({ chains: [chain] });
    expect(byId(placed, "wrap-up").placedStartAt).toEqual(endsAt);
    expect(byId(placed, "wrap-up").placedEndAt).toEqual(minutesAfter(endsAt, 30));
    expect(byId(placed, "unpack").placedStartAt).toEqual(minutesAfter(endsAt, 30));
    expect(byId(placed, "unpack").placedEndAt).toEqual(minutesAfter(endsAt, 40));
  });

  it("keeps each group in its own sequence order across a mixed venue/home after chain", () => {
    const c = commitment({ startsAt, endsAt, locationId: "work", transitionAfterMinutes: 10 });
    const chain = commitmentChain(
      c,
      [
        step({ id: "venue-1", sequence: 0, durationMinutes: 5, phase: "after", contexts: ["work"] }),
        step({ id: "home-1", sequence: 1, durationMinutes: 5, phase: "after", contexts: ["home"] }),
        step({ id: "venue-2", sequence: 2, durationMinutes: 5, phase: "after", contexts: ["work"] }),
        step({ id: "home-2", sequence: 3, durationMinutes: 5, phase: "after", contexts: ["home"] })
      ],
      { locationId: "work" }
    );
    const placed = place({ chains: [chain] });
    expect(byId(placed, "venue-1").placedStartAt).toEqual(endsAt);
    expect(byId(placed, "venue-2").placedStartAt).toEqual(minutesAfter(endsAt, 5));
    expect(byId(placed, "home-1").placedStartAt).toEqual(minutesAfter(endsAt, 10));
    expect(byId(placed, "home-2").placedStartAt).toEqual(minutesAfter(endsAt, 15));
  });

  it("does not open a gap in either after chain when a step in it is skipped", () => {
    const c = commitment({ startsAt, endsAt, locationId: "work", transitionAfterMinutes: 10 });
    const chain = commitmentChain(
      c,
      [
        step({ id: "venue-1", sequence: 0, durationMinutes: 5, phase: "after", contexts: ["work"], skip: true }),
        step({ id: "venue-2", sequence: 1, durationMinutes: 5, phase: "after", contexts: ["work"] }),
        step({ id: "home-1", sequence: 2, durationMinutes: 5, phase: "after", contexts: ["home"], skip: true }),
        step({ id: "home-2", sequence: 3, durationMinutes: 5, phase: "after", contexts: ["home"] })
      ],
      { locationId: "work" }
    );
    const placed = place({ chains: [chain] });
    expect(placed.some((p) => p.stepId === "venue-1")).toBe(false);
    expect(byId(placed, "venue-2").placedStartAt).toEqual(endsAt);
    expect(placed.some((p) => p.stepId === "home-1")).toBe(false);
    expect(byId(placed, "home-2").placedStartAt).toEqual(minutesAfter(endsAt, 10));
  });

  it("ends the before chain at setupStartsAt, which folds in travel and the arrival margin ahead of setup", () => {
    // leaveBy = startsAt - margin - travelBefore; setupStartsAt = leaveBy - setup.
    const c = commitment({ startsAt, endsAt, setupBeforeMinutes: 5, travelBeforeMinutes: 20 });
    const chain = commitmentChain(
      c,
      [step({ id: "pack-bag", sequence: 0, durationMinutes: 10, phase: "before" })],
      {},
      3
    );
    const placed = byId(place({ chains: [chain] }), "pack-bag");
    // setupStartsAt = startsAt - margin(3) - travelBefore(20) - setup(5) = startsAt - 28.
    expect(placed.placedEndAt).toEqual(minutesAfter(startsAt, -28));
    expect(placed.placedStartAt).toEqual(minutesAfter(startsAt, -38));
  });

  it("a non-pending step (status, not the skip flag) is never placed but its stored interval still shapes its pending neighbour", () => {
    const c = commitment({ startsAt, endsAt, locationId: "work", transitionAfterMinutes: 10 });
    const chain = commitmentChain(
      c,
      [
        step({
          id: "venue-1",
          sequence: 0,
          durationMinutes: 5,
          phase: "after",
          contexts: ["work"],
          status: "cancelled",
          scheduledStartAt: endsAt,
          scheduledEndAt: minutesAfter(endsAt, 5)
        }),
        step({ id: "venue-2", sequence: 1, durationMinutes: 5, phase: "after", contexts: ["work"] })
      ],
      { locationId: "work" }
    );
    const placed = place({ chains: [chain] });
    // A non-pending, non-skip step is an input only — never (re)placed — but it still occupies its
    // own stored interval, so the pending neighbour chains from where that interval actually ends.
    expect(placed.some((p) => p.stepId === "venue-1")).toBe(false);
    expect(byId(placed, "venue-2").placedStartAt).toEqual(minutesAfter(endsAt, 5));
  });

  describe("trackedEndedAt", () => {
    it("re-anchors the after chain from tracked overtime rather than the stale scheduled endsAt", () => {
      const trackedEndedAt = minutesAfter(endsAt, 38);
      const c = commitment({ startsAt, endsAt, transitionAfterMinutes: 20, trackedEndedAt });
      const chain = commitmentChain(c, [step({ id: "eat-a-meal", sequence: 0, durationMinutes: 15, phase: "after" })]);
      const placed = byId(place({ chains: [chain] }), "eat-a-meal");
      expect(placed.placedStartAt).toEqual(minutesAfter(trackedEndedAt, 20));
      expect(placed.placedEndAt).toEqual(minutesAfter(trackedEndedAt, 35));
    });

    it("also pushes the venue chain's own start to the tracked end, not the scheduled one", () => {
      const trackedEndedAt = minutesAfter(endsAt, 38);
      const c = commitment({ startsAt, endsAt, locationId: "work", trackedEndedAt });
      const chain = commitmentChain(
        c,
        [step({ id: "log-off", sequence: 0, durationMinutes: 5, phase: "after", contexts: ["work"] })],
        {
          locationId: "work"
        }
      );
      const placed = byId(place({ chains: [chain] }), "log-off");
      expect(placed.placedStartAt).toEqual(trackedEndedAt);
      expect(placed.placedEndAt).toEqual(minutesAfter(trackedEndedAt, 5));
    });

    it("is unaffected when the session finished on time or early", () => {
      for (const trackedEndedAt of [endsAt, minutesAfter(endsAt, -10)]) {
        const c = commitment({ startsAt, endsAt, trackedEndedAt });
        const chain = commitmentChain(c, [step({ id: "step", sequence: 0, durationMinutes: 10, phase: "after" })]);
        const placed = byId(place({ chains: [chain] }), "step");
        expect(placed.placedStartAt).toEqual(endsAt);
        expect(placed.placedEndAt).toEqual(minutesAfter(endsAt, 10));
      }
    });

    it("never moves a before-phase step, however much overtime is tracked", () => {
      const trackedEndedAt = minutesAfter(endsAt, 38);
      const c = commitment({ startsAt, endsAt, setupBeforeMinutes: 5, trackedEndedAt });
      const chain = commitmentChain(c, [step({ id: "pack-bag", sequence: 0, durationMinutes: 10, phase: "before" })]);
      const placed = byId(place({ chains: [chain] }), "pack-bag");
      expect(placed.placedStartAt).toEqual(minutesAfter(startsAt, -15));
      expect(placed.placedEndAt).toEqual(minutesAfter(startsAt, -5));
    });
  });
});

describe("placeRoutineChains — waits", () => {
  const startsAt = new Date("2026-09-27T07:00:00.000Z");

  it("a wait with a dependent chains the dependent's latest start minus the wait", () => {
    const c = commitment({ startsAt, endsAt: minutesAfter(startsAt, 60) });
    const wash = step({ id: "wash", sequence: 0, durationMinutes: 5, phase: "before", waitAfterMinutes: 30 });
    const dry = step({ id: "dry", sequence: 1, durationMinutes: 5, phase: "before", dependencyIds: ["wash"] });
    const placed = place({ chains: [commitmentChain(c, [wash, dry])] });
    const dryPlaced = byId(placed, "dry");
    const washPlaced = byId(placed, "wash");
    expect(dryPlaced.placedStartAt).toEqual(minutesAfter(startsAt, -5));
    expect(washPlaced.waitEndsAt).toEqual(dryPlaced.placedStartAt);
    expect(washPlaced.startBy).toEqual(washPlaced.placedStartAt);
  });

  it("a wait with no dependent chains from the boundary itself", () => {
    const c = commitment({ startsAt, endsAt: minutesAfter(startsAt, 60) });
    const soak = step({ id: "soak", sequence: 0, durationMinutes: 10, phase: "before", waitAfterMinutes: 45 });
    const placed = byId(place({ chains: [commitmentChain(c, [soak])] }), "soak");
    expect(placed.placedStartAt).toEqual(minutesAfter(startsAt, -55));
    expect(placed.placedEndAt).toEqual(minutesAfter(startsAt, -45));
    expect(placed.waitEndsAt).toEqual(startsAt);
  });

  it("a later step, not the wait's own dependent, may sit inside an earlier step's wait", () => {
    const c = commitment({ startsAt: minutesAfter(startsAt, -120), endsAt: startsAt });
    const stepA = step({ id: "a", sequence: 0, durationMinutes: 5, phase: "after", waitAfterMinutes: 60 });
    const stepB = step({ id: "b", sequence: 1, durationMinutes: 5, phase: "after" });
    const placed = place({ chains: [commitmentChain(c, [stepA, stepB])] });
    const a = byId(placed, "a");
    const b = byId(placed, "b");
    // Hands-on intervals never overlap...
    expect(b.placedStartAt!.getTime()).toBeGreaterThanOrEqual(a.placedEndAt!.getTime());
    // ...but b starts well inside a's wait window, since b is not a's dependent.
    expect(b.placedStartAt!.getTime()).toBeLessThan(a.waitEndsAt!.getTime());
  });

  it("a completed prerequisite's wait runs from completedAt, not its stored scheduledEndAt, in a forward chain", () => {
    const c = commitment({ startsAt: minutesAfter(startsAt, -120), endsAt: startsAt });
    // Deliberately different from scheduledEndAt, so a placer reading the stored schedule instead of
    // completedAt would be caught rather than coincidentally matching.
    const completedAt = minutesAfter(startsAt, 12);
    const prereq = step({
      id: "prereq",
      sequence: 0,
      durationMinutes: 5,
      phase: "after",
      status: "completed",
      completedAt,
      waitAfterMinutes: 20,
      scheduledStartAt: startsAt,
      scheduledEndAt: minutesAfter(startsAt, 5)
    });
    const dependent = step({
      id: "dependent",
      sequence: 1,
      durationMinutes: 5,
      phase: "after",
      dependencyIds: ["prereq"]
    });
    const placed = byId(place({ chains: [commitmentChain(c, [prereq, dependent])] }), "dependent");
    expect(placed.placedStartAt).toEqual(minutesAfter(completedAt, 20));
  });
});

describe("placeRoutineChains — must start by", () => {
  const startsAt = new Date("2026-09-27T07:00:00.000Z");

  it("before phase: caps the latest start and reports startBy", () => {
    const c = commitment({ startsAt, endsAt: minutesAfter(startsAt, 60) });
    const s = step({ id: "s", sequence: 0, durationMinutes: 5, phase: "before", mustStartByMinutes: 30 });
    const placed = byId(place({ chains: [commitmentChain(c, [s])] }), "s");
    expect(placed.placedStartAt).toEqual(minutesAfter(startsAt, -30));
    expect(placed.startBy).toEqual(minutesAfter(startsAt, -30));
  });

  it("forward phase: reports startBy without moving the placement", () => {
    const c = commitment({ startsAt: minutesAfter(startsAt, -60), endsAt: startsAt });
    const s = step({ id: "s", sequence: 0, durationMinutes: 5, phase: "after", mustStartByMinutes: 15 });
    const placed = byId(place({ chains: [commitmentChain(c, [s])] }), "s");
    expect(placed.placedStartAt).toEqual(startsAt);
    expect(placed.startBy).toEqual(minutesAfter(startsAt, 15));
  });
});

describe("placeRoutineChains — bands", () => {
  const startsAt = new Date("2026-09-27T07:00:00.000Z");
  const longAgo = new Date("2026-09-26T06:00:00.000Z");

  function flexibleChain(overrides: Partial<PlacementStep> = {}) {
    const c = commitment({ startsAt, endsAt: minutesAfter(startsAt, 60) });
    const s = step({
      id: "task",
      sequence: 0,
      durationMinutes: 30,
      phase: "before",
      timingRule: "flexible",
      maxLeadMinutes: 600,
      preferredBands: ["evening"],
      ...overrides
    });
    return commitmentChain(c, [s]);
  }

  it("chooses the latest fitting slot in the latest occurrence within the window", () => {
    const placed = byId(place({ chains: [flexibleChain()], bands: [evening], now: longAgo }), "task");
    expect(placed.placedStartAt).toEqual(new Date("2026-09-26T21:30:00.000Z"));
    expect(placed.earliestAt).toEqual(new Date("2026-09-26T21:00:00.000Z"));
  });

  it("falls back to the chain slot when no band occurrence is long enough", () => {
    const shortEvening: TimeBand = { id: "evening", name: "Evening", start: "21:45", end: "22:00" };
    const placed = byId(place({ chains: [flexibleChain()], bands: [shortEvening], now: longAgo }), "task");
    expect(placed.placedStartAt).toEqual(minutesAfter(startsAt, -30));
  });

  it("skips to an earlier fit when the latest slot overlaps a blocked range", () => {
    const blocked = [{ startsAt: new Date("2026-09-26T21:45:00.000Z"), endsAt: new Date("2026-09-26T22:00:00.000Z") }];
    const placed = byId(place({ chains: [flexibleChain()], bands: [evening], now: longAgo, blocked }), "task");
    expect(placed.placedStartAt).toEqual(new Date("2026-09-26T21:15:00.000Z"));
  });

  it("falls back to the chain slot once the only occurrence has fully passed", () => {
    const now = new Date("2026-09-26T23:00:00.000Z"); // after the evening band has closed
    const placed = byId(place({ chains: [flexibleChain()], bands: [evening], now }), "task");
    expect(placed.placedStartAt).toEqual(minutesAfter(startsAt, -30));
  });

  it("re-places within whatever room remains once now has advanced into the band", () => {
    const now = new Date("2026-09-26T21:45:00.000Z");
    const placed = byId(place({ chains: [flexibleChain({ durationMinutes: 10 })], bands: [evening], now }), "task");
    expect(placed.placedStartAt).toEqual(new Date("2026-09-26T21:50:00.000Z"));
  });

  it("the wash/hang-out/pack chain: flexible steps move into the evening band, pack stays at the chain slot", () => {
    const c = commitment({ startsAt, endsAt: minutesAfter(startsAt, 60) });
    const wash = step({
      id: "wash",
      sequence: 0,
      durationMinutes: 5,
      phase: "before",
      timingRule: "flexible",
      maxLeadMinutes: 720,
      waitAfterMinutes: 90,
      preferredBands: ["evening"],
      dependencyIds: []
    });
    const hangOut = step({
      id: "hang-out",
      sequence: 1,
      durationMinutes: 5,
      phase: "before",
      timingRule: "flexible",
      maxLeadMinutes: 720,
      waitAfterMinutes: 240,
      preferredBands: ["evening"],
      dependencyIds: ["wash"]
    });
    const pack = step({ id: "pack", sequence: 2, durationMinutes: 5, phase: "before", dependencyIds: ["hang-out"] });
    const placed = place({ chains: [commitmentChain(c, [wash, hangOut, pack])], bands: [evening], now: longAgo });

    const hangOutPlaced = byId(placed, "hang-out");
    const washPlaced = byId(placed, "wash");
    const packPlaced = byId(placed, "pack");
    expect(hangOutPlaced.placedStartAt).toEqual(new Date("2026-09-26T21:55:00.000Z"));
    expect(washPlaced.placedStartAt).toEqual(new Date("2026-09-26T20:20:00.000Z"));
    expect(packPlaced.placedStartAt).toEqual(minutesAfter(startsAt, -5));
    // Coordinator refinement: wash's own wait ends no later than hang-out actually starts, and
    // hang-out's wait ends no later than pack actually starts — the chain stays ordered even though
    // both flexible steps moved into the evening band the night before.
    expect(washPlaced.waitEndsAt!.getTime()).toBeLessThanOrEqual(hangOutPlaced.placedStartAt!.getTime());
    expect(hangOutPlaced.waitEndsAt!.getTime()).toBeLessThanOrEqual(packPlaced.placedStartAt!.getTime());
  });

  it("falls back to the tightened bound, not the untightened chain slot, when a band-eligible step names no fitting band", () => {
    const c = commitment({ startsAt, endsAt: minutesAfter(startsAt, 60) });
    const wash = step({
      id: "wash",
      sequence: 0,
      durationMinutes: 5,
      phase: "before",
      timingRule: "flexible",
      maxLeadMinutes: 720,
      waitAfterMinutes: 90,
      preferredBands: [], // flexible, but names no band — never finds a fit
      dependencyIds: []
    });
    const hangOut = step({
      id: "hang-out",
      sequence: 1,
      durationMinutes: 5,
      phase: "before",
      timingRule: "flexible",
      maxLeadMinutes: 720,
      waitAfterMinutes: 240,
      preferredBands: ["evening"],
      dependencyIds: ["wash"]
    });
    const placed = place({ chains: [commitmentChain(c, [wash, hangOut])], bands: [evening], now: longAgo });
    const washPlaced = byId(placed, "wash");
    const hangOutPlaced = byId(placed, "hang-out");
    expect(hangOutPlaced.placedStartAt).toEqual(new Date("2026-09-26T21:55:00.000Z"));
    // Wash still ran into the tightened bound (hang-out's actual start minus wash's wait and hands-on
    // time) — never the untightened pure chain slot, which would have put it after hang-out entirely.
    expect(washPlaced.placedStartAt).toEqual(new Date("2026-09-26T20:20:00.000Z"));
    expect(washPlaced.waitEndsAt!.getTime()).toBeLessThanOrEqual(hangOutPlaced.placedStartAt!.getTime());
  });

  it("a band-placed flexible step never overlaps a contiguous step's slot in the same chain (rule 4)", () => {
    const commitStartsAt = new Date("2026-09-27T08:00:00.000Z");
    const morning: TimeBand = { id: "morning", name: "Morning", start: "06:00", end: "12:00" };
    const c = commitment({ startsAt: commitStartsAt, endsAt: minutesAfter(commitStartsAt, 60) });
    // A: contiguous, chains from the boundary — pure pass places it 07:25-07:55.
    const a = step({ id: "a", sequence: 0, durationMinutes: 30, phase: "before" });
    // B: flexible, would ideally sit right up against the blocked range (07:45-07:50), which falls
    // inside A's 07:25-07:55 slot — the band search must respect A's already-placed interval too.
    const b = step({
      id: "b",
      sequence: 1,
      durationMinutes: 5,
      phase: "before",
      timingRule: "flexible",
      maxLeadMinutes: 600,
      preferredBands: ["morning"]
    });
    const blocked = [{ startsAt: new Date("2026-09-27T07:50:00.000Z"), endsAt: commitStartsAt }];
    const placed = place({ chains: [commitmentChain(c, [a, b])], bands: [morning], now: longAgo, blocked });
    const aPlaced = byId(placed, "a");
    const bPlaced = byId(placed, "b");
    expect(bPlaced.placedEndAt!.getTime()).toBeLessThanOrEqual(aPlaced.placedStartAt!.getTime());
  });
});

describe("placeRoutineChains — sleep chains", () => {
  it("bedtime chains backward, contiguous, exactly like today", () => {
    const endsAt = new Date("2026-09-26T22:00:00.000Z");
    const chain: BedtimeChain = {
      kind: "bedtime",
      anchorId: "night-1",
      endsAt,
      steps: [
        step({ id: "brush", sequence: 0, durationMinutes: 10, phase: "before" }),
        step({ id: "read", sequence: 1, durationMinutes: 15, phase: "before" })
      ]
    };
    const placed = place({ chains: [chain] });
    expect(byId(placed, "brush").placedStartAt).toEqual(minutesAfter(endsAt, -25));
    expect(byId(placed, "read").placedStartAt).toEqual(minutesAfter(endsAt, -15));
    expect(byId(placed, "read").placedEndAt).toEqual(endsAt);
  });

  it("bedtime chains with a wait: the next step in sequence is the dependent", () => {
    const endsAt = new Date("2026-09-26T22:00:00.000Z");
    const chain: BedtimeChain = {
      kind: "bedtime",
      anchorId: "night-1",
      endsAt,
      steps: [
        step({ id: "brush", sequence: 0, durationMinutes: 10, phase: "before", waitAfterMinutes: 20 }),
        step({ id: "read", sequence: 1, durationMinutes: 15, phase: "before" })
      ]
    };
    const placed = place({ chains: [chain] });
    const brush = byId(placed, "brush");
    const read = byId(placed, "read");
    expect(brush.placedEndAt).toEqual(minutesAfter(endsAt, -35));
    expect(brush.waitEndsAt).toEqual(read.placedStartAt);
    expect(read.placedStartAt).toEqual(minutesAfter(endsAt, -15));
  });

  it("wake chains forward, contiguous, exactly like today", () => {
    const startsAt = new Date("2026-09-27T06:00:00.000Z");
    const chain: WakeChain = {
      kind: "wake",
      anchorId: "night-1",
      startsAt,
      steps: [
        step({ id: "alarm", sequence: 0, durationMinutes: 2, phase: "before" }),
        step({ id: "stretch", sequence: 1, durationMinutes: 8, phase: "before" })
      ]
    };
    const placed = place({ chains: [chain] });
    expect(byId(placed, "alarm").placedStartAt).toEqual(startsAt);
    expect(byId(placed, "stretch").placedStartAt).toEqual(minutesAfter(startsAt, 2));
    expect(byId(placed, "stretch").placedEndAt).toEqual(minutesAfter(startsAt, 10));
  });

  it("wake chains with a wait: the previous step in sequence is the prerequisite", () => {
    const startsAt = new Date("2026-09-27T06:00:00.000Z");
    const chain: WakeChain = {
      kind: "wake",
      anchorId: "night-1",
      startsAt,
      steps: [
        step({ id: "alarm", sequence: 0, durationMinutes: 2, phase: "before", waitAfterMinutes: 5 }),
        step({ id: "stretch", sequence: 1, durationMinutes: 8, phase: "before" })
      ]
    };
    const placed = place({ chains: [chain] });
    expect(byId(placed, "alarm").placedEndAt).toEqual(minutesAfter(startsAt, 2));
    expect(byId(placed, "stretch").placedStartAt).toEqual(minutesAfter(startsAt, 7));
    expect(byId(placed, "stretch").placedEndAt).toEqual(minutesAfter(startsAt, 15));
  });
});

describe("placeRoutineChains — determinism and sorting", () => {
  it("sorts output by (anchorId, sequence) and is pure across repeated calls", () => {
    const startsAt = new Date("2026-09-27T07:00:00.000Z");
    const c1 = commitment({ id: "b", startsAt, endsAt: minutesAfter(startsAt, 30) });
    const c2 = commitment({ id: "a", startsAt: minutesAfter(startsAt, 60), endsAt: minutesAfter(startsAt, 90) });
    const chain1 = commitmentChain(c1, [
      step({ id: "b-2", sequence: 1, durationMinutes: 5, phase: "before" }),
      step({ id: "b-1", sequence: 0, durationMinutes: 5, phase: "before", dependencyIds: [] })
    ]);
    const chain2 = commitmentChain(c2, [step({ id: "a-1", sequence: 0, durationMinutes: 5, phase: "before" })]);
    const first = place({ chains: [chain1, chain2] });
    const second = place({ chains: [chain1, chain2] });
    expect(first.map((p) => p.stepId)).toEqual(["a-1", "b-1", "b-2"]);
    expect(first).toEqual(second);
  });
});
