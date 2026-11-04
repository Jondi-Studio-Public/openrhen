import { describe, expect, it } from "vitest";
import { nextDaytimeDelivery } from "./push-timing.js";

const SEED_ZONE = "Australia/Sydney";

describe("nextDaytimeDelivery", () => {
  it("holds a push queued in the night until that morning's wake time", () => {
    // 03:30 in the seed zone (AEDT, +11:00) on 28 Oct; wake 07:15 the same morning.
    const at = nextDaytimeDelivery(new Date("2026-10-27T16:30:00Z"), SEED_ZONE, "07:15:00", "22:00:00");
    expect(at.toISOString()).toBe("2026-10-27T20:15:00.000Z");
  });

  it("sends at once during the day", () => {
    const now = new Date("2026-10-28T01:00:00Z"); // 12:00 in the seed zone
    expect(nextDaytimeDelivery(now, SEED_ZONE, "07:15:00", "22:00:00")).toEqual(now);
  });

  it("holds a late-evening push for the next morning", () => {
    // 23:00 on 28 Oct in the seed zone; wake 07:15 on 29 Oct.
    const at = nextDaytimeDelivery(new Date("2026-10-28T12:00:00Z"), SEED_ZONE, "07:15", "22:00");
    expect(at.toISOString()).toBe("2026-10-28T20:15:00.000Z");
  });

  it("falls back to 08:00 and 22:00 with nothing stored", () => {
    const at = nextDaytimeDelivery(new Date("2026-10-27T16:30:00Z"), SEED_ZONE, null, null);
    expect(at.toISOString()).toBe("2026-10-27T21:00:00.000Z");
  });

  it("uses the offset of the wake day when the clocks change overnight", () => {
    // seed-zone moves to AEDT at 02:00 on 4 Oct 2026; 01:30 AEST (+10) that night, wake 07:00 AEDT (+11).
    const at = nextDaytimeDelivery(new Date("2026-10-03T15:30:00Z"), SEED_ZONE, "07:00", "22:00");
    expect(at.toISOString()).toBe("2026-10-03T20:00:00.000Z");
  });

  it("handles a night that starts after midnight", () => {
    // Wake 07:00, horizon end 00:30 (UTC for clarity): noon and 00:15 are day, 03:30 is night.
    const noon = new Date("2026-10-28T12:00:00Z");
    expect(nextDaytimeDelivery(noon, "UTC", "07:00", "00:30")).toEqual(noon);
    const quarterPast = new Date("2026-10-28T00:15:00Z");
    expect(nextDaytimeDelivery(quarterPast, "UTC", "07:00", "00:30")).toEqual(quarterPast);
    expect(nextDaytimeDelivery(new Date("2026-10-28T03:30:00Z"), "UTC", "07:00", "00:30").toISOString()).toBe(
      "2026-10-28T07:00:00.000Z"
    );
  });
});
