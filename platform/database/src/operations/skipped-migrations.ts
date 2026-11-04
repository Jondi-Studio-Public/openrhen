import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { baselineMigration, decideAdoption, loadBaseline } from "./baseline-equivalence.js";

/**
 * One journal migration as drizzle records it: the journal's `when`, and the sha256 drizzle stores for the
 * file. That is the file as read, so a Windows checkout with CRLF line endings hashes differently from the
 * LF file the deploy applied; `hashes` holds both.
 */
export interface JournalMigration {
  tag: string;
  when: number;
  hashes: string[];
}

/** One row of `drizzle.__drizzle_migrations`; `created_at` is the applied migration's `when`. */
export interface AppliedRow {
  hash: string;
  createdAt: number;
}

export interface MigrationCheck {
  /** Newer than everything applied: the next `migrate` runs them. */
  pending: string[];
  /** Not applied, yet no newer than the latest applied one, so drizzle will never run them. */
  skipped: string[];
}

/**
 * Which journal migrations a database has not applied, split into pending and skipped. Drizzle decides by
 * timestamp alone (it runs entries whose `when` is newer than the newest `created_at`), so an entry that
 * was stamped older than an applied one is passed over for good, and `pendingMigrationTags` cannot see it.
 * This matches applied rows to entries by file hash first, then, for files edited after they were applied
 * (0063 and 0077-0083 were), by `when`. Hash first matters: a re-stamped entry's old `when` can equal
 * another entry's, as 0056's did 0054's on 2026-09-01. A row whose hash is a known file's never stands in
 * for another entry by `when`, even when it is a second row for the same file (0056 applied at both stamps).
 */
export function checkAppliedMigrations(migrations: JournalMigration[], rows: AppliedRow[]): MigrationCheck {
  const unmatched = [...rows];
  const take = (match: (row: AppliedRow) => boolean) => {
    const index = unmatched.findIndex(match);
    if (index === -1) return false;
    unmatched.splice(index, 1);
    return true;
  };
  const missing = migrations.filter((migration) => !take((row) => migration.hashes.includes(row.hash)));
  const known = new Set(migrations.flatMap((migration) => migration.hashes));
  for (let index = unmatched.length - 1; index >= 0; index--)
    if (known.has(unmatched[index]!.hash)) unmatched.splice(index, 1);
  const notApplied = missing.filter((migration) => !take((row) => row.createdAt === migration.when));
  const latest = Math.max(0, ...rows.map((row) => row.createdAt));
  return {
    pending: notApplied.filter((migration) => migration.when > latest).map((migration) => migration.tag),
    skipped: notApplied.filter((migration) => migration.when <= latest).map((migration) => migration.tag)
  };
}

type Query = (strings: TemplateStringsArray) => PromiseLike<{ hash: string; created_at: string }[]>;

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The hashes of a migration file's text: as drizzle stores it (as read), and with LF line endings. */
export function migrationHashes(text: string): string[] {
  return [...new Set([sha256(text), sha256(text.replace(/\r\n/g, "\n"))])];
}

/** The folder's journal with each file's hashes: as drizzle's migrator computes it, and with LF line endings. */
export function journalMigrations(migrationsFolder: string): JournalMigration[] {
  const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
    entries: { tag: string; when: number }[];
  };
  return journal.entries.map((entry) => {
    const text = readFileSync(join(migrationsFolder, `${entry.tag}.sql`)).toString();
    return { tag: entry.tag, when: entry.when, hashes: migrationHashes(text) };
  });
}

/** Every row of `drizzle.__drizzle_migrations` (none when the table does not exist yet). Read-only. */
export async function readLedgerRows(sql: Query): Promise<AppliedRow[]> {
  try {
    const result = await sql`SELECT hash, created_at::text AS created_at FROM drizzle.__drizzle_migrations`;
    return result.map((row) => ({ hash: row.hash, createdAt: Number(row.created_at) }));
  } catch (error) {
    // 42P01: the migrations table does not exist yet, so nothing has been applied.
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "42P01")) throw error;
    return [];
  }
}

/**
 * Read-only: what `migrationsFolder` holds that this database has not applied. A database that holds the whole
 * pre-baseline history but not the baseline's own row counts the baseline as applied (`baseline-equivalence.ts`);
 * only `migrate-on-deploy` writes the adoption row.
 */
export async function checkDatabaseMigrations(sql: Query, migrationsFolder: string): Promise<MigrationCheck> {
  const rows = await readLedgerRows(sql);
  const migrations = journalMigrations(migrationsFolder);
  const baseline = loadBaseline(migrationsFolder);
  const decision = baseline ? decideAdoption(baseline, baselineMigration(baseline, migrations), rows) : null;
  const check = checkAppliedMigrations(migrations, rows);
  if (decision?.action !== "adopt") return check;
  const tag = decision.baselineTag;
  return { pending: check.pending.filter((t) => t !== tag), skipped: check.skipped.filter((t) => t !== tag) };
}

/** The error a deploy fails with when a migration was skipped. */
export function skippedMigrationsMessage(skipped: string[]): string {
  return (
    `${skipped.length} migration${skipped.length === 1 ? " was" : "s were"} skipped: ${skipped.join(", ")}. ` +
    "Drizzle never applies a journal entry stamped older than one the database already has. Apply each file's SQL by hand " +
    "in one transaction and insert its row into drizzle.__drizzle_migrations, then redeploy."
  );
}
