import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { areaBalance } from "./area-balance";

const seed = createSeedState(new Date("2026-09-15T00:00:00.000Z"));

describe("areaBalance", () => {
  it("sums recorded minutes into each project's area, busiest first, with its share", () => {
    const rows = areaBalance(seed, [
      { projectId: "networking-assignment", minutes: 90 },
      { projectId: "clean-room", minutes: 30 }
    ]);
    expect(rows.map((row) => [row.areaId, row.recordedMinutes, row.share])).toEqual([
      ["area-study", 90, 0.75],
      ["area-home", 30, 0.25]
    ]);
    expect(rows.every((row) => !row.neglected)).toBe(true);
  });

  it("flags an active area with live work but no recorded time as neglected", () => {
    const rows = areaBalance(seed, [{ projectId: "networking-assignment", minutes: 60 }]);
    const home = rows.find((row) => row.areaId === "area-home")!;
    expect(home).toMatchObject({ recordedMinutes: 0, share: 0, activeOutcomes: 1, activeProjects: 1, neglected: true });
  });

  it("does not flag an empty area, and leaves inactive areas out", () => {
    const state = {
      ...seed,
      areas: [
        ...seed.areas,
        { id: "area-empty", name: "Empty", status: "active" as const, sortOrder: 2 },
        { id: "area-old", name: "Old", status: "archived" as const, sortOrder: 3 }
      ]
    };
    const rows = areaBalance(state, []);
    expect(rows.find((row) => row.areaId === "area-empty")?.neglected).toBe(false);
    expect(rows.some((row) => row.areaId === "area-old")).toBe(false);
  });

  it("puts time on an unknown project in an Unassigned row rather than dropping it", () => {
    const rows = areaBalance(seed, [{ projectId: "gone", minutes: 45 }]);
    expect(rows[0]).toMatchObject({ areaId: "unassigned", recordedMinutes: 45, share: 1 });
  });
});
