import { describe, expect, it } from "vitest";
import { resolvePulse } from "./pulse.js";

/**
 * `resolvePulse`'s precedence — session, then travel, then routine step, then commitment, then
 * sleep, then the recommended action, then nothing — ported from `now-activity.test.ts`'s exercise of
 * the same chain in `resolveOne` (`platform/contracts/src/planning/now-activity.ts:411-430`). Those portal tests are
 * untouched; these prove the same ordering over the plain candidates this module actually receives.
 */

const session = { targetType: "action" as const, id: "session-action", title: "Session action" };
const routineStep = { id: "step-1", title: "Pack bag" };
const commitment = { id: "commitment-1", title: "Dinner" };
const sleep = { id: "sleep-1", title: "Tonight" };
const action = { id: "action-1", title: "Sort the bedroom floor" };

describe("resolvePulse precedence", () => {
  it("a session outranks everything else", () => {
    const pulse = resolvePulse({ session, travel: true, routineStep, commitment, sleep, action });
    expect(pulse.doing).toEqual({ kind: "action", id: "session-action", title: "Session action" });
  });

  it("travel outranks a routine step, a commitment, sleep and the recommendation, and names no doing", () => {
    const pulse = resolvePulse({ travel: true, routineStep, commitment, sleep, action });
    expect(pulse.doing).toBeUndefined();
  });

  it("a routine step outranks a commitment, sleep and the recommendation", () => {
    const pulse = resolvePulse({ routineStep, commitment, sleep, action });
    expect(pulse.doing).toEqual({ kind: "step", id: "step-1", title: "Pack bag" });
  });

  it("a commitment outranks sleep and the recommendation", () => {
    const pulse = resolvePulse({ commitment, sleep, action });
    expect(pulse.doing).toEqual({ kind: "commitment", id: "commitment-1", title: "Dinner" });
  });

  it("sleep outranks the recommendation", () => {
    const pulse = resolvePulse({ sleep, action });
    expect(pulse.doing).toEqual({ kind: "sleep", id: "sleep-1", title: "Tonight" });
  });

  it("the recommended action is the last rank before nothing", () => {
    const pulse = resolvePulse({ action });
    expect(pulse.doing).toEqual({ kind: "action", id: "action-1", title: "Sort the bedroom floor" });
  });

  it("names no doing when nothing is on the clock", () => {
    const pulse = resolvePulse({});
    expect(pulse.doing).toBeUndefined();
    expect(pulse).toEqual({});
  });
});

describe("resolvePulse session target-type mapping", () => {
  it.each([
    ["action", "action"],
    ["deliverable", "deliverable"],
    ["routine_step", "step"],
    ["fixed_commitment", "commitment"],
    ["sleep", "sleep"]
  ] as const)("maps a %s session onto doing kind %s", (targetType, kind) => {
    const pulse = resolvePulse({ session: { targetType, id: "target-1", title: "Whatever it names" } });
    expect(pulse.doing).toEqual({ kind, id: "target-1", title: "Whatever it names" });
  });

  it("names no doing for a routine_instance session — there is no sixth noun for the whole routine", () => {
    const pulse = resolvePulse({ session: { targetType: "routine_instance", id: "instance-1", title: "Bedtime" } });
    expect(pulse.doing).toBeUndefined();
  });
});

describe("resolvePulse onPlan and offPlanSince", () => {
  it("never fills onPlan or offPlanSince — the criteria are not yet designed", () => {
    const pulse = resolvePulse({ commitment, lastConfirmedAt: "2026-09-12T10:00:00.000Z" });
    expect(pulse.onPlan).toBeUndefined();
    expect(pulse.offPlanSince).toBeUndefined();
  });
});

describe("resolvePulse lastConfirmedAt", () => {
  it("passes lastConfirmedAt through unchanged when present", () => {
    const pulse = resolvePulse({ action, lastConfirmedAt: "2026-09-12T09:30:00.000Z" });
    expect(pulse.lastConfirmedAt).toBe("2026-09-12T09:30:00.000Z");
  });

  it("omits lastConfirmedAt when absent, rather than setting it to undefined explicitly", () => {
    const pulse = resolvePulse({ action });
    expect("lastConfirmedAt" in pulse).toBe(false);
  });
});
