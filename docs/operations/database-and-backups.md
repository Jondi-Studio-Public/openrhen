# Database and backups

You need this when you are backing up, restoring or upgrading, or checking where your data lives.

PostgreSQL 17 is OpenRhen's only store. Without a configured database the portal refuses to serve planning state.

## Connection

The Docker path creates and wires a database for you. To use your own, create a dedicated database and a least-privilege login rather than using an administrator account:

```text
Database: openrhen
Role:     openrhen_app
```

The role needs to connect and to create and alter tables while migrations run. Restrict `pg_hba.conf` to trusted hosts, use `scram-sha-256`, and never expose port 5432 to the public internet. Then set, in `.env` (which is git-ignored):

```text
DATABASE_URL=postgresql://openrhen_app:URL_ENCODED_PASSWORD@db.example.com:5432/openrhen?sslmode=require
```

Use `sslmode=disable` only on a trusted local network. Special characters in the user name or password must be URL-encoded. Never paste the password into an issue, a document or a screenshot.

`DATABASE_URL` is a runtime variable, not a build argument: images never contain credentials, and changing the database needs a container restart, not a rebuild.

## Migrations

Apply the schema from the repository root with `corepack pnpm db:migrate` (the `migrate` service does this on `docker compose up`; the command suits a fresh database only, because it does not adopt an existing history). Migrations are append-only: a correction is a new migration. Drizzle applies a migration only when its journal timestamp is newer than every one already applied, so an entry stamped older than a deployed one is skipped silently; CI checks the journal order to catch this when two branches generate migrations.

The first migration is a baseline that replaces the history before the public release (`drizzle/meta/baseline.json` lists it). A database that already holds all of that history is adopted: the deploy takes a dump, writes one ledger row for the baseline and runs nothing from it; later deploys are no-ops until a new migration arrives. A database holding only part of that history is refused with the count that is missing; bring it up to the last release before the baseline first. `MIGRATE_ON_DEPLOY=skip` bypasses the migrator for a restore.

A deployment can add a second, add-on migration set: drizzle migrations in `platform/database/addon-drizzle/` (or `ADDON_MIGRATIONS_FOLDER`), baked into the migrate image, with their own ledger `drizzle.__drizzle_migrations_addon` so their timestamps never order against core's. With no `meta/_journal.json` there, nothing changes. The deploy checks both sets before writing anything (each refusal names its set), takes one dump, then adopts and migrates core, then the add-on, each step committed by itself; a failure names the failed set and the dump, and a rerun finishes the rest. An add-on baseline may declare `"legacyLedger": "core"` in its `meta/baseline.json` to be adopted from the core ledger's history. A ledger with rows but no add-on folder is refused unless `ADDON_MIGRATIONS_OPTOUT=1`. `drizzle.addon.config.ts` generates the set from `src/schema/private/` alone.

The Plan screen shows `PostgreSQL connected`, the server version and latency when the connection works, and `Connection unavailable` (without the connection string) when it does not.

## Backup

Create a checksummed logical backup of every table holding authored data:

```text
corepack pnpm db:backup
```

`platform/database/src/operations/backup-format.ts` sorts every table into one of two lists. `BACKUP_TABLES` holds authored data, ordered so that restoring in sequence never violates a foreign key. `REGENERABLE_TABLES` holds planning output, the job queue and audit logs, all recomputed from the first list. A backup fails if any table in the database appears in neither list, so adding a table forces a decision about it. Where an authored table references a regenerable one, the reference is cleared on restore. Format 20 added `watch_imports` and `watch_events` (Takeout watch history) to the first list and `video_info` (public video lengths) to the second. Format 21 added `offer_log` (the append-only Now offer log: what Now offered and what happened next) to the first list, after `users`; it is history nothing regenerates, and planning retention never touches it. Format 22 added the activity store (`activity_imports`, `activity_events`, `activity_source_state`) to the first list, after `offer_log`. Format 23 changes where the largest of those lives: the JSON backup is one string with one checksum built in memory (1,000,000 synthetic activity rows made a 453 MB file and about 2.4 GB of process memory, and 2,000,000 failed with `Invalid string length`), so `activity_events` rows go to a separate NDJSON file beside it, `<backup name>.activity-events.ndjson`, one row per line, streamed from a Postgres cursor in the same snapshot as the rest and written atomically, so memory stays flat at any size. In the JSON, `tables.activity_events` is empty and a `streamed.activity_events` entry records the file name, row count, byte size and its own SHA-256. It bumps the format because a format 22 build would read such a JSON as complete and restore an empty events table without saying so; this build restores formats 23, 22, 21 and 20: older backups lack the later tables and restore with them empty, and a format 22 file keeps its events in the JSON (or carries a `skipped` entry, reported as `leftOutOfTheBackup`, if its writer left them out over a 500,000-row guard that no longer exists). `legacyRequiredTables` in `operations/private/legacy-backups.ts` holds the frozen table lists. Keep the section file with its JSON: copying, moving or deleting one without the other makes the backup unusable (`backup:run` copies and prunes them together, sections first). `app_secrets` (the sealed keys typed into Settings > Passwords and keys) and `youtube_quota_use` (the day's YouTube quota count) are in the second list, so the JSON backup leaves them out: a backup is not encrypted and may leave the machine, so after restoring from it the keys are entered again. The `pg_dump` taken before a migration (in `/backups`) is a whole-database copy and so holds `app_secrets`, but only as sealed ciphertext; the master key is never in `/backups`. A restore also wipes them: it truncates the users table with CASCADE, which empties both tables, so keys saved before a restore are gone and are entered again even if the backup came from this same machine. That needed no format bump.

Backups are written under `var/backups`, which is git-ignored because they contain your tasks, notes and imported content. The format is versioned and checksummed but **not encrypted**: treat access to a backup as access to the database.

## Verify and restore

Prove the newest backup restores into an isolated database:

```text
corepack pnpm db:restore:verify
```

This verifies the SHA-256 checksum (and, for each streamed section file, its byte size, row count and SHA-256 before anything else; a newest backup with a missing or damaged section is skipped for the previous good one), applies the current schema to a scratch database, restores every record in one transaction (streamed sections in batches, in dependency order: users, activity imports, activity events, settings), and compares every table's row count. For the activity events it also reads the restored table back through the backup's own cursor and serialisation, and its row count and SHA-256 must equal the manifest's, so the check is exact without holding the table in memory. It refuses any target whose name does not end in `_restore_test`, so ordinary use cannot overwrite the live database.

For a real recovery:

1. Keep the damaged database; do not clear it.
2. Set `RESTORE_DATABASE_NAME` to a new name ending in `_restore_test`.
3. Set `BACKUP_FILE` to the chosen backup, or omit it for the newest.
4. Run `corepack pnpm db:restore:verify`.
5. Inspect the restored data by pointing a temporary `DATABASE_URL` at it.
6. Only after checking, switch the portal to the recovered database. Never restore destructively over the original.

With Docker only:

```text
docker compose run --rm backup corepack pnpm db:backup
docker compose run --rm backup corepack pnpm db:restore:verify
docker compose run --rm -e RESTORE_DATABASE_NAME=openrhen_recovered_restore_test backup corepack pnpm db:restore:verify
```

Older backups may lack tables or columns the current schema has. The restore reports what it had to default or drop under `emptyBecauseAbsentFromBackup` and `columnsReshaped`; read that list before promoting an old restore.

## Scheduled backups

The `backup` compose service runs the same backup daily at `BACKUP_TIME` (default 03:30, in `BACKUP_TZ`, default UTC) and pings `BACKUP_PING_URL` before and after, so a missing ping alerts you. Setup is described in [Self-hosting](self-hosting.md#backups). Without Docker, schedule `corepack pnpm backup:run` with cron or your platform's task scheduler; it backs up, verifies, and copies the result to a second location. A final log line with `"status":"ok"` and a `copiedTo` path is a complete run; `localOnly: true` means no copy folder is set, so the backup stayed on this machine (the Data check reports it); a `warnings` array means something else needs a look, such as a restore check skipped for want of `POSTGRES_ADMIN_URL`.

## Retention of planning evidence

Planning tables grow with every change. The worker prunes them hourly in one transaction: finished planning jobs older than `PLANNING_RETENTION_JOB_DAYS` (default 3), and planning runs, forecast snapshots and recommendations older than `PLANNING_RETENTION_RUN_DAYS` (default 7). It always keeps in-flight jobs, the current run, and anything an issue snapshot or session still references. Authored data is never pruned.
