import { describe, expect, it } from "vitest";
import {
  commitmentRecurrenceRuleSchema,
  deliverableActionSchema,
  commitmentSchema,
  portalStateSchema,
  pulseWireSchema
} from "./state-schema.js";

const baseCommitment = {
  id: "commitment-1",
  title: "Pick up kids",
  startsAt: "2026-09-09T15:00:00.000Z",
  endsAt: "2026-09-09T16:00:00.000Z",
  status: "confirmed" as const,
  setupBeforeMinutes: 0,
  transitionAfterMinutes: 0
};

const baseRule = {
  id: "rule-1",
  title: "Weekday school run",
  timezone: "Australia/Sydney",
  startDate: "2026-09-09",
  repeat: { unit: "days" as const, intervalDays: 1 },
  localStartTime: "15:00",
  localEndTime: "16:00",
  setupBeforeMinutes: 0,
  transitionAfterMinutes: 0,
  status: "active" as const
};

describe("commitmentSchema", () => {
  it("parses a commitment without the sharing fields, defaulting them absent", () => {
    const parsed = commitmentSchema.parse(baseCommitment);
    expect(parsed.shareToCalendar).toBeUndefined();
    expect(parsed.shareSource).toBeUndefined();
  });

  it("round-trips shareToCalendar and shareSource when present", () => {
    const parsed = commitmentSchema.parse({
      ...baseCommitment,
      shareToCalendar: true,
      shareSource: "custom"
    });
    expect(parsed.shareToCalendar).toBe(true);
    expect(parsed.shareSource).toBe("custom");
  });

  it("rejects a shareSource value outside inherit/custom", () => {
    expect(() => commitmentSchema.parse({ ...baseCommitment, shareToCalendar: true, shareSource: "bogus" })).toThrow();
  });

  it("leaves attendance absent (meaning in person) and round-trips a remote one with its preferred place", () => {
    expect(commitmentSchema.parse(baseCommitment).attendance).toBeUndefined();
    const parsed = commitmentSchema.parse({
      ...baseCommitment,
      attendance: "remote",
      preferredLocationId: "home-desk"
    });
    expect(parsed.attendance).toBe("remote");
    expect(parsed.preferredLocationId).toBe("home-desk");
  });

  it("rejects an attendance outside in_person/remote", () => {
    expect(() => commitmentSchema.parse({ ...baseCommitment, attendance: "hybrid" })).toThrow();
  });
});

describe("commitmentRecurrenceRuleSchema", () => {
  it("parses a rule without shareToCalendar", () => {
    const parsed = commitmentRecurrenceRuleSchema.parse(baseRule);
    expect(parsed.shareToCalendar).toBeUndefined();
  });

  it("round-trips shareToCalendar when present", () => {
    const parsed = commitmentRecurrenceRuleSchema.parse({ ...baseRule, shareToCalendar: true });
    expect(parsed.shareToCalendar).toBe(true);
  });
});

describe("pulse check-in allowance and wire", () => {
  it("round-trips checkInExtraMinutes on a commitment and a rule, absent meaning the default", () => {
    expect(commitmentSchema.parse(baseCommitment).checkInExtraMinutes).toBeUndefined();
    expect(commitmentSchema.parse({ ...baseCommitment, checkInExtraMinutes: 40 }).checkInExtraMinutes).toBe(40);
    expect(commitmentSchema.safeParse({ ...baseCommitment, checkInExtraMinutes: -1 }).success).toBe(false);
    expect(commitmentRecurrenceRuleSchema.parse({ ...baseRule, checkInExtraMinutes: 0 }).checkInExtraMinutes).toBe(0);
  });

  it("carries unknown, the off reason, who confirmed and when silence ends", () => {
    const base = {
      since: "2026-10-28T01:00:00.000Z",
      private: false,
      shares: {
        today: { onPercent: null, countedMinutes: 0 },
        days7: { onPercent: null, countedMinutes: 0 },
        days30: { onPercent: null, countedMinutes: 0 }
      }
    };
    expect(pulseWireSchema.safeParse({ ...base, state: "unknown", reason: "unconfirmed" }).success).toBe(true);
    const lapsed = pulseWireSchema.parse({
      ...base,
      state: "off",
      reason: "lapsed",
      offReason: "lapsed",
      confirmedBy: "agent",
      silenceUntil: "2026-10-28T09:00:00.000Z"
    });
    expect(lapsed.offReason).toBe("lapsed");
    expect(lapsed.confirmedBy).toBe("agent");
    expect(
      pulseWireSchema.safeParse({ ...base, state: "off", reason: "lapsed", confirmedBy: "schedule" }).success
    ).toBe(false);
  });
});

describe("protected recovery window", () => {
  const stateWith = (recoveryStartTime: string, recoveryEndTime: string) => ({
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
      conditionCatalog: ["home"],
      preferredBedtime: "23:00",
      preferredWakeTime: "07:00",
      desiredSleepMinutes: 480,
      minimumSleepMinutes: 420,
      maxAwakeHours: 16,
      recoveryStartTime,
      recoveryEndTime
    },
    areas: [],
    outcomes: [],
    projects: [],
    actions: [],
    commitments: [],
    routineSteps: [],
    routinePresets: [],
    occurrences: [],
    sleepPlans: [],
    captures: [],
    completedToday: [],
    assertedConditions: [],
    currentEnergy: "medium",
    horizonEnd: "2026-08-14T04:00:00.000Z",
    activeSession: null
  });

  it("accepts a same-day window", () => {
    expect(portalStateSchema.safeParse(stateWith("14:00", "15:00")).success).toBe(true);
  });

  it("accepts an overnight window, whose end is before its start", () => {
    expect(portalStateSchema.safeParse(stateWith("23:00", "06:00")).success).toBe(true);
  });

  it("rejects a zero-length window", () => {
    const parsed = portalStateSchema.safeParse(stateWith("14:00", "14:00"));
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("recoveryEndTime");
  });
});

describe("deliverable step status on the read side", () => {
  const step = {
    id: "step-1",
    title: "Write it up",
    optimisticMinutes: 10,
    expectedMinutes: 20,
    pessimisticMinutes: 30,
    remainingMinutes: 0,
    energy: "low",
    minimumSessionMinutes: 10,
    maximumSessionMinutes: 30
  };

  it.each(["done", "cancelled", "archived"])("parses a %s step (closing a done step leaves it archived)", (status) => {
    expect(deliverableActionSchema.parse({ ...step, status }).status).toBe(status);
  });

  it("still rejects a status that is not a step status", () => {
    expect(() => deliverableActionSchema.parse({ ...step, status: "inbox" })).toThrow();
  });
});
