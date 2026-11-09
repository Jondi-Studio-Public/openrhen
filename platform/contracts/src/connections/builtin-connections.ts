import type { ConnectionManifest } from "./manifest.js";

// Must not import ../integrations/*: those files import this folder.
//
// The core list: connections every build serves. Other connections register their own manifests from
// `../private/` (see registry.ts `registerConnectionManifest`), which the OpenRhen export leaves out.

const SYNC_INTERVAL = {
  kind: "interval",
  minutesEnv: "CALENDAR_SYNC_INTERVAL_MINUTES",
  defaultMinutes: 60
} as const;

export const BUILTIN_CONNECTIONS: readonly ConnectionManifest[] = [
  {
    id: "google_calendar",
    label: "Google Calendar",
    capabilities: ["calendar_source"],
    ops: { calendar_source: ["proof", "list_calendars", "read_events"] },
    secrets: {
      anyOf: [["GOOGLE_CALENDAR_CLIENT_ID", "GOOGLE_CALENDAR_CLIENT_SECRET", "GOOGLE_CALENDAR_REFRESH_TOKEN"]]
    },
    config: {
      CALENDAR_SYNC_INTERVAL_MINUTES: { required: false, default: "60" },
      CALENDAR_SYNC_PROVIDERS: { required: false },
      CALENDAR_SYNC_WINDOW_DAYS: { required: false },
      CALENDAR_SYNC_MAX_DELETES: { required: false }
    },
    telemetryName: "google_calendar",
    calendarSource: {
      role: "secondary",
      sourceType: "google_calendar_event",
      diffProfile: "calendar",
      relationshipPrefix: "google",
      syncByDefault: true,
      authFailure: { anyFailure: false, reasons: ["invalid_grant"] },
      schedule: SYNC_INTERVAL
    }
  },
  {
    id: "google",
    label: "Google Maps",
    capabilities: ["travel_time", "geocoding"],
    secrets: { anyOf: [["GOOGLE_MAPS_API_KEY"]] },
    config: {},
    telemetryName: "google"
  },
  {
    id: "openai",
    label: "OpenAI",
    capabilities: ["model_provider"],
    ops: { model_provider: ["extract", "stream", "probe"] },
    secrets: { anyOf: [["OPENAI_API_KEY"]] },
    config: {},
    telemetryName: "openai"
  },
  {
    id: "deepinfra",
    label: "DeepInfra",
    capabilities: ["model_provider"],
    ops: { model_provider: ["embed", "complete"] },
    secrets: { anyOf: [["DEEPINFRA_API_KEY"]] },
    config: { DEEPINFRA_EMBEDDING_MODEL: { required: false } }
  },
  {
    // A language model on the person's own machine (Ollama), reached over the LAN or tailnet. The address arrives in
    // each request's body (`baseUrl`) and is checked by the proxy's address guard; there is no key.
    id: "ollama",
    label: "Ollama",
    capabilities: ["model_provider"],
    ops: { model_provider: ["complete"] },
    secrets: { anyOf: [] },
    credentialSource: "request",
    config: {}
  },
  {
    id: "pulse",
    label: "Pulse",
    capabilities: ["status_publish"],
    secrets: { anyOf: [["PULSE_PUBLISH_URL", "PULSE_PUBLISH_SECRET"]] },
    config: {}
  },
  {
    // Video lengths for watch history. The key is typed into the app, stored encrypted in the portal, and sent in each
    // request's body; the proxy holds none, so it is always ready and reads nothing from its environment.
    id: "youtube_data",
    label: "YouTube Data API",
    capabilities: ["video_metadata"],
    secrets: { anyOf: [] },
    credentialSource: "request",
    config: {}
  }
];
