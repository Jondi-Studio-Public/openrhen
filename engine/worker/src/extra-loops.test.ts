import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";
import { extraLoopSteps, registerExtraLoop } from "./extra-loops.js";

const context = {
  portalInternalUrl: undefined,
  workerId: "w",
  portalHeaders: () => ({}),
  positiveInteger: (_value: string | undefined, fallback: number) => fallback,
  sql: {} as Sql,
  ownerTimezone: async () => "UTC",
  configuredLocalTime: (_name: string, fallback: string) => fallback
};

describe("extra worker loops", () => {
  it("builds one step per registered loop and ignores a repeated name", async () => {
    let built = 0;
    registerExtraLoop({
      name: "example",
      create: () => {
        built += 1;
        return { name: "example", run: async () => "idle" };
      }
    });
    registerExtraLoop({ name: "example", create: () => ({ name: "dup", run: async () => "x" }) });
    const steps = extraLoopSteps(context).filter((step) => step.name === "example" || step.name === "dup");
    expect(steps.map((step) => step.name)).toEqual(["example"]);
    expect(built).toBe(1);
  });
});
