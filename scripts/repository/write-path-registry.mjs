import "./private/index.mjs";
import { loadAddonWriters } from "./addon-routes.mjs";
import { extensionWriters } from "./write-path-extensions.mjs";
// The list itself lives in the contracts package (data-flow registry, E1), so the registry check and this guard read one file.
import planInputTables from "../../platform/contracts/src/data-flow/plan-input-tables.json" with { type: "json" };
// Registry for the one-write-path guard.
//
// `check-structure.mjs` uses this to enforce that every production write to a table the planning
// engine reads goes through `recordStateChange` (`portal/server/persistence/postgres/planning-evidence.ts`),
// which logs a `write_rows` row and enqueues a recalculation job in the same call.
//
// This is a text match over source files: `INSERT INTO <table>`, `UPDATE <table>` and
// `DELETE FROM <table>`. It cannot see a table name built at runtime (string concatenation,
// template interpolation of the table name itself), and it cannot see through the drizzle query
// builder used elsewhere in the workspace — nothing under these paths writes a plan-input table
// through drizzle today. If something starts to, this registry and the rule in `check-structure.mjs`
// both need extending, or a writer can pass unseen.

// Tables `readPortalState` / `buildPlanForecastRequest` read to build a plan forecast request
// Every production write to one of these
// must be logged and enqueued through `recordStateChange`, so every writer must appear in `WRITERS`.
export const PLAN_INPUT_TABLES = planInputTables;

// Deliberately left out: read but never planned from. `captures` feeds the request hash but
// `engine/core/src` never reads it. `deliverable_sources`, `source_files` and
// `deliverable_chat_messages` are read-only support for the deliverable workbench, not plan input.
// `check_in` reaches the request only as `activeSession.lastVerifiedAt`, which `engine/core/src`
// never reads, and check-in answers are deliberately record-only (invariant 5). The inbox tables
// (`captures`, `sources` and the messages of other people) hold unresolved intake, not
// plan input. `travel_lookup_budget` is
// the daily travel lookup spend counter, not plan input itself — it is recomputable bookkeeping the
// engine never reads. `journey_samples` *is* plan input (`readJourneySummary` feeds
// `request.journeys`), so every writer of it is registered below.

// `class` is one of:
// - `owner`: calls `recordStateChange` itself; must contain the literal text `recordStateChange(`.
// - `helper`: writes a plan-input table but only from inside a call made by a registered owner
//   (directly, or through another registered helper). `owners` names those owner files.
// - `write-back`: engine output written back into an input table (invariant 3); never logs or
//   enqueues by design.
// - `bootstrap`: one-time user setup, outside the planning transaction flow.
// - `store`: a table owner (modularity W0): `platform/database/src/stores/`, `portal/server/persistence/postgres/stores/`
//   and `.../entities/` as folders, plus the two single-purpose store files that already hold most of their tables'
//   writes. A store holds the SQL for the tables `TABLE_OWNERS` names it for; it never decides when to log a change, so
//   a store that owns a plan-input table is called only from a registered writer (`rules/write-owners.mjs`).
// - `operations`: `platform/database/src/operations/`, a directory prefix covering backup, restore,
//   migration and seed scripts, none of which run against a live plan.
// - `retention`: a scheduled sweep that deletes rows already outside every query the engine reads
//   plan input through (for `journey_samples`, rows older than the 180-day window
//   `readJourneySummary` itself queries) — removing them changes nothing the current request can see,
//   so, like write-back, it never logs or enqueues.
const CORE_WRITERS = {
  "portal/server/persistence/postgres/planning-evidence.ts": {
    class: "owner",
    reason: "Defines and calls recordStateChange; the recalculate() path is the guard's own home."
  },
  "portal/server/persistence/postgres/entity-commands.ts": {
    class: "owner",
    reason: "Entity CRUD commands call recordStateChange once per transaction."
  },
  "portal/server/persistence/postgres/activity-commands.ts": {
    class: "owner",
    reason: "Activity start/stop/log commands call recordStateChange once per transaction."
  },
  "portal/server/persistence/postgres/session-commands.ts": {
    class: "owner",
    reason: "Session commands call recordStateChange once per transaction."
  },
  "portal/server/persistence/postgres/wake-command.ts": {
    class: "owner",
    reason: "The wake command settles last night in one transaction and calls recordStateChange once."
  },
  "portal/server/persistence/postgres/recurrence-commands.ts": {
    class: "owner",
    reason: "Recurrence commands call recordStateChange once per transaction."
  },
  "portal/server/persistence/postgres/commitment-source-commands.ts": {
    class: "owner",
    reason: "Not the same event calls recordStateChange once per transaction."
  },
  "portal/server/persistence/postgres/project-commands.ts": {
    class: "owner",
    reason: "Project commands call recordStateChange once per transaction."
  },
  "portal/server/persistence/postgres/close-commands.ts": {
    class: "owner",
    reason: "closeEntity closes or restores one row per command and calls recordStateChange once per transaction."
  },
  "portal/server/persistence/postgres/close-cascade.ts": {
    class: "helper",
    reason:
      "Writes the children, steps and prep actions of a close or restore only inside closeEntity's transaction, which calls recordStateChange once.",
    owners: ["portal/server/persistence/postgres/close-commands.ts"]
  },
  "portal/server/persistence/postgres/system-close.ts": {
    class: "owner",
    reason:
      "closeCommitmentAsSystem cancels one commitment the source removed (with its steps and prep) and calls recordStateChange for it in the same transaction."
  },
  "portal/server/persistence/postgres/recurrence-end.ts": {
    class: "owner",
    reason:
      "closeFutureOccurrences and restoreEndedOccurrences close and reopen a rule's future occurrences and their steps inside the rule save's (or the import commit's) transaction and call recordStateChange for the rule in it."
  },
  "portal/server/persistence/postgres/write-revert.ts": {
    class: "owner",
    reason:
      "A revert restores an agent write's rows and calls recordStateChange once per transaction; it also clears the planner's pending occurrences of a series it removes."
  },
  "portal/server/persistence/postgres/catch-up.ts": {
    class: "owner",
    reason: "settleCatchUp calls recordStateChange once per settle transaction."
  },
  "portal/server/persistence/postgres/pulse-disruption.ts": {
    class: "owner",
    reason: "recordDisruption calls recordStateChange once per record or end transaction."
  },
  "portal/server/persistence/postgres/reenter.ts": {
    class: "owner",
    reason:
      "reenter calls recordStateChange once per re-entry transaction, after settling the window through catch-up.ts and writing the situation."
  },
  "portal/server/persistence/postgres/stretch-command.ts": {
    class: "owner",
    reason:
      "stretch calls recordStateChange once per answer transaction, after writing only the stretch key of the situation."
  },
  "portal/server/persistence/postgres/import-store.ts": {
    class: "owner",
    reason: "Import commit transactions call recordStateChange once per commit."
  },
  "portal/server/persistence/postgres/state-store.ts": {
    class: "owner",
    reason:
      "put() -> replaceState calls recordStateChange; PUT /api/state returns 405 so nothing live reaches it, but the exported path does not skip the log."
  },
  "portal/server/location/location-observation-store.ts": {
    class: "owner",
    reason: "write() calls recordStateChange on a locationId change or a stale-to-fresh refresh."
  },
  "portal/server/travel/travel-spend.ts": {
    class: "owner",
    reason:
      "spendTravelLookup writes journey_samples (source 'google') and calls recordStateChange once, in the same transaction as the budget reservation (the travel time model design note, 'Sample writes')."
  },
  "portal/server/travel/own-trip.ts": {
    class: "helper",
    reason:
      "recordOwnTripOnArrival writes journey_samples (source 'own_trip') only inside a caller's transaction, called from every arrival write (the travel time model design note, 'Own trips (T2)').",
    owners: [
      "portal/server/persistence/postgres/entity-commands.ts",
      "portal/server/location/location-observation-store.ts"
    ]
  },
  "portal/server/persistence/postgres/cadence-completion.ts": {
    class: "helper",
    reason:
      "Writes action_recurrence_rules/action_cadence_completions/action_occurrences/actions only inside a caller's transaction.",
    owners: [
      "portal/server/persistence/postgres/activity-commands.ts",
      "portal/server/persistence/postgres/recurrence-commands.ts",
      "portal/server/persistence/postgres/session-commands.ts",
      "portal/server/persistence/postgres/entity-commands.ts",
      "portal/server/persistence/postgres/import-store.ts"
    ]
  },
  "portal/server/persistence/postgres/current-situation.ts": {
    class: "helper",
    reason:
      "reassertLocationOnWake writes user_preferences only inside a caller's transaction. readers/preferences.ts imports only the pure parseCurrentSituation parser from here, not a writer.",
    owners: [
      "portal/server/location/location-observation-store.ts",
      "portal/server/persistence/postgres/activity-commands.ts",
      "portal/server/persistence/postgres/entity-commands.ts",
      "portal/server/persistence/postgres/wake-command.ts"
    ]
  },
  "portal/server/persistence/postgres/deliverable-session-rollover.ts": {
    class: "helper",
    reason: "Rolls over deliverable sessions/actions only inside a caller's transaction.",
    owners: [
      "portal/server/persistence/postgres/activity-commands.ts",
      "portal/server/persistence/postgres/entity-commands.ts"
    ]
  },
  "portal/server/persistence/postgres/retroactive-end.ts": {
    class: "helper",
    reason:
      "Closes a session and moves the end of a checkpointed one's last segment only inside a caller's transaction.",
    owners: [
      "portal/server/persistence/postgres/activity-commands.ts",
      "portal/server/persistence/postgres/session-commands.ts",
      "portal/server/persistence/postgres/wake-command.ts"
    ]
  },
  "portal/server/persistence/postgres/deliverable-write.ts": {
    class: "helper",
    reason: "Writes deliverable tables only inside a caller's transaction.",
    owners: [
      "portal/server/persistence/postgres/entity-commands.ts",
      "portal/server/persistence/postgres/state-store.ts"
    ]
  },
  "portal/server/persistence/postgres/routine-step-arrival.ts": {
    class: "helper",
    reason: "skipMootRoutineSteps writes routine_steps/sessions only inside a caller's transaction.",
    owners: [
      "portal/server/location/location-observation-store.ts",
      "portal/server/persistence/postgres/entity-commands.ts"
    ]
  },
  "portal/server/persistence/postgres/routine-step-window.ts": {
    class: "helper",
    reason: "Writes action_occurrences only inside a caller's transaction.",
    owners: [
      "portal/server/persistence/postgres/activity-commands.ts",
      "portal/server/persistence/postgres/entity-commands.ts"
    ]
  },
  "portal/server/persistence/postgres/sleep-session-sync.ts": {
    class: "helper",
    reason: "Writes sessions/session_segments only inside a caller's transaction.",
    owners: [
      "portal/server/persistence/postgres/entity-commands.ts",
      "portal/server/persistence/postgres/wake-command.ts"
    ]
  },
  "portal/server/persistence/postgres/sleep-wake.ts": {
    class: "helper",
    reason:
      "The sleep record's shared rules (log a night, complete a tracked sleep, derive the last wake) write sleep_plans/user_preferences only inside a caller's transaction.",
    owners: [
      "portal/server/persistence/postgres/activity-commands.ts",
      "portal/server/persistence/postgres/entity-commands.ts",
      "portal/server/persistence/postgres/wake-command.ts"
    ]
  },
  "portal/server/persistence/postgres/state-replace.ts": {
    class: "helper",
    reason:
      "replaceState writes plan-input tables only inside state-store.ts's put() transaction. Also imported by ensure-user.ts (bootstrap), which is not registered as an owner.",
    owners: ["portal/server/persistence/postgres/state-store.ts"]
  },
  "portal/server/persistence/postgres/imports/commit-records.ts": {
    class: "helper",
    reason: "Writes import-derived rows only inside import-store.ts's commit transaction.",
    owners: ["portal/server/persistence/postgres/import-store.ts"]
  },
  "portal/server/persistence/postgres/imports/calendar-diff-core.ts": {
    class: "helper",
    reason:
      "linkCalendarEventCommitment writes sources/commitments/calendar_event_links, and recordCalendarDismissals/releaseKeptCalendarLinks write the calendar link and dismissal tables, only inside import-store.ts's commit transaction.",
    owners: ["portal/server/persistence/postgres/import-store.ts"]
  },
  "portal/server/persistence/postgres/imports/calendar-profiles/calendar.ts": {
    class: "helper",
    reason: "Writes commitments (the source link) only inside import-store.ts's commit transaction.",
    owners: ["portal/server/persistence/postgres/import-store.ts"]
  },
  "portal/server/persistence/postgres/imports/calendar-feed-dates.ts": {
    class: "helper",
    reason:
      "insertFeedDate and touchFeedDates write a rule's exception rows (commitments) and the feed link's snapshot only inside import-store.ts's commit transaction, called from the calendar feed import extension's hooks.",
    owners: ["portal/server/persistence/postgres/import-store.ts"]
  },
  "portal/server/persistence/postgres/imports/calendar-feed-lifecycle.ts": {
    class: "helper",
    reason:
      "recordFeedChoices writes the feed's own links and dismissals inside import-store.ts's commit transaction (the extension's afterCommit); repairStaleFeedKeys, settleRuleEnds and forgetKeptEnds write only the feed's links, dismissals and stale import_entity_keys at diff time, never a plan-input table.",
    owners: ["portal/server/persistence/postgres/import-store.ts"]
  },
  "portal/server/persistence/postgres/imports/calendar-feed-import-extension.ts": {
    class: "helper",
    reason:
      "The calendar feed extension's afterRecord/afterCommit hooks write exception rows (commitments) and feed links only inside import-store.ts's commit transaction; its diff (diffCalendarFeed) also writes import_entity_keys at diff time so a per-date key resolves as an update, which is not a plan-input table.",
    owners: ["portal/server/persistence/postgres/import-store.ts"]
  },
  "portal/server/persistence/postgres/imports/upserts.ts": {
    class: "helper",
    reason:
      "Writes area/outcome/project/action tables only inside import-store.ts's commit transaction (via commit-records.ts).",
    owners: ["portal/server/persistence/postgres/import-store.ts"]
  },
  "platform/database/src/planning/plan-forecast-runtime.ts": {
    class: "write-back",
    reason:
      "persistDerivedState and its callees write engine output back into input tables; never logs or enqueues (invariant 3)."
  },
  "platform/database/src/planning/routine-inheritance.ts": {
    class: "write-back",
    reason: "Write-back callee of persistDerivedState; never logs or enqueues (invariant 3)."
  },
  "platform/database/src/planning/routine-step-mootness.ts": {
    class: "write-back",
    reason: "Write-back callee of persistDerivedState; never logs or enqueues (invariant 3)."
  },
  "platform/database/src/consequence/refit.ts": {
    class: "write-back",
    reason:
      "refitConsequence writes the comparison-derived consequence_refined* columns back into projects and actions (a cache of the comparison log); it builds the table name at runtime, so the text guard cannot see it. It never logs or enqueues itself: the comparison write, the replace and import commits and the plan run that call it carry their own recalculation (invariant 3)."
  },
  "platform/database/src/planning/completion-ratios.ts": {
    class: "write-back",
    reason: "deriveProjectPace writes engine output back into projects; never logs or enqueues (invariant 3)."
  },
  "platform/database/src/planning/plan-retention.ts": {
    class: "retention",
    reason:
      "pruneExpiredJourneySamples deletes journey_samples rows older than JOURNEY_SUMMARY_WINDOW_DAYS (180 days), the exact window readJourneySummary queries; those rows are already invisible to every plan-forecast request before they are deleted, so removing them changes nothing the engine can see."
  },
  "portal/server/persistence/postgres/ensure-user.ts": {
    class: "bootstrap",
    reason: "One-time legacy user migration, outside the planning transaction flow."
  },
  "platform/database/src/stores/": {
    class: "store",
    reason:
      "Table owners that platform/database runtime code also writes through (planning, push, consequence, offer-log)."
  },
  "portal/server/persistence/postgres/stores/": {
    class: "store",
    reason: "Table owners for the portal's persistence layer."
  },
  "portal/server/persistence/postgres/entities/": {
    class: "store",
    reason: "One saveEntity handler per entity kind, each the owner of that kind's tables."
  },
  "portal/server/persistence/postgres/activity-store.ts": {
    class: "store",
    reason: "Already holds most writes of activity_events and activity_source_state, so it is their owner."
  },
  "portal/server/persistence/postgres/plan-map-store.ts": {
    class: "store",
    reason: "Already holds most writes of plan_findings and plan_links, so it is their owner."
  },
  "platform/database/src/operations/": {
    class: "operations",
    reason: "Backup, restore, migration and seed scripts; not part of the live write path."
  }
};

/**
 * The core's writers plus those a feature the export leaves out registers (`write-path-extensions.mjs`) and those
 * an add-on's route handlers declare as data (`portal/app/(addon)/<id>/write-paths.json`). An add-on's entries sit
 * under the core's, so an add-on cannot change what core says about its own files.
 */
export const WRITERS = { ...loadAddonWriters().writers, ...CORE_WRITERS, ...extensionWriters() };

/**
 * The one writer of every core table (modularity W0, metric S9): one row per `pgTable` in
 * `platform/database/src/schema/core.ts`, naming the **end-state** owner by its full repository path, as the W slices
 * of the plan create them. An owner file that does not exist yet is fine while every writer of its table is still in a
 * `scripts/repository/pending/write-owners/<lane>.json` shard; a W slice creates it and deletes the shard rows.
 * `owner: null` is allowed only for a table no file writes. `exempt` pins the one write that cannot move.
 * A new `pgTable` names its owner here in the pull request that adds it. Checked by `rules/write-owners.mjs`.
 */
export const TABLE_OWNERS = {
  users: { owner: "portal/server/persistence/postgres/stores/users.ts" }, // W15
  portal_state: { owner: "portal/server/persistence/postgres/ensure-user.ts" },
  user_preferences: { owner: "portal/server/persistence/postgres/stores/user-preferences.ts" }, // W15
  areas: { owner: "portal/server/persistence/postgres/entities/area.ts" }, // W6
  outcomes: { owner: "portal/server/persistence/postgres/entities/outcome.ts" }, // W6
  projects: { owner: "platform/database/src/stores/projects.ts" }, // W6
  actions: { owner: "platform/database/src/stores/actions.ts" }, // W10
  action_recurrence_rules: { owner: "portal/server/persistence/postgres/stores/action-rules.ts" }, // W10
  action_recurrence_windows: { owner: "portal/server/persistence/postgres/stores/action-rules.ts" }, // W10
  action_occurrences: { owner: "platform/database/src/stores/action-occurrences.ts" }, // W10
  action_requirement_pathways: { owner: "portal/server/persistence/postgres/stores/action-rules.ts" }, // W10
  action_requirements: { owner: "portal/server/persistence/postgres/stores/action-rules.ts" }, // W10
  action_preferences: { owner: "portal/server/persistence/postgres/stores/action-rules.ts" }, // W10
  action_dependencies: { owner: "portal/server/persistence/postgres/stores/action-rules.ts" }, // W10
  deliverables: { owner: "portal/server/persistence/postgres/entities/deliverable.ts" }, // W9
  entity_prerequisites: { owner: "portal/server/persistence/postgres/prerequisites.ts" },
  deliverable_dependencies: { owner: "portal/server/persistence/postgres/entities/deliverable.ts" }, // W9
  deliverable_criteria: { owner: "portal/server/persistence/postgres/entities/deliverable.ts" }, // W9
  deliverable_criterion_actions: { owner: "portal/server/persistence/postgres/entities/deliverable.ts" }, // W9
  deliverable_blockers: { owner: "portal/server/persistence/postgres/entities/deliverable.ts" }, // W9
  deliverable_blocker_actions: { owner: "portal/server/persistence/postgres/entities/deliverable.ts" }, // W9
  deliverable_chat_messages: { owner: "portal/server/persistence/postgres/deliverable-chat-store.ts" },
  deliverable_sources: { owner: "portal/server/persistence/postgres/stores/inbox.ts" }, // W4
  sources: { owner: "portal/server/persistence/postgres/stores/inbox.ts" }, // W4
  source_files: { owner: "portal/server/persistence/postgres/deliverable-proposal-store.ts" },
  captures: { owner: "portal/server/persistence/postgres/stores/inbox.ts" }, // W4
  commitment_recurrence_rules: { owner: "platform/database/src/stores/commitments.ts" }, // W11
  commitments: { owner: "platform/database/src/stores/commitments.ts" }, // W11
  check_in: { owner: "platform/database/src/stores/check-in.ts" }, // W2
  calendar_event_links: { owner: "portal/server/persistence/postgres/stores/calendar-links.ts" }, // W3
  calendar_source_selections: { owner: "portal/server/persistence/postgres/calendar-source-selections.ts" },
  calendar_event_dismissals: { owner: "portal/server/persistence/postgres/stores/calendar-links.ts" }, // W3
  source_match_aliases: { owner: "portal/server/persistence/postgres/stores/calendar-links.ts" }, // W3
  // Forward-declared: enforces nothing until D3 creates this store (no core file writes the table today).
  calendar_publications: { owner: "portal/server/persistence/postgres/stores/calendar-publications.ts" }, // D3; forward-declared: enforces nothing until D3 creates this store
  routine_steps: { owner: "platform/database/src/stores/routine-steps.ts" }, // W7
  routine_step_dependencies: { owner: "platform/database/src/stores/routine-steps.ts" }, // W7
  routine_presets: { owner: "portal/server/persistence/postgres/entities/routine-preset.ts" }, // W7
  routine_preset_steps: { owner: "portal/server/persistence/postgres/entities/routine-preset.ts" }, // W7
  routine_preset_step_dependencies: { owner: "portal/server/persistence/postgres/entities/routine-preset.ts" }, // W7
  condition_definitions: { owner: "platform/database/src/stores/condition-definitions.ts" }, // W15
  journey_samples: { owner: "platform/database/src/stores/journey-samples.ts" }, // W12
  travel_lookup_budget: { owner: "portal/server/travel/travel-spend.ts" },
  push_subscriptions: { owner: "portal/server/push/push-subscriptions.ts" },
  push_outbox: { owner: "platform/database/src/stores/push-outbox.ts" }, // W2
  agent_wakes: { owner: "platform/database/src/stores/agent-wakes.ts" }, // W2
  sleep_plans: { owner: "platform/database/src/stores/sleep-plans.ts" }, // W8
  sessions: { owner: "portal/server/persistence/postgres/stores/sessions.ts" }, // W8
  session_segments: { owner: "portal/server/persistence/postgres/stores/sessions.ts" }, // W8
  action_cadence_completions: { owner: "portal/server/persistence/postgres/cadence-completion.ts" },
  forecast_snapshots: { owner: "platform/database/src/stores/plan-forecast.ts" }, // W12
  recommendations: { owner: "platform/database/src/stores/plan-forecast.ts" }, // W12
  planning_runs: { owner: "platform/database/src/stores/plan-forecast.ts" }, // W12
  recommendation_candidates: { owner: "platform/database/src/stores/plan-forecast.ts" }, // W12
  writes: { owner: "portal/server/persistence/postgres/stores/command-log.ts" }, // W13
  write_rows: { owner: "platform/database/src/stores/write-log.ts" }, // W12
  agent_proposals: { owner: "portal/server/agent-proposals/store.ts" },
  agent_tokens: { owner: "portal/server/agent-token-store.ts" },
  owner_credentials: { owner: "portal/server/owner-credential-store.ts" },
  agent_access_tokens: { owner: "portal/server/mcp-access-tokens.ts" },
  oauth_clients: { owner: "portal/server/mcp-oauth-store.ts" },
  oauth_authorization_codes: { owner: "portal/server/mcp-oauth-store.ts" },
  oauth_refresh_tokens: { owner: "portal/server/mcp-oauth-store.ts" },
  agent_sessions: { owner: "portal/server/agent-session-store.ts" },
  provider_call_telemetry: { owner: "platform/database/src/stores/provider-calls.ts" }, // W12
  daily_plans: { owner: "portal/server/persistence/postgres/entities/daily-plan.ts" }, // W15
  daily_plan_desired_actions: { owner: "portal/server/persistence/postgres/entities/daily-plan.ts" }, // W15
  daily_plan_deferred_actions: { owner: "portal/server/persistence/postgres/entities/daily-plan.ts" }, // W15
  planning_focus_periods: { owner: "portal/server/persistence/postgres/entities/planning-focus.ts" }, // W6
  planning_focus_projects: { owner: "portal/server/persistence/postgres/entities/planning-focus.ts" }, // W6
  jobs: { owner: "platform/database/src/stores/plan-forecast.ts" }, // W12
  import_batches: { owner: "portal/server/persistence/postgres/stores/import-records.ts" }, // W3
  import_records: { owner: "portal/server/persistence/postgres/stores/import-records.ts" }, // W3
  import_entity_keys: { owner: "portal/server/persistence/postgres/stores/import-records.ts" }, // W3
  integration_sync_runs: {
    owner: "portal/server/persistence/postgres/run-log.ts",
    exempt: {
      "scripts/backup/record-run.mjs":
        "The backup sidecar runs plain node in its own image (scripts/backup/Dockerfile), so it cannot import a TypeScript owner, and moving its insert would edit a deploy file."
    }
  },
  issue_snapshots: { owner: "portal/server/persistence/postgres/issue-snapshot-store.ts" },
  pulse_segments: { owner: "platform/database/src/stores/pulse-segments.ts" }, // W13
  pulse_state: { owner: "portal/server/persistence/postgres/stores/pulse.ts" }, // W13
  pulse_disruptions: { owner: "portal/server/persistence/postgres/stores/pulse.ts" }, // W13
  plan_subjects: { owner: "portal/server/persistence/postgres/plan-map-store.ts" },
  plan_links: { owner: "portal/server/persistence/postgres/plan-map-store.ts" }, // W14
  plan_findings: { owner: "portal/server/persistence/postgres/plan-map-store.ts" }, // W14
  plan_shadow_log: { owner: "platform/database/src/stores/plan-shadow-log.ts" }, // W14
  plan_map_switches: { owner: "portal/server/persistence/postgres/plan-map-store.ts" },
  catch_up_runs: { owner: "portal/server/persistence/postgres/catch-up.ts" },
  photo_checkin_settings: { owner: "portal/server/persistence/postgres/photo-checkin-store.ts" },
  photo_checkin: { owner: "portal/server/persistence/postgres/photo-checkin-store.ts" },
  photo_checkin_stage: { owner: null },
  place_reference_photo: { owner: "portal/server/persistence/postgres/photo-checkin-store.ts" },
  spans: { owner: "portal/server/persistence/postgres/entities/span.ts" }, // W6
  watch_imports: { owner: "portal/server/persistence/postgres/watch-history-store.ts" },
  watch_events: { owner: "portal/server/persistence/postgres/watch-history-store.ts" },
  activity_imports: { owner: "portal/server/persistence/postgres/activity-store.ts" },
  activity_events: { owner: "portal/server/persistence/postgres/activity-store.ts" }, // W14
  activity_source_state: { owner: "portal/server/persistence/postgres/activity-store.ts" }, // W14
  derived_lineage: { owner: "portal/server/persistence/postgres/derived-lineage-store.ts" },
  extractor_state: { owner: "portal/server/persistence/postgres/extractor-state-store.ts" },
  derived_settings: { owner: "portal/server/persistence/postgres/derived-settings-store.ts" },
  derived_model_calls: { owner: "portal/server/persistence/postgres/derived-model-calls-store.ts" },
  video_info: { owner: "portal/server/persistence/postgres/video-lengths-store.ts" },
  app_secrets: { owner: "portal/server/persistence/postgres/app-secrets-store.ts" },
  youtube_quota_use: { owner: "portal/server/persistence/postgres/video-lengths-store.ts" },
  offer_log: { owner: "platform/database/src/offer-log/offer-log.ts" },
  consequence_comparisons: { owner: "platform/database/src/consequence/comparisons.ts" },
  consequence_groups_issued: { owner: "platform/database/src/consequence/comparisons.ts" }
};

/**
 * The files under `platform/database/src/operations/` that hold a write today. `operations/` is exempt from the
 * one-writer rule by prefix (backup, restore, migration and seed write every table by design), so a file there that
 * is not listed is refused, and a core runtime file outside `operations/` may not import one of these.
 */
export const OPERATIONS_WRITERS = [
  "platform/database/src/operations/migrate-on-deploy.ts",
  "platform/database/src/operations/restore-run.ts",
  "platform/database/src/operations/smoke-seed-late-commitment.ts"
];

/**
 * Test support that is not a `*.test.ts` file but writes tables to reset a database between tests. It is not a runtime
 * writer, so the one-writer rule does not read it. Pinned by exact path, never a pattern; a test holds this list to
 * exactly this one file.
 */
export const TEST_HARNESS_WRITERS = ["portal/server/persistence/postgres/state-store-harness.ts"];
