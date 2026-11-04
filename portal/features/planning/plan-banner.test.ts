import { describe, expect, it } from "vitest";
import { planningBanner, planTime } from "@/features/planning/plan-banner";
import type { PortalPlanningRuntimeState } from "@/features/planning/planning-runtime";

const ZONE = "Australia/Sydney";
// 10:00 am in the seed zone.
const NOW = new Date("2026-10-26T23:00:00.000Z");
const nineForty = "2026-10-26T22:40:00.000Z";
const banner = (planning: PortalPlanningRuntimeState, extra: Partial<Parameters<typeof planningBanner>[0]> = {}) =>
  planningBanner({ planning, timezone: ZONE, now: NOW, ...extra });

describe("planningBanner", () => {
  it("says nothing while the plan is current", () => {
    expect(
      banner({ status: "current", lastSuccessfulAt: nineForty, validUntil: "2026-10-27T00:00:00.000Z" })
    ).toBeNull();
  });

  it("treats an ordinary wait for a plan as working, in plain words", () => {
    expect(banner({ status: "pending" })).toEqual({ tone: "working", text: "Working out your plan…" });
    expect(banner({ status: "pending", lastSuccessfulAt: nineForty })).toEqual({
      tone: "working",
      text: "Using the plan from 9:40 am. A fresh one is on its way; Start is off until it lands."
    });
  });

  it("makes a retry after a failure a warning, and keeps a real error as its detail", () => {
    expect(banner({ status: "pending", lastSuccessfulAt: nineForty, message: "connect ECONNREFUSED" })).toEqual({
      tone: "warning",
      text: "Using the plan from 9:40 am. The last refresh failed and is retrying. Detail: connect ECONNREFUSED"
    });
  });

  it("keeps red for a failure, without the runtime's own stand-in message", () => {
    const failed = banner({ status: "failed", message: "The last Plan and Forecast Engine calculation failed." });
    expect(failed).toEqual({ tone: "danger", text: "The planner could not work out a plan. Capture still works." });
  });

  it("calls an old plan with no refresh running a warning", () => {
    expect(banner({ status: "stale", lastSuccessfulAt: nineForty })?.tone).toBe("warning");
  });

  it("is red once the worker has stalled, whatever the stored status says", () => {
    const stalled = banner(
      { status: "pending", lastSuccessfulAt: nineForty, validUntil: nineForty },
      { health: { refresh: "stalled", graceEndsAt: null, unreachable: false } }
    );
    expect(stalled?.tone).toBe("danger");
    expect(stalled?.text).toMatch(/planning worker may be down/);
  });

  it("never names the engine", () => {
    for (const status of ["pending", "failed", "stale", "unavailable"] as const)
      expect(
        banner({ status, message: "The Plan and Forecast Engine has not produced a result yet." })?.text
      ).not.toMatch(/Plan and Forecast Engine/);
  });
});

describe("planTime", () => {
  it("gives a time alone for today and adds the weekday for an older plan", () => {
    expect(planTime(nineForty, ZONE, NOW)).toBe("9:40 am");
    expect(planTime("2026-10-25T22:40:00.000Z", ZONE, NOW)).toBe("Mon 9:40 am");
  });
});
