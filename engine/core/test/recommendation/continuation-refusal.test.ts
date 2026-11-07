import { describe, expect, it } from "vitest";
import { continuationRefusal, limitNote } from "../../src/recommendation/continuation.js";

// A checkpoint used to read "A 0-minute continuation is shorter than the 15 minutes this work needs"
// beside a remaining-effort picker that said 30 minutes.
describe("continuationRefusal", () => {
  it("never states a 0-minute continuation", () => {
    expect(continuationRefusal(0, 45, 0, 15)).toBe(
      "Nothing is left on this work, so there is nothing to keep going on."
    );
    expect(continuationRefusal(0, 0, 30, 15)).toBe("There is no free time left before the next thing that can't move.");
  });
  it("names the free window when that is what bit", () => {
    expect(continuationRefusal(10, 10, 30, 15)).toBe("Only 10 minutes are free before the next thing that can't move.");
  });
  it("names the work's minimum when the window was not the short one", () => {
    expect(continuationRefusal(10, 60, 10, 15)).toBe(
      "Only 10 minutes are available, and this work needs at least 15 to be worth picking up again."
    );
  });
});

describe("limitNote", () => {
  const action = { maximumSessionMinutes: 90, remainingMinutes: 40 };
  it("is empty when nothing was asked or the ask was met", () => {
    expect(limitNote(undefined, 30, action, 120)).toBe("");
    expect(limitNote(30, 30, action, 120)).toBe("");
  });
  it("names the bound that capped the figure", () => {
    expect(limitNote(60, 15, action, 15)).toContain("free before the next thing that can't move");
    expect(limitNote(60, 40, action, 120)).toContain("40 minutes of work are left");
    expect(limitNote(120, 90, { maximumSessionMinutes: 90, remainingMinutes: 200 }, 300)).toContain("capped at 90");
    expect(limitNote(60, 30, { maximumSessionMinutes: 90, remainingMinutes: 200 }, 300)).toContain(
      "more urgent project"
    );
  });
});
