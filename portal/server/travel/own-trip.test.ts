import { describe, expect, it } from "vitest";
import type { PlanForecastResponse } from "@openrhen/contracts";
import { departureEvidence, latestPlanLegMode, ownTripSample, type DeviceObservationAt } from "./own-trip";

const ARRIVED_AT = new Date("2026-09-28T10:00:00.000Z");

describe("ownTripSample", () => {
  it("is null with no departure evidence", () => {
    expect(
      ownTripSample({
        fromLocationId: "home",
        toLocationId: "work",
        mode: "car",
        arrivedAt: ARRIVED_AT,
        departedAt: undefined
      })
    ).toBeNull();
  });

  it("is null when the gap is over 4 hours", () => {
    const departedAt = new Date(ARRIVED_AT.getTime() - 4 * 3_600_000 - 60_000);
    expect(
      ownTripSample({ fromLocationId: "home", toLocationId: "work", mode: "car", arrivedAt: ARRIVED_AT, departedAt })
    ).toBeNull();
  });

  it("is null when the departure is at or after the arrival", () => {
    expect(
      ownTripSample({
        fromLocationId: "home",
        toLocationId: "work",
        mode: "car",
        arrivedAt: ARRIVED_AT,
        departedAt: ARRIVED_AT
      })
    ).toBeNull();
  });

  it("is null, and does not throw, when a stored departure is not a valid date", () => {
    const base = { fromLocationId: "home", toLocationId: "work", mode: "car" as const };
    expect(ownTripSample({ ...base, arrivedAt: ARRIVED_AT, departedAt: new Date("x") })).toBeNull();
    expect(ownTripSample({ ...base, arrivedAt: new Date("x"), departedAt: ARRIVED_AT })).toBeNull();
  });

  it("records the gap in minutes when it is under 4 hours", () => {
    const departedAt = new Date(ARRIVED_AT.getTime() - 22 * 60_000);
    const sample = ownTripSample({
      fromLocationId: "home",
      toLocationId: "work",
      mode: "car",
      arrivedAt: ARRIVED_AT,
      departedAt
    });
    expect(sample).toEqual({
      fromLocationId: "home",
      toLocationId: "work",
      mode: "car",
      minutes: 22,
      departedAt,
      observedAt: ARRIVED_AT
    });
  });
});

describe("departureEvidence", () => {
  const base = { arrivedAt: ARRIVED_AT, fromLocationId: "home" as const, observations: [] as DeviceObservationAt[] };

  it("is undefined with no evidence at all", () => {
    expect(
      departureEvidence({
        ...base,
        locationSetAt: undefined,
        latestAnsweredCheckInAt: undefined,
        latestSessionEndAt: undefined
      })
    ).toBeUndefined();
  });

  it("falls back to the last evidence at P when there is no away observation", () => {
    const locationSetAt = new Date("2026-09-28T08:00:00.000Z");
    const latestSessionEndAt = new Date("2026-09-28T09:00:00.000Z"); // latest of the three
    const latestAnsweredCheckInAt = new Date("2026-09-28T08:30:00.000Z");
    expect(departureEvidence({ ...base, locationSetAt, latestAnsweredCheckInAt, latestSessionEndAt })).toEqual(
      latestSessionEndAt
    );
  });

  it("uses the first device observation away from P after the last evidence", () => {
    const locationSetAt = new Date("2026-09-28T08:00:00.000Z");
    const away = new Date("2026-09-28T09:15:00.000Z");
    const laterAway = new Date("2026-09-28T09:45:00.000Z");
    const observations: DeviceObservationAt[] = [
      { observedAt: new Date("2026-09-28T07:00:00.000Z"), locationId: "home" }, // before evidence floor, ignored
      { observedAt: away, locationId: "work" },
      { observedAt: laterAway, locationId: "work" }
    ];
    expect(
      departureEvidence({
        ...base,
        locationSetAt,
        latestAnsweredCheckInAt: undefined,
        latestSessionEndAt: undefined,
        observations
      })
    ).toEqual(away);
  });

  it("ignores an observation still at P or after the arrival", () => {
    const locationSetAt = new Date("2026-09-28T08:00:00.000Z");
    const observations: DeviceObservationAt[] = [
      { observedAt: new Date("2026-09-28T08:30:00.000Z"), locationId: "home" },
      { observedAt: new Date("2026-09-28T10:30:00.000Z"), locationId: "work" } // after arrival, ignored
    ];
    expect(
      departureEvidence({
        ...base,
        locationSetAt,
        latestAnsweredCheckInAt: undefined,
        latestSessionEndAt: undefined,
        observations
      })
    ).toEqual(new Date("2026-09-28T08:30:00.000Z"));
  });
});

describe("latestPlanLegMode", () => {
  function planWith(edges: { fromLocationId: string; toLocationId: string; mode: "car" | "bike" | "walk" }[]) {
    return {
      derivedState: {
        commitmentTimelines: edges.map((edge, index) => ({
          id: `c${index}`,
          journeyBefore: { ...edge, minutes: 10, typicalMinutes: 10, source: "typical" as const, sampleCount: 0 }
        }))
      }
    } as unknown as PlanForecastResponse;
  }

  it("finds the mode of a matching journeyBefore edge", () => {
    const plan = planWith([{ fromLocationId: "home", toLocationId: "work", mode: "bike" }]);
    expect(latestPlanLegMode(plan, "home", "work")).toBe("bike");
  });

  it("is undefined with no matching edge", () => {
    const plan = planWith([{ fromLocationId: "home", toLocationId: "gym", mode: "car" }]);
    expect(latestPlanLegMode(plan, "home", "work")).toBeUndefined();
  });

  it("is undefined with no plan", () => {
    expect(latestPlanLegMode(undefined, "home", "work")).toBeUndefined();
  });
});
