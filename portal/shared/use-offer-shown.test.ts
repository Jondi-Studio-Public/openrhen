import { describe, expect, it } from "vitest";
import { shouldSendShown, shownKey, shownTargetFor } from "./use-offer-shown";

type Activity = Parameters<typeof shownTargetFor>[0];
type Primary = Parameters<typeof shownTargetFor>[1];

const primary = { action: { id: "action-1", title: "Write essay" } } as unknown as Primary;
const recommended = { kind: "recommended", candidate: primary } as unknown as Activity;
const commitment = {
  kind: "commitment",
  commitment: { id: "commitment-1", title: "Dentist" },
  protectedCommitment: {}
} as unknown as Activity;

describe("shownTargetFor", () => {
  it("shows the primary as itself, with nothing suppressed", () => {
    expect(shownTargetFor(recommended, primary)).toEqual({
      resolutionKind: "recommended",
      targetType: "action",
      targetId: "action-1",
      label: "Write essay"
    });
  });

  it("records the engine primary a commitment hides as suppressedBy", () => {
    expect(shownTargetFor(commitment, primary)).toEqual({
      resolutionKind: "commitment",
      targetType: "fixed_commitment",
      targetId: "commitment-1",
      label: "Dentist",
      suppressedBy: { targetType: "action", targetId: "action-1", label: "Write essay" }
    });
  });

  it("has no suppressedBy when the model has no primary, and maps free to a fixed target", () => {
    expect(shownTargetFor(commitment, null).suppressedBy).toBeUndefined();
    expect(shownTargetFor({ kind: "free" } as Activity, null)).toMatchObject({
      resolutionKind: "free",
      targetType: "none",
      targetId: "free"
    });
  });

  it("keys a travel leg by the commitment it leads to, as the started row does", () => {
    const leg = (then?: unknown) =>
      ({
        kind: "travel",
        directive: {
          kind: "travel",
          toLocationId: "campus",
          title: "Drive", // oxlint-disable-next-line unicorn/no-thenable -- `then` is a domain field of the travel directive, not a promise continuation
          ...(then ? { then } : {})
        }
      }) as unknown as Activity;
    expect(shownTargetFor(leg({ kind: "commitment", targetId: "commitment-1", title: "Lecture" }), null)).toMatchObject(
      {
        resolutionKind: "travel",
        targetType: "fixed_commitment",
        targetId: "commitment-1"
      }
    );
    expect(shownTargetFor(leg(), null)).toMatchObject({ targetType: "travel", targetId: "campus" });
  });

  it("names a session by its target, falling back to the action", () => {
    const session = { kind: "session", session: { actionId: "a-1", targetTitle: "Lab" } } as unknown as Activity;
    expect(shownTargetFor(session, null)).toMatchObject({ targetType: "action", targetId: "a-1", label: "Lab" });
    const routine = {
      kind: "session",
      session: { actionId: "", targetType: "routine_step", targetId: "step-1", targetTitle: "Pack" }
    } as unknown as Activity;
    expect(shownTargetFor(routine, null)).toMatchObject({ targetType: "routine_step", targetId: "step-1" });
  });
});

describe("shownKey and shouldSendShown", () => {
  it("keys on kind and target, not on label or what was suppressed", () => {
    const a = shownKey(shownTargetFor(commitment, primary));
    const b = shownKey({ ...shownTargetFor(commitment, null), label: "Renamed" });
    expect(a).toBe(b);
    expect(shownKey(shownTargetFor(recommended, primary))).not.toBe(a);
  });

  it("sends only while visible and only for a key that differs from the last sent", () => {
    const key = shownKey(shownTargetFor(recommended, primary));
    expect(shouldSendShown(key, null, true)).toBe(true);
    expect(shouldSendShown(key, null, false)).toBe(false);
    expect(shouldSendShown(key, key, true)).toBe(false);
    expect(shouldSendShown(key, "other", true)).toBe(true);
  });
});
