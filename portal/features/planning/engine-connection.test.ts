import { describe, expect, it } from "vitest";
import type { PlanningRuntimeState } from "@openrhen/contracts";
import { engineConnectionView } from "./engine-connection";

describe("Plan and Forecast Engine connection view", () => {
  it.each([
    ["current", "Connected", "connected"],
    ["pending", "Updating", "waiting"],
    ["stale", "Stale", "waiting"],
    ["unavailable", "Unavailable", "waiting"],
    ["failed", "Failed", "failed"]
  ] as const)("maps %s runtime state", (status, label, tone) => {
    expect(engineConnectionView({ status } as PlanningRuntimeState)).toMatchObject({ label, tone });
  });

  it("distinguishes a pending refresh from a pending first result", () => {
    expect(engineConnectionView({ status: "pending", result: {} } as PlanningRuntimeState).summary).toContain(
      "previous engine result"
    );
    expect(engineConnectionView({ status: "pending" }).summary).toContain("first engine calculation");
  });
});
