import type { FlowEntry } from "../types.js";
import { flow } from "./define.js";

/** A file export parsed on the user's machine and posted to the activity pipe by `rhen import`. */
const exportSource = (id: string, name: string, activitySource: string, parser: string): FlowEntry =>
  flow({
    id,
    name,
    role: "source",
    category: "files",
    method: "file-import",
    trigger: { kind: "manual-run", where: "cli" },
    activitySource,
    via: ["activity-ingest"],
    code: { paths: [`integrations/activity-importers/src/parsers/${parser}.ts`] },
    from: [`local:${id}-export`],
    health: { kind: "activity", source: activitySource }
  });

/**
 * File imports and the shared pipes they and the pushed sources write through (design 2.3). Every activity source that
 * is a file export is one entry beside its parser; the shared route and store are the `activity-ingest` pipe.
 */
export const FILE_ENTRIES: readonly FlowEntry[] = [
  flow({
    id: "activity-ingest",
    name: "Activity ingest",
    role: "pipe",
    category: "files",
    method: "push",
    trigger: { kind: "on-request", by: "service" },
    code: {
      paths: ["portal/server/activity-ingest.ts", "portal/server/persistence/postgres/activity-store.ts"],
      routes: [
        "POST /api/activity-events",
        "DELETE /api/activity-imports/[id]",
        "DELETE /api/activity-sources/[source]/events",
        "PUT /api/activity-sources/[source]"
      ]
    },
    to: ["pg:activity_events", "pg:activity_imports"],
    incidentalWrites: [
      { table: "integration_sync_runs", reason: "a run row for a failure that would be silent" },
      { table: "activity_source_state", reason: "content gate and retention settings" },
      { table: "derived_lineage", reason: "lineage rows for ingested events" },
      { table: "extractor_state", reason: "extractor cursor for ingested events" }
    ],
    health: { kind: "none", reason: "health is per source" }
  }),
  exportSource("access-log-export", "Account access log export", "google-access-log", "access-log"),
  exportSource("apple-health-export", "Apple Health export", "apple-health", "apple-health"),
  exportSource("browser-takeout-export", "Browser history export", "chrome-takeout", "chrome"),
  exportSource("discord-export", "Discord data package", "discord-package", "discord"),
  exportSource("fit-export", "Fitness export", "fit", "fit"),
  exportSource("search-activity-export", "Search and activity export", "google-activity", "google-activity"),
  exportSource("chat-export", "Chat export", "google-chat", "google-chat"),
  exportSource("photos-export", "Photo library export", "google-photos", "google-photos"),
  exportSource("maps-places-export", "Saved places export", "maps-places", "maps"),
  exportSource("spotify-export", "Spotify streaming history", "spotify", "spotify"),
  exportSource("timeline-export", "Location timeline export", "timeline", "timeline"),
  flow({
    id: "mail-file-export",
    name: "Mail file import",
    role: "source",
    category: "files",
    method: "file-import",
    trigger: { kind: "manual-run", where: "cli" },
    via: ["activity-ingest"],
    code: {
      paths: ["integrations/activity-importers/src/parsers/mail.ts", "integrations/activity-importers/src/mail-mime.ts"]
    },
    from: ["local:mail-file-export-export"],
    health: { kind: "none", reason: "the caller names the source, so health is per source" }
  }),
  flow({
    id: "youtube-watch-history",
    name: "Watch history import",
    role: "source",
    category: "files",
    method: "file-import",
    trigger: { kind: "on-request", by: "owner" },
    code: {
      paths: [
        "portal/server/imports/watch-history-parser.ts",
        "portal/server/persistence/postgres/watch-history-store.ts"
      ],
      routes: ["POST /api/imports/watch-history", "DELETE /api/imports/watch-history/[id]"]
    },
    from: ["local:takeout-watch-history"],
    to: ["pg:watch_events", "pg:watch_imports"],
    incidentalWrites: [{ table: "app_secrets", reason: "the stored connection secret is rotated on refresh" }],
    health: { kind: "max", table: "watch_imports", column: "imported_at" }
  }),
  flow({
    id: "import-batches",
    name: "Import review queue",
    role: "pipe",
    category: "files",
    method: "manual",
    trigger: { kind: "on-request", by: "owner" },
    code: {
      routes: [
        "POST /api/imports/preview",
        "POST /api/imports/extract",
        "PUT /api/imports/[id]",
        "DELETE /api/imports/[id]",
        "POST /api/imports/[id]/commit",
        "POST /api/imports/[id]/commit-ready"
      ]
    },
    to: ["pg:import_batches", "pg:import_records", "pg:import_entity_keys"],
    health: { kind: "max", table: "import_batches", column: "created_at" }
  }),
  flow({
    id: "text-import",
    name: "Spreadsheet and text import",
    role: "source",
    category: "files",
    method: "file-import",
    trigger: { kind: "on-request", by: "owner" },
    connection: "openai",
    via: ["import-batches"],
    code: {
      paths: [
        "portal/server/imports/import-extractor.ts",
        "portal/server/imports/openai-import-extractor.ts",
        "portal/server/imports/csv-template-archive.ts"
      ]
    },
    from: ["local:spreadsheet-or-text"],
    incidentalWrites: [{ table: "provider_call_telemetry", reason: "outbound call counts for the model provider" }],
    health: { kind: "max", table: "import_batches", column: "created_at" }
  }),
  flow({
    id: "deliverable-sources",
    name: "Deliverable source files and chat",
    role: "source",
    category: "files",
    method: "manual",
    trigger: { kind: "on-request", by: "owner" },
    code: {
      paths: [
        "portal/server/imports/deliverable-source-file.ts",
        "portal/server/imports/deliverable-contract-extractor.ts",
        "portal/server/imports/openai-deliverable-chat.ts"
      ],
      routes: [
        "POST /api/deliverables/[id]/sources",
        "POST /api/deliverables/[id]/chat",
        "POST /api/deliverables/[id]/handoff",
        "POST /api/deliverables/[id]/workspace"
      ]
    },
    connection: "openai",
    from: ["local:deliverable-file"],
    to: ["pg:sources", "pg:source_files", "pg:deliverable_sources", "pg:deliverable_chat_messages", "pg:captures"],
    incidentalWrites: [
      { table: "provider_call_telemetry", reason: "outbound call counts for the model provider" },
      { table: "writes", reason: "the change ledger entry for a workspace move" }
    ],
    health: { kind: "none", reason: "owner-driven; no schedule to be late against" }
  })
];
