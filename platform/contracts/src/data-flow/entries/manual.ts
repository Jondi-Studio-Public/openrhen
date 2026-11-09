import { PLAN_INPUT_TABLES } from "../surfaces.js";
import type { DatasetRef, FlowEntry } from "../types.js";
import { flow } from "./define.js";

const pg = (tables: readonly string[]): DatasetRef[] => tables.map((table): DatasetRef => `pg:${table}`);

/** What the person types, taps and settles in the portal. */
export const MANUAL_ENTRIES: readonly FlowEntry[] = [
  flow({
    id: "portal-plan-edits",
    name: "Plan edits in the portal",
    role: "source",
    category: "manual",
    method: "manual",
    trigger: { kind: "on-request", by: "owner" },
    code: {
      routes: [
        "POST /api/commands/action",
        "POST /api/commands/activity",
        "POST /api/commands/cadence-completion",
        "POST /api/commands/changeset",
        "POST /api/commands/close",
        "POST /api/commands/commitment-recurrence",
        "POST /api/commands/commitment-source-split",
        "POST /api/commands/entity",
        "POST /api/commands/project",
        "POST /api/commands/project-review",
        "POST /api/commands/recalculate",
        "POST /api/commands/recurrence-goal",
        "POST /api/commands/revert",
        "POST /api/commands/session",
        "POST /api/commands/stretch",
        "POST /api/commands/wake",
        "PUT /api/state"
      ]
    },
    from: ["ext:owner"],
    to: [...pg(PLAN_INPUT_TABLES), ...pg(["spans", "captures", "entity_prerequisites", "source_match_aliases"])],
    health: { kind: "max", table: "writes", column: "created_at" }
  }),
  flow({
    id: "portal-consequence-ranking",
    name: "Consequence ranking answers",
    role: "source",
    category: "manual",
    method: "manual",
    trigger: { kind: "on-request", by: "owner" },
    code: { routes: ["POST /api/commands/consequence"] },
    from: ["ext:owner"],
    to: pg(["consequence_comparisons", "consequence_groups_issued"]),
    incidentalWrites: [{ table: "writes", reason: "the change ledger entry for the command" }],
    health: { kind: "max", table: "consequence_comparisons", column: "answered_at" }
  }),
  flow({
    id: "consequence-refit",
    name: "Consequence refit",
    role: "reader",
    category: "manual",
    method: "derived",
    trigger: { kind: "on-request", by: "owner" },
    gives: "refined consequence ratings the engine ranks by",
    from: pg(["consequence_comparisons", "consequence_groups_issued"]),
    to: pg(["projects", "actions"]),
    value: { note: "the refit rewrites the refined consequence columns" },
    health: { kind: "none", reason: "runs inside the ranking command; its source has the probe" }
  }),
  flow({
    id: "portal-check-ins",
    name: "Check-ins and re-entry",
    role: "source",
    category: "manual",
    method: "manual",
    trigger: { kind: "on-request", by: "owner" },
    code: {
      routes: ["POST /api/commands/check-in", "POST /api/commands/reenter", "POST /api/commands/pulse-disruption"]
    },
    from: ["ext:owner"],
    to: pg(["check_in", "user_preferences", "pulse_disruptions"]),
    incidentalWrites: [{ table: "writes", reason: "the change ledger entry for the command" }],
    health: { kind: "max", table: "check_in", column: "created_at" }
  }),
  flow({
    id: "catch-up-settle",
    name: "Catch-up settling",
    role: "source",
    category: "manual",
    method: "manual",
    trigger: { kind: "on-request", by: "owner" },
    code: { routes: ["POST /api/commands/catch-up-settle"] },
    from: ["ext:owner"],
    to: pg(["catch_up_runs", "agent_proposals"]),
    health: { kind: "none", reason: "owner-driven; no schedule to be late against" }
  }),
  flow({
    id: "offer-shown-beacon",
    name: "Now offer shown beacon",
    role: "pipe",
    category: "manual",
    method: "push",
    trigger: { kind: "on-request", by: "owner" },
    code: { routes: ["POST /api/offer-log/shown"] },
    from: ["ext:portal-page"],
    to: ["pg:offer_log"],
    health: { kind: "max", table: "offer_log", column: "occurred_at" }
  }),
  flow({
    id: "saved-keys",
    name: "Saved provider keys",
    role: "pipe",
    category: "manual",
    method: "manual",
    trigger: { kind: "on-request", by: "owner" },
    code: { routes: ["PUT /api/settings/secrets/[name]", "DELETE /api/settings/secrets/[name]"] },
    credentials: [],
    from: ["ext:owner"],
    to: ["pg:app_secrets"],
    health: { kind: "none", reason: "a key is either set or not; the connection probe shows use" }
  }),
  flow({
    id: "issue-snapshots",
    name: "Issue snapshots",
    role: "source",
    category: "manual",
    method: "manual",
    trigger: { kind: "on-request", by: "owner" },
    code: {
      paths: ["portal/server/persistence/postgres/issue-snapshot-store.ts"],
      routes: ["POST /api/snapshots", "POST /api/snapshots/[id]/review"]
    },
    from: ["ext:owner"],
    to: ["pg:issue_snapshots"],
    incidentalWrites: [
      { table: "action_occurrences", reason: "restoring a snapshot rewrites the plan rows it captured" },
      { table: "commitments", reason: "restoring a snapshot rewrites the plan rows it captured" },
      { table: "condition_definitions", reason: "restoring a snapshot rewrites the plan rows it captured" },
      { table: "forecast_snapshots", reason: "restoring a snapshot rewrites the plan rows it captured" },
      { table: "jobs", reason: "restoring a snapshot rewrites the plan rows it captured" },
      { table: "planning_runs", reason: "restoring a snapshot rewrites the plan rows it captured" },
      { table: "recommendation_candidates", reason: "restoring a snapshot rewrites the plan rows it captured" },
      { table: "recommendations", reason: "restoring a snapshot rewrites the plan rows it captured" },
      { table: "routine_steps", reason: "restoring a snapshot rewrites the plan rows it captured" },
      { table: "sleep_plans", reason: "restoring a snapshot rewrites the plan rows it captured" }
    ],
    health: { kind: "none", reason: "owner-driven; no schedule to be late against" }
  }),
  flow({
    id: "push-subscriptions",
    name: "Push subscriptions",
    role: "source",
    category: "device",
    method: "manual",
    trigger: { kind: "on-request", by: "owner" },
    code: {
      paths: ["portal/server/push/push-subscriptions.ts"],
      routes: [
        "POST /api/push/subscriptions",
        "DELETE /api/push/subscriptions",
        "DELETE /api/push/subscriptions/[id]",
        "POST /api/push/test"
      ]
    },
    from: ["ext:browser"],
    to: pg(["push_subscriptions", "push_outbox"]),
    health: { kind: "none", reason: "a subscription is set or not; the push drain has the health" }
  }),
  flow({
    id: "derived-settings",
    name: "Mail understanding settings",
    role: "pipe",
    category: "manual",
    method: "manual",
    trigger: { kind: "on-request", by: "owner" },
    code: {
      paths: [
        "portal/server/persistence/postgres/derived-settings-store.ts",
        "portal/server/derived/derived-settings.ts"
      ],
      routes: ["PUT /api/derived-settings", "POST /api/derived-settings/test"]
    },
    to: ["pg:derived_settings"],
    incidentalWrites: [{ table: "derived_model_calls", reason: "the Test button records its one model call" }],
    health: { kind: "none", reason: "the owner's settings; nothing arrives on a schedule" }
  })
];
