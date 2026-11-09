import type { FlowEntry } from "../types.js";

/**
 * File imports and the shared pipes they and the pushed sources write through (design 2.3). Seed entries only: PR A2
 * adds the rest of the core sources.
 */
export const FILE_ENTRIES: readonly FlowEntry[] = [
  {
    id: "activity-ingest",
    name: "Activity ingest",
    role: "pipe",
    category: "files",
    method: "push",
    trigger: { kind: "on-request", by: "service" },
    code: {
      paths: ["portal/server/activity-ingest.ts", "portal/server/persistence/postgres/activity-store.ts"],
      routes: ["POST /api/activity-events"]
    },
    from: [],
    to: ["pg:activity_events", "pg:activity_imports"],
    incidentalWrites: [{ table: "activity_source_state", reason: "content gate settings" }],
    health: { kind: "none", reason: "health is per source" }
  },
  {
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
      routes: ["POST /api/imports/watch-history"]
    },
    from: ["local:takeout-watch-history"],
    to: ["pg:watch_events", "pg:watch_imports"],
    health: { kind: "max", table: "watch_imports", column: "imported_at" }
  }
];
