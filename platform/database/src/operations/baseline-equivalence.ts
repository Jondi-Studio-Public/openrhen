import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkAppliedMigrations, type AppliedRow, type JournalMigration } from "./skipped-migrations.js";

/**
 * Baseline equivalence. OpenRhen's journal starts at one baseline migration that replaces the private history
 * before it. A database built by that history already is the baseline, so instead of running the baseline's
 * SQL over it (it would die on `type ... already exists`), the migrator recognises the history in the ledger
 * and records the baseline as applied. `meta/baseline.json` lists the replaced migrations (idx, `when`,
 * file hashes; never tags, which name private features). Everything here is pure and takes the migrations,
 * rows and ledger as parameters, so any migration set can use it.
 */

/** One replaced migration: the same shape `journalMigrations` computes, with the idx in place of the tag. */
export interface LegacyMigration {
  idx: number;
  when: number;
  hashes: string[];
}

export interface BaselineFile {
  version: 1;
  /** The idx of the baseline entry in the journal; the legacy history runs 0 to this. */
  baselineIdx: number;
  legacy: LegacyMigration[];
  /**
   * Which ledger the replaced history is classified against. Absent: the set's own. An add-on set whose
   * baseline replaces tables the core history built says `"core"`, so its legacy rows are looked up there.
   */
  legacyLedger?: "core";
  /** Legacy migrations after the baseline (private-only ones included); their rows are known, never "ahead". */
  laterLegacy?: (LegacyMigration & { exported?: boolean })[];
}

export type LegacyState = "none" | "complete" | "partial";

export interface LegacyClassification {
  state: LegacyState;
  matched: number;
  total: number;
  /** The lowest idx with no ledger row; null when none is missing. */
  firstMissingIdx: number | null;
}

/** `meta/baseline.json` in a migrations folder, or null when the folder has none (a set without a baseline). */
export function loadBaseline(migrationsFolder: string): BaselineFile | null {
  const path = join(migrationsFolder, "meta/baseline.json");
  if (!existsSync(path)) return null;
  const file = JSON.parse(readFileSync(path, "utf8")) as BaselineFile;
  if (file.version !== 1) throw new Error(`Unsupported baseline.json version ${String(file.version)}`);
  return file;
}

const asJournal = (legacy: LegacyMigration[]): JournalMigration[] =>
  legacy.map((entry) => ({ tag: String(entry.idx), when: entry.when, hashes: entry.hashes }));

/**
 * How much of the replaced history `rows` holds, matched with the ledger's usual two steps (file hash, then
 * `created_at == when` for files edited after they were applied). A second row for one file (0056) is spare.
 */
export function classifyLegacy(legacy: LegacyMigration[], rows: AppliedRow[]): LegacyClassification {
  const { pending, skipped } = checkAppliedMigrations(asJournal(legacy), rows);
  const missing = [...pending, ...skipped].map(Number);
  const matched = legacy.length - missing.length;
  return {
    state: matched === 0 ? "none" : missing.length === 0 ? "complete" : "partial",
    matched,
    total: legacy.length,
    firstMissingIdx: missing.length === 0 ? null : Math.min(...missing)
  };
}

/**
 * The rows that belong to the legacy history (before or after the baseline): a row matches an entry by hash,
 * or by `created_at == when`. The ahead check ignores them, so a private-only legacy migration the image
 * does not carry never reads as a database from the future.
 */
export function knownLedgerRows(legacy: LegacyMigration[], laterLegacy: LegacyMigration[], rows: AppliedRow[]) {
  const all = [...legacy, ...laterLegacy];
  const hashes = new Set(all.flatMap((entry) => entry.hashes));
  const whens = new Set(all.map((entry) => entry.when));
  return rows.filter((row) => hashes.has(row.hash) || whens.has(row.createdAt));
}

/** The newest `created_at` among rows that are not known legacy rows: what the ahead check compares. */
export function unknownLedgerTimestamp(baseline: BaselineFile | null, rows: AppliedRow[]): number {
  const known = new Set(baseline ? knownLedgerRows(baseline.legacy, baseline.laterLegacy ?? [], rows) : []);
  return Math.max(0, ...rows.filter((row) => !known.has(row)).map((row) => row.createdAt));
}

export type AdoptionDecision =
  | { action: "fresh"; classification: LegacyClassification }
  | { action: "already"; classification: LegacyClassification }
  | { action: "adopt"; classification: LegacyClassification; baselineTag: string; hash: string; createdAt: number }
  | { action: "refuse"; classification: LegacyClassification; message: string };

/** The baseline's own journal entry. */
export function baselineMigration(
  baseline: BaselineFile,
  migrations: JournalMigration[]
): JournalMigration & { idx: number } {
  const index = migrations.findIndex((migration) =>
    migration.tag.startsWith(String(baseline.baselineIdx).padStart(4, "0"))
  );
  const found = migrations[index];
  if (!found)
    throw new Error(`baseline.json names baselineIdx ${baseline.baselineIdx}, which the journal does not list`);
  return { ...found, idx: baseline.baselineIdx };
}

/**
 * What to do about the baseline for a database with these ledger rows.
 * - the baseline's own hash row is present: `already`, the legacy rows are ignored;
 * - no legacy row: `fresh`, the baseline runs normally;
 * - the whole legacy history: `adopt` the baseline by inserting its row (hash drizzle would write, baseline `when`);
 * - part of it: `refuse`, naming the first missing migration and no private names.
 */
export function decideAdoption(
  baseline: BaselineFile,
  baselineEntry: JournalMigration,
  rows: AppliedRow[],
  legacyRows: AppliedRow[] = rows
): AdoptionDecision {
  // `rows` is the set's own ledger (is the baseline's own row there?); `legacyRows` is the ledger the replaced
  // history lives in, which differs only for an add-on set with `legacyLedger: "core"`.
  const classification = classifyLegacy(baseline.legacy, legacyRows);
  if (rows.some((row) => baselineEntry.hashes.includes(row.hash))) return { action: "already", classification };
  if (classification.state === "none") return { action: "fresh", classification };
  if (classification.state === "partial") {
    return {
      action: "refuse",
      classification,
      message:
        `This database holds ${classification.matched} of ${classification.total} migrations from before the OpenRhen baseline ` +
        `(the first missing is number ${classification.firstMissingIdx}). OpenRhen can only take over a database that is at the last ` +
        "migration of the previous history: restore a pre-migrate dump taken at that point, or deploy the last previous release so it " +
        "migrates fully, then upgrade. To bring the service up on this database unchanged meanwhile, deploy with MIGRATE_ON_DEPLOY=skip " +
        "and remove it afterwards. Nothing was written."
    };
  }
  return {
    action: "adopt",
    classification,
    baselineTag: baselineEntry.tag,
    // The hash drizzle stores is of the file as read, which is the first of the two.
    hash: baselineEntry.hashes[0]!,
    createdAt: baselineEntry.when
  };
}
