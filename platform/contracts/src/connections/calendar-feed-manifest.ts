import { registerConnectionManifest } from "./manifest-store.js";

// The calendar feed (one https ICS URL, read-only). It lives with the core connections, not under `../private/`: the
// OpenRhen export empties that seam, and the feed is part of the open code. `connection-id.ts` imports this file right
// after the private seam, so it registers after the seam's connections (Google stays first) and in every build.
//
// Dormant by construction: the secret is the one env name `CALENDAR_FEED_URL`, so `/connections` reports it not ready
// until the field exists; it is not in the default `CALENDAR_SYNC_PROVIDERS`, so nothing schedules it; it has no
// `telemetryName`, so `/api/connections/status` never probes it (a probe would download the feed); and there is no
// Connections card for it.
export const CALENDAR_FEED_ID = "calendar_feed";
export const CALENDAR_FEED_URL_ENV = "CALENDAR_FEED_URL";

registerConnectionManifest({
  id: CALENDAR_FEED_ID,
  label: "Calendar feed",
  capabilities: ["calendar_source"],
  // `proof` is DNS plus a TLS handshake and downloads nothing; only `read_events` downloads, so a sync is one download.
  ops: { calendar_source: ["proof", "read_events"] },
  secrets: { anyOf: [[CALENDAR_FEED_URL_ENV]] },
  config: {
    CALENDAR_SYNC_INTERVAL_MINUTES: { required: false, default: "60" },
    CALENDAR_SYNC_PROVIDERS: { required: false },
    CALENDAR_SYNC_WINDOW_DAYS: { required: false },
    CALENDAR_SYNC_MAX_DELETES: { required: false }
  },
  calendarSource: {
    role: "secondary",
    sourceType: "calendar_feed_event",
    diffProfile: "fixed_blocks",
    // A failed read (a 404, a bad certificate) must not block the feed for the rest of the local day.
    authFailure: { anyFailure: false, reasons: [] },
    schedule: { kind: "interval", minutesEnv: "CALENDAR_SYNC_INTERVAL_MINUTES", defaultMinutes: 60 }
  }
});
