// This export reads the current backup format (28), and the legacy formats 27, 26, 25, 24, 23, 22, 21 and 20.
import type { BackupTable, OpenRhenBackup } from "../backup-format.js";
import { groupBackupTables } from "../../schema/table-groups.js";

/**
 * Format 20's table list, frozen: format 21 added the offer-log table to `BACKUP_TABLES`, and format 22 added the three
 * activity tables. A backup of an older format has no key for the tables added since, so restore leaves them empty
 * (`tablesAbsentFrom`). Registered table groups added the same tables to every format, so they are read from the live
 * "current" list. Format 21 is format 20 plus `offer_log`.
 */
const FORMAT_20_CORE_TABLES = [
  "portal_state",
  "users",
  "check_in",
  "areas",
  "daily_plans",
  "import_batches",
  "import_entity_keys",
  "integration_sync_runs",
  "issue_snapshots",
  "planning_focus_periods",
  "routine_presets",
  "sleep_plans",
  "sources",
  "source_files",
  "user_preferences",
  "import_records",
  "outcomes",
  "captures",
  "projects",
  "deliverables",
  "commitment_recurrence_rules",
  "commitments",
  "condition_definitions",
  "actions",
  "action_dependencies",
  "action_preferences",
  "action_recurrence_rules",
  "action_requirement_pathways",
  "action_recurrence_windows",
  "action_requirements",
  "calendar_event_links",
  "calendar_source_selections",
  "calendar_event_dismissals",
  "calendar_publications",
  "routine_preset_steps",
  "routine_preset_step_dependencies",
  "routine_steps",
  "action_occurrences",
  "routine_step_dependencies",
  "sessions",
  "session_segments",
  "action_cadence_completions",
  "deliverable_criteria",
  "deliverable_blockers",
  "deliverable_dependencies",
  "deliverable_criterion_actions",
  "deliverable_blocker_actions",
  "deliverable_sources",
  "deliverable_chat_messages",
  "journey_samples",
  "pulse_segments",
  "source_match_aliases",
  "plan_subjects",
  "plan_links",
  "plan_findings",
  "plan_shadow_log",
  "plan_map_switches",
  "photo_checkin_settings",
  "photo_checkin",
  "photo_checkin_stage",
  "place_reference_photo",
  "spans",
  "entity_prerequisites",
  "daily_plan_desired_actions",
  "daily_plan_deferred_actions",
  "planning_focus_projects",
  "watch_imports",
  "watch_events"
] as const;

const FORMAT_21_CORE_TABLES = [...FORMAT_20_CORE_TABLES, "offer_log"] as const;

/**
 * Format 22 is format 21 plus the three activity tables, all in the JSON (a 22 backup may carry a `skipped` entry when
 * `activity_events` was over its 500,000-row guard; it then restores with that table empty and says so). Format 23 has
 * the same tables but keeps `activity_events` rows in a streamed section, so it is the current list.
 */
const FORMAT_22_CORE_TABLES = [
  ...FORMAT_21_CORE_TABLES,
  "activity_imports",
  "activity_events",
  "activity_source_state"
] as const;

/** Format 23 is format 22 with `activity_events` streamed; format 24 added `derived_lineage` and `extractor_state`. */
const FORMAT_23_CORE_TABLES = FORMAT_22_CORE_TABLES;

/** Format 24 is format 23 plus the two derived-reader tables; format 25 added the two consequence comparison tables. */
const FORMAT_24_CORE_TABLES = [...FORMAT_23_CORE_TABLES, "derived_lineage", "extractor_state"] as const;

/** Format 25 is format 24 plus the comparison log; format 26 added `derived_settings` and `derived_model_calls`. */
const FORMAT_25_CORE_TABLES = [
  ...FORMAT_24_CORE_TABLES,
  "consequence_groups_issued",
  "consequence_comparisons"
] as const;

/**
 * Format 26 has the same tables as format 25 plus `derived_settings` and `derived_model_calls`. Format 27 changed no table
 * list: it added `activity_source_state.expected_every_minutes`, and a current-format backup must come back row for row, so
 * a file written without that column is a format 26 one and restores with the column null.
 */
const FORMAT_26_CORE_TABLES = [...FORMAT_25_CORE_TABLES, "derived_settings", "derived_model_calls"] as const;

/**
 * Format 27 has the same tables as format 26: the column it added, `activity_source_state.expected_every_minutes`, changed
 * no list. Format 28 added `activity_supersessions` (after `activity_events`), so a format 27 file lacks it and restores
 * with it empty.
 */
const FORMAT_27_CORE_TABLES = FORMAT_26_CORE_TABLES;

export function legacyRequiredTables(formatVersion: number): readonly BackupTable[] | undefined {
  if (formatVersion === 20) return [...FORMAT_20_CORE_TABLES, ...groupBackupTables("current")];
  if (formatVersion === 27) return [...FORMAT_27_CORE_TABLES, ...groupBackupTables("current")];
  if (formatVersion === 26) return [...FORMAT_26_CORE_TABLES, ...groupBackupTables("current")];
  if (formatVersion === 25) return [...FORMAT_25_CORE_TABLES, ...groupBackupTables("current")];
  if (formatVersion === 24) return [...FORMAT_24_CORE_TABLES, ...groupBackupTables("current")];
  if (formatVersion === 23) return [...FORMAT_23_CORE_TABLES, ...groupBackupTables("current")];
  if (formatVersion === 22) return [...FORMAT_22_CORE_TABLES, ...groupBackupTables("current")];
  if (formatVersion === 21) return [...FORMAT_21_CORE_TABLES, ...groupBackupTables("current")];
  return undefined;
}

export function upgradeLegacyBackup(backup: OpenRhenBackup): OpenRhenBackup {
  return backup;
}

export function fillLegacyRows(
  _table: BackupTable,
  _formatVersion: OpenRhenBackup["formatVersion"],
  rows: readonly Record<string, unknown>[]
): Record<string, unknown>[] {
  return [...rows];
}
