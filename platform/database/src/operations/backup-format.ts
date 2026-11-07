import { createHash } from "node:crypto";
import type postgres from "postgres";
import "../schema/private/index.js";
import { groupBackupTables } from "../schema/table-groups.js";
import { legacyRequiredTables } from "./private/legacy-backups.js";

/**
 * Every table holding data a person authored, ordered so that inserting them in sequence never
 * violates a foreign key. The order is derived from the live constraint graph; if you add a table,
 * put it after everything it references. `assertBackupCoverage` fails the backup when a table exists
 * in the database but appears in neither this list nor `REGENERABLE_TABLES`, so a migration that adds
 * a table cannot silently fall out of the backup the way tables 0008-0024 did.
 */
const CORE_BACKUP_TABLES = [
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
  // `deliverables` moves ahead of `actions` here (it used to sit with its own criteria/blockers
  // below): a deliverable's action now carries `deliverable_id`, a real FK into this table
  // so the row it points at must already
  // exist when `actions` is inserted on restore.
  "deliverables",
  // `commitment_recurrence_rules` and `commitments` move ahead of `actions` here: an action's
  // nullable `prep_for_commitment_id` is a real FK into `commitments`
  //, so the commitment must exist when the action is inserted.
  "commitment_recurrence_rules",
  "commitments",
  // `condition_definitions` follows both: a `live` condition's `commitment_id` / `recurrence_rule_id` are
  // real FKs (migrations 0063, 0078) into the two tables just above, and the row must name exactly one.
  "condition_definitions",
  "actions",
  "action_dependencies",
  "action_preferences",
  "action_recurrence_rules",
  "action_requirement_pathways",
  "action_recurrence_windows",
  "action_requirements",
  "calendar_event_links",
  // The calendar sync design note: the chosen Google calendars and the events a person rejected in
  // review. Both are decisions no other table can regenerate; neither references anything but `users`.
  "calendar_source_selections",
  "calendar_event_dismissals",
  "calendar_publications",
  // `routine_preset_steps`/`routine_preset_step_dependencies` move ahead of `routine_steps` here (a
  // pre-existing ordering gap this rename's own edit happened to touch): a routine step's nullable
  // `preset_step_id` is a real FK into `routine_preset_steps`, so that row must already exist when a
  // step naming it is inserted on restore.
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
  // `journey_samples`: a Google-measured or own-trip
  // journey. Own trips cannot be re-fetched, so unlike `travel_lookup_budget` (a spend counter
  // recomputable from this table's Google rows, in REGENERABLE_TABLES below) this is authored data.
  "journey_samples",
  // `pulse_segments`: the recorded on/off/free/
  // asleep/gap history. It cannot be regenerated from anything else — unlike `pulse_state` (the
  // recorder's and publisher's own bookkeeping, in REGENERABLE_TABLES below) this is history.
  "pulse_segments",
  // `source_match_aliases`: the owner's "same event" decisions pairing a remote
  // title with a local one. They cannot be recomputed, so they are authored data.
  "source_match_aliases",
  // Plan map: subjects, stored links, findings, the shadow log (60-day
  // evidence the owner judges add-ons on) and the per-add-on switches are all decisions or evidence no other
  // table can regenerate. Each references only `users`.
  "plan_subjects",
  "plan_links",
  "plan_findings",
  "plan_shadow_log",
  "plan_map_switches",
  // Photo check-ins: the switch, each photo's row (transcript, the
  // person's own description and edits), every stage's audit output and the place reference photos are
  // authored or audit evidence no other table can regenerate. Photo bytes are not in this file: rows
  // hold content hashes, and the blob folder is copied beside the backup.
  "photo_checkin_settings",
  "photo_checkin",
  "photo_checkin_stage",
  "place_reference_photo",
  // Calendar spans: labelled blocks of days the person authored. They
  // reference `users` and `projects`, both earlier in this list.
  "spans",
  // Prerequisites across entity kinds: polymorphic edges with no
  // foreign keys, so the position in this list does not matter. Authored, nothing regenerates them.
  "entity_prerequisites",
  // A day's desired wins and deferred actions, and a focus period's projects: join rows that replaced
  // three jsonb arrays (format 17). They reference `daily_plans`, `planning_focus_periods`, `actions` and
  // `projects`, all earlier in this list. Authored.
  "daily_plan_desired_actions",
  "daily_plan_deferred_actions",
  "planning_focus_projects",
  // Watch history (format 20): each uploaded Takeout file, then its raw events. Authored, kept so a restore
  // does not lose years of history; `watch_events` references `watch_imports` and `users`, so it comes second.
  // Neither is a plan input and the engine never reads them.
  "watch_imports",
  "watch_events",
  // The Now offer log (format 21): what Now offered and what happened next. Append-only history nothing regenerates
  // (`plan-retention.ts` deletes the recommendations it describes after a week). References only `users`. A format 20
  // backup has no such table and restores with it empty (`legacy-backups.ts`). The planner never reads it.
  "offer_log"
] as const;

export const BACKUP_TABLES: readonly BackupTable[] = [...CORE_BACKUP_TABLES, ...groupBackupTables("current")];

/**
 * Planning output, the job queue and audit logs. All of it is recomputed from the tables above, and
 * together it is roughly 99% of the byte size of a full backup, so carrying it makes backups large
 * and slow while protecting nothing. Excluded deliberately — not by omission.
 */
const CORE_REGENERABLE_TABLES = [
  "recommendations",
  "recommendation_candidates",
  "forecast_snapshots",
  "planning_runs",
  "jobs",
  // The write ledger (migration 0121): command headers (idempotency, actor), the per-entity change feed and the
  // undo row images. Excluded as the tables it replaced were; no format bump (never in BACKUP_TABLES).
  "writes",
  "write_rows",
  // Agent proposals: a transient queue (a pending row expires after 14 days)
  // plus the audit of what the person decided, like `writes`. Left out of the backup deliberately; adding
  // it to BACKUP_TABLES means a backup format bump and a frozen list of the previous format.
  "agent_proposals",
  // Scoped agent tokens: sha256 hashes of secrets the person
  // revokes at will. Excluded so a restore cannot resurrect a token revoked since the backup was taken;
  // the cost is that a restore revokes every agent token and each is issued again.
  "agent_tokens",
  // Owner tokens and enrolled browsers (same section): hashes of secrets the person revokes at will, left out so
  // a restore cannot resurrect a revoked one. A restore signs every credential out; `OWNER_RECOVERY_TOKEN` is the way back in.
  "owner_credentials",
  // Access tokens minted from an agent token for the remote `/mcp` endpoint (section 4): one hour, hashed, and
  // dead with their agent token, so a restore has nothing to bring back.
  "agent_access_tokens",
  // Agent time: usage observations, read by one Review line and nothing else. Left out of
  // the backup like `writes`; a restore loses the history, and adding it to BACKUP_TABLES would bump the format.
  "agent_sessions",
  // OAuth clients, authorization codes and refresh tokens for the same endpoint: hashed, short-lived, and tied
  // to agent tokens a restore revokes anyway.
  "oauth_clients",
  "oauth_authorization_codes",
  "oauth_refresh_tokens",
  "catch_up_runs",
  "provider_call_telemetry",
  // The daily Google lookup spend: recomputable from
  // `journey_samples`' Google rows, so it rides here rather than in the backup itself.
  "travel_lookup_budget",
  // Web push: a restored subscription in
  // the test database or a restore-verify stack could push to the real phone, and re-enabling on the
  // device costs one tap. The queue is disposable output, not authored data, either way.
  "push_subscriptions",
  "push_outbox",
  // Wakes for the owner's OpenClaw agent: a short-lived queue; a restore must not
  // send an old wake.
  "agent_wakes",
  // The recorder's and publisher's own bookkeeping: fully
  // recomputable from `pulse_segments` (in BACKUP_TABLES above) and the live plan state. It also holds the
  // pulse state machine's memory: a restore without it resumes from the open
  // segment's state, so it stays regenerable. The new `pulse_segments.source`, the pulse threshold columns on
  // `user_preferences` and `check_in_extra_minutes` on commitments and rules ride inside their own tables.
  "pulse_state",
  // A recorded disruption: short-lived, and losing one only lapses the pulse.
  "pulse_disruptions",
  // Public video lengths fetched from YouTube: no user data, refetched on demand, so never backed up.
  "video_info",
  // Passwords and keys the person typed in, encrypted under OPENRHEN_SECRETS_KEY. A backup is not encrypted and may
  // be copied off the machine, so it never carries them; restoring means entering the keys again. No format bump:
  // the table is not part of what a backup contains.
  "app_secrets",
  // The day's YouTube Data API quota use: bookkeeping that resets daily.
  "youtube_quota_use"
] as const;

export const REGENERABLE_TABLES: readonly BackupTable[] = [
  ...CORE_REGENERABLE_TABLES,
  ...groupBackupTables("regenerable")
];

/**
 * Columns that point into `REGENERABLE_TABLES`. Their targets are not restored, so the reference is
 * dropped rather than left dangling. `sessions.recommendation_id` is nullable with ON DELETE SET
 * NULL, which is the same outcome the database would produce if the recommendation were deleted.
 */
export const REFERENCES_CLEARED_ON_RESTORE: Readonly<Record<string, readonly string[]>> = {
  sessions: ["recommendation_id"]
};

/** A table name in a backup: a core table, or one a registered group (`schema/table-groups.ts`) adds. */
export type BackupTable = string;
/** The tables the kept source names itself, for the typed column-rename maps below. */
export type CoreBackupTable = (typeof CORE_BACKUP_TABLES)[number];
/** Core tables are typed by name; a registered group's tables are reached by string, when that group is installed. */
export type BackupTables = Record<CoreBackupTable, Record<string, unknown>[]> &
  Record<string, Record<string, unknown>[]>;

/** The format a new backup is written in. A format bump changes this one constant and nothing else. */
export const CURRENT_BACKUP_FORMAT_VERSION = 21 as const;

/** Only a current-format backup is held to a row-for-row content check on restore (S8-11). */
export function isContentVerifiedFormat(formatVersion: number): boolean {
  return formatVersion === CURRENT_BACKUP_FORMAT_VERSION;
}

/** What this repository writes. Backups already on disk carry it, so the writer keeps it. */
export const BACKUP_FORMAT = "priorities-postgresql-logical-backup" as const;

/**
 * Every format string the reader accepts: the one above and the OpenRhen name, so renaming the format later cannot
 * strand a backup. Add a name here before any writer starts producing it.
 */
export const ACCEPTED_BACKUP_FORMATS = [BACKUP_FORMAT, "openrhen-postgresql-logical-backup"] as const;

export interface OpenRhenBackup {
  format: (typeof ACCEPTED_BACKUP_FORMATS)[number];
  formatVersion: number;
  createdAt: string;
  sourceDatabase: string;
  tables: BackupTables;
  sha256: string;
}

export function checksum(tables: Record<string, Record<string, unknown>[]>): string {
  return createHash("sha256").update(JSON.stringify(tables)).digest("hex");
}

export function databaseName(connectionString: string): string {
  return decodeURIComponent(new URL(connectionString).pathname.replace(/^\//, ""));
}

/**
 * Reads every backed-up table from ONE snapshot. The reads run inside a single
 * `REPEATABLE READ, READ ONLY` transaction, so a parent and child written between two SELECTs by
 * the portal or a worker cannot land in the backup as an orphan or as skew between tables (S8-04).
 * The reads are sequential on that transaction's one connection.
 */
export async function readAllTables(sql: postgres.Sql): Promise<BackupTables> {
  return (await sql.begin("isolation level repeatable read read only", async (transaction) => {
    const entries: (readonly [string, Record<string, unknown>[]])[] = [];
    for (const table of BACKUP_TABLES) {
      const rows = await transaction.unsafe<Record<string, unknown>[]>(`SELECT * FROM "${table}" ORDER BY 1`);
      entries.push([table, [...rows]] as const);
    }
    return Object.fromEntries(entries) as BackupTables;
  })) as BackupTables;
}

/**
 * Tables whose content differs between what a restore inserted and what it reads back. Row counts
 * alone let wrong-typed, truncated or dropped values through (S8-11). Compared per table by
 * checksum so the answer names the table.
 */
export function tablesWithDifferentContent(
  expected: Readonly<Record<string, Record<string, unknown>[]>>,
  actual: Readonly<Record<string, Record<string, unknown>[]>>
): string[] {
  return Object.keys(expected).filter(
    (table) => checksum({ [table]: expected[table] ?? [] }) !== checksum({ [table]: actual[table] ?? [] })
  );
}

/**
 * Guards against the failure this module already suffered once: a migration adds a table, nobody
 * updates `BACKUP_TABLES`, and backups keep reporting success while quietly omitting it.
 */
export async function assertBackupCoverage(sql: postgres.Sql): Promise<void> {
  const rows = await sql.unsafe<{ tablename: string }[]>(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '__drizzle_migrations'
  `);
  const known = new Set<string>([...BACKUP_TABLES, ...REGENERABLE_TABLES]);
  const unclassified = rows
    .map((row) => row.tablename)
    .filter((table) => !known.has(table))
    .sort();
  if (unclassified.length) {
    throw new Error(
      `Backup coverage is out of date. These tables exist in the database but are listed in neither ` +
        `BACKUP_TABLES nor REGENERABLE_TABLES: ${unclassified.join(", ")}. Add each one to the ` +
        `appropriate list in backup-format.ts — to BACKUP_TABLES (after every table it references) if ` +
        `it holds authored data, or to REGENERABLE_TABLES if it is recomputed output.`
    );
  }
  const missing = BACKUP_TABLES.filter((table) => !rows.some((row) => row.tablename === table));
  if (missing.length)
    throw new Error(`BACKUP_TABLES names tables that do not exist: ${missing.join(", ")}. Run migrations first.`);
}

export function validateBackup(value: unknown): OpenRhenBackup {
  if (!value || typeof value !== "object") throw new Error("Backup is not a JSON object");
  const backup = value as Partial<OpenRhenBackup>;
  if (!ACCEPTED_BACKUP_FORMATS.includes(backup.format as never) || !backup.tables || !backup.sha256) {
    throw new Error("Unsupported or incomplete OpenRhen backup");
  }
  const version = backup.formatVersion;
  // An older format is read only where the legacy reader registers its table list (format 20 is registered there).
  const required =
    version === CURRENT_BACKUP_FORMAT_VERSION
      ? BACKUP_TABLES
      : typeof version === "number"
        ? legacyRequiredTables(version)
        : undefined;
  if (!required) {
    const reason =
      typeof version === "number" &&
      Number.isInteger(version) &&
      version >= 1 &&
      version < CURRENT_BACKUP_FORMAT_VERSION
        ? `: this build restores format ${CURRENT_BACKUP_FORMAT_VERSION} backups${
            legacyRequiredTables(CURRENT_BACKUP_FORMAT_VERSION - 1)
              ? ` and format ${CURRENT_BACKUP_FORMAT_VERSION - 1} ones`
              : ""
          } only`
        : "";
    throw new Error(`Unsupported backup formatVersion ${String(version)}${reason}`);
  }
  for (const table of required) {
    if (!Array.isArray((backup.tables as Record<string, unknown>)[table]))
      throw new Error(`Backup is missing table ${table}`);
  }
  if (checksum(backup.tables) !== backup.sha256) throw new Error("Backup checksum does not match its contents");
  return backup as OpenRhenBackup;
}

/** Tables a given backup cannot restore, so restore can say so instead of silently leaving them empty. */
export function tablesAbsentFrom(backup: OpenRhenBackup): BackupTable[] {
  return BACKUP_TABLES.filter((table) => !Array.isArray(backup.tables[table]));
}

/**
 * Which columns a restore may name for one table, and what that leaves out on either side.
 *
 * `restore.ts` used to insert with `SELECT *` over `json_populate_recordset(NULL::"t", …)`. That
 * builds every row from a NULL base record, so a column the backup does not carry arrives as an
 * explicit `NULL` — which **overrides the column's `DEFAULT`** rather than letting it apply. A
 * `NOT NULL` column added after a backup was written therefore fails the whole restore even when it
 * has a perfectly good default. That is not hypothetical: a real `formatVersion` 1 backup dies on
 * `user_preferences.preferred_bedtime`, which is `NOT NULL DEFAULT '22:00'`.
 *
 * Naming the columns the backup actually carries fixes both directions at once. Omitted columns are
 * left to their `DEFAULT`, and keys the backup carries for columns that no longer exist are dropped
 * instead of being relied on to be ignored. `defaulted` and `dropped` are returned so a restore can
 * report what it did rather than quietly reshaping the row.
 *
 * Column order follows the table, not the JSON, so the generated SQL is deterministic.
 */
export function restorableColumns(
  rows: readonly Record<string, unknown>[],
  tableColumns: readonly string[]
): { insert: string[]; defaulted: string[]; dropped: string[] } {
  const present = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) present.add(key);
  const columns = new Set(tableColumns);
  return {
    insert: tableColumns.filter((column) => present.has(column)),
    defaulted: tableColumns.filter((column) => !present.has(column)),
    dropped: [...present].filter((key) => !columns.has(key)).sort()
  };
}
