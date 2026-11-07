import { config } from "dotenv";
import { mkdir } from "node:fs/promises";
import { writeFileAtomic } from "./backup-files.js";
import { resolve } from "node:path";
import postgres from "postgres";
import {
  assertBackupCoverage,
  BACKUP_FORMAT,
  checksum,
  CURRENT_BACKUP_FORMAT_VERSION,
  databaseName,
  readAllTables,
  type OpenRhenBackup,
  type SkippedBackupTable
} from "./backup-format.js";

config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const backupDirectory = resolve(process.cwd(), process.env.BACKUP_DIRECTORY ?? "../../var/backups");
const createdAt = new Date().toISOString();
const filename = `priorities-${createdAt.replace(/[:.]/g, "-")}.json`;
const outputPath = resolve(backupDirectory, filename);

const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10, fetch_types: false });
try {
  await assertBackupCoverage(sql);
  const skipped: SkippedBackupTable[] = [];
  const tables = await readAllTables(sql, skipped);
  const backup: OpenRhenBackup = {
    format: BACKUP_FORMAT,
    formatVersion: CURRENT_BACKUP_FORMAT_VERSION,
    createdAt,
    sourceDatabase: databaseName(databaseUrl),
    tables,
    ...(skipped.length ? { skipped } : {}),
    sha256: checksum(tables)
  };
  for (const entry of skipped) console.error(`WARNING: ${entry.table} was left out of this backup. ${entry.reason}`);
  await mkdir(backupDirectory, { recursive: true });
  // Written compact: nothing reads this by eye, and indenting it doubles the file on disk.
  // Atomic: a kill or full disk leaves a .partial file, never a truncated file with a backup name.
  const text = `${JSON.stringify(backup)}\n`;
  await writeFileAtomic(outputPath, text);
  const records = Object.values(tables).reduce((total, rows) => total + rows.length, 0);
  // `bytes` is logged each run so growth toward V8's ~512 MB string limit is visible (S8-16).
  console.log(
    JSON.stringify({
      backup: outputPath,
      records,
      bytes: Buffer.byteLength(text),
      checksum: backup.sha256,
      ...(skipped.length ? { skipped } : {})
    })
  );
} finally {
  await sql.end();
}
