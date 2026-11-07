import { config } from "dotenv";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { databaseName, validateBackup } from "./backup-format.js";
import { loadMigrationSets, migratorOptions } from "./migration-sets.js";
import { upgradeLegacyBackup } from "./private/legacy-backups.js";
import { restoreBackup } from "./restore-run.js";
import { verifySection } from "./streamed-sections.js";
import { latestValidBackup } from "./backup-files.js";
import { missingBlobHashes, referencedBlobHashes } from "./photo-blobs.js";

config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required");

const restoreDatabaseName =
  process.env.RESTORE_DATABASE_NAME ?? `${process.env.TARGET_DATABASE_NAME ?? "rhen"}_restore_test`;
if (!/^[A-Za-z][A-Za-z0-9_]*_restore_test$/.test(restoreDatabaseName)) {
  throw new Error("RESTORE_DATABASE_NAME must be an identifier ending in _restore_test");
}

const backupDirectory = resolve(process.cwd(), process.env.BACKUP_DIRECTORY ?? "../../var/backups");
// A backup is only usable if its streamed sections are beside it and intact, so loading checks them (rows, bytes and
// sha256 against the manifest) before anything else happens. A broken section skips the file like a truncated JSON.
const loadBackup = async (text: string, path: string) => {
  const backup = validateBackup(JSON.parse(text) as unknown);
  for (const section of Object.values(backup.streamed ?? {})) {
    const sectionPath = resolve(dirname(path), section.file);
    try {
      await verifySection(sectionPath, section);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new Error(`Backup section ${section.file} is missing from ${dirname(path)}`);
      throw error;
    }
  }
  return backup;
};
// With BACKUP_FILE the named file must validate or the run fails; without it, a truncated newest
// file is skipped for the previous good one instead of failing a recovery (S8-10).
const chosen = process.env.BACKUP_FILE
  ? (() => {
      const path = resolve(process.env.BACKUP_FILE);
      return readFile(path, "utf8").then(async (text) => ({
        path,
        backup: await loadBackup(text, path),
        skipped: [] as string[]
      }));
    })()
  : latestValidBackup(backupDirectory, loadBackup);
const { path: backupPath, backup: validated, skipped } = await chosen;
for (const note of skipped) console.error(`Skipped unusable backup ${note}`);
// The upgrade runs after validation (which checks the backup's own on-disk shape against the table set its
// formatVersion actually carried) and before anything reads `backup.tables`, so every consumer below sees the
// current shape however old the file is. A current-format backup passes through unchanged.
const backup = upgradeLegacyBackup(validated);

const restoreUrl = new URL(adminUrl);
restoreUrl.pathname = `/${restoreDatabaseName}`;

const admin = postgres(adminUrl, { max: 1, connect_timeout: 10 });
try {
  const existing = await admin<{ exists: boolean }[]>`
    SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${restoreDatabaseName}) AS exists
  `;
  if (!existing[0]?.exists) await admin.unsafe(`CREATE DATABASE "${restoreDatabaseName}"`);
} finally {
  await admin.end();
}

const migrationSql = postgres(restoreUrl.toString(), { max: 1, connect_timeout: 10 });
try {
  // A restore target is empty, so both sets simply run in full (core first); adoption is migrate-on-deploy's job.
  const { all } = loadMigrationSets({ coreFolder: resolve(process.cwd(), "drizzle") });
  for (const set of all) await migrate(drizzle(migrationSql), migratorOptions(set));
} finally {
  await migrationSql.end();
}

const restoreSql = postgres(restoreUrl.toString(), { max: 1, connect_timeout: 10, fetch_types: false });
try {
  const { absent, present, reshaped, restored, streamedRows, records } = await restoreBackup(
    restoreSql,
    backup,
    backupPath
  );
  // Photos are files beside the database, so a restore is only whole if every photo it points at exists. The
  // backup copy (BACKUP_COPY_DIR/photos, what `backup:run` keeps add-only) is what protects them, so a hash
  // missing there fails the run; the live store is reported only, since a fresh machine may not hold it yet.
  const referenced = referencedBlobHashes(restored);
  const copyDirectory = process.env.BACKUP_COPY_DIR?.trim();
  const missingFromCopy = copyDirectory
    ? await missingBlobHashes(resolve(copyDirectory, "photos"), referenced)
    : undefined;
  if (missingFromCopy?.length)
    throw new Error(`Restore points at ${missingFromCopy.length} photo files missing from the backup copy`);
  const missingFromStore = referenced.length
    ? await missingBlobHashes(
        resolve(process.cwd(), process.env.PHOTO_STORE_HOST_DIR?.trim() || "../../var/photos"),
        referenced
      )
    : [];
  console.log(
    JSON.stringify({
      restoredFrom: backupPath,
      restoredTo: databaseName(restoreUrl.toString()),
      formatVersion: backup.formatVersion,
      records,
      verifiedTables: present.length,
      ...(Object.keys(streamedRows).length ? { streamedRows } : {}),
      ...(referenced.length
        ? {
            photoFiles: {
              referenced: referenced.length,
              missingFromLiveStore: missingFromStore.length,
              ...(missingFromCopy ? { checkedInBackupCopy: true } : {})
            }
          }
        : {}),
      ...(absent.length ? { emptyBecauseAbsentFromBackup: absent } : {}),
      ...(backup.skipped?.length ? { leftOutOfTheBackup: backup.skipped } : {}),
      ...(Object.keys(reshaped).length ? { columnsReshaped: reshaped } : {})
    })
  );
} finally {
  await restoreSql.end();
}
