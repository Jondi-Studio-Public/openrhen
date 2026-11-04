// This export reads backups in the current format only, so it recognises no older version.
import type { BackupTable, OpenRhenBackup } from "../backup-format.js";

export function legacyRequiredTables(_formatVersion: number): readonly BackupTable[] | undefined {
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
