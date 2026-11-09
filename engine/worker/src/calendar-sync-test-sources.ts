import { registerConnectionManifest } from "@openrhen/contracts";

// Two example sources the schedule tests register, so they pin the rules (an interval source that locks out on any
// failure; a daily source) without naming a provider. Import this before `./calendar-sync-schedule.js`: that module
// reads the registry when it loads.
export const EXAMPLE_INTERVAL_SOURCE = "example_shared";
export const EXAMPLE_DAILY_SOURCE = "example_daily";
export const EXAMPLE_DEFAULT_SOURCE = "example_default";

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

registerConnectionManifest({
  id: EXAMPLE_DEFAULT_SOURCE,
  label: "Example Default",
  capabilities: ["calendar_source"],
  ops: { calendar_source: ["proof", "read_events"] },
  secrets: { anyOf: [["EXAMPLE_DEFAULT_TOKEN"]] },
  config: {},
  calendarSource: {
    role: "secondary",
    sourceType: "example_default_event",
    diffProfile: "shared_calendar",
    syncByDefault: true,
    authFailure: { anyFailure: false, reasons: [] },
    schedule: { kind: "interval", minutesEnv: "CALENDAR_SYNC_INTERVAL_MINUTES", defaultMinutes: 60 }
  }
});
