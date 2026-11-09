import type { FlowEntry } from "../types.js";
import { flow } from "./define.js";

/** Calendars, travel time and the model and status providers behind connections. */
export const CALENDAR_ENTRIES: readonly FlowEntry[] = [
  flow({
    id: "calendar-account-sync",
    name: "Calendar account sync",
    role: "source",
    category: "calendar",
    method: "api-pull",
    trigger: { kind: "loop", loop: "calendar-sync" },
    connection: "google_calendar",
    syncProvider: "google_calendar",
    freshness: "from-connection",
    via: ["import-batches"],
    code: {
      paths: ["portal/server/imports/calendar-sync.ts", "portal/server/imports/calendar-providers.ts"],
      routes: [
        "PUT /api/connections/[connectionId]/calendars",
        "POST /api/connections/[connectionId]/import/preview",
        "POST /api/connections/[connectionId]/sync"
      ],
      loops: ["calendar-sync"]
    },
    from: ["ext:calendar-account"],
    to: ["pg:calendar_source_selections", "pg:calendar_event_links", "pg:calendar_event_dismissals"],
    incidentalWrites: [{ table: "integration_sync_runs", reason: "the run record of the sync" }],
    health: { kind: "sync-runs", provider: "google_calendar" }
  }),
  flow({
    id: "calendar-feed-sync",
    name: "Calendar feed sync",
    role: "source",
    category: "calendar",
    method: "api-pull",
    trigger: { kind: "loop", loop: "calendar-sync" },
    connection: "calendar_feed",
    syncProvider: "calendar_feed",
    freshness: "from-connection",
    via: ["import-batches"],
    code: {
      paths: ["portal/server/imports/calendar-feed-adapter.ts", "portal/server/imports/calendar-sync-providers.ts"]
    },
    from: ["ext:calendar-feed"],
    incidentalWrites: [
      { table: "calendar_event_links", reason: "links between feed events and commitments" },
      { table: "commitments", reason: "a synced event becomes a commitment" }
    ],
    health: { kind: "sync-runs", provider: "calendar_feed" }
  }),
  flow({
    id: "calendar-publish",
    name: "Calendar publish",
    role: "sink",
    category: "calendar",
    method: "api-pull",
    trigger: { kind: "on-request", by: "owner" },
    connection: "google_calendar",
    code: {
      paths: ["portal/server/imports/publish-marker.ts"],
      routes: [
        "POST /api/connections/[connectionId]/publish",
        "POST /api/connections/[connectionId]/publish/remove",
        "POST /api/connections/[connectionId]/write-proof"
      ]
    },
    from: ["pg:commitments", "pg:actions"],
    to: ["surface:external/google_calendar"],
    health: { kind: "none", reason: "published on request; the sync probe covers the connection" }
  }),
  flow({
    id: "travel-lookup",
    name: "Travel time lookup",
    role: "source",
    category: "calendar",
    method: "api-pull",
    trigger: { kind: "loop", loop: "travel-lookup" },
    connection: "google",
    code: {
      paths: ["portal/server/travel/lookup-plan.ts", "portal/server/travel/travel-spend.ts"],
      routes: ["POST /api/integrations/travel/tick", "POST /api/travel/refresh", "POST /api/travel/geocode"],
      loops: ["travel-lookup"]
    },
    from: ["ext:travel-time-provider"],
    to: ["pg:journey_samples", "pg:travel_lookup_budget"],
    incidentalWrites: [
      { table: "action_cadence_completions", reason: "the cadence completion moves with the occurrence" },
      { table: "action_occurrences", reason: "a lookup updates the occurrence's travel time" },
      { table: "action_recurrence_rules", reason: "a lookup updates the rule's travel time" },
      { table: "actions", reason: "a lookup updates the action's travel time" },
      { table: "provider_call_telemetry", reason: "outbound call counts for the provider" }
    ],
    health: { kind: "telemetry", name: "google" }
  }),
  flow({
    id: "model-provider-embeddings",
    name: "Embedding model provider",
    role: "pipe",
    category: "operations",
    method: "api-pull",
    trigger: { kind: "on-request", by: "service" },
    connection: "deepinfra",
    code: {
      paths: [
        "integrations/outbound-proxy/src/connections/deepinfra/connection.ts",
        "integrations/outbound-proxy/src/connections/deepinfra/embeddings-client.ts"
      ]
    },
    health: { kind: "none", reason: "no portal data is written; a call fails visibly" }
  }),
  flow({
    id: "youtube-video-lengths",
    name: "Video length lookup",
    role: "source",
    category: "files",
    method: "api-pull",
    trigger: { kind: "on-request", by: "owner" },
    connection: "youtube_data",
    code: {
      paths: ["portal/server/persistence/postgres/video-lengths-store.ts"],
      routes: ["POST /api/review/watch-history/lengths"]
    },
    from: ["ext:video-metadata-provider"],
    to: ["pg:video_info", "pg:youtube_quota_use"],
    health: { kind: "telemetry", name: "youtube_data" }
  })
];
