/**
 * Registry of optional table groups. A group is a set of tables that lives in its own file under
 * `schema/private/` and is registered by importing that file (via `schema/private/index.ts`), so the
 * kept source never names a group's tables: `backup-format.ts` asks this registry which extra tables
 * each backup table list carries, and builds the same lists as before when every group is installed
 * and the core-only lists when none is.
 *
 * Group tables are appended after the core tables of a list. That is foreign-key safe because a group
 * table only ever references core tables or tables earlier in its own group, and no core table
 * references a group table.
 */
import type { Sql } from "postgres";
import type { Shifter } from "../operations/demo-seed/demo-dates.js";

/** The backup table lists a group can add tables to; `vN` is the frozen `LEGACY_VN_TABLES` list. */
export const BACKUP_LIST_IDS = [
  "current",
  "regenerable",
  "v3",
  "v5",
  "v6",
  "v7",
  "v8",
  "v9",
  "v10",
  "v11",
  "v12",
  "v13",
  "v14",
  "v15"
] as const;

export type BackupListId = (typeof BACKUP_LIST_IDS)[number];

export interface TableGroup {
  /** Stable name, unique across groups. */
  id: string;
  /** Per backup list, the group's tables in insertion order. A list not named gets none of them. */
  backup: Partial<Record<BackupListId, readonly string[]>>;
  /** Rows the demo seed (`operations/demo-seed/seed-demo.ts`) writes by SQL for this group, when no API route can. */
  demoSeed?: { heading: string; run: (sql: Sql, shifter: Shifter) => Promise<void> };
}

const groups = new Map<string, TableGroup>();

/** Registers a group once; registering the same id again (a second import path) is a no-op. */
export function registerTableGroup(group: TableGroup): void {
  if (!groups.has(group.id)) groups.set(group.id, group);
}

export function registeredTableGroups(): readonly TableGroup[] {
  return [...groups.values()];
}

/** The tables registered groups add to one backup list, in registration order. */
export function groupBackupTables(list: BackupListId): readonly string[] {
  return registeredTableGroups().flatMap((group) => group.backup[list] ?? []);
}
