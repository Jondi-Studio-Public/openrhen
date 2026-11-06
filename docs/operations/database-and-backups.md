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

`platform/database/src/operations/backup-format.ts` sorts every table into one of two lists. `BACKUP_TABLES` holds authored data, ordered so that restoring in sequence never violates a foreign key. `REGENERABLE_TABLES` holds planning output, the job queue and audit logs, all recomputed from the first list. A backup fails if any table in the database appears in neither list, so adding a table forces a decision about it. Where an authored table references a regenerable one, the reference is cleared on restore. Format 20 added `watch_imports` and `watch_events` (Takeout watch history) to the first list and `video_info` (public video lengths) to the second; this build restores format 20 only.

Backups are written under `var/backups`, which is git-ignored because they contain your tasks, notes and imported content. The format is versioned and checksummed but **not encrypted**: treat access to a backup as access to the database.

## Verify and restore

Prove the newest backup restores into an isolated database:

```text
corepack pnpm db:restore:verify
```

This verifies the SHA-256 checksum, applies the current schema to a scratch database, restores every record in one transaction, and compares every table's row count. It refuses any target whose name does not end in `_restore_test`, so ordinary use cannot overwrite the live database.

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
