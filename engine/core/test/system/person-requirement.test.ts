import { describe, expect, it } from "vitest";
import { PLAN_FORECAST_CONTRACT_VERSION, planForecastRequestSchema, portalStateSchema } from "@openrhen/contracts";
import { calculatePlanAndForecast } from "../../src/index.js";

/**
 * A step that needs a person ("build hive boxes" needs the garage and pete@with) end to end through the
 * planner: only the owner saying Pete is here (or a live in-person commitment with him) lets it lead, and
 * unknown never schedules it or counts as no. Names are invented.
 */
const now = new Date("2026-08-14T04:00:00.000Z");
const HOUR = 3_600_000;
const iso = (date: Date) => date.toISOString();

interface Fixture {
  at?: Date;
  locationId?: string | null;
  presence?: Record<string, unknown>;
  waivers?: Record<string, unknown>;
  commitments?: unknown[];
  deadlineAt?: string;
  contexts?: string[];
}

function request(fixture: Fixture = {}) {
  const at = fixture.at ?? now;
  const state = portalStateSchema.parse({
    settings: {
      timezone: "Australia/Sydney",
      planningHorizonEnd: "22:00",
      defaultUsableFraction: 1,
      defaultSetupBufferMinutes: 0,
      defaultTransitionBufferMinutes: 0,
      submissionBufferMinutes: 0,
      submissionBufferPercent: 0,
      energyMeanings: { high: "high", medium: "medium", low: "low", recovery: "recovery" },
      estimateBucketsMinutes: [15, 30, 60],
      conditionCatalog: ["garage"],
      preferredBedtime: "23:00",
      preferredWakeTime: "07:00",
      desiredSleepMinutes: 480,
      minimumSleepMinutes: 420,
      maxAwakeHours: 16,
      homeLocationId: "garage"
    },
    areas: [{ id: "area-1", name: "Home", status: "active", sortOrder: 0 }],
    outcomes: [
      {
        id: "outcome-1",
        areaId: "area-1",
        title: "Keep bees",
        definitionOfDone: "Hives up",
        value: 3,
        status: "active"
      }
    ],
    projects: [
      {
        id: "project-1",
        title: "Hives",
        area: "area-1",
        outcomeId: "outcome-1",
        status: "active",
        uncertainty: "known",
        value: 3,
        consequence: 3,
        ...(fixture.deadlineAt ? { externalDeadlineAt: fixture.deadlineAt } : {})
      }
    ],
    actions: [
      {
        id: "hive-boxes",
        projectId: "project-1",
        title: "Build hive boxes",
        status: "active",
        optimisticMinutes: 20,
        expectedMinutes: 30,
        remainingMinutes: 30,
        pessimisticMinutes: 45,
        energy: "medium",
        minimumSessionMinutes: 15,
        maximumSessionMinutes: 45,
        importance: 3,
        consequence: 3,
        contexts: [],
        requirementPathways: [{ id: "p1", contextIds: fixture.contexts ?? ["garage", "pete@with"] }],
        dependencyIds: [],
        splittable: true,
        setupMinutes: 0
      }
    ],
    commitments: [
      ...(fixture.commitments ?? []),
      {
        id: "before-window",
        title: "Blocked (before window)",
        status: "confirmed",
        startsAt: iso(new Date(at.getTime() - 14 * HOUR)),
        endsAt: iso(new Date(at.getTime() - 6 * HOUR)),
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0
      },
      {
        id: "after-window",
        title: "Blocked (after window)",
        status: "confirmed",
        startsAt: iso(new Date(at.getTime() + 9 * HOUR)),
        endsAt: iso(new Date(at.getTime() + 20 * 24 * HOUR)),
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0
      }
    ],
    routineSteps: [],
    routinePresets: [],
    occurrences: [],
    sleepPlans: [],
    captures: [],
    completedToday: [],
    assertedConditions: ["garage"],
    currentEnergy: "medium",
    horizonEnd: iso(new Date(at.getTime() + 14 * 24 * HOUR)),
    activeSession: null,
    conditionDefinitions: [
      { id: "garage", name: "Garage", kind: "location", status: "active" },
      { id: "pete", name: "Pete", kind: "contact", status: "active", channels: ["sync_remote"] }
    ],
    currentSituation: {
      locationId: fixture.locationId === undefined ? "garage" : fixture.locationId,
      locationSetAt: at.toISOString(),
      overrides: {},
      carrying: {},
      transportModes: ["car"],
      travel: {},
      ...(fixture.presence ? { presence: fixture.presence } : {}),
      ...(fixture.waivers ? { waivers: fixture.waivers } : {})
    }
  });
  return planForecastRequestSchema.parse({
    contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
    requestId: "00000000-0000-4000-8000-0000000000d1",
    inputVersion: "person-requirement-fixture",
    calculatedAt: at.toISOString(),
    horizonEnd: iso(new Date(at.getTime() + 14 * 24 * HOUR)),
    state
  });
}

interface Candidate {
  action: { id: string };
  eligible: boolean;
  exclusionReasons: string[];
  conditionMatch: { status: string; personHold?: { people: { contactId: string; state: string }[] } };
}
function run(fixture: Fixture = {}) {
  const response = calculatePlanAndForecast(request(fixture));
  const recommendation = response.recommendation as unknown as {
    primary: { action: { id: string } } | null;
    candidates: Candidate[];
    needsAnswer: Candidate[];
    headline: string;
  };
  return { response, recommendation, primary: recommendation.primary?.action.id ?? null };
}
const hereToday = (until = iso(new Date(now.getTime() + 10 * HOUR))) => ({
  pete: { state: "here", setAt: iso(new Date(now.getTime() - HOUR)), until }
});

describe("a step that needs a person", () => {
  it("is not offered while nobody has said Pete is here, and is not a question either", () => {
    const { primary, recommendation } = run();
    expect(primary).not.toBe("hive-boxes");
    const candidate = recommendation.candidates.find((c) => c.action.id === "hive-boxes")!;
    expect(candidate.eligible).toBe(false);
    expect(candidate.conditionMatch.status).toBe("unknown");
    expect(candidate.conditionMatch.personHold?.people).toEqual([
      { contactId: "pete", name: "Pete", state: "unknown" }
    ]);
    expect(candidate.exclusionReasons.join(" ")).toContain("Waiting on Pete");
    expect(recommendation.needsAnswer.map((c) => c.action.id)).not.toContain("hive-boxes");
  });

  it("leads once Pete is said to be here", () => {
    expect(run({ presence: hereToday() }).primary).toBe("hive-boxes");
  });

  it("does not lead once that statement has run out", () => {
    const expired = hereToday(iso(new Date(now.getTime() - 1000)));
    expect(run({ presence: expired }).primary).not.toBe("hive-boxes");
  });

  it("is blocked at once by a known away", () => {
    const away = {
      pete: {
        state: "away",
        setAt: iso(new Date(now.getTime() - HOUR)),
        until: iso(new Date(now.getTime() + 10 * HOUR))
      }
    };
    const { primary, recommendation } = run({ presence: away });
    expect(primary).not.toBe("hive-boxes");
    const candidate = recommendation.candidates.find((c) => c.action.id === "hive-boxes")!;
    expect(candidate.conditionMatch.status).toBe("no");
  });

  it("leads while a confirmed in-person commitment with Pete is running", () => {
    const meeting = {
      id: "hive-day",
      title: "Hive day",
      status: "confirmed",
      startsAt: iso(new Date(now.getTime() - HOUR)),
      endsAt: iso(new Date(now.getTime() + 2 * HOUR)),
      setupBeforeMinutes: 0,
      transitionAfterMinutes: 0,
      presence: "anchor",
      contactId: "pete",
      attendance: "in_person"
    };
    expect(run({ commitments: [meeting] }).primary).toBe("hive-boxes");
    expect(run({ commitments: [{ ...meeting, attendance: "remote" }] }).primary).not.toBe("hive-boxes");
    expect(run({ commitments: [{ ...meeting, status: "cancelled" }] }).primary).not.toBe("hive-boxes");
  });

  it("stays unknown, never yes, when the place is not known", () => {
    const { primary } = run({ presence: hereToday(), locationId: null });
    expect(primary).not.toBe("hive-boxes");
  });

  it("is not scheduled into the plan while Pete is unknown or away, and is once he is here", () => {
    // Planned work is the work with a deadline to plan towards.
    const deadlineAt = iso(new Date(now.getTime() + 5 * 24 * HOUR));
    const placed = (fixture: Fixture) =>
      JSON.stringify(
        (run({ ...fixture, deadlineAt }).response.schedule as unknown as { allocations: unknown }).allocations
      ).includes("hive-boxes");
    expect(placed({})).toBe(false);
    const away = {
      pete: {
        state: "away",
        setAt: iso(new Date(now.getTime() - HOUR)),
        until: iso(new Date(now.getTime() + 10 * HOUR))
      }
    };
    expect(placed({ presence: away })).toBe(false);
    expect(placed({ presence: hereToday() })).toBe(true);
    // Not holding the place back: a bare contact is planned as it always was.
    expect(placed({ contexts: ["garage", "pete"] })).toBe(true);
  });

  it("a one-time waiver lets it lead without Pete, for that step only", () => {
    const waivers = {
      "hive-boxes": {
        people: ["pete"],
        setAt: iso(new Date(now.getTime() - HOUR)),
        until: iso(new Date(now.getTime() + 24 * HOUR))
      }
    };
    expect(run({ waivers }).primary).toBe("hive-boxes");
    const wrongStep = { other: waivers["hive-boxes"] };
    expect(run({ waivers: wrongStep }).primary).not.toBe("hive-boxes");
    const wrongPerson = { "hive-boxes": { ...waivers["hive-boxes"], people: ["mia"] } };
    expect(run({ waivers: wrongPerson }).primary).not.toBe("hive-boxes");
    const lapsed = { "hive-boxes": { ...waivers["hive-boxes"], until: iso(new Date(now.getTime() - 1000)) } };
    expect(run({ waivers: lapsed }).primary).not.toBe("hive-boxes");
  });

  it("a waiver does not waive the place", () => {
    const waivers = {
      "hive-boxes": {
        people: ["pete"],
        setAt: iso(new Date(now.getTime() - HOUR)),
        until: iso(new Date(now.getTime() + 24 * HOUR))
      }
    };
    expect(run({ waivers, locationId: null }).primary).not.toBe("hive-boxes");
  });

  it("an action with a bare pete (today's meaning) is unchanged by presence", () => {
    expect(run({ contexts: ["garage", "pete"] }).primary).toBe("hive-boxes");
    expect(
      run({
        contexts: ["garage", "pete"],
        presence: { pete: { state: "away", setAt: iso(now), until: iso(new Date(now.getTime() + HOUR)) } }
      }).primary
    ).toBe("hive-boxes");
  });
});
