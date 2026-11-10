import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "@openrhen/contracts";
import { registerDiffProfile, registeredDiffProfileNames, type CalendarDiffProfile } from "./calendar-diff";
import { calendarProfile } from "./calendar-profiles/calendar";
import {
  defaultEvent,
  describeProfileConformance,
  type ProfileUnderTest
} from "./calendar-profiles/profile-conformance";

/**
 * The diff orchestration scenarios run against each profile core registers, plus a synthetic profile that belongs to no
 * real provider, so public CI covers the orchestration whatever profiles a build ships. The scenarios live in
 * ./calendar-profiles/profile-conformance.ts as `describeProfileConformance(entries)`; a private overlay calls that
 * from its own test file with its own entries (roster, shared_calendar) and never edits this one. Vitest isolates
 * modules per file, so each file covers the profiles registered in its own process.
 */

const SYNTHETIC = "synthetic_test";
const { groupSeries: _noSeriesGrouping, ...calendarWithoutSeries } = calendarProfile;
const syntheticProfile: CalendarDiffProfile = {
  ...calendarWithoutSeries,
  provider: SYNTHETIC,
  sourceLabel: "Synthetic feed",
  relationshipPrefix: "synthetic",
  missingWhy: "No longer in the synthetic feed",
  eventKey: (event) => event.externalEventId,
  linkKey: (_frame, externalEventId) => externalEventId,
  frameOf: () => "feed",
  seriesKey: () => null,
  importKeyPrefix: `${SYNTHETIC}:block:`,
  isEcho: (event, input) => input.publishedRemoteIds?.has(event.externalEventId) ?? false
};
registerDiffProfile(SYNTHETIC, () => syntheticProfile);

/** The event a profile under test is given: the scenarios' defaults, moved to a frame the profile knows. */
const withDefaults = (overrides: Partial<CalendarEvent> = {}, calendarId: string | null = null): CalendarEvent => ({
  ...defaultEvent(),
  calendarId,
  ...overrides
});

/** Each profile core registers, by name, with the provider id and label a connection would give it. */
const CORE_ENTRIES: ProfileUnderTest[] = [
  {
    name: SYNTHETIC,
    provider: SYNTHETIC,
    label: "Synthetic feed",
    makeEvent: (overrides) => withDefaults(overrides),
    makeEcho: () => ({ event: withDefaults(), publishedRemoteIds: new Set(["e1"]) })
  },
  {
    // The optional `input` reaches every scenario: this entry runs them over a wider window than the default.
    name: SYNTHETIC,
    provider: SYNTHETIC,
    label: "Synthetic feed",
    makeEvent: (overrides) => withDefaults(overrides),
    makeEcho: () => ({ event: withDefaults(), publishedRemoteIds: new Set(["e1"]) }),
    input: { timeMin: "2026-07-01T00:00:00.000Z", timeMax: "2026-10-01T00:00:00.000Z" }
  },
  {
    name: "fixed_blocks",
    provider: "rota_feed",
    label: "Rota feed",
    makeEvent: (overrides) => withDefaults(overrides),
    makeEcho: () => ({ event: withDefaults(), publishedRemoteIds: new Set(["e1"]) })
  },
  {
    name: "calendar",
    provider: "google_calendar",
    label: "Google Calendar",
    makeEvent: (overrides) => withDefaults(overrides, "feed"),
    makeEcho: () => ({ event: withDefaults({ description: "OpenRhen:abc123" }, "feed") })
  }
];

describeProfileConformance(CORE_ENTRIES);

/**
 * Profiles that register in this process but that core does not own: the private overlay's, which the private seam
 * (./calendar-profiles/private/index.ts) imports unconditionally, so they cannot be told apart by registration alone.
 * The overlay covers them from its own conformance file. The synthetic profile registers here and is listed above.
 * Everything else registered is core's, so a profile core adds without an entry fails below.
 */
const NOT_CORE_REGISTERED = new Set(["roster", "shared_calendar"]);

describe("profile conformance coverage", () => {
  it("lists every profile core registers", () => {
    const listed = new Set(CORE_ENTRIES.map((entry) => entry.name));
    const coreRegistered = registeredDiffProfileNames().filter((name) => !NOT_CORE_REGISTERED.has(name));
    const missing = coreRegistered.filter((name) => !listed.has(name));
    expect(missing, `Core profiles with no conformance entry: ${missing.join(", ")}`).toEqual([]);
  });
});
