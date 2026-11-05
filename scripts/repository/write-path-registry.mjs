import "./private/index.mjs";
import { loadAddonWriters } from "./addon-routes.mjs";
import { extensionWriters } from "./write-path-extensions.mjs";
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
export const PLAN_INPUT_TABLES = [
  "user_preferences",
  "users",
  "areas",
  "outcomes",
  "projects",
  "actions",
  "action_dependencies",
  "action_recurrence_rules",
  "action_recurrence_windows",
  "action_cadence_completions",
  "action_occurrences",
  "condition_definitions",
  "action_requirement_pathways",
  "action_requirements",
  "action_preferences",
  "sessions",
  "session_segments",
  "daily_plans",
  "daily_plan_desired_actions",
  "daily_plan_deferred_actions",
  "planning_focus_periods",
  "planning_focus_projects",
  "deliverables",
  "deliverable_criteria",
  "deliverable_blockers",
  "deliverable_dependencies",
  "deliverable_criterion_actions",
  "deliverable_blocker_actions",
  "commitments",
  "commitment_recurrence_rules",
  "routine_steps",
  "routine_step_dependencies",
  "routine_presets",
  "routine_preset_steps",
  "routine_preset_step_dependencies",
  "sleep_plans",
  "journey_samples"
];

// Deliberately left out: read but never planned from. `captures` feeds the request hash but
// `engine/core/src` never reads it. `deliverable_sources`, `source_files` and
// `deliverable_chat_messages` are read-only support for the deliverable workbench, not plan input.
// `check_in` reaches the request only as `activeSession.lastVerifiedAt`, which `engine/core/src`
// never reads, and check-in answers are deliberately record-only (invariant 5). The inbox tables
// (`captures`, `sources` and the messages of other people) hold unresolved intake, not
// plan input. `travel_lookup_budget` is
// the daily Google lookup spend counter, not plan input itself — it is recomputable bookkeeping the
// engine never reads. `journey_samples` *is* plan input (`readJourneySummary` feeds
// `request.journeys`), so every writer of it is registered below.

// `class` is one of:
// - `owner`: calls `recordStateChange` itself; must contain the literal text `recordStateChange(`.
// - `helper`: writes a plan-input table but only from inside a call made by a registered owner
//   (directly, or through another registered helper). `owners` names those owner files.
// - `write-back`: engine output written back into an input table (invariant 3); never logs or
//   enqueues by design.
// - `bootstrap`: one-time user setup, outside the planning transaction flow.
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
