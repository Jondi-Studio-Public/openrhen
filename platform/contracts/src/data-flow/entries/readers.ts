import { PLAN_INPUT_TABLES } from "../surfaces.js";
import type { DatasetRef, FlowEntry } from "../types.js";
import { flow } from "./define.js";

/** Plan-input tables the engine reader is handed and does not consume, each with why (finding E-1). */
const NOT_READ = [
  {
    table: "daily_plan_desired_actions",
    reason: "saved and shown on Today, but no engine rule reads desired wins"
  },
  {
    table: "daily_plan_deferred_actions",
    reason: "saved and shown on Today, but no engine rule reads deferred items"
  }
] as const;

const notRead = new Set<string>(NOT_READ.map((item) => item.table));

/** A portal page that loads rows through a GET route. The page closure must hold the route (V3). */
const view = (
  id: string,
  name: string,
  gives: string,
  routes: string[],
  tables: readonly string[],
  pages: readonly string[]
): FlowEntry =>
  flow({
    id,
    name,
    role: "reader",
    category: "operations",
    method: "derived",
    trigger: { kind: "on-request", by: "owner" },
    gives,
    code: { routes },
    from: tables.map((table): DatasetRef => `pg:${table}`),
    to: pages.map((page): DatasetRef => `surface:page/${page}`),
    health: { kind: "none", reason: "a page read; the sources it shows have the health" }
  });

/** Readers: what turns stored data into something used. Pass-through readers never count as use. */
export const READER_ENTRIES: readonly FlowEntry[] = [
  flow({
    id: "engine-plan-input",
    name: "Planning engine input",
    role: "reader",
    category: "engine",
    method: "derived",
    trigger: { kind: "loop", loop: "plan-forecast-jobs" },
    gives: "the plan, leave-by times and travel tiers",
    code: {
      paths: ["portal/server/persistence/postgres/state-read.ts"],
      loops: ["plan-forecast-jobs"]
    },
    from: PLAN_INPUT_TABLES.filter((table) => !notRead.has(table)).map((table): DatasetRef => `pg:${table}`),
    notRead: NOT_READ,
    to: ["surface:engine"],
    health: { kind: "max", table: "planning_runs", column: "calculated_at" }
  }),
  flow({
    id: "watch-history-panel",
    name: "Review watch history",
    role: "reader",
    category: "operations",
    method: "derived",
    trigger: { kind: "on-request", by: "owner" },
    gives: "watch time by day and hour",
    code: {
      paths: ["portal/features/review/components/watch-history-panel.tsx"],
      routes: ["GET /api/review/watch-history"]
    },
    from: ["pg:watch_events", "pg:video_info"],
    to: ["surface:page/review"],
    health: { kind: "none", reason: "a page read; the import has the health" }
  }),
  view(
    "portal-state-view",
    "Plan and schedule views",
    "plan, schedule and history",
    ["GET /api/state"],
    [
      ...PLAN_INPUT_TABLES,
      "spans",
      "captures",
      "portal_state",
      "check_in",
      "recommendations",
      "recommendation_candidates"
    ],
    ["today", "plan", "schedule", "history"]
  ),
  view(
    "inbox-view",
    "Inbox",
    "proposals and imports waiting for a decision",
    ["GET /api/agent-proposals", "GET /api/imports"],
    ["agent_proposals", "import_batches", "import_records", "catch_up_runs"],
    ["inbox"]
  ),
  view(
    "connections-view",
    "Connections",
    "calendar selections and what was published",
    ["GET /api/connections/status", "GET /api/connections/[connectionId]/calendars"],
    ["calendar_source_selections", "calendar_event_links", "calendar_event_dismissals", "calendar_publications"],
    ["connections"]
  ),
  view(
    "photo-checkins-view",
    "Photo check-ins",
    "check-in photos and the mode",
    ["GET /api/photo-checkins"],
    ["photo_checkin", "photo_checkin_settings"],
    ["photo-checkins"]
  ),
  view(
    "plan-map-view",
    "Plan map",
    "links and findings between plan items",
    ["GET /api/plan-map"],
    ["plan_subjects", "plan_links", "plan_findings", "plan_map_switches"],
    ["map"]
  ),
  view("snapshots-view", "Reports", "saved issue snapshots", ["GET /api/snapshots"], ["issue_snapshots"], ["reports"]),
  view(
    "doctor-view",
    "Doctor",
    "health checks on sync, planning and push",
    ["GET /api/doctor"],
    ["integration_sync_runs", "planning_runs", "push_outbox", "pulse_segments"],
    ["doctor"]
  ),
  view(
    "agent-review-view",
    "Agent review",
    "what agents did and proposed",
    ["GET /api/agent-sessions", "GET /api/agent-changes"],
    ["agent_sessions", "agent_proposals", "writes", "write_rows"],
    ["review"]
  ),
  view(
    "deliverables-view",
    "Deliverables",
    "source files and the chat for a deliverable",
    ["GET /api/deliverables/[id]/chat", "GET /api/deliverable-source-files/[id]"],
    ["sources", "source_files", "deliverable_sources", "deliverable_chat_messages"],
    ["deliverables"]
  ),
  flow({
    id: "handheld-now",
    name: "Handheld now page",
    role: "reader",
    category: "device",
    method: "derived",
    trigger: { kind: "on-request", by: "device" },
    gives: "what to do now, on the handheld",
    code: {
      paths: ["portal/server/device/device-now.ts", "portal/server/device/device-shown.ts"],
      routes: ["GET /api/device/now"]
    },
    from: ["pg:commitments", "pg:actions", "pg:check_in"],
    to: ["surface:device/api/device/now", "pg:offer_log"],
    health: { kind: "max", table: "offer_log", column: "occurred_at", where: { surface: "handheld" } }
  }),
  flow({
    id: "rest-activity-read",
    name: "Raw activity read",
    role: "reader",
    category: "operations",
    method: "derived",
    trigger: { kind: "on-request", by: "owner" },
    passThrough: true,
    code: {
      routes: ["GET /api/activity-events", "GET /api/activity-events/summary"]
    },
    from: ["pg:activity_events", "pg:activity_imports"],
    to: ["surface:rest"],
    health: { kind: "none", reason: "pass-through read; nothing to be late" }
  }),
  flow({
    id: "rest-drift-report",
    name: "Drift report",
    role: "reader",
    category: "operations",
    method: "derived",
    trigger: { kind: "on-request", by: "owner" },
    passThrough: true,
    code: {
      paths: ["portal/server/drift/drift-report.ts"],
      routes: ["GET /api/drift-report"]
    },
    from: ["pg:check_in", "pg:sessions"],
    to: ["surface:rest"],
    health: { kind: "none", reason: "pass-through read; nothing to be late" }
  }),
  flow({
    id: "eval-report",
    name: "Derived rows evaluation report",
    role: "reader",
    category: "derived",
    method: "derived",
    trigger: { kind: "manual-run", where: "cli" },
    passThrough: true,
    code: { paths: ["portal/server/persistence/postgres/eval-report-store.ts"] },
    from: ["pg:activity_events[source=derived]", "pg:activity_events[source=derived-shadow]"],
    to: ["surface:rest"],
    health: { kind: "none", reason: "evaluation read; nothing to be late" }
  }),
  flow({
    id: "backup-run",
    name: "Backup",
    role: "sink",
    category: "operations",
    method: "derived",
    trigger: { kind: "manual-run", where: "powershell" },
    passThrough: true,
    code: { paths: ["platform/database/src/operations/backup-run.ts"] },
    to: ["surface:backup"],
    value: { note: "reads every table by name list" },
    health: { kind: "none", reason: "backup freshness is the doctor's backup check" }
  })
];
