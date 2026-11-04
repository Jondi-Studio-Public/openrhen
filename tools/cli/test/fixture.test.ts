import { planningRuntimeStateSchema, portalStateSchema } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";
import { fixtureActiveSession, fixtureRawState, fixtureState, fixtureActiveSessionId } from "./fixture-state.js";

describe("fixture-state", () => {
  it("fixtureState() does not throw", () => {
    expect(() => fixtureState()).not.toThrow();
  });

  it("fixtureRawState() minus planning satisfies portalStateSchema", () => {
    const { planning, ...document } = fixtureRawState();
    void planning;
    const result = portalStateSchema.safeParse(document);
    expect(result.success, result.success ? "" : JSON.stringify(result.error?.issues)).toBe(true);
  });

  it("fixtureRawState().planning satisfies planningRuntimeStateSchema", () => {
    const raw = fixtureRawState();
    const result = planningRuntimeStateSchema.safeParse(raw.planning);
    expect(result.success, result.success ? "" : JSON.stringify(result.error?.issues)).toBe(true);
  });

  it("fixtureState(fixtureActiveSession()) has an active session on the draft", () => {
    const state = fixtureState(fixtureActiveSession());
    expect(state.activeSession?.id).toBe(fixtureActiveSessionId);
  });
});
