import { describe, expect, it } from "vitest";
import type { StoredProject } from "@/state/portal-state";
import { isStaleProject, overdueSeenThisWeek } from "./stale-projects";

const now = new Date("2026-10-28T00:00:00.000Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60_000).toISOString();
const project = (fields: Partial<StoredProject>) =>
  ({ id: "p", status: "active", title: "P", ...fields }) as unknown as StoredProject;

describe("isStaleProject", () => {
  it("is stale when active with neither work nor a keep recorded", () => {
    expect(isStaleProject(project({}), now)).toBe(true);
  });

  it("is stale when work is over seven days old and the keep is over 30 days old", () => {
    expect(isStaleProject(project({ lastWorkedAt: daysAgo(9), lastReviewedAt: daysAgo(31) }), now)).toBe(true);
  });

  it("is not stale when worked on in the last seven days", () => {
    expect(isStaleProject(project({ lastWorkedAt: daysAgo(3) }), now)).toBe(false);
  });

  it("stays kept for 30 days, however long since it was worked", () => {
    expect(isStaleProject(project({ lastWorkedAt: daysAgo(40), lastReviewedAt: daysAgo(2) }), now)).toBe(false);
    expect(isStaleProject(project({ lastReviewedAt: daysAgo(10) }), now)).toBe(false);
    expect(isStaleProject(project({ lastReviewedAt: daysAgo(29) }), now)).toBe(false);
  });

  it("comes back once the keep ages past 30 days", () => {
    expect(isStaleProject(project({ lastWorkedAt: daysAgo(40), lastReviewedAt: daysAgo(30.5) }), now)).toBe(true);
  });

  it("is never stale while it is a focus project", () => {
    expect(isStaleProject(project({ id: "f" }), now, new Set(["f"]))).toBe(false);
    expect(isStaleProject(project({ id: "g" }), now, new Set(["f"]))).toBe(true);
  });

  it("is never stale unless active", () => {
    expect(isStaleProject(project({ status: "paused" }), now)).toBe(false);
  });
});

describe("overdueSeenThisWeek", () => {
  const seedZone = "Australia/Sydney";
  it("counts a Seen pressed on or after the week's Monday", () => {
    expect(overdueSeenThisWeek(project({ overdueSeenAt: "2026-10-26T00:30:00.000Z" }), "2026-10-26", seedZone)).toBe(
      true
    );
    expect(overdueSeenThisWeek(project({ overdueSeenAt: "2026-10-27T10:00:00.000Z" }), "2026-10-26", seedZone)).toBe(
      true
    );
  });

  it("asks again in a new week, and when it was never pressed", () => {
    expect(overdueSeenThisWeek(project({ overdueSeenAt: "2026-10-24T10:00:00.000Z" }), "2026-10-26", seedZone)).toBe(
      false
    );
    expect(overdueSeenThisWeek(project({}), "2026-10-26", seedZone)).toBe(false);
  });

  it("reads the day in the person's time zone", () => {
    // 13:30 UTC on Sunday 25 Oct is 00:30 Monday 26 Oct in the seed zone.
    expect(overdueSeenThisWeek(project({ overdueSeenAt: "2026-10-25T13:30:00.000Z" }), "2026-10-26", seedZone)).toBe(
      true
    );
  });
});
