import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type postgres from "postgres";
import { writeFileAtomic } from "./backup-files.js";
import {
  assertBackupCoverage,
  BACKUP_FORMAT,
  checksum,
  CURRENT_BACKUP_FORMAT_VERSION,
  databaseName,
  readAllTables,
  type OpenRhenBackup
} from "./backup-format.js";
import { sectionFileName, writeSection, type StreamedSection } from "./streamed-sections.js";

export interface BackupResult {
  path: string;
  records: number;
  bytes: number;
  checksum: string;
  /** Streamed section files written beside the JSON, with their absolute paths. */
  sections: (StreamedSection & { path: string; table: string })[];
}

/**
 * Writes one backup into `directory`: the JSON manifest plus a streamed NDJSON section for each streamed table
 * (`activity_events`). Everything is read in one snapshot. Section files are written first, each atomically, and the JSON
 * is renamed into place last, so a backup name never appears without its sections; a failure removes what it wrote.
 */
export async function writeBackup(
  sql: postgres.Sql,
  options: { databaseUrl: string; directory: string; createdAt?: string }
): Promise<BackupResult> {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const filename = `priorities-${createdAt.replace(/[:.]/g, "-")}.json`;
  const outputPath = resolve(options.directory, filename);
  await assertBackupCoverage(sql);
  await mkdir(options.directory, { recursive: true });
  const sections: BackupResult["sections"] = [];
  try {
    const tables = await readAllTables(sql, {
      streamTo: async (table, batches) => {
        const file = sectionFileName(filename, table);
        const path = resolve(options.directory, file);
        const written = await writeSection(path, batches);
        const section = { file, ...written };
        sections.push({ ...section, path, table });
        return section;
      }
    });
    const backup: OpenRhenBackup = {
      format: BACKUP_FORMAT,
      formatVersion: CURRENT_BACKUP_FORMAT_VERSION,
      createdAt,
      sourceDatabase: databaseName(options.databaseUrl),
      tables,
      streamed: Object.fromEntries(sections.map(({ path: _path, table, ...section }) => [table, section])),
      sha256: checksum(tables)
    };
    // Written compact: nothing reads this by eye, and indenting it doubles the file on disk.
    // Atomic: a kill or full disk leaves a .partial file, never a truncated file with a backup name.
    const text = `${JSON.stringify(backup)}\n`;
    await writeFileAtomic(outputPath, text);
    const records =
      Object.values(tables).reduce((total, rows) => total + rows.length, 0) +
      sections.reduce((total, section) => total + section.rows, 0);
    return { path: outputPath, records, bytes: Buffer.byteLength(text), checksum: backup.sha256, sections };
  } catch (error) {
    for (const section of sections) await rm(section.path, { force: true });
    throw error;
  }
}
