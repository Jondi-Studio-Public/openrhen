import { registerConnectionManifest } from "./manifest-store.js";

// Two example calendar sources that tests register, so they pin the rules (an interval source; a daily source that is
// the primary record) without naming a provider. Importing this module registers them; a test that reads the registry
// at load imports it first.
export const EXAMPLE_INTERVAL_SOURCE = "example_shared";
export const EXAMPLE_DAILY_SOURCE = "example_daily";

registerConnectionManifest({
  id: EXAMPLE_INTERVAL_SOURCE,
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

registerConnectionManifest({
  id: EXAMPLE_DAILY_SOURCE,
  label: "Example Daily",
  capabilities: ["calendar_source"],
  ops: { calendar_source: ["proof", "read_events"] },
  secrets: { anyOf: [["EXAMPLE_DAILY_TOKEN"]] },
  config: { EXAMPLE_DAILY_LOCAL_TIME: { required: false, default: "05:30" } },
  calendarSource: {
    role: "primary",
    sourceType: "example_daily_event",
    diffProfile: "roster",
    authFailure: { anyFailure: false, reasons: [] },
    schedule: { kind: "daily", localTimeEnv: "EXAMPLE_DAILY_LOCAL_TIME", defaultLocalTime: "05:30" }
  }
});
