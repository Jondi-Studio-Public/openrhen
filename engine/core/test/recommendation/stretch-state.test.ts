import { describe, expect, it } from "vitest";
import type { StretchState } from "@openrhen/contracts";
import { resolveStretchState } from "../../src/recommendation/stretch.js";

/** Stored stretch answers to engine arguments (low-energy deadlines design, PR 3). */

const EAST = "Australia/Sydney";
const NY = "America/New_York";
const iso = (value: string) => new Date(value).toISOString();
const record = (over: Partial<{ actionId: string; acceptedAt: string; until: string }> = {}) => ({
  actionId: "unit-3",
  title: "Unit 3",
  acceptedAt: iso("2026-08-07T10:00:00Z"),
  until: iso("2026-08-07T10:40:00Z"),
  minutes: 40,
  by: "person" as const,
  ...over
});
const resolve = (
  stretch: StretchState | undefined,
  over: Partial<Parameters<typeof resolveStretchState>[0]> & { energySetAt?: string } = {}
) => {
  const { energySetAt = iso("2026-08-07T09:00:00Z"), ...rest } = over;
  return resolveStretchState({
    situation: { energySetAt, stretch },
    now: new Date("2026-08-07T10:20:00Z"),
    timeZone: "UTC",
    energyFresh: true,
    ...rest
  });
};

describe("resolveStretchState accepted records", () => {
  it("waives an active record and reports its end", () => {
    const out = resolve({ accepted: [record()], declined: [] });
    expect(out.energyWaivedActionIds).toEqual(["unit-3"]);
    expect(out.energyWaivedUntil["unit-3"]!.toISOString()).toBe("2026-08-07T10:40:00.000Z");
  });

  it("is inactive at now == until and after", () => {
    const at = (now: string) => resolve({ accepted: [record()], declined: [] }, { now: new Date(now) });
    expect(at("2026-08-07T10:39:59.999Z").energyWaivedActionIds).toEqual(["unit-3"]);
    expect(at("2026-08-07T10:40:00.000Z").energyWaivedActionIds).toEqual([]);
    expect(at("2026-08-07T11:00:00.000Z").energyWaivedActionIds).toEqual([]);
  });

  it("ends when energy was declared after the acceptance, but not at the same instant", () => {
    const stretch = { accepted: [record()], declined: [] };
    expect(resolve(stretch, { energySetAt: iso("2026-08-07T10:10:00Z") }).energyWaivedActionIds).toEqual([]);
    expect(resolve(stretch, { energySetAt: record().acceptedAt }).energyWaivedActionIds).toEqual(["unit-3"]);
  });

  it("waives nothing when energy is stale or was never dated", () => {
    const stretch = { accepted: [record()], declined: [] };
    expect(resolve(stretch, { energyFresh: false }).energyWaivedActionIds).toEqual([]);
    expect(
      resolveStretchState({
        situation: { stretch },
        now: new Date("2026-08-07T10:20:00Z"),
        timeZone: "UTC",
        energyFresh: true
      }).energyWaivedActionIds
    ).toEqual([]);
  });

  it("takes the latest end when one action has two records", () => {
    const out = resolve({
      accepted: [record(), record({ until: iso("2026-08-07T10:55:00Z") })],
      declined: []
    });
    expect(out.energyWaivedActionIds).toEqual(["unit-3"]);
    expect(out.energyWaivedUntil["unit-3"]!.toISOString()).toBe("2026-08-07T10:55:00.000Z");
  });

  it("returns an empty, harmless result with no stretch", () => {
    const out = resolveStretchState({ situation: undefined, now: new Date(), timeZone: "UTC", energyFresh: true });
    expect(out).toEqual({
      energyWaivedActionIds: [],
      energyWaivedUntil: {},
      context: { declinedActionIds: [], declinedAll: false }
    });
  });
});

describe("resolveStretchState declines", () => {
  it("counts a decline from the same local day only, in the person's zone", () => {
    // 2026-08-07 14:00Z is 00:00 on the 8th in this UTC+10 zone: a decline at 13:59Z is still the 7th there.
    const stretch = {
      accepted: [],
      declined: [
        { actionId: "before", at: iso("2026-08-07T13:59:00Z") },
        { actionId: "after", at: iso("2026-08-07T14:00:00Z") }
      ]
    };
    const east = (now: string) =>
      resolve(stretch, { timeZone: EAST, now: new Date(now), energySetAt: iso("2026-08-07T00:00:00Z") }).context;
    expect(east("2026-08-07T13:59:30Z").declinedActionIds).toEqual(["before"]);
    expect(east("2026-08-07T14:00:30Z").declinedActionIds).toEqual(["after"]);
    // The same instants in New York are both on the 7th.
    expect(
      resolve(stretch, {
        timeZone: NY,
        now: new Date("2026-08-07T14:30:00Z"),
        energySetAt: iso("2026-08-07T00:00:00Z")
      }).context.declinedActionIds
    ).toEqual(["before", "after"]);
  });

  it("clears a per-action decline made before energy was re-declared", () => {
    const stretch = { accepted: [], declined: [{ actionId: "unit-3", at: iso("2026-08-07T09:30:00Z") }] };
    expect(resolve(stretch, { energySetAt: iso("2026-08-07T09:00:00Z") }).context.declinedActionIds).toEqual([
      "unit-3"
    ]);
    expect(resolve(stretch, { energySetAt: iso("2026-08-07T09:30:00Z") }).context.declinedActionIds).toEqual([
      "unit-3"
    ]);
    expect(resolve(stretch, { energySetAt: iso("2026-08-07T10:00:00Z") }).context.declinedActionIds).toEqual([]);
  });

  it("keeps declined-all after energy is re-declared, and ends it at the next local day", () => {
    const stretch = { accepted: [], declined: [], declinedAllAt: iso("2026-08-07T09:30:00Z") };
    expect(resolve(stretch, { energySetAt: iso("2026-08-07T10:00:00Z") }).context.declinedAll).toBe(true);
    expect(resolve(stretch, { now: new Date("2026-08-08T00:00:00Z") }).context.declinedAll).toBe(false);
    // Made at 13:00Z (23:00 there), it holds until that zone's midnight at 14:00Z.
    const late = { accepted: [], declined: [], declinedAllAt: iso("2026-08-07T13:00:00Z") };
    expect(resolve(late, { timeZone: EAST, now: new Date("2026-08-07T13:59:00Z") }).context.declinedAll).toBe(true);
    expect(resolve(late, { timeZone: EAST, now: new Date("2026-08-07T14:00:00Z") }).context.declinedAll).toBe(false);
  });

  it("passes the next wake through", () => {
    const nextWakeAt = new Date("2026-08-07T20:00:00Z");
    expect(resolve(undefined, { nextWakeAt }).context.nextWakeAt).toBe(nextWakeAt);
  });
});
