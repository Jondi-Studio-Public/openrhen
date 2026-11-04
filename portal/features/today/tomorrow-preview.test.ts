import { describe, expect, it } from "vitest";
import { createSeedState, type PortalState } from "@/state/portal-state";
import { tomorrowBrief, tomorrowDayKey } from "./tomorrow-preview";

// Wednesday 19 August 2026 in the seed zone runs 2026-08-18T14:00Z to 2026-08-19T14:00Z. `now` is 10:00 local,
// so tomorrow is Thursday the 20th: 2026-08-19T14:00Z to 2026-08-20T14:00Z.
const NOW = new Date("2026-08-19T00:00:00.000Z");
const SEED_ZONE = "Australia/Sydney";
const hours = (bounds: { startsAt: Date; endsAt: Date }) =>
  (bounds.endsAt.getTime() - bounds.startsAt.getTime()) / 3_600_000;

function baseState(overrides: Partial<PortalState> = {}): PortalState {
  const state = createSeedState(NOW);
  return {
    ...state,
    commitments: [],
    routineSteps: [],
    occurrences: [],
    sleepPlans: [],
    conditionDefinitions: [],
    ...overrides
  };
}

const commitment = (id: string, startsAt: string, endsAt: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Commitment ${id}`,
  startsAt,
  endsAt,
  status: "confirmed" as const,
  setupBeforeMinutes: 0,
  transitionAfterMinutes: 0,
  ...extra
});

const step = (id: string, scheduledStartAt?: string, scheduledEndAt?: string, extra: Record<string, unknown> = {}) => ({
  id,
  commitmentId: "c1",
  anchorType: "commitment" as const,
  title: `Step ${id}`,
  durationMinutes: 15,
  sequence: 0,
  timingRule: "contiguous" as const,
  energy: "medium" as const,
  contexts: [],
  dependencyIds: [],
  phase: "before" as const,
  status: "pending" as const,
  ...(scheduledStartAt ? { scheduledStartAt } : {}),
  ...(scheduledEndAt ? { scheduledEndAt } : {}),
  ...extra
});

const occurrence = (id: string, localDate: string, extra: Record<string, unknown> = {}) => ({
  id,
  actionId: "a1",
  recurrenceRuleId: "r1",
  windowId: "w1",
  windowName: "Morning",
  localDate,
  windowStartsAt: `${localDate}T20:00:00.000Z`,
  windowEndsAt: `${localDate}T21:00:00.000Z`,
  anchorSource: "local_time" as const,
  status: "pending" as const,
  ...extra
});

const sleepPlan = (id: string, plannedStartAt: string, plannedWakeAt: string, extra: Record<string, unknown> = {}) => ({
  id,
  plannedStartAt,
  plannedWakeAt,
  desiredMinutes: 480,
  allowedMinutes: 480,
  sleepDeficitMinutes: 0,
  anchorDeviationMinutes: 0,
  hardErrors: [],
  explanation: "",
  status: "planned" as const,
  ...extra
});

const place = (id: string, name: string) => ({
  id,
  name,
  kind: "location" as const,
  status: "active" as const,
  pathways: [],
  portability: "fixed" as const,
  grants: [],
  channels: [],
  setupBeforeMinutes: 0,
  transitionAfterMinutes: 0
});

describe("tomorrowDayKey", () => {
  it("advances the calendar day rather than adding twenty-four hours across both clock changes", () => {
    // seed-zone springs forward on 2026-10-04, so that local day is only 23 hours long.
    expect(tomorrowDayKey(new Date("2026-10-03T13:30:00.000Z"), SEED_ZONE)).toBe("2026-10-04");
    expect(tomorrowDayKey(new Date("2026-10-03T23:00:00.000Z"), SEED_ZONE)).toBe("2026-10-05");
    // seed-zone falls back on 2026-04-05, making that local day 25 hours long.
    expect(tomorrowDayKey(new Date("2026-04-04T02:00:00.000Z"), SEED_ZONE)).toBe("2026-04-05");
    expect(tomorrowDayKey(new Date("2026-04-04T13:30:00.000Z"), SEED_ZONE)).toBe("2026-04-06");
    // New York springs forward on 2026-03-08.
    expect(tomorrowDayKey(new Date("2026-03-07T18:00:00.000Z"), "America/New_York")).toBe("2026-03-08");
    expect(tomorrowDayKey(new Date("2026-03-08T18:00:00.000Z"), "America/New_York")).toBe("2026-03-09");
  });

  it("rolls over month, year, and leap-day ends", () => {
    expect(tomorrowDayKey(new Date("2026-01-31T05:00:00.000Z"), "UTC")).toBe("2026-02-01");
    expect(tomorrowDayKey(new Date("2026-02-28T05:00:00.000Z"), "UTC")).toBe("2026-03-01");
    expect(tomorrowDayKey(new Date("2028-02-28T05:00:00.000Z"), "UTC")).toBe("2028-02-29");
    expect(tomorrowDayKey(new Date("2026-12-31T05:00:00.000Z"), "UTC")).toBe("2027-01-01");
    // 2026-12-31T23:00Z is already New Year's Day in the seed zone, so its tomorrow is the 2nd.
    expect(tomorrowDayKey(new Date("2026-12-31T23:00:00.000Z"), SEED_ZONE)).toBe("2027-01-02");
  });

  it("reads the day from the planning zone, not from UTC", () => {
    // 23:00 on the 19th in New York is already the 20th in UTC.
    expect(tomorrowDayKey(new Date("2026-08-20T03:00:00.000Z"), "America/New_York")).toBe("2026-08-20");
    expect(tomorrowDayKey(new Date("2026-08-20T03:00:00.000Z"), "UTC")).toBe("2026-08-21");
  });
});

describe("tomorrowBrief", () => {
  it("bounds tomorrow in the planning zone, over a clock change as well", () => {
    const brief = tomorrowBrief(baseState(), NOW);
    expect(brief.dayKey).toBe("2026-08-20");
    expect(brief.bounds.startsAt.toISOString()).toBe("2026-08-19T14:00:00.000Z");
    expect(brief.bounds.endsAt.toISOString()).toBe("2026-08-20T14:00:00.000Z");
    const springForward = tomorrowBrief(baseState(), new Date("2026-10-03T02:00:00.000Z"));
    expect(springForward.dayKey).toBe("2026-10-04");
    expect(hours(springForward.bounds)).toBe(23);
  });

  it("says nothing is on when nothing lands tomorrow", () => {
    const brief = tomorrowBrief(
      baseState({
        commitments: [
          // Today, and the day after tomorrow: neither touches tomorrow's bounds.
          commitment("today", "2026-08-19T04:00:00.000Z", "2026-08-19T05:00:00.000Z"),
          commitment("later", "2026-08-21T04:00:00.000Z", "2026-08-21T05:00:00.000Z")
        ],
        occurrences: [occurrence("o-today", "2026-08-19")]
      }),
      NOW
    );
    expect(brief).toMatchObject({
      sleep: null,
      firstCommitment: null,
      commitments: 0,
      preparationSteps: 0,
      occurrences: 0,
      travel: null
    });
  });

  it("counts what lands tomorrow and names the first fixed commitment", () => {
    const brief = tomorrowBrief(
      baseState({
        commitments: [
          commitment("dentist", "2026-08-19T23:00:00.000Z", "2026-08-20T00:00:00.000Z", { title: "Dentist" }),
          commitment("class", "2026-08-19T21:00:00.000Z", "2026-08-19T22:30:00.000Z", { title: "Class" }),
          commitment("gone", "2026-08-19T22:00:00.000Z", "2026-08-19T23:00:00.000Z", { status: "cancelled" }),
          commitment("today", "2026-08-19T04:00:00.000Z", "2026-08-19T05:00:00.000Z")
        ],
        routineSteps: [
          step("s1", "2026-08-19T20:30:00.000Z", "2026-08-19T20:45:00.000Z"),
          step("s2", "2026-08-19T04:00:00.000Z", "2026-08-19T04:15:00.000Z"),
          // No scheduled time at all, so it is not a placed fact on any day.
          step("s3"),
          // Already ticked off by hand, so it is not preparation tomorrow still holds.
          step("s4", "2026-08-19T20:45:00.000Z", "2026-08-19T21:00:00.000Z", { status: "completed" })
        ],
        occurrences: [
          occurrence("o1", "2026-08-20"),
          occurrence("o2", "2026-08-20"),
          occurrence("o3", "2026-08-20", { status: "cancelled" }),
          occurrence("o4", "2026-08-21")
        ]
      }),
      NOW
    );
    expect(brief.commitments).toBe(2);
    expect(brief.preparationSteps).toBe(1);
    expect(brief.occurrences).toBe(2);
    expect(brief.firstCommitment).toMatchObject({ id: "class", title: "Class", startsBeforeDay: false });
    expect(brief.firstCommitment!.startsAt.toISOString()).toBe("2026-08-19T21:00:00.000Z");
  });

  it("counts a commitment that runs in over midnight and marks it as already under way", () => {
    const brief = tomorrowBrief(
      baseState({
        commitments: [
          commitment("nightshift", "2026-08-19T12:00:00.000Z", "2026-08-19T16:00:00.000Z", { title: "Night shift" }),
          commitment("morning", "2026-08-19T22:00:00.000Z", "2026-08-19T23:00:00.000Z")
        ]
      }),
      NOW
    );
    expect(brief.commitments).toBe(2);
    expect(brief.firstCommitment).toMatchObject({ id: "nightshift", title: "Night shift", startsBeforeDay: true });
  });

  it("attributes a night spanning midnight to the day it wakes on, and ignores one that ends today", () => {
    const state = baseState({
      sleepPlans: [
        // Last night: wakes this morning, so it is not tomorrow's.
        sleepPlan("last", "2026-08-18T12:00:00.000Z", "2026-08-18T20:00:00.000Z", { status: "completed" }),
        // Tonight: 10 pm local to 6:30 am local, waking inside tomorrow's bounds.
        sleepPlan("tonight", "2026-08-19T12:00:00.000Z", "2026-08-19T20:30:00.000Z"),
        // Tomorrow night: wakes on the day after, so it belongs to that day's brief.
        sleepPlan("next", "2026-08-20T12:00:00.000Z", "2026-08-20T20:30:00.000Z"),
        sleepPlan("dropped", "2026-08-19T13:00:00.000Z", "2026-08-19T19:00:00.000Z", { status: "cancelled" })
      ]
    });
    const brief = tomorrowBrief(state, NOW);
    expect(brief.sleep).toMatchObject({ minutes: 510, startsBeforeDay: true });
    expect(brief.sleep!.startsAt.toISOString()).toBe("2026-08-19T12:00:00.000Z");
    expect(brief.sleep!.wakeAt.toISOString()).toBe("2026-08-19T20:30:00.000Z");
  });

  it("prefers the actual times of a night already being slept", () => {
    const brief = tomorrowBrief(
      baseState({
        sleepPlans: [
          sleepPlan("tonight", "2026-08-19T12:00:00.000Z", "2026-08-19T20:30:00.000Z", {
            status: "sleeping",
            actualStartAt: "2026-08-19T13:10:00.000Z"
          })
        ]
      }),
      NOW
    );
    expect(brief.sleep!.startsAt.toISOString()).toBe("2026-08-19T13:10:00.000Z");
    expect(brief.sleep!.minutes).toBe(440);
  });

  it("names the places tomorrow takes you, counting each place once and leaving home out", () => {
    const state = baseState({
      settings: { ...createSeedState(NOW).settings, homeLocationId: "ctx-home" },
      commitments: [
        commitment("a", "2026-08-19T21:00:00.000Z", "2026-08-19T22:00:00.000Z", { locationId: "ctx-campus" }),
        commitment("b", "2026-08-19T23:00:00.000Z", "2026-08-20T00:00:00.000Z", { locationId: "ctx-campus" }),
        commitment("c", "2026-08-20T01:00:00.000Z", "2026-08-20T02:00:00.000Z", {
          locationId: "ctx-clinic",
          location: "Written by hand"
        }),
        commitment("d", "2026-08-20T03:00:00.000Z", "2026-08-20T04:00:00.000Z", { locationId: "ctx-home" }),
        commitment("e", "2026-08-20T05:00:00.000Z", "2026-08-20T06:00:00.000Z")
      ],
      conditionDefinitions: [place("ctx-campus", "Campus"), place("ctx-home", "Home")]
    });
    // The clinic has no context definition, so the commitment's own label stands in for its name.
    expect(tomorrowBrief(state, NOW).travel).toEqual({ commitments: 3, places: ["Campus", "Written by hand"] });
  });

  it("counts every named place as travel when no home base is chosen", () => {
    const state = baseState({
      commitments: [
        commitment("a", "2026-08-19T21:00:00.000Z", "2026-08-19T22:00:00.000Z", { locationId: "ctx-home" })
      ],
      conditionDefinitions: [place("ctx-home", "Home")]
    });
    expect(tomorrowBrief(state, NOW).travel).toEqual({ commitments: 1, places: ["Home"] });
  });
});
