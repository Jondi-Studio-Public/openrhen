import { describe, expect, it } from "vitest";
import { continuationRefusal } from "../../src/recommendation/continuation.js";

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
