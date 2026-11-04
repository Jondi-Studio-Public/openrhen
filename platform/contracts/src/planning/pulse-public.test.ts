import { describe, expect, it } from "vitest";
import { localMidnightUtc, publicPulse, publicPulseV1Schema, pulseShares, type PulseSegment } from "./pulse-public.js";

const TZ = "America/New_York";

function seg(startedAt: string, endedAt: string | null, state: PulseSegment["state"]): PulseSegment {
  return { startedAt: new Date(startedAt), endedAt: endedAt ? new Date(endedAt) : null, state };
}

describe("localMidnightUtc", () => {
  it("finds local midnight in a fixed offset zone", () => {
    const midnight = localMidnightUtc(new Date("2026-09-26T14:00:00.000Z"), TZ);
    // 2026-09-26 is EDT (UTC-4): local midnight is 04:00 UTC.
    expect(midnight.toISOString()).toBe("2026-09-26T04:00:00.000Z");
  });

  it("crosses a DST transition correctly", () => {
    // 2026-11-01 is EST (UTC-5) in New York after the fall-back.
    const midnight = localMidnightUtc(new Date("2026-11-02T12:00:00.000Z"), TZ);
    expect(midnight.toISOString()).toBe("2026-11-02T05:00:00.000Z");
  });
});

describe("pulseShares", () => {
  it("computes on/(on+off) as a whole percent, rounded half-up", () => {
    const now = new Date("2026-09-26T14:00:00.000Z");
    const segments: PulseSegment[] = [
      seg("2026-09-26T04:00:00.000Z", "2026-09-26T10:00:00.000Z", "on"),
      seg("2026-09-26T10:00:00.000Z", "2026-09-26T14:00:00.000Z", "off")
    ];
    const shares = pulseShares(segments, now, TZ);
    // 6h on, 4h off => 60%
    expect(shares.today.onPercent).toBe(60);
    expect(shares.today.countedMinutes).toBe(600);
  });

  it("excludes free, asleep and gap segments from both numerator and denominator", () => {
    const now = new Date("2026-09-26T14:00:00.000Z");
    const segments: PulseSegment[] = [
      seg("2026-09-26T04:00:00.000Z", "2026-09-26T08:00:00.000Z", "asleep"),
      seg("2026-09-26T08:00:00.000Z", "2026-09-26T10:00:00.000Z", "on"),
      seg("2026-09-26T10:00:00.000Z", "2026-09-26T11:00:00.000Z", "free"),
      seg("2026-09-26T11:00:00.000Z", "2026-09-26T12:00:00.000Z", "gap"),
      seg("2026-09-26T12:00:00.000Z", "2026-09-26T14:00:00.000Z", "off")
    ];
    const shares = pulseShares(segments, now, TZ);
    // Counted: 2h on + 2h off = 4h = 240 minutes; on% = 50
    expect(shares.today.countedMinutes).toBe(240);
    expect(shares.today.onPercent).toBe(50);
  });

  it("returns null onPercent below the 15-minute floor", () => {
    const now = new Date("2026-09-26T04:05:00.000Z");
    const segments: PulseSegment[] = [seg("2026-09-26T04:00:00.000Z", null, "on")];
    const shares = pulseShares(segments, now, TZ);
    expect(shares.today.countedMinutes).toBe(5);
    expect(shares.today.onPercent).toBeNull();
  });

  it("clips an open segment to now and a window to its start", () => {
    const now = new Date("2026-09-26T14:00:00.000Z");
    const segments: PulseSegment[] = [seg("2026-09-01T00:00:00.000Z", null, "on")];
    const days7 = pulseShares(segments, now, TZ).days7;
    expect(days7.countedMinutes).toBe(7 * 24 * 60);
    expect(days7.onPercent).toBe(100);
  });

  it("today, days7 and days30 windows differ", () => {
    const now = new Date("2026-09-26T14:00:00.000Z");
    const segments: PulseSegment[] = [seg("2026-09-01T00:00:00.000Z", null, "off")];
    const shares = pulseShares(segments, now, TZ);
    expect(shares.today.countedMinutes).toBeLessThan(shares.days7.countedMinutes);
    expect(shares.days7.countedMinutes).toBeLessThan(shares.days30.countedMinutes);
  });
});

describe("publicPulse", () => {
  const now = new Date("2026-09-26T14:00:00.000Z");
  const shares = pulseShares([], now, TZ);

  it("includes doing when on plan and not private", () => {
    const pulse = publicPulse(
      { state: "on", doing: { kind: "action", id: "a1", title: "Sort the bedroom floor" }, private: false },
      new Date("2026-09-26T13:00:00.000Z"),
      shares,
      1,
      now
    );
    expect(pulse.doing).toEqual({ kind: "action", title: "Sort the bedroom floor" });
    expect(pulse.private).toBe(false);
  });

  it("omits doing and any id when private, but state is still on", () => {
    const pulse = publicPulse(
      { state: "on", doing: { kind: "commitment", id: "c1", title: "Therapy" }, private: true },
      new Date("2026-09-26T13:00:00.000Z"),
      shares,
      1,
      now
    );
    expect(pulse.state).toBe("on");
    expect(pulse.private).toBe(true);
    expect(pulse.doing).toBeUndefined();
    expect(JSON.stringify(pulse)).not.toContain("Therapy");
    expect(JSON.stringify(pulse)).not.toContain("c1");
  });

  it("truncates a long title to 60 characters", () => {
    const longTitle = "x".repeat(120);
    const pulse = publicPulse(
      { state: "on", doing: { kind: "action", id: "a1", title: longTitle }, private: false },
      now,
      shares,
      1,
      now
    );
    expect(pulse.doing?.title.length).toBe(60);
  });

  it("omits doing when off, free or asleep", () => {
    for (const state of ["off", "free", "asleep"] as const) {
      const pulse = publicPulse({ state, private: false }, now, shares, 1, now);
      expect(pulse.doing).toBeUndefined();
    }
  });

  it("carries no ids, locations, segments or reasons anywhere in the object", () => {
    const pulse = publicPulse(
      { state: "on", doing: { kind: "commitment", id: "secret-id", title: "Doctor" }, private: false },
      now,
      shares,
      1,
      now
    );
    const json = JSON.stringify(pulse);
    expect(json).not.toContain("secret-id");
    expect(json).not.toContain("reason");
  });
});

describe("publicPulseV1Schema", () => {
  const now = new Date("2026-09-26T14:00:00.000Z");
  const shares = pulseShares([], now, TZ);

  it("accepts a well-formed object", () => {
    const pulse = publicPulse(
      { state: "on", doing: { kind: "action", id: "a1", title: "Sort the bedroom floor" }, private: false },
      now,
      shares,
      1,
      now
    );
    expect(publicPulseV1Schema.safeParse(pulse).success).toBe(true);
  });

  it("refuses an extra top-level field", () => {
    const pulse = publicPulse({ state: "free", private: false }, now, shares, 1, now);
    const result = publicPulseV1Schema.safeParse({ ...pulse, location: "Home" });
    expect(result.success).toBe(false);
  });

  it("refuses an extra field nested inside doing", () => {
    const pulse = publicPulse(
      { state: "on", doing: { kind: "action", id: "a1", title: "Sort the bedroom floor" }, private: false },
      now,
      shares,
      1,
      now
    );
    const result = publicPulseV1Schema.safeParse({ ...pulse, doing: { ...pulse.doing, id: "a1" } });
    expect(result.success).toBe(false);
  });

  it("refuses a v other than 1", () => {
    const pulse = publicPulse({ state: "free", private: false }, now, shares, 1, now);
    expect(publicPulseV1Schema.safeParse({ ...pulse, v: 2 }).success).toBe(false);
  });
});

describe("unknown (the state machine's contact axis)", () => {
  it("leaves unknown time out of both numerator and denominator, like a gap", () => {
    const now = new Date("2026-09-26T14:00:00.000Z");
    const segments: PulseSegment[] = [
      seg("2026-09-26T08:00:00.000Z", "2026-09-26T10:00:00.000Z", "on"),
      seg("2026-09-26T10:00:00.000Z", "2026-09-26T12:00:00.000Z", "unknown"),
      seg("2026-09-26T12:00:00.000Z", "2026-09-26T14:00:00.000Z", "off")
    ];
    const shares = pulseShares(segments, now, TZ);
    expect(shares.today.countedMinutes).toBe(240);
    expect(shares.today.onPercent).toBe(50);
  });

  it("publishes unknown as unknown, with no doing, and the strict schema accepts it", () => {
    const now = new Date("2026-09-26T14:00:00.000Z");
    const shares = pulseShares([], now, TZ);
    const pulse = publicPulse(
      { state: "unknown", doing: { kind: "action", id: "a1", title: "Write" }, private: false },
      now,
      shares,
      1,
      now
    );
    expect(pulse.state).toBe("unknown");
    expect(pulse.doing).toBeUndefined();
    expect(publicPulseV1Schema.safeParse(pulse).success).toBe(true);
  });

  it("still refuses a state the contract does not name", () => {
    const now = new Date("2026-09-26T14:00:00.000Z");
    const pulse = publicPulse({ state: "on", private: false }, now, pulseShares([], now, TZ), 1, now);
    expect(publicPulseV1Schema.safeParse({ ...pulse, state: "lapsed" }).success).toBe(false);
  });
});
