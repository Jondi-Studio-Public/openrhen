import { describe, expect, it } from "vitest";
import { deriveCompletionRatios } from "@openrhen/contracts";

const startedAt = new Date("2026-08-01T00:00:00.000Z");
const deadline = new Date("2026-09-01T00:00:00.000Z"); // 31 days after startedAt

describe("deriveCompletionRatios", () => {
  it("measures actual completion against the baseline when scope has not changed", () => {
    const ratios = deriveCompletionRatios({
      baselineMinutes: 1000,
      completedMinutes: 400,
      currentTotalMinutes: 1000,
      startedAt,
      deadline,
      now: startedAt
    });
    expect(ratios.actualCompletionRatio).toBeCloseTo(0.4, 5);
  });

  it("measures elapsed time against the baseline-to-deadline window", () => {
    // Halfway between startedAt and deadline.
    const now = new Date((startedAt.getTime() + deadline.getTime()) / 2);
    const ratios = deriveCompletionRatios({
      baselineMinutes: 1000,
      completedMinutes: 0,
      currentTotalMinutes: 1000,
      startedAt,
      deadline,
      now
    });
    expect(ratios.requiredCompletionRatio).toBeCloseTo(0.5, 5);
  });

  it("divides by the larger of baseline and current scope, so added work lowers the ratio instead of exceeding 1", () => {
    // Baseline was 1000 minutes; 900 minutes of new work were added since, and 400 minutes are done.
    const ratios = deriveCompletionRatios({
      baselineMinutes: 1000,
      completedMinutes: 400,
      currentTotalMinutes: 1900,
      startedAt,
      deadline,
      now: startedAt
    });
    expect(ratios.actualCompletionRatio).toBeCloseTo(400 / 1900, 5);
  });

  it("never lets actualCompletionRatio exceed 1 even if completed exceeds the recorded scope", () => {
    const ratios = deriveCompletionRatios({
      baselineMinutes: 100,
      completedMinutes: 150,
      currentTotalMinutes: 100,
      startedAt,
      deadline,
      now: startedAt
    });
    expect(ratios.actualCompletionRatio).toBe(1);
  });

  it("clamps requiredCompletionRatio to 1 once the deadline has passed", () => {
    const ratios = deriveCompletionRatios({
      baselineMinutes: 100,
      completedMinutes: 0,
      currentTotalMinutes: 100,
      startedAt,
      deadline,
      now: new Date(deadline.getTime() + 10 * 86_400_000)
    });
    expect(ratios.requiredCompletionRatio).toBe(1);
  });

  it("clamps requiredCompletionRatio to 0 for a now before the baseline", () => {
    const ratios = deriveCompletionRatios({
      baselineMinutes: 100,
      completedMinutes: 0,
      currentTotalMinutes: 100,
      startedAt,
      deadline,
      now: new Date(startedAt.getTime() - 60_000)
    });
    expect(ratios.requiredCompletionRatio).toBe(0);
  });

  it("treats a deadline at or before the baseline as fully required immediately", () => {
    const ratios = deriveCompletionRatios({
      baselineMinutes: 100,
      completedMinutes: 0,
      currentTotalMinutes: 100,
      startedAt,
      deadline: startedAt,
      now: startedAt
    });
    expect(ratios.requiredCompletionRatio).toBe(1);
  });

  it("never returns a negative ratio when no work is done and scope is zero", () => {
    const ratios = deriveCompletionRatios({
      baselineMinutes: 0,
      completedMinutes: 0,
      currentTotalMinutes: 0,
      startedAt,
      deadline,
      now: startedAt
    });
    expect(ratios.actualCompletionRatio).toBe(0);
    expect(Number.isFinite(ratios.actualCompletionRatio)).toBe(true);
  });
});
