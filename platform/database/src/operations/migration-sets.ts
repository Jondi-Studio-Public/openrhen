import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  baselineMigration,
  decideAdoption,
  loadBaseline,
  unknownLedgerTimestamp,
  type AdoptionDecision,
  type BaselineFile
} from "./baseline-equivalence.js";
import { imageNewestMigration, pendingTagsAfter, schemaAheadProblem } from "./pending-migrations.js";
import {
  checkAppliedMigrations,
  journalMigrations,
  type AppliedRow,
  type JournalMigration,
  type LedgerTable
} from "./skipped-migrations.js";

/**
 * Migration sets. OpenRhen's `core` set is the journal in `drizzle/`. A deployment may add a second, `addon`,
 * set (its own tables, such as the private push channels) from `addon-drizzle/`; it has its own ledger table
 * because `max(created_at)` is global to a ledger and core and add-on stamps must never order against each
 * other. A folder with no `meta/_journal.json` is no add-on, so a core-only install sees one set, as before.
 * The functions here are pure apart from reading the folders; the callers (migrate-on-deploy, dev migrate,
 * check-migrations, restore) own the database.
 */

export type SetName = "core" | "addon";

export interface MigrationSet {
  name: SetName;
  folder: string;
  /** The ledger table in the `drizzle` schema. */
  table: LedgerTable;
  journal: JournalMigration[];
  baseline: BaselineFile | null;
  /** Which ledger the baseline's replaced history is classified against. */
  legacyLedger: SetName;
}

export const CORE_TABLE: LedgerTable = "__drizzle_migrations";
export const ADDON_TABLE: LedgerTable = "__drizzle_migrations_addon";

function readSet(name: SetName, folder: string): MigrationSet {
  const baseline = loadBaseline(folder);
  return {
    name,
    folder,
    table: name === "core" ? CORE_TABLE : ADDON_TABLE,
    journal: journalMigrations(folder),
    baseline,
    legacyLedger: name === "addon" && baseline?.legacyLedger === "core" ? "core" : name
  };
}

/** The folder the add-on set is read from: `ADDON_MIGRATIONS_FOLDER`, else `addon-drizzle` beside `drizzle`. */
export function addonFolder(env: NodeJS.ProcessEnv = process.env): string {
  return env.ADDON_MIGRATIONS_FOLDER || resolve(process.cwd(), "addon-drizzle");
}

/** Whether the folder holds an add-on journal (a folder with only a `.gitkeep` does not). */
export function hasAddon(folder: string): boolean {
  return existsSync(join(folder, "meta/_journal.json"));
}

/** The core set, then the add-on set when its folder has a journal. Core is always first. */
export function loadMigrationSets(
  options: { coreFolder?: string; addonFolder?: string; env?: NodeJS.ProcessEnv } = {}
): { core: MigrationSet; addon: MigrationSet | null; all: MigrationSet[] } {
  const env = options.env ?? process.env;
  const core = readSet("core", options.coreFolder ?? env.MIGRATIONS_FOLDER ?? resolve(process.cwd(), "drizzle"));
  const addonDir = options.addonFolder ?? addonFolder(env);
  const addon = hasAddon(addonDir) ? readSet("addon", addonDir) : null;
  return { core, addon, all: addon ? [core, addon] : [core] };
}

/** Drizzle's own ledger DDL (0.45), so adoption can write a row before drizzle's migrator has created the table. */
export const ledgerTableDdl = (table: LedgerTable) =>
  `CREATE SCHEMA IF NOT EXISTS "drizzle"; CREATE TABLE IF NOT EXISTS "drizzle"."${table}" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`;

/** drizzle's migrator options for a set: the default ledger for core, the add-on table for the add-on. */
export const migratorOptions = (set: MigrationSet) =>
  set.name === "core"
    ? { migrationsFolder: set.folder }
    : { migrationsFolder: set.folder, migrationsSchema: "drizzle", migrationsTable: set.table };

/** `message` prefixed so a failure names the set; core's own messages stay as they were. */
export const setMessage = (set: MigrationSet, message: string) =>
  set.name === "core" ? message : `Add-on migration set: ${message}`;

/**
 * The core ledger rows an add-on baseline with `legacyLedger: "core"` is classified against: every row except
 * core's own baseline row. On a database OpenRhen built (no legacy history) that row's `created_at` equals the
 * last legacy `when` by design, so left in it would match that one legacy entry by `when` and read as a
 * partial history, refusing a later add-on run on a perfectly native database.
 */
export function coreLegacyRows(core: MigrationSet, coreRows: AppliedRow[]): AppliedRow[] {
  if (!core.baseline) return coreRows;
  const own = baselineMigration(core.baseline, core.journal).hashes;
  return coreRows.filter((row) => !own.includes(row.hash));
}

export interface SetPlan {
  set: MigrationSet;
  decision: AdoptionDecision | null;
  adopt: Extract<AdoptionDecision, { action: "adopt" }> | null;
  /** Tags the next `migrate()` for this set applies, counting what adoption makes applied as applied. */
  pending: string[];
  skipped: string[];
  /** Why the set must not run (partial legacy, ahead of the image), or null. Nothing has been written. */
  problem: string | null;
}

/**
 * Everything decided about one set from the ledger rows alone. `rows` is the set's own ledger; `coreRows` the
 * core ledger as `coreLegacyRows` filters it, which an add-on baseline with `legacyLedger: "core"` is classified against.
 */
export function planSet(set: MigrationSet, rows: AppliedRow[], coreRows: AppliedRow[]): SetPlan {
  const legacyRows = set.legacyLedger === "core" ? coreRows : rows;
  const decision = set.baseline
    ? decideAdoption(set.baseline, baselineMigration(set.baseline, set.journal), rows, legacyRows)
    : null;
  const adopt = decision?.action === "adopt" ? decision : null;
  const applied = Math.max(0, ...rows.map((row) => row.createdAt));
  const check = checkAppliedMigrations(set.journal, rows);
  const skipped = check.skipped.filter((tag) => tag !== adopt?.baselineTag);
  let problem: string | null = null;
  if (decision?.action === "refuse") problem = setMessage(set, decision.message);
  else {
    // Rows of the replaced history (and legacy migrations after the baseline) are not "ahead" of this image,
    // but only where that history lives in this set's own ledger.
    const known = set.legacyLedger === set.name ? set.baseline : null;
    const ahead = schemaAheadProblem(unknownLedgerTimestamp(known, rows), imageNewestMigration(set.journal));
    if (ahead) problem = setMessage(set, ahead);
  }
  return {
    set,
    decision,
    adopt,
    pending: pendingTagsAfter(adopt ? Math.max(applied, adopt.createdAt) : applied, set.journal),
    skipped,
    problem
  };
}
