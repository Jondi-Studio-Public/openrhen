import { describe, expect, it } from "vitest";
import { createSeedState, type PortalState, type StoredCommitmentRecurrenceRule } from "@/state/portal-state";
import { zonedWallTimeOnDay } from "@/features/today/local-datetime";
import { buildWeekPlan, projectedRuleCommitments, weekDayKeys, type WeekPlanState } from "./week-plan";

// Wednesday 19 August 2026 in the seed zone runs 2026-08-18T14:00Z to 2026-08-19T14:00Z. `now` is 10:00 local.
const NOW = new Date("2026-08-19T00:00:00.000Z");
const TZ = "Australia/Sydney";
const DAY = "2026-08-19";

function baseState(overrides: Partial<PortalState> = {}): WeekPlanState {
  const state = createSeedState(NOW);
  return {
    ...state,
    commitments: [],
    commitmentRecurrenceRules: [],
    routineSteps: [],
    routinePresets: [],
    sleepPlans: [],
    occurrences: [],
    completedToday: [],
    activeSession: null,
    planning: { status: "current" },
    ...overrides
  };
}

const rule = (
  id: string,
  overrides: Partial<StoredCommitmentRecurrenceRule> & { intervalDays?: number } = {}
): StoredCommitmentRecurrenceRule => {
  const { intervalDays, ...rest } = overrides;
  return {
    id,
    title: `Rule ${id}`,
    timezone: TZ,
    startDate: DAY,
    repeat: { unit: "days", intervalDays: intervalDays ?? 1 },
    localStartTime: "09:00",
    localEndTime: "10:00",
    setupBeforeMinutes: 0,
    transitionAfterMinutes: 0,
    status: "active",
    ...rest
  } as StoredCommitmentRecurrenceRule;
};

const materializedCommitment = (id: string, ruleId: string, localDate: string) => ({
  id,
  title: "Materialized",
  startsAt: `${localDate}T00:00:00.000Z`,
  endsAt: `${localDate}T01:00:00.000Z`,
  status: "confirmed" as const,
  setupBeforeMinutes: 0,
  transitionAfterMinutes: 0,
  recurrenceRuleId: ruleId,
  localDate
});

describe("weekDayKeys", () => {
  it("returns seven consecutive keys starting at the anchor", () => {
    expect(weekDayKeys(DAY)).toEqual([
      "2026-08-19",
      "2026-08-20",
      "2026-08-21",
      "2026-08-22",
      "2026-08-23",
      "2026-08-24",
      "2026-08-25"
    ]);
  });

  it("rolls across a month boundary without snapping to Monday", () => {
    expect(weekDayKeys("2026-08-28")).toEqual([
      "2026-08-28",
      "2026-08-29",
      "2026-08-30",
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
      "2026-09-03"
    ]);
  });
});

describe("projectedRuleCommitments", () => {
  const dayKeys = weekDayKeys(DAY);

  it("materializes an interval-1 rule on every day in range", () => {
    const projected = projectedRuleCommitments([rule("daily")], dayKeys, []);
    expect(projected.map((item) => item.localDate)).toEqual(dayKeys);
    expect(projected.every((item) => item.status === "tentative")).toBe(true);
    expect(projected.every((item) => item.recurrenceRuleId === "daily")).toBe(true);
    expect(projected[0]!.id).toBe(`projected:daily:${DAY}`);
  });

  it("materializes an interval-2 rule every other day, anchored at the rule's start", () => {
    const projected = projectedRuleCommitments([rule("every-other", { intervalDays: 2 })], dayKeys, []);
    expect(projected.map((item) => item.localDate)).toEqual(["2026-08-19", "2026-08-21", "2026-08-23", "2026-08-25"]);
  });

  it("materializes an interval-7 rule only on the day matching the start date", () => {
    const projected = projectedRuleCommitments([rule("weekly", { intervalDays: 7 })], dayKeys, []);
    expect(projected.map((item) => item.localDate)).toEqual(["2026-08-19"]);
  });

  it("stops at the rule's end date", () => {
    const projected = projectedRuleCommitments([rule("bounded", { endDate: "2026-08-21" })], dayKeys, []);
    expect(projected.map((item) => item.localDate)).toEqual(["2026-08-19", "2026-08-20", "2026-08-21"]);
  });

  it("excludes an ended rule entirely", () => {
    const projected = projectedRuleCommitments([rule("gone", { status: "ended" })], dayKeys, []);
    expect(projected).toEqual([]);
  });

  it("does not duplicate a day that already has a real materialized commitment", () => {
    const existing = [materializedCommitment("real-1", "daily", "2026-08-21")];
    const projected = projectedRuleCommitments([rule("daily")], dayKeys, existing);
    expect(projected.map((item) => item.localDate)).toEqual([
      "2026-08-19",
      "2026-08-20",
      "2026-08-22",
      "2026-08-23",
      "2026-08-24",
      "2026-08-25"
    ]);
  });

  it("copies location, setup, transition and project from the rule", () => {
    const projected = projectedRuleCommitments(
      [
        rule("copy", {
          location: "Studio",
          locationId: "loc-studio",
          setupBeforeMinutes: 10,
          transitionAfterMinutes: 5,
          projectId: "p1"
        })
      ],
      [DAY],
      []
    );
    expect(projected[0]).toMatchObject({
      location: "Studio",
      locationId: "loc-studio",
      setupBeforeMinutes: 10,
      transitionAfterMinutes: 5,
      projectId: "p1"
    });
  });

  it("carries the rule's presence, so an anchoring series stays an anchor past the horizon", () => {
    expect(projectedRuleCommitments([rule("anchored", { presence: "anchor" })], [DAY], [])[0]!.presence).toBe("anchor");
    // A rule with no opinion says nothing, and the commitment's own default takes over downstream.
    expect(projectedRuleCommitments([rule("silent")], [DAY], [])[0]!.presence).toBeUndefined();
  });

  it("places the rule's wall-clock times using the zoned wall-time helper, not raw UTC arithmetic", () => {
    const projected = projectedRuleCommitments([rule("wall")], [DAY], []);
    expect(projected[0]!.startsAt).toBe(zonedWallTimeOnDay(DAY, "09:00", TZ).toISOString());
    expect(projected[0]!.endsAt).toBe(zonedWallTimeOnDay(DAY, "10:00", TZ).toISOString());
  });

  it("keeps the rule's wall-clock time fixed across the seed-zone daylight-saving fallback", () => {
    // Clocks go back from 03:00 AEDT to 02:00 AEST on 2026-04-05; a 09:00 commitment is unaffected
    // by the ambiguity window, but its UTC instant must still shift by the offset change.
    const keys = ["2026-04-04", "2026-04-05", "2026-04-06"];
    const projected = projectedRuleCommitments([rule("dst", { startDate: "2026-04-04", intervalDays: 1 })], keys, []);
    expect(projected.map((item) => item.startsAt)).toEqual([
      "2026-04-03T22:00:00.000Z", // AEDT (UTC+11)
      "2026-04-04T23:00:00.000Z", // AEST (UTC+10) — the transition day
      "2026-04-05T23:00:00.000Z" // AEST (UTC+10)
    ]);
    // Cross-checked against the trusted helper directly, so a hand-rolled offset would be caught here too.
    for (const [index, key] of keys.entries())
      expect(projected[index]!.startsAt).toBe(zonedWallTimeOnDay(key, "09:00", TZ).toISOString());
  });
});

describe("buildWeekPlan", () => {
  it("produces seven days keyed from the anchor", () => {
    const week = buildWeekPlan({
      state: baseState(),
      slots: [],
      allocations: [],
      currentDirective: null,
      recommendation: null,
      upcomingDirectives: [],
      now: NOW,
      timezone: TZ,
      anchorDayKey: "2026-08-17"
    });
    expect(week.anchorDayKey).toBe("2026-08-17");
    expect(week.days.map((day) => day.dayKey)).toEqual(weekDayKeys("2026-08-17"));
    expect(week.days).toHaveLength(7);
  });

  it("gives the engine's now-shaped inputs only to the day now falls on", () => {
    const upcomingDirectives = [
      { kind: "action" as const, targetId: "a1", title: "Do the thing", recommendedMinutes: 30 }
    ];
    const week = buildWeekPlan({
      state: baseState(),
      slots: [],
      allocations: [],
      currentDirective: null,
      recommendation: null,
      upcomingDirectives,
      now: NOW,
      timezone: TZ,
      anchorDayKey: "2026-08-17"
    });
    const nowDay = week.days.find((day) => day.dayKey === DAY)!;
    const otherDays = week.days.filter((day) => day.dayKey !== DAY);
    expect(nowDay.plan.untimed.some((item) => item.id === "upcoming:action:a1")).toBe(true);
    for (const day of otherDays) expect(day.plan.untimed.some((item) => item.id === "upcoming:action:a1")).toBe(false);
    // The now-line itself is likewise only ever drawn on the day now actually falls on.
    expect(nowDay.plan.nowAt).toEqual(NOW);
    for (const day of otherDays) expect(day.plan.nowAt).toBeNull();
  });

  it("passes the engine's projected day through to every day, letting buildDayPlan clip it per day", () => {
    const engineDayPlan = {
      through: "2026-08-20T00:00:00.000Z",
      mode: "policy_replay" as const,
      blocks: [
        {
          startsAt: "2026-08-19T05:00:00.000Z",
          endsAt: "2026-08-19T06:00:00.000Z",
          kind: "action" as const,
          targetId: "a1",
          title: "Work on a1",
          projectId: "p1",
          focusedMinutes: 60,
          wallClockMinutes: 60,
          reason: "Ranked highest.",
          confidence: "firm" as const
        }
      ],
      truncated: false,
      displaced: [],
      locations: []
    };
    const week = buildWeekPlan({
      state: baseState(),
      slots: [],
      allocations: [],
      currentDirective: null,
      recommendation: null,
      upcomingDirectives: [],
      engineDayPlan,
      now: NOW,
      timezone: TZ,
      anchorDayKey: "2026-08-17"
    });
    const nowDay = week.days.find((day) => day.dayKey === DAY)!;
    expect(nowDay.plan.items.some((item) => item.kind === "directive")).toBe(true);
    const otherDays = week.days.filter((day) => day.dayKey !== DAY);
    for (const day of otherDays) expect(day.plan.items.some((item) => item.kind === "directive")).toBe(false);
  });

  it("injects projected recurring commitments as tentative items in the right day's plan", () => {
    const week = buildWeekPlan({
      state: baseState({ commitmentRecurrenceRules: [rule("gym", { intervalDays: 2 })] }),
      slots: [],
      allocations: [],
      currentDirective: null,
      recommendation: null,
      upcomingDirectives: [],
      now: NOW,
      timezone: TZ,
      anchorDayKey: "2026-08-17"
    });
    const occursOn = week.days.find((day) => day.dayKey === "2026-08-19")!;
    const skipsOn = week.days.find((day) => day.dayKey === "2026-08-20")!;
    const projectedItem = occursOn.plan.items.find((item) => item.entityId === "projected:gym:2026-08-19");
    expect(projectedItem).toBeDefined();
    expect(projectedItem!.kind).toBe("commitment");
    expect(projectedItem!.tentative).toBe(true);
    expect(skipsOn.plan.items.some((item) => item.entityId.startsWith("projected:gym:"))).toBe(false);
  });

  it("does not duplicate a real materialized commitment with a projected one", () => {
    const real = materializedCommitment("real-1", "gym", "2026-08-19");
    const week = buildWeekPlan({
      state: baseState({
        commitments: [real],
        commitmentRecurrenceRules: [rule("gym")]
      }),
      slots: [],
      allocations: [],
      currentDirective: null,
      recommendation: null,
      upcomingDirectives: [],
      now: NOW,
      timezone: TZ,
      anchorDayKey: "2026-08-17"
    });
    const day = week.days.find((entry) => entry.dayKey === "2026-08-19")!;
    const commitmentItems = day.plan.items.filter((item) => item.kind === "commitment");
    expect(commitmentItems).toHaveLength(1);
    expect(commitmentItems[0]!.entityId).toBe("real-1");
  });

  it("draws a leave-by marker on the day its commitment falls, but never the waits strip (out of scope for the week)", () => {
    const dentist = {
      id: "dentist",
      title: "Dentist",
      startsAt: "2026-08-19T04:00:00.000Z",
      endsAt: "2026-08-19T05:00:00.000Z",
      status: "confirmed" as const,
      setupBeforeMinutes: 10,
      transitionAfterMinutes: 10
    };
    const wash = {
      id: "wash",
      version: 1,
      commitmentId: "dentist",
      anchorType: "commitment" as const,
      anchorId: "dentist",
      title: "Wash",
      durationMinutes: 5,
      sequence: 0,
      timingRule: "flexible" as const,
      energy: "low" as const,
      contexts: [],
      dependencyIds: [],
      phase: "before" as const,
      status: "pending" as const,
      scheduledStartAt: "2026-08-19T03:00:00.000Z",
      scheduledEndAt: "2026-08-19T03:05:00.000Z"
    };
    const week = buildWeekPlan({
      state: baseState({
        commitments: [dentist],
        routineSteps: [wash],
        planning: {
          status: "current",
          result: {
            derivedState: {
              commitmentTimelines: [
                {
                  id: "dentist",
                  setupStartsAt: "2026-08-19T03:30:00.000Z",
                  leaveBy: "2026-08-19T03:38:00.000Z",
                  arriveBy: "2026-08-19T03:55:00.000Z",
                  startsAt: "2026-08-19T04:00:00.000Z",
                  endsAt: "2026-08-19T05:00:00.000Z",
                  effectiveEndsAt: "2026-08-19T05:00:00.000Z",
                  freeAt: "2026-08-19T05:10:00.000Z",
                  overtime: false,
                  latenessMatters: true,
                  journeyBefore: {
                    fromLocationId: "home",
                    toLocationId: "dentist",
                    mode: "car",
                    minutes: 22,
                    typicalMinutes: 18,
                    source: "typical",
                    sampleCount: 5
                  }
                }
              ],
              stepPlacements: [
                {
                  stepId: "wash",
                  anchorKind: "commitment",
                  anchorId: "dentist",
                  waitStartsAt: "2026-08-19T03:05:00.000Z",
                  waitEndsAt: "2026-08-19T03:35:00.000Z"
                }
              ]
            }
          }
        } as unknown as NonNullable<WeekPlanState["planning"]>
      }),
      slots: [],
      allocations: [],
      currentDirective: null,
      recommendation: null,
      upcomingDirectives: [],
      now: NOW,
      timezone: TZ,
      anchorDayKey: "2026-08-17"
    });
    const today = week.days.find((day) => day.dayKey === DAY)!;
    expect(today.plan.items.some((item) => item.kind === "leave_by")).toBe(true);
    // Waits are never drawn in the week, even on the very day whose stepPlacement would otherwise
    // produce one — the strip belongs to the day view alone.
    for (const day of week.days) expect(day.plan.waits).toEqual([]);
  });

  it("a projected recurring commitment has no matching timeline entry, so it draws no halos", () => {
    const week = buildWeekPlan({
      state: baseState({ commitmentRecurrenceRules: [rule("gym", { intervalDays: 2 })] }),
      slots: [],
      allocations: [],
      currentDirective: null,
      recommendation: null,
      upcomingDirectives: [],
      now: NOW,
      timezone: TZ,
      anchorDayKey: "2026-08-17"
    });
    const occursOn = week.days.find((day) => day.dayKey === "2026-08-19")!;
    const projectedItem = occursOn.plan.items.find((item) => item.entityId === "projected:gym:2026-08-19")!;
    expect(projectedItem.halos ?? []).toEqual([]);
  });
});
