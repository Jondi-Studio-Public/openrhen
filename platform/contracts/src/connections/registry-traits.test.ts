import { describe, expect, it } from "vitest";
import { doctorSyncCadence } from "../planning/doctor-cadence.js";
import { EXAMPLE_DAILY_SOURCE, EXAMPLE_INTERVAL_SOURCE } from "./example-sources.js";
import {
  calendarSinkLabel,
  calendarSourceIds,
  connectionManifest,
  intervalCalendarSourceIds,
  primarySourceIds,
  primarySourceLabel,
  relationshipPrefixOf,
  reviewCalendarSourceIds
} from "./registry.js";

// Kept code asks the registry for names and traits; these pin the rules with the example sources, so they hold in a
// build with no private connections.
describe("registry traits", () => {
  it("finds the primary source and the interval sources by role and schedule", () => {
    expect(primarySourceIds()).toContain(EXAMPLE_DAILY_SOURCE);
    expect(intervalCalendarSourceIds()).toContain(EXAMPLE_INTERVAL_SOURCE);
    expect(intervalCalendarSourceIds()).not.toContain(EXAMPLE_DAILY_SOURCE);
    expect(calendarSourceIds()).toEqual(expect.arrayContaining(["google_calendar", EXAMPLE_INTERVAL_SOURCE]));
    expect(reviewCalendarSourceIds()).not.toContain(EXAMPLE_DAILY_SOURCE);
    expect(reviewCalendarSourceIds()).toContain(EXAMPLE_INTERVAL_SOURCE);
  });

  it("reads labels from the manifest and falls back to a generic phrase", () => {
    expect(primarySourceLabel()).toBeTruthy();
    expect(calendarSinkLabel()).toBeTruthy();
    expect(connectionManifest(EXAMPLE_DAILY_SOURCE)?.label).toBe("Example Daily");
  });

  it("uses the connection id as the conflict prefix unless the manifest names one", () => {
    expect(relationshipPrefixOf(connectionManifest("google_calendar")!)).toBe("google");
    expect(relationshipPrefixOf(connectionManifest(EXAMPLE_INTERVAL_SOURCE)!)).toBe(EXAMPLE_INTERVAL_SOURCE);
  });

  it("derives doctor's worker cadence from each source's schedule", () => {
    const hour = 3_600_000;
    expect(doctorSyncCadence()).toMatchObject({
      [EXAMPLE_DAILY_SOURCE]: { intervalMs: 24 * hour, lateAfterMs: 48 * hour },
      [EXAMPLE_INTERVAL_SOURCE]: { intervalMs: hour, lateAfterMs: 3 * hour },
      google_calendar: { intervalMs: hour, lateAfterMs: 3 * hour }
    });
  });
});
