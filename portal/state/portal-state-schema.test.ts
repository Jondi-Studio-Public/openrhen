import { describe, expect, it } from "vitest";
import { portalStateSchema } from "@openrhen/contracts";
import { createSeedState } from "./portal-state";

describe("portal state API contract", () => {
  it("accepts a complete normalized portal state", () => {
    expect(portalStateSchema.safeParse(createSeedState(new Date("2026-08-08T08:00:00.000Z"))).success).toBe(true);
  });

  it("keeps the row version on projects and actions, which the portal sends back as the expected version", () => {
    const state = createSeedState(new Date("2026-08-08T08:00:00.000Z"));
    state.projects[0]!.version = 4;
    state.actions[0]!.version = 7;
    const result = portalStateSchema.parse(state);
    expect(result.projects[0]!.version).toBe(4);
    expect(result.actions[0]!.version).toBe(7);
  });

  it("rejects invalid scores and dangling dependencies before persistence", () => {
    const state = createSeedState(new Date("2026-08-08T08:00:00.000Z"));
    state.projects[0]!.consequence = 9;
    state.actions[0]!.dependencyIds = ["missing-action"];
    const result = portalStateSchema.safeParse(state);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.map((issue) => issue.message).join(" ")).toContain("invalid dependency");
  });
});
