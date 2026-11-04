import { describe, expect, it } from "vitest";
import { overCapMessage, overPendingCap } from "./cap";

describe("pending cap", () => {
  it("allows up to 49 pending and refuses the 51st", () => {
    expect(overPendingCap(49)).toBe(false);
    expect(overPendingCap(50)).toBe(true);
    expect(overPendingCap(3, 3)).toBe(true);
  });
  it("says which agent is over and that nothing was recorded", () => {
    expect(overCapMessage("scribe")).toContain('"scribe"');
    expect(overCapMessage("scribe")).toContain("Nothing was recorded");
  });
});
