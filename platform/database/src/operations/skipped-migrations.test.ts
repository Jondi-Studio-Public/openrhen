import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";
import journal from "../../drizzle/meta/_journal.json" with { type: "json" };
import { checkAppliedMigrations, checkDatabaseMigrations, journalMigrations } from "./skipped-migrations.js";

const migration = (tag: string, when: number) => ({ tag, when, hashes: [`hash-${tag}`] });
const applied = (tag: string, when: number) => ({ hash: `hash-${tag}`, createdAt: when });
const migrations = [migration("0000_a", 100), migration("0001_b", 200), migration("0002_c", 300)];

describe("checkAppliedMigrations", () => {
  it("reports nothing when every migration is applied", () => {
    expect(
      checkAppliedMigrations(
        migrations,
        migrations.map((m) => applied(m.tag, m.when))
      )
    ).toEqual({
      pending: [],
      skipped: []
    });
  });

  it("lists migrations newer than the latest applied one as pending", () => {
    expect(checkAppliedMigrations(migrations, [applied("0000_a", 100)])).toEqual({
      pending: ["0001_b", "0002_c"],
      skipped: []
    });
  });

  it("lists an unapplied migration older than an applied one as skipped", () => {
    expect(checkAppliedMigrations(migrations, [applied("0000_a", 100), applied("0002_c", 300)])).toEqual({
      pending: [],
      skipped: ["0001_b"]
    });
  });

  it("counts a file edited after it was applied by its when", () => {
    const rows = [applied("0000_a", 100), { hash: "hash-of-the-old-0001_b", createdAt: 200 }, applied("0002_c", 300)];
    expect(checkAppliedMigrations(migrations, rows)).toEqual({ pending: [], skipped: [] });
  });

  it("does not let a re-stamped migration's old row stand in for another entry", () => {
    // 2026-09-01: 0056 applied at 700, then re-stamped 900 with 0054 slotted in at 700 and 0055 at 800.
    const journal = [migration("0054", 700), migration("0055", 800), migration("0056", 900)];
    const rows = [applied("0056", 700), applied("0055", 800)];
    expect(checkAppliedMigrations(journal, rows)).toEqual({ pending: [], skipped: ["0054"] });
  });

  it("does not let a second row for the same file stand in for another entry, whatever the row order", () => {
    // 0056 applied at its old stamp (700) and again at its new one (900): two rows, one hash.
    const journal = [migration("0054", 700), migration("0055", 800), migration("0056", 900)];
    const rows = [applied("0056", 700), applied("0055", 800), applied("0056", 900)];
    for (const order of [rows, [...rows].reverse()])
      expect(checkAppliedMigrations(journal, order)).toEqual({ pending: [], skipped: ["0054"] });
  });

  it("treats every migration as pending on an empty database", () => {
    expect(checkAppliedMigrations(migrations, [])).toEqual({ pending: migrations.map((m) => m.tag), skipped: [] });
  });
});

describe("checkDatabaseMigrations", () => {
  const folder = resolve(import.meta.dirname, "../../drizzle");

  it("hashes the bundled journal the way drizzle does", () => {
    const bundled = journalMigrations(folder);
    expect(bundled.map((m) => m.tag)).toEqual(journal.entries.map((entry) => entry.tag));
    const drizzleHashes = readMigrationFiles({ migrationsFolder: folder }).map((file) => file.hash);
    expect(bundled.map((m) => m.hashes[0])).toEqual(drizzleHashes);
  });

  it("recognises the LF hash the deploy stored from a CRLF (Windows) checkout", () => {
    const copy = mkdtempSync(join(tmpdir(), "crlf-migrations-"));
    try {
      cpSync(folder, copy, { recursive: true });
      const tag = journal.entries[0]!.tag;
      const path = join(copy, `${tag}.sql`);
      writeFileSync(path, readFileSync(path, "utf8").replace(/\r?\n/g, "\r\n"));
      const lf = journalMigrations(folder)[0]!.hashes[0]!;
      expect(journalMigrations(copy)[0]!.hashes).toContain(lf);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });

  it("reads the applied rows and reports none skipped for a fully migrated database", async () => {
    const rows = journalMigrations(folder).map((m) => ({ hash: m.hashes[0]!, created_at: String(m.when) }));
    expect(await checkDatabaseMigrations(async () => rows, folder)).toEqual({ pending: [], skipped: [] });
  });

  it("treats a missing migrations table as nothing applied", async () => {
    const missing = Object.assign(new Error("relation does not exist"), { code: "42P01" });
    const result = await checkDatabaseMigrations(async () => {
      throw missing;
    }, folder);
    expect(result.pending).toHaveLength(journal.entries.length);
  });

  it("rethrows any other database error", async () => {
    await expect(
      checkDatabaseMigrations(async () => {
        throw new Error("connection refused");
      }, folder)
    ).rejects.toThrow("connection refused");
  });
});
