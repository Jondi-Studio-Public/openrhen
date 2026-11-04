import { describe, expect, it } from "vitest";
import { PLAN_FORECAST_CONTRACT_VERSION, planForecastRequestSchema, portalStateSchema } from "@openrhen/contracts";
import { calculatePlanAndForecast } from "../../src/index.js";
import { activePlanningDate, dailyHorizonEnd } from "../../src/recommendation/directive.js";

/**
 * A planning-day end at or before the day's start (the preferred wake time) is an overnight end:
 * "00:30" means half past midnight tonight, not half past midnight this morning. Building it on
 * today's date put it hours in the past and blanked the whole day (lane 2 audit, E2). The settings
 * preview (`nextHorizonEnd`) already read it the overnight way.
 */
type HorizonState = Parameters<typeof dailyHorizonEnd>[0];

function horizonState(planningHorizonEnd: string, preferredWakeTime = "07:00", timezone = "Australia/Sydney") {
  return { settings: { timezone, planningHorizonEnd, preferredWakeTime }, dailyPlan: null } as unknown as HorizonState;
}
const horizon = (end: string, at: string, wake = "07:00") => dailyHorizonEnd(horizonState(end, wake), new Date(at));

describe("dailyHorizonEnd", () => {
  // 2026-08-17 15:00 in the seed zone (UTC+10, no DST).
  const afternoon = "2026-08-17T05:00:00.000Z";

  it("keeps an ordinary evening end on today's date, passed or not", () => {
    expect(horizon("22:00", afternoon).toISOString()).toBe("2026-08-17T12:00:00.000Z");
    // 23:30 local, after a 22:00 end: still today's 22:00, so the day has ended rather than rolled.
    expect(horizon("22:00", "2026-08-17T13:30:00.000Z").toISOString()).toBe("2026-08-17T12:00:00.000Z");
  });

  it("rolls 00:30 to half past midnight tonight, not this morning", () => {
    expect(horizon("00:30", afternoon).toISOString()).toBe("2026-08-17T14:30:00.000Z");
    expect(horizon("00:30", afternoon).getTime()).toBeGreaterThan(new Date(afternoon).getTime());
  });

  it("rolls 00:00 and 01:00 the same way", () => {
    expect(horizon("00:00", afternoon).toISOString()).toBe("2026-08-17T14:00:00.000Z");
    expect(horizon("01:00", afternoon).toISOString()).toBe("2026-08-17T15:00:00.000Z");
  });

  it("treats an end equal to the wake time as overnight, the same boundary the capacity window uses", () => {
    expect(horizon("07:00", afternoon).toISOString()).toBe("2026-08-17T21:00:00.000Z");
    expect(horizon("07:01", afternoon).toISOString()).toBe("2026-08-16T21:01:00.000Z");
  });

  it("follows the person's wake time rather than a fixed 04:00", () => {
    // A 05:00 wake makes a 04:30 end overnight; with 07:00 it is overnight too, with 03:00 it is not.
    expect(horizon("04:30", afternoon, "05:00").toISOString()).toBe("2026-08-17T18:30:00.000Z");
    expect(horizon("04:30", afternoon, "03:00").toISOString()).toBe("2026-08-16T18:30:00.000Z");
  });

  describe("overnight end, around midnight (wake 07:00, end 00:30, seed-zone 17 August)", () => {
    // 00:01 on 17 August is 2026-08-16T14:01Z. The planning day that began on the 16th ends at 00:30 tonight.
    it("at 00:01 belongs to yesterday's planning day: 00:30 is 29 minutes ahead", () => {
      const at = new Date("2026-08-16T14:01:00.000Z");
      const end = horizon("00:30", at.toISOString());
      expect(end.toISOString()).toBe("2026-08-16T14:30:00.000Z");
      expect((end.getTime() - at.getTime()) / 60_000).toBe(29);
    });

    it("at 00:45 returns the passed end, so the day reads as ended, and keeps it until wake", () => {
      const at = new Date("2026-08-16T14:45:00.000Z");
      const end = horizon("00:30", at.toISOString());
      expect(end.toISOString()).toBe("2026-08-16T14:30:00.000Z");
      expect(end.getTime()).toBeLessThan(at.getTime());
    });

    it("at 06:59 is still yesterday's day and at 07:00 rolls to today's", () => {
      expect(horizon("00:30", "2026-08-16T20:59:00.000Z").toISOString()).toBe("2026-08-16T14:30:00.000Z");
      expect(horizon("00:30", "2026-08-16T21:00:00.000Z").toISOString()).toBe("2026-08-17T14:30:00.000Z");
    });

    it("applies an override keyed to yesterday at 00:10, but not once today's day has begun", () => {
      const state = {
        ...horizonState("00:30"),
        dailyPlan: { localDate: "2026-08-16", horizonOverrideAt: "2026-08-16T16:00:00.000Z" }
      } as unknown as HorizonState;
      expect(dailyHorizonEnd(state, new Date("2026-08-16T14:10:00.000Z")).toISOString()).toBe(
        "2026-08-16T16:00:00.000Z"
      );
      expect(dailyHorizonEnd(state, new Date("2026-08-16T21:00:00.000Z")).toISOString()).toBe(
        "2026-08-17T14:30:00.000Z"
      );
    });

    it("applies an after-midnight extension saved under today's date to that night only", () => {
      // 00:45 on 17 August: "Work later tonight" to 02:00 is saved under the new calendar date.
      const state = {
        ...horizonState("00:30"),
        dailyPlan: { localDate: "2026-08-17", horizonOverrideAt: "2026-08-16T16:00:00.000Z" }
      } as unknown as HorizonState;
      // At 01:00 the overnight day is still live and the extension applies.
      expect(dailyHorizonEnd(state, new Date("2026-08-16T15:00:00.000Z")).toISOString()).toBe(
        "2026-08-16T16:00:00.000Z"
      );
      // Just before wake it still applies; from 07:00 today's day has begun and the expired 02:00 is
      // ignored, so the normal horizon applies instead of blanking the day.
      expect(dailyHorizonEnd(state, new Date("2026-08-16T20:59:00.000Z")).toISOString()).toBe(
        "2026-08-16T16:00:00.000Z"
      );
      expect(dailyHorizonEnd(state, new Date("2026-08-16T21:00:00.000Z")).toISOString()).toBe(
        "2026-08-17T14:30:00.000Z"
      );
      expect(dailyHorizonEnd(state, new Date("2026-08-16T21:30:00.000Z")).toISOString()).toBe(
        "2026-08-17T14:30:00.000Z"
      );
    });

    it("compares the override with wake across a DST change", () => {
      // Sunday 2026-10-04 spring forward (02:00 AEST becomes 03:00 AEDT): wake 07:00 AEDT is
      // 2026-10-03T20:00Z. An extension to 01:30 AEST (15:30Z), saved under the 4th, expires at wake.
      const state = {
        ...horizonState("00:30"),
        dailyPlan: { localDate: "2026-10-04", horizonOverrideAt: "2026-10-03T15:30:00.000Z" }
      } as unknown as HorizonState;
      expect(dailyHorizonEnd(state, new Date("2026-10-03T15:00:00.000Z")).toISOString()).toBe(
        "2026-10-03T15:30:00.000Z"
      );
      expect(dailyHorizonEnd(state, new Date("2026-10-03T20:00:00.000Z")).toISOString()).toBe(
        "2026-10-04T13:30:00.000Z"
      );
    });

    it("keeps a 22:00 day's extension and still ignores one that predates the day", () => {
      const evening = (override: string, localDate = "2026-08-17") =>
        ({
          ...horizonState("22:00"),
          dailyPlan: { localDate, horizonOverrideAt: override }
        }) as unknown as HorizonState;
      const at = new Date("2026-08-17T11:00:00.000Z");
      expect(dailyHorizonEnd(evening("2026-08-17T14:00:00.000Z"), at).toISOString()).toBe("2026-08-17T14:00:00.000Z");
      // An instant at or before today's 07:00 wake can only be left over from an earlier day.
      expect(dailyHorizonEnd(evening("2026-08-16T21:00:00.000Z"), at).toISOString()).toBe("2026-08-17T12:00:00.000Z");
      // The window closes at tomorrow's 07:00 wake (2026-08-17T21:00Z): an extension to it still applies,
      // one past it is ignored rather than leaking into the next day.
      expect(dailyHorizonEnd(evening("2026-08-17T21:00:00.000Z"), at).toISOString()).toBe("2026-08-17T21:00:00.000Z");
      expect(dailyHorizonEnd(evening("2026-08-17T21:30:00.000Z"), at).toISOString()).toBe("2026-08-17T12:00:00.000Z");
    });

    it("holds an override to its own planning day: after that day's wake, no later than the next", () => {
      // seed-zone 17 August: wake 07:00 is 2026-08-16T21:00Z. At 05:00 the day that began on the 16th is live.
      const saved = (override: string) =>
        ({
          ...horizonState("00:30"),
          dailyPlan: { localDate: "2026-08-17", horizonOverrideAt: override }
        }) as unknown as HorizonState;
      const at0500 = new Date("2026-08-16T19:00:00.000Z");
      const at0700 = new Date("2026-08-16T21:00:00.000Z");
      // "+3 hours" at 05:00 is held to the 07:00 wake when it is saved; that instant still extends the live day...
      expect(dailyHorizonEnd(saved("2026-08-16T21:00:00.000Z"), at0500).toISOString()).toBe("2026-08-16T21:00:00.000Z");
      // ...and the day that begins at 07:00 starts clean on its own 00:30 end rather than inheriting it.
      expect(dailyHorizonEnd(saved("2026-08-16T21:00:00.000Z"), at0700).toISOString()).toBe("2026-08-17T14:30:00.000Z");
      // One past the wake (08:00, the unclamped "+3 hours") is outside the live day's window, so it is ignored
      // there instead of being trimmed; the save paths never store one (`clampHorizonOverride`).
      expect(dailyHorizonEnd(saved("2026-08-16T22:00:00.000Z"), at0500).toISOString()).toBe("2026-08-16T14:30:00.000Z");
    });

    it("closes the override window at a wake inside a spring-forward gap past the gap", () => {
      // seed-zone 2026-10-04: a 02:30 wake never occurs and `zonedDateTime` places it at 03:30 AEDT
      // (2026-10-03T16:30Z). The portal's `nextPlanningWake` must land on the same instant.
      const saved = (override: string) =>
        ({
          ...horizonState("01:00", "02:30"),
          dailyPlan: { localDate: "2026-10-04", horizonOverrideAt: override }
        }) as unknown as HorizonState;
      const at = new Date("2026-10-03T14:15:00.000Z");
      expect(dailyHorizonEnd(saved("2026-10-03T16:30:00.000Z"), at).toISOString()).toBe("2026-10-03T16:30:00.000Z");
      expect(dailyHorizonEnd(saved("2026-10-03T16:31:00.000Z"), at).toISOString()).toBe("2026-10-03T15:00:00.000Z");
    });

    it("keeps a 22:00 day active past midnight through an extension it was promised, then starts clean at wake", () => {
      // seed-zone: 22:00 end, 07:00 wake. At 23:30 on the 17th "+1 hour" saves 00:30 under the 17th's row.
      const saved = {
        ...horizonState("22:00"),
        dailyPlan: { localDate: "2026-08-17", horizonOverrideAt: "2026-08-17T14:30:00.000Z" }
      } as unknown as HorizonState;
      // Before midnight it is the 17th's own override.
      expect(dailyHorizonEnd(saved, new Date("2026-08-17T13:40:00.000Z")).toISOString()).toBe(
        "2026-08-17T14:30:00.000Z"
      );
      // At 00:15 the calendar says the 18th, but the 17th's night is still in progress and its 00:30 holds.
      const afterMidnight = new Date("2026-08-17T14:15:00.000Z");
      expect(activePlanningDate(saved, afterMidnight)).toBe("2026-08-17");
      expect(dailyHorizonEnd(saved, afterMidnight).toISOString()).toBe("2026-08-17T14:30:00.000Z");
      // The same when a later row (desired wins saved at 00:10) carries the still-future override.
      const carried = {
        ...saved,
        dailyPlan: { localDate: "2026-08-18", horizonOverrideAt: "2026-08-17T14:30:00.000Z" }
      } as unknown as HorizonState;
      expect(dailyHorizonEnd(carried, afterMidnight).toISOString()).toBe("2026-08-17T14:30:00.000Z");
      // Once it has passed nothing is promised: the 18th is active with its own 22:00 end.
      const passed = new Date("2026-08-17T14:45:00.000Z");
      expect(activePlanningDate(saved, passed)).toBe("2026-08-18");
      expect(dailyHorizonEnd(saved, passed).toISOString()).toBe("2026-08-18T12:00:00.000Z");
      // The next planning day starts at 07:00 with nothing carried over.
      expect(dailyHorizonEnd(saved, new Date("2026-08-17T21:00:00.000Z")).toISOString()).toBe(
        "2026-08-18T12:00:00.000Z"
      );
      // An override cannot hold a day open past the wake: the day that begins there is the active one.
      const crossing = {
        ...saved,
        dailyPlan: { localDate: "2026-08-17", horizonOverrideAt: "2026-08-17T22:00:00.000Z" }
      } as unknown as HorizonState;
      expect(activePlanningDate(crossing, afterMidnight)).toBe("2026-08-18");
    });

    it("leaves an ordinary 22:00 end on today's date at 01:00, with no overnight reading", () => {
      expect(horizon("22:00", "2026-08-16T15:00:00.000Z").toISOString()).toBe("2026-08-17T12:00:00.000Z");
    });

    it("holds the same boundaries across the seed zone's DST changes", () => {
      // Spring forward Sunday 2026-10-04 02:00 (+10 to +11): 00:01 is AEST, 06:59 and 07:00 are AEDT.
      expect(horizon("00:30", "2026-10-03T14:01:00.000Z").toISOString()).toBe("2026-10-03T14:30:00.000Z");
      expect(horizon("00:30", "2026-10-03T19:59:00.000Z").toISOString()).toBe("2026-10-03T14:30:00.000Z");
      expect(horizon("00:30", "2026-10-03T20:00:00.000Z").toISOString()).toBe("2026-10-04T13:30:00.000Z");
      // Fall back Sunday 2027-04-04 03:00 (+11 to +10): 00:01 is AEDT, 06:59 and 07:00 are AEST.
      expect(horizon("00:30", "2027-04-03T13:01:00.000Z").toISOString()).toBe("2027-04-03T13:30:00.000Z");
      expect(horizon("00:30", "2027-04-03T20:59:00.000Z").toISOString()).toBe("2027-04-03T13:30:00.000Z");
      expect(horizon("00:30", "2027-04-03T21:00:00.000Z").toISOString()).toBe("2027-04-04T14:30:00.000Z");
    });
  });

  it("is the same instant at any time from wake to midnight on one local day", () => {
    for (const at of ["2026-08-16T21:00:00.000Z", "2026-08-17T05:00:00.000Z", "2026-08-17T13:59:00.000Z"])
      expect(horizon("00:30", at).toISOString()).toBe("2026-08-17T14:30:00.000Z");
  });

  it("lets today's explicit override win over the rolled end", () => {
    const state = {
      ...horizonState("00:30"),
      dailyPlan: { localDate: "2026-08-17", horizonOverrideAt: "2026-08-17T11:00:00.000Z" }
    } as unknown as HorizonState;
    expect(dailyHorizonEnd(state, new Date(afternoon)).toISOString()).toBe("2026-08-17T11:00:00.000Z");
  });

  it("keeps the local wall time across the seed zone's spring-forward and fall-back changes", () => {
    // DST starts Sunday 2026-10-04 02:00 (+10 to +11). The Saturday end lands in AEST, the Sunday end in AEDT.
    expect(horizon("00:30", "2026-10-03T05:00:00.000Z").toISOString()).toBe("2026-10-03T14:30:00.000Z");
    expect(horizon("00:30", "2026-10-04T05:00:00.000Z").toISOString()).toBe("2026-10-04T13:30:00.000Z");
    // DST ends Sunday 2027-04-04 03:00 (+11 to +10).
    expect(horizon("00:30", "2027-04-03T05:00:00.000Z").toISOString()).toBe("2027-04-03T13:30:00.000Z");
    expect(horizon("00:30", "2027-04-04T05:00:00.000Z").toISOString()).toBe("2027-04-04T14:30:00.000Z");
  });
});

describe("a midnight planning-day end through the whole engine", () => {
  // Monday 2026-08-17 15:00 in the seed zone.
  const defaultNow = new Date("2026-08-17T05:00:00.000Z");
  function run(planningHorizonEnd: string, now = defaultNow, dailyPlan?: Record<string, unknown>) {
    const later = (hours: number) => new Date(now.getTime() + hours * 60 * 60_000).toISOString();
    const state = portalStateSchema.parse({
      settings: {
        timezone: "Australia/Sydney",
        planningHorizonEnd,
        defaultUsableFraction: 1,
        defaultSetupBufferMinutes: 0,
        defaultTransitionBufferMinutes: 0,
        submissionBufferMinutes: 0,
        submissionBufferPercent: 0,
        energyMeanings: { high: "high", medium: "medium", low: "low", recovery: "recovery" },
        estimateBucketsMinutes: [15, 30, 60],
        conditionCatalog: ["home"],
        preferredBedtime: "01:30",
        preferredWakeTime: "08:00",
        desiredSleepMinutes: 480,
        minimumSleepMinutes: 420,
        maxAwakeHours: 20
      },
      areas: [{ id: "area", name: "Work", status: "active", sortOrder: 0 }],
      outcomes: [
        { id: "outcome", areaId: "area", title: "Report", definitionOfDone: "Done", value: 4, status: "active" }
      ],
      projects: [
        {
          id: "project",
          title: "Report",
          area: "Work",
          outcomeId: "outcome",
          status: "active",
          uncertainty: "some",
          value: 4,
          consequence: 3,
          internalDeadlineAt: later(24 * 10)
        }
      ],
      actions: [
        {
          id: "write",
          projectId: "project",
          title: "Write the report",
          status: "active",
          optimisticMinutes: 40,
          expectedMinutes: 60,
          remainingMinutes: 60,
          pessimisticMinutes: 90,
          energy: "high",
          minimumSessionMinutes: 15,
          maximumSessionMinutes: 90,
          importance: 3,
          consequence: 3,
          contexts: [],
          dependencyIds: [],
          splittable: true,
          setupMinutes: 0,
          schedulingMode: "one_off"
        }
      ],
      commitments: [],
      routineSteps: [],
      routinePresets: [],
      occurrences: [],
      sleepPlans: [],
      captures: [],
      completedToday: [],
      assertedConditions: ["home"],
      currentEnergy: "high",
      horizonEnd: later(96),
      activeSession: null,
      ...(dailyPlan ? { dailyPlan } : {})
    });
    return calculatePlanAndForecast(
      planForecastRequestSchema.parse({
        contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
        requestId: "00000000-0000-4000-8000-0000000000e2",
        inputVersion: "midnight-horizon-fixture",
        calculatedAt: now.toISOString(),
        horizonEnd: later(96),
        state,
        deliverables: []
      })
    );
  }

  it.each(["22:00", "00:00", "00:30", "01:00"])("still recommends work at 15:00 with the day ending at %s", (end) => {
    const response = run(end);
    expect(response.currentDirective.kind).not.toBe("boundary");
    expect(response.currentDirective).toMatchObject({ kind: "action", targetId: "write" });
    expect(response.dayPlan?.blocks.length ?? 0).toBeGreaterThan(0);
  });

  it("just after midnight the overnight day is still live until 00:30, then reads as ended until wake", () => {
    const at = (iso: string) => new Date(iso);
    const live = run("00:30", at("2026-08-16T14:01:00.000Z"));
    expect(live.currentDirective).toMatchObject({ kind: "action", targetId: "write" });
    // Only 29 minutes remain in the day, so the session is bounded by them, not by a 24-hour horizon.
    expect(
      (live.recommendation as unknown as { primary: { recommendedMinutes: number } }).primary.recommendedMinutes
    ).toBeLessThanOrEqual(29);
    const ended = run("00:30", at("2026-08-16T14:45:00.000Z"));
    expect(ended.currentDirective.kind).toBe("boundary");
    expect(run("00:30", at("2026-08-16T20:59:00.000Z")).currentDirective.kind).toBe("boundary");
  });

  it("bounds the day plan by an extension saved after midnight under today's date", () => {
    // 00:45 on 17 August in the seed zone: the 00:30 end has passed, and "Work later tonight" was saved to
    // 02:00 under the current calendar date. The live directive accepts it, so the plan must too.
    const now = new Date("2026-08-16T14:45:00.000Z");
    const until = "2026-08-16T16:00:00.000Z";
    const plan = (localDate: string) => ({
      id: "00000000-0000-4000-8000-0000000000d1",
      version: 1,
      localDate,
      desiredActionIds: [],
      deferredItems: [],
      recoverySkipped: false,
      horizonOverrideAt: until
    });
    const extended = run("00:30", now, plan("2026-08-17"));
    expect(extended.currentDirective).toMatchObject({ kind: "action", targetId: "write" });
    const planEnd = (response: ReturnType<typeof run>) =>
      Math.max(0, ...(response.dayPlan?.blocks ?? []).map((block) => new Date(block.endsAt).getTime()));
    // The plan runs to the extended end, not to the passed default (which stops it after the first block).
    expect(planEnd(extended)).toBe(new Date(until).getTime());
    // Saved under the planning day still in progress (yesterday's date) it applies the same way.
    expect(planEnd(run("00:30", now, plan("2026-08-16")))).toBe(new Date(until).getTime());
    // Without an override the passed 00:30 end leaves the plan ending before the extended one.
    expect(planEnd(run("00:30", now))).toBeLessThan(new Date(until).getTime());
  });

  it("gives the same day plan for the end at 00:30 as for 22:00 up to the later end", () => {
    const early = run("22:00").dayPlan!;
    const late = run("00:30").dayPlan!;
    // Cut at the earlier end, the later plan is the earlier one block for block; it only runs on past it.
    const earlyEnd = Math.max(...early.blocks.map((block) => new Date(block.endsAt).getTime()));
    const cut = late.blocks
      .filter((block) => new Date(block.startsAt).getTime() < earlyEnd)
      .map((block) => [block.startsAt, new Date(Math.min(new Date(block.endsAt).getTime(), earlyEnd)).toISOString()]);
    expect(early.blocks.length).toBeGreaterThan(0);
    expect(cut).toEqual(early.blocks.map((block) => [block.startsAt, block.endsAt]));
    expect(Math.max(...late.blocks.map((block) => new Date(block.endsAt).getTime()))).toBeGreaterThan(earlyEnd);
  });
});
