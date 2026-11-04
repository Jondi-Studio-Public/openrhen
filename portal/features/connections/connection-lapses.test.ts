import { EXAMPLE_SHARED } from "@/test/example-calendar-sources";
import { connectionManifest, primarySourceConnection } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";
import { deriveLapses, rosterStaleLine } from "./connection-lapses";

// The primary (roster) source and a secondary source, whichever this build registers.
const primary = primarySourceConnection()!;
const secondary = connectionManifest(EXAMPLE_SHARED)!;

const failed = (reason?: string) => ({ lastRun: { status: "failed", summary: reason ? { reason } : null } });
const ok = { lastRun: { status: "synced" } };

describe("deriveLapses", () => {
  it("flags a connection whose last recorded run failed, and words a lapsed roster sign-in", () => {
    const result = deriveLapses({
      [primary.id]: failed("session_expired"),
      [secondary.id]: failed(),
      google_calendar: ok
    });
    expect(result.lapsed.map((item) => item.label)).toEqual([
      `${primary.label} roster hasn't synced lately`,
      `${secondary.label} hasn't synced lately`
    ]);
  });

  it("names the date of the last good sync when one is recorded", () => {
    const result = deriveLapses({ [primary.id]: { ...failed(), lastSuccessAt: "2026-10-19T04:00:00.000Z" } });
    expect(result.lapsed[0]?.label).toBe(`${primary.label} roster hasn't synced since 19 Oct`);
  });

  it("does not flag working, switched-off, unread or never-run connections", () => {
    const result = deriveLapses({
      [primary.id]: ok,
      [secondary.id]: { enabled: false, ...failed() },
      google_calendar: undefined
    });
    expect(result.lapsed).toEqual([]);
    expect(deriveLapses({ [primary.id]: { lastRun: null } }).lapsed).toEqual([]);
  });

  it("carries the roster's last good sync", () => {
    expect(
      deriveLapses({ [primary.id]: { ...failed(), lastSuccessAt: "2026-10-01T00:00:00.000Z" } }).rosterSyncedAt
    ).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("roster age", () => {
  it("is carried only when the last roster run was synced, needs_review or failed", () => {
    const old = "2026-10-01T00:00:00.000Z";
    for (const status of ["synced", "needs_review", "failed"])
      expect(deriveLapses({ [primary.id]: { lastRun: { status }, lastSuccessAt: old } }).rosterSyncedAt).toBe(old);
    for (const status of ["not_configured", "disabled"])
      expect(deriveLapses({ [primary.id]: { lastRun: { status }, lastSuccessAt: old } }).rosterSyncedAt).toBeNull();
    expect(deriveLapses({ [primary.id]: { lastRun: null, lastSuccessAt: old } }).rosterSyncedAt).toBeNull();
  });
});

describe("roster history ended", () => {
  const oldest = new Date(Date.now() - 88 * 86_400_000).toISOString();
  it("is set when every run on record failed and the oldest is at the retention edge", () => {
    expect(
      deriveLapses({ [primary.id]: { ...failed(), lastSuccessAt: null, oldestRunAt: oldest } }).rosterHistoryDays
    ).toBe(88);
  });
  it("is not set for a roster that simply started failing recently, or has a good run", () => {
    const recent = new Date(Date.now() - 3 * 86_400_000).toISOString();
    expect(
      deriveLapses({ [primary.id]: { ...failed(), lastSuccessAt: null, oldestRunAt: recent } }).rosterHistoryDays
    ).toBeNull();
    expect(
      deriveLapses({ [primary.id]: { ...failed(), lastSuccessAt: "2026-10-01T00:00:00.000Z", oldestRunAt: oldest } })
        .rosterHistoryDays
    ).toBeNull();
  });
  it("words the line from the age of the oldest run when there is no date to give", () => {
    expect(rosterStaleLine(null, new Date(), 88)).toBe("Roster hasn't synced in over 88 days");
    expect(rosterStaleLine(null, new Date(), null)).toBeNull();
  });
});

describe("rosterStaleLine", () => {
  const now = new Date("2026-10-28T00:00:00.000Z");
  it("speaks only once the last good sync is more than two days old", () => {
    expect(rosterStaleLine("2026-10-26T12:00:00.000Z", now)).toBeNull();
    expect(rosterStaleLine("2026-10-26T00:00:00.000Z", now)).toBeNull();
    expect(rosterStaleLine("2026-10-25T23:00:00.000Z", now)).toBe("Roster last synced 2 days ago");
    expect(rosterStaleLine("2026-10-19T00:00:00.000Z", now)).toBe("Roster last synced 9 days ago");
  });
  it("says nothing when no good sync is known or the date is unreadable", () => {
    expect(rosterStaleLine(null, now)).toBeNull();
    expect(rosterStaleLine("nope", now)).toBeNull();
  });
});
