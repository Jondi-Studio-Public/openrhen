import { describe, expect, it } from "vitest";
import { decidePlanRecheck, PLAN_RECHECK_THRESHOLD_MS, type PlanRecheckFacts } from "./plan-recheck-watchdog.js";

const now = new Date("2026-11-10T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
const dead: PlanRecheckFacts = {
  now,
  newestRunAt: minutesAgo(120),
  hasActiveJob: false,
  lastJobEngineUnavailableAt: null
};

describe("decidePlanRecheck", () => {
  it("heals a chain with an old run and no active job", () => expect(decidePlanRecheck(dead)).toEqual({ heal: true }));

  it("waits 70 minutes: 60 plus a 10 minute grace", () => {
    expect(PLAN_RECHECK_THRESHOLD_MS).toBe(70 * 60_000);
    expect(decidePlanRecheck({ ...dead, newestRunAt: minutesAgo(70) })).toEqual({ heal: false, reason: "recent_run" });
    expect(decidePlanRecheck({ ...dead, newestRunAt: minutesAgo(69) })).toEqual({ heal: false, reason: "recent_run" });
    expect(decidePlanRecheck({ ...dead, newestRunAt: minutesAgo(71) })).toEqual({ heal: true });
  });

  it("does nothing while a job is active, however old the run", () =>
    expect(decidePlanRecheck({ ...dead, hasActiveJob: true })).toEqual({ heal: false, reason: "active_job" }));

  it("does nothing while the engine was reported unavailable within the last 70 minutes", () =>
    expect(decidePlanRecheck({ ...dead, lastJobEngineUnavailableAt: minutesAgo(5) })).toEqual({
      heal: false,
      reason: "engine_unavailable"
    }));

  it("heals when the unavailable failure is older than 70 minutes: nothing retries it, so the chain is dead", () => {
    expect(decidePlanRecheck({ ...dead, lastJobEngineUnavailableAt: minutesAgo(70) })).toEqual({
      heal: false,
      reason: "engine_unavailable"
    });
    expect(decidePlanRecheck({ ...dead, lastJobEngineUnavailableAt: minutesAgo(71) })).toEqual({ heal: true });
  });

  it("heals a user at most once per 70 minutes", () => {
    expect(decidePlanRecheck({ ...dead, lastHealAt: minutesAgo(5) })).toEqual({
      heal: false,
      reason: "recently_healed"
    });
    expect(decidePlanRecheck({ ...dead, lastHealAt: minutesAgo(71) })).toEqual({ heal: true });
  });
});
