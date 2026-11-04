import { describe, expect, it } from "vitest";
import { clampHorizonOverride, nextPlanningWake } from "./planning-day";

// seed-zone, UTC+10 on 17 August 2026 (no DST). 05:00 local is 19:00Z the day before.
const overnight = { timezone: "Australia/Sydney", preferredWakeTime: "07:00", planningHorizonEnd: "00:30" };
const evening = { ...overnight, planningHorizonEnd: "22:00" };

describe("nextPlanningWake", () => {
  it("is this morning's wake for an overnight end until that wake, then tomorrow's", () => {
    // 05:00 and 06:59 on the 17th still belong to the day that began on the 16th.
    expect(nextPlanningWake(new Date("2026-08-16T19:00:00.000Z"), overnight).toISOString()).toBe(
      "2026-08-16T21:00:00.000Z"
    );
    expect(nextPlanningWake(new Date("2026-08-16T20:59:00.000Z"), overnight).toISOString()).toBe(
      "2026-08-16T21:00:00.000Z"
    );
    expect(nextPlanningWake(new Date("2026-08-16T21:00:00.000Z"), overnight).toISOString()).toBe(
      "2026-08-17T21:00:00.000Z"
    );
    // Just after midnight the day in progress is still yesterday's.
    expect(nextPlanningWake(new Date("2026-08-16T14:10:00.000Z"), overnight).toISOString()).toBe(
      "2026-08-16T21:00:00.000Z"
    );
  });

  it("is tomorrow's wake for an ordinary evening end", () => {
    expect(nextPlanningWake(new Date("2026-08-17T11:00:00.000Z"), evening).toISOString()).toBe(
      "2026-08-17T21:00:00.000Z"
    );
    expect(nextPlanningWake(new Date("2026-08-16T19:00:00.000Z"), evening).toISOString()).toBe(
      "2026-08-17T21:00:00.000Z"
    );
  });

  it("reads a database time value with seconds, and a missing wake as midnight", () => {
    expect(
      nextPlanningWake(new Date("2026-08-17T11:00:00.000Z"), {
        ...evening,
        preferredWakeTime: "07:00:00"
      }).toISOString()
    ).toBe("2026-08-17T21:00:00.000Z");
    expect(
      nextPlanningWake(new Date("2026-08-17T11:00:00.000Z"), { ...evening, preferredWakeTime: null }).toISOString()
    ).toBe("2026-08-17T14:00:00.000Z");
  });

  it("places a wake inside a spring-forward gap where the engine does, past the gap", () => {
    // seed-zone 2026-10-04: 02:00 AEST jumps to 03:00 AEDT, so a 02:30 wake never occurs. `zonedDateTime` in
    // engine/core resolves it to 03:30 AEDT (2026-10-03T16:30Z); the portal's `zonedWallTimeOnDay` settles
    // on 01:30 AEST (15:30Z), which would clamp "work later" an hour before the planning day ends.
    const gap = { timezone: "Australia/Sydney", preferredWakeTime: "02:30", planningHorizonEnd: "01:00" };
    // 01:15 AEST on the 4th (14:15Z on the 3rd): overnight end, so the day in progress ends at the wake.
    expect(nextPlanningWake(new Date("2026-10-03T14:15:00.000Z"), gap).toISOString()).toBe("2026-10-03T16:30:00.000Z");
    // That evening (21:00 on the 3rd), an evening end rolls to the wake on the 4th, resolved the same way.
    expect(
      nextPlanningWake(new Date("2026-10-03T11:00:00.000Z"), { ...gap, planningHorizonEnd: "22:00" }).toISOString()
    ).toBe("2026-10-03T16:30:00.000Z");
  });

  it("keeps a promised extension's night active past midnight, so its next wake is this morning's", () => {
    // 22:00 end, 07:00 wake. At 00:15 on the 18th (14:15Z on the 17th) the 17th's row promises 00:30.
    const at = new Date("2026-08-17T14:15:00.000Z");
    const held = { localDate: "2026-08-17", horizonOverrideAt: "2026-08-17T14:30:00.000Z" };
    expect(nextPlanningWake(at, evening, held).toISOString()).toBe("2026-08-17T21:00:00.000Z");
    // Nothing promised, or the promise has passed: the calendar's day, whose wake is tomorrow's.
    expect(nextPlanningWake(at, evening).toISOString()).toBe("2026-08-18T21:00:00.000Z");
    expect(nextPlanningWake(new Date("2026-08-17T14:45:00.000Z"), evening, held).toISOString()).toBe(
      "2026-08-18T21:00:00.000Z"
    );
    // The evening before, 23:30 on the 17th, the wake is already this coming morning's.
    expect(nextPlanningWake(new Date("2026-08-17T13:30:00.000Z"), evening, null).toISOString()).toBe(
      "2026-08-17T21:00:00.000Z"
    );
  });

  it("follows the wall clock across a DST change", () => {
    // Spring forward Sunday 2026-10-04 02:00: 05:00 AEDT that morning, wake 07:00 AEDT is 20:00Z the day before.
    expect(nextPlanningWake(new Date("2026-10-03T18:00:00.000Z"), overnight).toISOString()).toBe(
      "2026-10-03T20:00:00.000Z"
    );
  });
});

describe("clampHorizonOverride", () => {
  it("holds a 05:00 '+3 hours' to the 07:00 wake", () => {
    const now = new Date("2026-08-16T19:00:00.000Z");
    const threeHours = new Date(now.getTime() + 3 * 60 * 60_000);
    expect(clampHorizonOverride(threeHours, now, overnight).toISOString()).toBe("2026-08-16T21:00:00.000Z");
  });

  it("leaves an extension that fits untouched", () => {
    const now = new Date("2026-08-16T19:00:00.000Z");
    const oneHour = new Date(now.getTime() + 60 * 60_000);
    expect(clampHorizonOverride(oneHour, now, overnight)).toEqual(oneHour);
    const lateEvening = new Date("2026-08-17T14:00:00.000Z");
    expect(clampHorizonOverride(lateEvening, new Date("2026-08-17T11:30:00.000Z"), evening)).toEqual(lateEvening);
  });
});
