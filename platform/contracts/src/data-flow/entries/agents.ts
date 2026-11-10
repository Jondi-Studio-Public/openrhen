import type { FlowEntry } from "../types.js";
import { flow } from "./define.js";

/** Every MCP tool that writes or proposes (scope `write:` or `propose:`); the tool list is checked against the manifest (M1). */
const WRITE_TOOLS = [
  "rhen_save",
  "rhen_save_action",
  "rhen_save_project",
  "rhen_save_commitment",
  "rhen_save_capture",
  "rhen_changeset",
  "rhen_capture",
  "rhen_propose",
  "rhen_catch_up_settle",
  "rhen_reenter",
  "rhen_disrupt",
  "rhen_arrive",
  "rhen_stretch",
  "rhen_wake",
  "rhen_session",
  "rhen_span",
  "rhen_review",
  "rhen_archive",
  "rhen_cancel",
  "rhen_activity",
  "rhen_check_in",
  "rhen_check_in_tag",
  "rhen_disruption",
  "rhen_routine",
  "rhen_recalculate",
  "rhen_cadence",
  "rhen_recurrence",
  "rhen_inbox_act",
  "rhen_bulk",
  "rhen_deliverable",
  "rhen_undo"
] as const;

/** Agents, the scheduled ticks that act for the person, and the engine's own output. */
export const AGENT_ENTRIES: readonly FlowEntry[] = [
  flow({
    id: "agent-writes",
    name: "Agent proposals and writes",
    role: "source",
    category: "agent",
    method: "api-pull",
    trigger: { kind: "on-request", by: "agent" },
    code: {
      routes: [
        "POST /api/agent-proposals",
        "POST /api/agent-proposals/[id]/resolve",
        "POST /api/agent-sessions",
        "POST /api/agent-changes/[id]/undo"
      ],
      mcpTools: WRITE_TOOLS
    },
    from: ["ext:agent"],
    to: ["pg:agent_proposals", "pg:agent_sessions"],
    health: { kind: "max", table: "agent_sessions", column: "started_at" }
  }),
  flow({
    id: "fact-marks",
    name: "Marks on open mail items",
    role: "pipe",
    category: "agent",
    method: "api-pull",
    trigger: { kind: "on-request", by: "agent" },
    code: {
      paths: [
        "portal/server/persistence/postgres/fact-act-store.ts",
        "integrations/communication-readers/src/fact-act.ts"
      ],
      routes: ["POST /api/facts/[id]"]
    },
    from: ["pg:activity_events[source=derived]"],
    via: ["activity-ingest"],
    to: ["pg:writes", "pg:activity_events[source=derived]"],
    health: { kind: "none", reason: "written only when an agent marks an item" }
  }),
  flow({
    id: "agent-wake",
    name: "Agent wake",
    role: "pipe",
    category: "agent",
    method: "derived",
    trigger: { kind: "loop", loop: "agent-wake" },
    code: {
      paths: ["platform/database/src/planning/agent-wake.ts", "platform/database/src/planning/agent-wake-sender.ts"],
      loops: ["agent-wake"]
    },
    to: ["pg:agent_wakes"],
    health: { kind: "none", reason: "sent only when a wake is queued" }
  }),
  flow({
    id: "check-in-prompts",
    name: "Check-in prompts",
    role: "source",
    category: "derived",
    method: "derived",
    trigger: { kind: "loop", loop: "check-in-scheduler" },
    code: { paths: ["platform/database/src/planning/check-in-scheduler.ts"], loops: ["check-in-scheduler"] },
    to: ["pg:check_in"],
    incidentalWrites: [
      { table: "routine_steps", reason: "an answered prompt advances a routine step" },
      { table: "push_outbox", reason: "a prompt queues one check-in push" }
    ],
    health: { kind: "max", table: "check_in", column: "created_at" }
  }),
  flow({
    id: "leave-by-reminders",
    name: "Leave-by reminders",
    role: "source",
    category: "derived",
    method: "derived",
    trigger: { kind: "loop", loop: "leave-by-push" },
    code: { paths: ["platform/database/src/push/leave-by-scheduler.ts"], loops: ["leave-by-push"] },
    to: ["pg:push_outbox"],
    health: { kind: "none", reason: "queued only when something needs a reminder" }
  }),
  flow({
    id: "plan-forecast-runner",
    name: "Plan and forecast jobs",
    role: "source",
    category: "engine",
    method: "derived",
    trigger: { kind: "loop", loop: "plan-forecast-jobs" },
    code: { paths: ["platform/database/src/planning/plan-forecast-runtime.ts"], loops: ["plan-forecast-jobs"] },
    from: ["surface:engine"],
    to: [
      "pg:forecast_snapshots",
      "pg:recommendations",
      "pg:recommendation_candidates",
      "pg:planning_runs",
      "pg:plan_shadow_log",
      "pg:jobs",
      "pg:offer_log"
    ],
    incidentalWrites: [
      { table: "commitments", reason: "engine output written back into the input row" },
      { table: "action_occurrences", reason: "engine output written back into the input row" },
      { table: "projects", reason: "engine output written back into the input row" },
      { table: "condition_definitions", reason: "engine output written back into the input row" },
      { table: "routine_steps", reason: "engine output written back into the input row" },
      { table: "routine_step_dependencies", reason: "engine output written back into the input row" },
      { table: "sleep_plans", reason: "engine output written back into the input row" }
    ],
    health: { kind: "max", table: "planning_runs", column: "calculated_at" }
  }),
  flow({
    id: "plan-map-sweep",
    name: "Plan map sweep",
    role: "source",
    category: "derived",
    method: "derived",
    trigger: { kind: "loop", loop: "plan-map-sweep" },
    code: { routes: ["POST /api/plan-map/sweep"], loops: ["plan-map-sweep"] },
    to: ["pg:plan_subjects", "pg:plan_links", "pg:plan_findings", "pg:plan_shadow_log", "pg:plan_map_switches"],
    incidentalWrites: [
      { table: "integration_sync_runs", reason: "a run row for a failure that would be silent" },
      { table: "action_occurrences", reason: "a proposer rewrites a stale occurrence" },
      { table: "catch_up_runs", reason: "a sweep can open a catch-up" },
      { table: "check_in", reason: "a sweep can queue a check-in" },
      { table: "projects", reason: "a proposer updates a project" },
      { table: "push_outbox", reason: "a finding can queue a push" },
      { table: "writes", reason: "the change ledger entry for a proposer's write" }
    ],
    health: { kind: "none", reason: "ticks daily and writes only on findings" }
  }),
  flow({
    id: "plan-map-edits",
    name: "Plan map edits",
    role: "source",
    category: "manual",
    method: "manual",
    trigger: { kind: "on-request", by: "owner" },
    code: {
      routes: [
        "POST /api/plan-map/links",
        "POST /api/plan-map/links/[id]",
        "POST /api/plan-map/links/bulk",
        "POST /api/plan-map/findings/[id]",
        "POST /api/plan-map/propose",
        "PUT /api/plan-map/switches"
      ]
    },
    from: ["ext:owner"],
    to: ["pg:plan_subjects", "pg:plan_links", "pg:plan_findings", "pg:plan_shadow_log", "pg:plan_map_switches"],
    health: { kind: "none", reason: "owner-driven; no schedule to be late against" }
  }),
  flow({
    id: "pulse-recorder",
    name: "Pulse recorder",
    role: "source",
    category: "derived",
    method: "derived",
    trigger: { kind: "loop", loop: "pulse-tick" },
    code: {
      paths: ["portal/server/pulse/pulse-recorder.ts"],
      routes: ["POST /api/integrations/pulse/tick"],
      loops: ["pulse-tick"]
    },
    to: ["pg:pulse_segments", "pg:pulse_state", "pg:pulse_disruptions"],
    incidentalWrites: [{ table: "push_outbox", reason: "a back-on-plan message is queued" }],
    health: { kind: "max", table: "pulse_segments", column: "started_at" }
  }),
  flow({
    id: "pulse-publish",
    name: "Pulse status publish",
    role: "sink",
    category: "operations",
    method: "api-pull",
    trigger: { kind: "loop", loop: "pulse-tick" },
    connection: "pulse",
    code: { paths: ["portal/server/pulse/pulse-publish-client.ts", "portal/server/pulse/pulse-publisher.ts"] },
    from: ["pg:pulse_state", "pg:pulse_segments", "pg:pulse_disruptions"],
    to: ["surface:external/pulse"],
    incidentalWrites: [{ table: "pulse_state", reason: "the published state is recorded" }],
    health: { kind: "telemetry", name: "pulse" }
  }),
  flow({
    id: "push-drain",
    name: "Push drain",
    role: "sink",
    category: "operations",
    method: "push",
    trigger: { kind: "on-request", by: "service" },
    code: {
      paths: ["portal/server/push/push-drain.ts", "portal/server/push/push-transports.ts"],
      routes: ["POST /api/integrations/push/drain"]
    },
    from: ["pg:push_outbox", "pg:push_subscriptions"],
    to: ["surface:push"],
    incidentalWrites: [{ table: "push_outbox", reason: "a sent or failed message is marked" }],
    health: { kind: "max", table: "push_outbox", column: "created_at" }
  })
];
