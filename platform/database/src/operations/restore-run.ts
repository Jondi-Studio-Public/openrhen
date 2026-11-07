import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import type postgres from "postgres";
import {
  BACKUP_TABLES,
  REFERENCES_CLEARED_ON_RESTORE,
  STREAMED_BACKUP_TABLES,
  isContentVerifiedFormat,
  isStreamedIn,
  readAllTables,
  restorableColumns,
  streamTableRows,
  tablesAbsentFrom,
  tablesWithDifferentContent,
  type BackupTables,
  type OpenRhenBackup
} from "./backup-format.js";
import { fillLegacyRows } from "./private/legacy-backups.js";
import { readSection, type SectionReadback } from "./streamed-sections.js";

export interface RestoreOutcome {
  absent: string[];
  present: string[];
  reshaped: Record<string, { defaulted?: string[]; dropped?: string[] }>;
  /** Every restored table except the streamed ones, read back from the database. */
  restored: BackupTables;
  /** Rows now in each streamed table, counted in the database. */
  streamedRows: Record<string, number>;
  records: number;
}

const insertSql = (table: string, list: string) =>
  `INSERT INTO "${table}" (${list}) SELECT ${list} FROM json_populate_recordset(NULL::"${table}", $1::text::json)`;

/**
 * Loads `backup` into the (migrated, empty or not) database behind `restoreSql` and proves it came back: row counts for
 * every table, row-for-row content for a current-format backup, and for a streamed table the section file's rows are
 * inserted in batches in dependency order (users, activity_imports, activity_events, ...) and the table is then read back
 * through the same cursor and serialisation the backup used, so its row count and sha256 must equal the manifest's.
 * `backupPath` is the JSON backup; section files are resolved beside it.
 */
export async function restoreBackup(
  restoreSql: postgres.Sql,
  backup: OpenRhenBackup,
  backupPath: string
): Promise<RestoreOutcome> {
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

  const reshaped: RestoreOutcome["reshaped"] = {};
  const inserted: Record<string, Record<string, unknown>[]> = {};

  const insertRows = async (
    transaction: postgres.TransactionSql,
    table: string,
    rows: Record<string, unknown>[],
    noteReshape: boolean
  ) => {
    const { insert, defaulted, dropped } = restorableColumns(rows, columnsByTable.get(table) ?? []);
    if (!insert.length) throw new Error(`Backup rows for ${table} name no column that still exists`);
    if (noteReshape && (defaulted.length || dropped.length)) {
      reshaped[table] = { ...(defaulted.length ? { defaulted } : {}), ...(dropped.length ? { dropped } : {}) };
    }
    // Naming the columns is what lets an absent one fall to its DEFAULT. `SELECT *` would insert an
    // explicit NULL from the NULL base record and defeat the default — see `restorableColumns`.
    const list = insert.map((column) => `"${column}"`).join(", ");
    await transaction.unsafe(insertSql(table, list), [JSON.stringify(rows)]);
  };

  await restoreSql.begin(async (transaction) => {
    const targets = BACKUP_TABLES.map((table) => `"${table}"`).join(", ");
    await transaction.unsafe(`TRUNCATE TABLE ${targets} RESTART IDENTITY CASCADE`);
    for (const table of present) {
      if (isStreamedIn(backup, table)) {
        const section = backup.streamed![table]!;
        const readback: SectionReadback = { rows: 0, bytes: 0, sha256: "" };
        let first = true;
        for await (const batch of readSection(resolve(dirname(backupPath), section.file), readback)) {
          const rows = fillLegacyRows(table, backup.formatVersion, batch);
          await insertRows(transaction, table, rows, first);
          first = false;
        }
        continue;
      }
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
      await insertRows(transaction, table, rows, true);
    }
  });

  // A streamed table is not held in memory here: it is counted, and (for a current-format backup) hashed through the
  // backup's own cursor and serialisation. Every other table is read back whole, as before.
  const restored = await readAllTables(restoreSql, { omitStreamed: true });
  const streamedRows: Record<string, number> = {};
  for (const table of STREAMED_BACKUP_TABLES) {
    if (!present.includes(table)) continue;
    const [held] = await restoreSql.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${table}"`);
    streamedRows[table] = held!.n;
  }
  const expectedRows = (table: string) =>
    isStreamedIn(backup, table) ? backup.streamed![table]!.rows : (backup.tables[table] ?? []).length;
  const mismatches = present.filter((table) =>
    STREAMED_BACKUP_TABLES.includes(table)
      ? streamedRows[table] !== expectedRows(table)
      : (restored[table] ?? []).length !== expectedRows(table)
  );
  if (mismatches.length) throw new Error(`Restore row-count mismatch: ${mismatches.join(", ")}`);
  if (isContentVerifiedFormat(backup.formatVersion)) {
    // A current-format backup must come back identical, not just the same length (S8-11): compare
    // what was inserted against what was read back, and treat any reshaping as backup/schema drift.
    const comparable = present.filter((table) => !STREAMED_BACKUP_TABLES.includes(table));
    const different = tablesWithDifferentContent(
      Object.fromEntries(comparable.map((table) => [table, inserted[table] ?? []])),
      restored
    );
    for (const table of STREAMED_BACKUP_TABLES) {
      const section = backup.streamed?.[table];
      if (!section) continue;
      const hash = createHash("sha256");
      let rows = 0;
      for await (const batch of streamTableRows(restoreSql, table)) {
        hash.update(`${batch.map((row) => JSON.stringify(row)).join("\n")}\n`);
        rows += batch.length;
      }
      if (rows !== section.rows || hash.digest("hex") !== section.sha256) different.push(table);
    }
    if (different.length) throw new Error(`Restore content mismatch: ${different.join(", ")}`);
    if (Object.keys(reshaped).length)
      throw new Error(`Current-format backup was reshaped on restore: ${JSON.stringify(reshaped)}`);
  }
  const records =
    present
      .filter((table) => !STREAMED_BACKUP_TABLES.includes(table))
      .reduce((total, table) => total + (restored[table] ?? []).length, 0) +
    Object.values(streamedRows).reduce((total, n) => total + n, 0);
  return { absent, present, reshaped, restored, streamedRows, records };
}
