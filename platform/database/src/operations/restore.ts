import { config } from "dotenv";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  BACKUP_TABLES,
  REFERENCES_CLEARED_ON_RESTORE,
  databaseName,
  isContentVerifiedFormat,
  readAllTables,
  restorableColumns,
  tablesAbsentFrom,
  tablesWithDifferentContent,
  validateBackup
} from "./backup-format.js";
import { loadMigrationSets, migratorOptions } from "./migration-sets.js";
import { fillLegacyRows, upgradeLegacyBackup } from "./private/legacy-backups.js";
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
const loadBackup = (text: string) => validateBackup(JSON.parse(text) as unknown);
// With BACKUP_FILE the named file must validate or the run fails; without it, a truncated newest
// file is skipped for the previous good one instead of failing a recovery (S8-10).
const chosen = process.env.BACKUP_FILE
  ? (() => {
      const path = resolve(process.env.BACKUP_FILE);
      return readFile(path, "utf8").then((text) => ({ path, backup: loadBackup(text), skipped: [] as string[] }));
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
  const absent = tablesAbsentFrom(backup);
  const present = BACKUP_TABLES.filter((table) => !absent.includes(table));

  // What the migrations actually produced, rather than what the schema module believes.
  const columnRows = await restoreSql<{ table_name: string; column_name: string }[]>`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' ORDER BY table_name, ordinal_position
  `;
  const columnsByTable = new Map<string, string[]>();
  for (const row of columnRows) {
    const columns = columnsByTable.get(row.table_name);
    if (columns) columns.push(row.column_name);
    else columnsByTable.set(row.table_name, [row.column_name]);
  }

  const reshaped: Record<string, { defaulted?: string[]; dropped?: string[] }> = {};
  const inserted: Record<string, Record<string, unknown>[]> = {};

  await restoreSql.begin(async (transaction) => {
    const targets = BACKUP_TABLES.map((table) => `"${table}"`).join(", ");
    await transaction.unsafe(`TRUNCATE TABLE ${targets} RESTART IDENTITY CASCADE`);
    for (const table of present) {
      const cleared = REFERENCES_CLEARED_ON_RESTORE[table] ?? [];
      // Targets live in REGENERABLE_TABLES and are not restored, so the reference has to go before
      // the insert — foreign keys are checked per statement, not at commit.
      const clearedRows = cleared.length
        ? (backup.tables[table] ?? []).map((row) => ({
            ...row,
            ...Object.fromEntries(cleared.map((column) => [column, null]))
          }))
        : (backup.tables[table] ?? []);
      // A column renamed since the backup's own formatVersion is remapped to its current name before
      // restorableColumns sees it, so the old key is matched against the live schema instead of reported as gone.
      const rows = fillLegacyRows(table, backup.formatVersion, clearedRows);
      inserted[table] = rows;
      if (!rows.length) continue;
      const { insert, defaulted, dropped } = restorableColumns(rows, columnsByTable.get(table) ?? []);
      if (!insert.length) throw new Error(`Backup rows for ${table} name no column that still exists`);
      if (defaulted.length || dropped.length) {
        reshaped[table] = { ...(defaulted.length ? { defaulted } : {}), ...(dropped.length ? { dropped } : {}) };
      }
      // Naming the columns is what lets an absent one fall to its DEFAULT. `SELECT *` would insert an
      // explicit NULL from the NULL base record and defeat the default — see `restorableColumns`.
      const list = insert.map((column) => `"${column}"`).join(", ");
      await transaction.unsafe(
        `INSERT INTO "${table}" (${list}) SELECT ${list} FROM json_populate_recordset(NULL::"${table}", $1::text::json)`,
        [JSON.stringify(rows)]
      );
    }
  });

  const restored = await readAllTables(restoreSql);
  const mismatches = present.filter((table) => (restored[table] ?? []).length !== (backup.tables[table] ?? []).length);
  if (mismatches.length) throw new Error(`Restore row-count mismatch: ${mismatches.join(", ")}`);
  if (isContentVerifiedFormat(backup.formatVersion)) {
    // A current-format backup must come back identical, not just the same length (S8-11): compare
    // what was inserted against what was read back, and treat any reshaping as backup/schema drift.
    const different = tablesWithDifferentContent(
      Object.fromEntries(present.map((table) => [table, inserted[table] ?? []])),
      restored
    );
    if (different.length) throw new Error(`Restore content mismatch: ${different.join(", ")}`);
    if (Object.keys(reshaped).length)
      throw new Error(`Current-format backup was reshaped on restore: ${JSON.stringify(reshaped)}`);
  }
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
  const records = present.reduce((total, table) => total + (restored[table] ?? []).length, 0);
  console.log(
    JSON.stringify({
      restoredFrom: backupPath,
      restoredTo: databaseName(restoreUrl.toString()),
      formatVersion: backup.formatVersion,
      records,
      verifiedTables: present.length,
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
      ...(Object.keys(reshaped).length ? { columnsReshaped: reshaped } : {})
    })
  );
} finally {
  await restoreSql.end();
}
