import { describe, expect, it } from "vitest";
import { createSeedState, defaultPlanningSettings } from "@/state/portal-state";
import { applyPlanningSettings, nextHorizonEnd, validatePlanningSettings } from "./settings";

describe("planning settings", () => {
  it("resolves the seed-zone horizon correctly from UTC", () => {
    expect(nextHorizonEnd(new Date("2026-08-08T08:00:00.000Z"), "Australia/Sydney", "22:00").toISOString()).toBe(
      "2026-08-08T12:00:00.000Z"
    );
  });

  it("rolls a passed horizon into the next local day", () => {
    expect(nextHorizonEnd(new Date("2026-08-08T13:00:00.000Z"), "Australia/Sydney", "22:00").toISOString()).toBe(
      "2026-08-09T12:00:00.000Z"
    );
  });

  it("rejects invalid capacity and estimate defaults", () => {
    expect(
      validatePlanningSettings({ ...defaultPlanningSettings(), minimumSleepMinutes: 600, desiredSleepMinutes: 480 })
    ).toContain("cannot exceed");
    expect(validatePlanningSettings({ ...defaultPlanningSettings(), estimateBucketsMinutes: [15, 5] })).toContain(
      "ascending"
    );
  });

  it("carries the chosen home base through, and accepts none being chosen", () => {
    const state = createSeedState(new Date("2026-08-08T08:00:00.000Z"));
    const at = new Date("2026-08-08T08:00:00.000Z");
    expect(state.settings.homeLocationId).toBeUndefined();
    const withHome = applyPlanningSettings(state, { ...state.settings, homeLocationId: "home" }, at);
    expect(withHome.settings.homeLocationId).toBe("home");
    expect(validatePlanningSettings(withHome.settings)).toBeNull();
    const cleared = applyPlanningSettings(withHome, { ...withHome.settings, homeLocationId: undefined }, at);
    expect(cleared.settings.homeLocationId).toBeUndefined();
  });

  it("updates both persistent settings and the active horizon", () => {
    const state = createSeedState(new Date("2026-08-08T08:00:00.000Z"));
    const settings = { ...state.settings, planningHorizonEnd: "21:30" };
    const updated = applyPlanningSettings(state, settings, new Date("2026-08-08T08:00:00.000Z"));
    expect(updated.settings.planningHorizonEnd).toBe("21:30");
    expect(updated.horizonEnd).toBe("2026-08-08T11:30:00.000Z");
  });
});
