import { describe, expect, it } from "vitest";
import { criticalTierLabel } from "./critical-tiers";

describe("criticalTierLabel", () => {
  it("shows nothing for ordinary or absent tiers", () => {
    expect(criticalTierLabel("ordinary")).toBeNull();
    expect(criticalTierLabel(undefined)).toBeNull();
  });

  it("reads a stored pre-rename renegotiate tier as the stale-date label", () => {
    expect(criticalTierLabel("renegotiate")).toBe(criticalTierLabel("stale_date"));
    expect(criticalTierLabel("stale_date")).toContain("lapsed");
  });
});
