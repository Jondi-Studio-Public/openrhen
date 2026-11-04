import { describe, expect, it } from "vitest";
import {
  CALIBRATION_MAX_FACTOR,
  CALIBRATION_MIN_FACTOR,
  calibrationFactorForArea,
  deriveEstimateCalibration,
  type CalibrationSample
} from "./estimate-calibration.js";

function samples(ratios: number[], areaId: string | null = "work", estimate = 60): CalibrationSample[] {
  return ratios.map((ratio, index) => ({
    actionId: `${areaId ?? "none"}-${index}`,
    areaId,
    completedAt: new Date(Date.UTC(2026, 8, 1 + index)).toISOString(),
    estimatedMinutes: estimate,
    actualMinutes: Math.round(estimate * ratio)
  }));
}

describe("deriveEstimateCalibration", () => {
  it("learns nothing from fewer than five usable samples", () => {
    expect(deriveEstimateCalibration(samples([2, 2, 2, 2]))).toEqual({ overall: null, areas: [] });
    // A tiny estimate says nothing about a ratio, so it does not count towards five.
    expect(deriveEstimateCalibration([...samples([2, 2, 2, 2]), ...samples([2], "work", 3)]).overall).toBeNull();
  });

  it("moves gradually from 1 towards the evidence", () => {
    // 1 → 1.25 → 1.4375 → 1.578 → 1.684 → 1.763
    const calibration = deriveEstimateCalibration(samples([2, 2, 2, 2, 2]));
    expect(calibration.overall).toEqual({
      factor: 1.76,
      spread: 1,
      samples: 5,
      lastSampleAt: "2026-09-05T00:00:00.000Z"
    });
    expect(calibration.areas).toEqual([
      { areaId: "work", factor: 1.76, spread: 1, samples: 5, lastSampleAt: "2026-09-05T00:00:00.000Z" }
    ]);
  });

  it("learns a padding spread from how widely the ratios scatter, clamped", () => {
    // Identical ratios scatter nowhere: no padding beyond the calibrated mean.
    expect(deriveEstimateCalibration(samples([2, 2, 2, 2, 2])).overall!.spread).toBe(1);
    const scattered = deriveEstimateCalibration(samples([0.5, 2, 0.6, 1.8, 1, 1.5])).overall!.spread!;
    expect(scattered).toBeGreaterThan(1.2);
    expect(scattered).toBeLessThanOrEqual(2);
    expect(deriveEstimateCalibration(samples([0.25, 4, 0.25, 4, 0.25, 4])).overall!.spread).toBe(2);
  });

  it("averages in completion order, whatever order the samples arrive in", () => {
    const ordered = samples([1, 1, 1, 1, 3]);
    expect(deriveEstimateCalibration([...ordered].reverse())).toEqual(deriveEstimateCalibration(ordered));
    // The newest sample carries the most weight.
    expect(deriveEstimateCalibration(ordered).overall!.factor).toBe(1.5);
    expect(deriveEstimateCalibration(samples([3, 1, 1, 1, 1])).overall!.factor).toBeLessThan(1.5);
  });

  it("clamps the factor and bounds any one outlier", () => {
    expect(deriveEstimateCalibration(samples(Array(40).fill(10))).overall!.factor).toBe(CALIBRATION_MAX_FACTOR);
    expect(deriveEstimateCalibration(samples(Array(40).fill(0.1))).overall!.factor).toBe(CALIBRATION_MIN_FACTOR);
    // A forgotten timer (20×) counts as 4×, not 20×.
    expect(deriveEstimateCalibration(samples([1, 1, 1, 1, 20])).overall!.factor).toBe(1.75);
  });

  it("keeps an area's own factor only once it has five samples of its own", () => {
    const calibration = deriveEstimateCalibration([...samples([2, 2, 2, 2, 2], "work"), ...samples([1, 1], "home")]);
    expect(calibration.areas.map((entry) => entry.areaId)).toEqual(["work"]);
    expect(calibration.overall!.samples).toBe(7);
    expect(calibrationFactorForArea(calibration, "work")).toMatchObject({ factor: 1.76, scope: "area" });
    expect(calibrationFactorForArea(calibration, "home")).toMatchObject({ scope: "overall", samples: 7 });
    expect(calibrationFactorForArea({ overall: null, areas: [] }, "home")).toBeNull();
  });
});
