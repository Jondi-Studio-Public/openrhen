// This export reads the current backup format, and formats 20 and 21 (the ones before the Now offer log and the activity store).
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

export function legacyRequiredTables(formatVersion: number): readonly BackupTable[] | undefined {
  if (formatVersion === 20) return [...FORMAT_20_CORE_TABLES, ...groupBackupTables("current")];
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
