import { describe, expect, it } from "vitest";
import { zonedDateTime } from "@openrhen/contracts";
import { assumedWakeAt } from "../../src/recurrence/sleep.js";

const SEED_ZONE = "Australia/Sydney";

describe("sleep planning resolves wall times the same way as zonedDateTime", () => {
  it("moves a spring-forward gap wake time to the same instant as zonedDateTime", () => {
    const now = new Date("2026-10-04T10:00:00.000Z");
    const wake = assumedWakeAt(now, SEED_ZONE, "02:30");
    expect(wake.toISOString()).toBe(zonedDateTime("2026-10-04", "02:30", SEED_ZONE).toISOString());
    expect(wake.toISOString()).toBe("2026-10-03T16:30:00.000Z");
  });

  it("resolves an ambiguous fall-back wake time to the same instant as zonedDateTime", () => {
    const now = new Date("2026-04-05T10:00:00.000Z");
    const wake = assumedWakeAt(now, SEED_ZONE, "02:30");
    expect(wake.toISOString()).toBe(zonedDateTime("2026-04-05", "02:30", SEED_ZONE).toISOString());
    expect(wake.toISOString()).toBe("2026-04-04T16:30:00.000Z");
  });

  it("uses the previous local day's resolution before today's wake time", () => {
    // 01:00 AEDT on Apr 5 is before that day's 02:30 wake, so the assumed wake is Apr 4's.
    const now = new Date("2026-04-04T14:00:00.000Z");
    expect(assumedWakeAt(now, SEED_ZONE, "02:30").toISOString()).toBe(
      zonedDateTime("2026-04-04", "02:30", SEED_ZONE).toISOString()
    );
  });
});
