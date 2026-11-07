import { describe, expect, it } from "vitest";
import { shownTargetFor } from "@openrhen/contracts";
import { shouldSendShown, shownKey, SHOWN_SETTLE_MS } from "./use-offer-shown";

type Activity = Parameters<typeof shownTargetFor>[0];
type Primary = Parameters<typeof shownTargetFor>[1];

const primary = { action: { id: "action-1", title: "Write essay" } } as unknown as Primary;
const recommended = { kind: "recommended", candidate: primary } as unknown as Activity;
const commitment = {
  kind: "commitment",
  commitment: { id: "commitment-1", title: "Dentist" },
  protectedCommitment: {}
} as unknown as Activity;

describe("shownKey and shouldSendShown", () => {
  it("keys on kind and target, not on label or what was suppressed", () => {
    const a = shownKey(shownTargetFor(commitment, primary));
    const b = shownKey({ ...shownTargetFor(commitment, null), label: "Renamed" });
    expect(a).toBe(b);
    expect(shownKey(shownTargetFor(recommended, primary))).not.toBe(a);
  });

  it("waits a couple of seconds for a resolution to settle", () => {
    expect(SHOWN_SETTLE_MS).toBeGreaterThanOrEqual(1000);
  });

  it("sends only while visible and only for a key that differs from the last sent", () => {
    const key = shownKey(shownTargetFor(recommended, primary));
    expect(shouldSendShown(key, null, true)).toBe(true);
    expect(shouldSendShown(key, null, false)).toBe(false);
    expect(shouldSendShown(key, key, true)).toBe(false);
    expect(shouldSendShown(key, "other", true)).toBe(true);
  });
});
