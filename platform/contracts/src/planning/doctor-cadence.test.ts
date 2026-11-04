import "../connections/example-sources.js";
import { describe, expect, it } from "vitest";
import { cadenceItems, type DoctorCadenceSlice } from "./doctor-cadence.js";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const empty: DoctorCadenceSlice = { cadences: [], recurring: [], syncs: [] };
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

const cadence = (last: string | undefined, intervalDays = 7) => ({
  id: "c1",
  title: "Gym",
  rule: {
    intervalDays,
    timezone: "Australia/Sydney",
    startDate: "2026-01-01",
    ...(last ? { lastCompletedLocalDate: last } : {})
  }
});

describe("cadenceItems", () => {
  it("is empty for nothing", () => expect(cadenceItems(empty, NOW)).toEqual([]));

  it("flags a cadence a whole cycle past its own next date", () => {
    const [item] = cadenceItems({ ...empty, cadences: [cadence("2026-10-01")] }, NOW);
    expect(item).toMatchObject({
      id: "cadence_overdue:c1",
      check: "cadence_overdue",
      tier: "degrading",
      area: "routines"
    });
    expect(item!.fix.who).toBe("person");
    expect(item!.handles).toEqual(["action:c1"]);
    expect(item!.title).toContain("every 7 days");
  });

  it("leaves a cadence that is due but not a cycle late, or not due", () => {
    expect(cadenceItems({ ...empty, cadences: [cadence("2026-10-20")] }, NOW)).toEqual([]);
    expect(cadenceItems({ ...empty, cadences: [cadence("2026-10-29")] }, NOW)).toEqual([]);
  });

  it("honours a period rule: target met this period is not due", () => {
    const rule = {
      intervalDays: 1,
      timezone: "UTC",
      startDate: "2026-01-01",
      period: { unit: "month" as const },
      targetOccurrences: 1,
      lastCompletedLocalDate: "2026-10-05",
      completionLocalDates: ["2026-10-05"]
    };
    expect(cadenceItems({ ...empty, cadences: [{ id: "m", title: "Bills", rule }] }, NOW)).toEqual([]);
  });

  it("flags three misses in a row, newest first", () => {
    const runs = (...statuses: string[]) => ({
      id: "r1",
      title: "Stretch",
      recent: statuses.map((status, i) => ({ localDate: `2026-10-${String(28 - i).padStart(2, "0")}`, status }))
    });
    const [item] = cadenceItems({ ...empty, recurring: [runs("missed", "missed", "missed", "completed")] }, NOW);
    expect(item).toMatchObject({ id: "routine_missed:r1", check: "routine_missed", since: "2026-10-26T00:00:00.000Z" });
    expect(item!.title).toContain("3 times");
    expect(cadenceItems({ ...empty, recurring: [runs("missed", "missed", "completed", "missed")] }, NOW)).toEqual([]);
    expect(cadenceItems({ ...empty, recurring: [runs("completed", "missed", "missed", "missed")] }, NOW)).toEqual([]);
  });

  it("flags a successful sync older than its cadence, status only", () => {
    const sync = (provider: string, h: number, lastRunStatus = "synced") => ({
      provider,
      lastRunStatus,
      lastRunAt: hoursAgo(h),
      lastSuccessAt: hoursAgo(h)
    });
    const items = cadenceItems(
      {
        ...empty,
        syncs: [
          sync("google_calendar", 5),
          sync("example_daily", 30),
          sync("example_shared", 1),
          sync("example_daily", 90, "failed")
        ]
      },
      NOW
    );
    expect(items.map((i) => i.id).sort()).toEqual(["sync_late:google_calendar"]);
    expect(items[0]).toMatchObject({ tier: "degrading", area: "integrations" });
    expect(items[0]!.fix.who).toBe("person");
  });
});
