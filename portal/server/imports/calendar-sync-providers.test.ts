import { describe, expect, it } from "vitest";
import { registerConnectionManifest } from "@openrhen/contracts";

// A provider-free interval source, registered before the module reads the registry at load.
registerConnectionManifest({
  id: "example_shared",
  label: "Example Shared",
  capabilities: ["calendar_source"],
  ops: { calendar_source: ["proof", "read_events"] },
  secrets: { anyOf: [["EXAMPLE_SHARED_TOKEN"]] },
  config: {},
  calendarSource: {
    role: "secondary",
    sourceType: "example_shared_event",
    diffProfile: "shared_calendar",
    authFailure: { anyFailure: true, reasons: [] },
    schedule: { kind: "interval", minutesEnv: "CALENDAR_SYNC_INTERVAL_MINUTES", defaultMinutes: 60 }
  }
});

const { enabledCalendarSyncProviders, isCalendarSyncEnabled } = await import("./calendar-sync-providers");

describe("enabledCalendarSyncProviders", () => {
  it("defaults to Google only when unset or blank", () => {
    expect(enabledCalendarSyncProviders({})).toEqual(["google_calendar"]);
    expect(enabledCalendarSyncProviders({ CALENDAR_SYNC_PROVIDERS: "  " })).toEqual(["google_calendar"]);
  });

  it("returns the known providers in registry order and ignores unknown names", () => {
    expect(
      enabledCalendarSyncProviders({ CALENDAR_SYNC_PROVIDERS: "example_shared, google_calendar, nope, roster_only" })
    ).toEqual(["google_calendar", "example_shared"]);
  });

  it("answers per provider", () => {
    const env = { CALENDAR_SYNC_PROVIDERS: "example_shared" };
    expect(isCalendarSyncEnabled("example_shared", env)).toBe(true);
    expect(isCalendarSyncEnabled("google_calendar", env)).toBe(false);
  });
});

describe("the calendar feed", () => {
  it("is not enabled by default or by naming other providers, so its sync route answers not_enabled", () => {
    expect(enabledCalendarSyncProviders({})).not.toContain("calendar_feed");
    expect(enabledCalendarSyncProviders({ CALENDAR_SYNC_PROVIDERS: "google_calendar, example_shared" })).not.toContain(
      "calendar_feed"
    );
    expect(isCalendarSyncEnabled("calendar_feed", {})).toBe(false);
    expect(isCalendarSyncEnabled("calendar_feed", { CALENDAR_FEED_URL: "https://calendar.example.com/a.ics" })).toBe(
      false
    );
  });

  it("is enabled only when named", () => {
    expect(isCalendarSyncEnabled("calendar_feed", { CALENDAR_SYNC_PROVIDERS: "calendar_feed" })).toBe(true);
  });
});
