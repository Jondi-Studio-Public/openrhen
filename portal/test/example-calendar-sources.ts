import { registerConnectionManifest } from "@openrhen/contracts";

// Two example calendar sources that portal tests register, so the cross-source rules (matching, series links, link
// keys, the commit-time source split) are pinned without naming a provider: a secondary interval source that shares
// a calendar (`shared_calendar` profile) and a primary daily source that is the definitive record (`roster`
// profile). They mirror the pair in `platform/contracts/src/connections/example-sources.ts`; the real providers run
// the same rules in the provider-specific twins of the tests that use these. Importing this module registers them.
export const EXAMPLE_SHARED = "example_shared";
export const EXAMPLE_DAILY = "example_daily";
export const EXAMPLE_SHARED_LABEL = "Example Shared";
export const EXAMPLE_DAILY_LABEL = "Example Daily";

registerConnectionManifest({
  id: EXAMPLE_SHARED,
  label: EXAMPLE_SHARED_LABEL,
  capabilities: ["calendar_source"],
  ops: { calendar_source: ["proof", "read_events"] },
  secrets: { anyOf: [["EXAMPLE_SHARED_TOKEN"]] },
  config: {},
  telemetryName: EXAMPLE_SHARED,
  calendarSource: {
    role: "secondary",
    sourceType: "example_shared_event",
    diffProfile: "shared_calendar",
    authFailure: { anyFailure: true, reasons: [] },
    schedule: { kind: "interval", minutesEnv: "CALENDAR_SYNC_INTERVAL_MINUTES", defaultMinutes: 60 }
  }
});

registerConnectionManifest({
  id: EXAMPLE_DAILY,
  label: EXAMPLE_DAILY_LABEL,
  capabilities: ["calendar_source"],
  ops: { calendar_source: ["proof", "read_events"] },
  secrets: { anyOf: [["EXAMPLE_DAILY_TOKEN"]] },
  config: {},
  telemetryName: EXAMPLE_DAILY,
  calendarSource: {
    role: "primary",
    sourceType: "example_daily_event",
    diffProfile: "roster",
    authFailure: { anyFailure: false, reasons: [] },
    schedule: { kind: "daily", localTimeEnv: "EXAMPLE_DAILY_LOCAL_TIME", defaultLocalTime: "05:30" }
  }
});
