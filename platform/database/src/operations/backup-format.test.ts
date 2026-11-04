import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable, type TableConfig } from "drizzle-orm/pg-core";
import * as schema from "../schema.js";
import { groupBackupTables } from "../schema/table-groups.js";
import {
  ACCEPTED_BACKUP_FORMATS,
  BACKUP_FORMAT,
  CURRENT_BACKUP_FORMAT_VERSION,
  isContentVerifiedFormat,
  BACKUP_TABLES,
  REFERENCES_CLEARED_ON_RESTORE,
  REGENERABLE_TABLES,
  restorableColumns,
  readAllTables,
  tablesWithDifferentContent,
  validateBackup
} from "./backup-format.js";

/** A backup of `formatVersion` carrying exactly `list` as empty tables, checksummed so only the version can fail it. */
const backupOf = (formatVersion: number, list: readonly string[], format: string = BACKUP_FORMAT) => {
  const tables = Object.fromEntries(list.map((table) => [table, []])) as Record<string, unknown[]>;
  return {
    format,
    formatVersion,
    createdAt: new Date().toISOString(),
    sourceDatabase: "openrhen_test",
    tables,
    sha256: createHash("sha256").update(JSON.stringify(tables)).digest("hex")
  };
};

/**
 * The live-database check `assertBackupCoverage` runs (queries `pg_tables`, needs a real Postgres) is
 * the one that actually matters in production, but it cannot run here. This is its schema-only
 * shadow: every table `schema.ts` declares must be named in `BACKUP_TABLES` or `REGENERABLE_TABLES`,
 * checked straight off the Drizzle table objects with no database required. It is exactly the failure
 * mode the module's own comment describes — a migration adds a table and nobody updates this list —
 * caught at `pnpm test` time instead of at the next backup.
 */
describe("backup table coverage", () => {
  it("names every declared table in BACKUP_TABLES or REGENERABLE_TABLES", () => {
    const known = new Set<string>([...BACKUP_TABLES, ...REGENERABLE_TABLES]);
    const declared = Object.values(schema)
      .filter((value) => is(value, PgTable))
      .map((table) => getTableConfig(table as PgTable<TableConfig>).name);
    const unclassified = declared.filter((name) => !known.has(name)).sort();
    expect(unclassified).toEqual([]);
  });

  it("orders BACKUP_TABLES so every foreign key points at an earlier table", () => {
    const position = new Map(BACKUP_TABLES.map((table, index) => [table as string, index]));
    const violations: string[] = [];
    for (const value of Object.values(schema)) {
      if (!is(value, PgTable)) continue;
      const config = getTableConfig(value as PgTable<TableConfig>);
      const child = config.name;
      for (const foreignKey of config.foreignKeys) {
        const reference = foreignKey.reference();
        const parent = getTableConfig(reference.foreignTable).name;
        if (parent === child) continue;
        const childPosition = position.get(child);
        const parentPosition = position.get(parent);
        // A regenerable parent is not restored; a column pointing into it is cleared (see
        // REFERENCES_CLEARED_ON_RESTORE). A regenerable child is not restored at all.
        if (childPosition === undefined) continue;
        if (parentPosition === undefined) {
          const columns = reference.columns.map((column) => column.name);
          const cleared = REFERENCES_CLEARED_ON_RESTORE[child] ?? [];
          if (!columns.every((column) => cleared.includes(column))) {
            violations.push(`${child}(${columns.join(",")}) -> ${parent} is not in BACKUP_TABLES nor cleared`);
          }
          continue;
        }
        if (parentPosition > childPosition) violations.push(`${child} is listed before ${parent} it references`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("lists check_in in BACKUP_TABLES, after the users table it references", () => {
    expect(BACKUP_TABLES).toContain("check_in");
    expect(BACKUP_TABLES.indexOf("users")).toBeLessThan(BACKUP_TABLES.indexOf("check_in"));
  });
});

/**
 * The column-level counterpart to the table-level coverage guard above. A backup written before a
 * column existed carries rows without it, and the restore has to leave that column to its `DEFAULT`
 * rather than writing an explicit `NULL` over it. Getting this wrong is silent until someone tries a
 * real recovery: a `formatVersion` 1 backup failed on `user_preferences.preferred_bedtime`
 * (`NOT NULL DEFAULT '22:00'`) — a column that *has* a usable default and was being overwritten with
 * NULL anyway.
 */
describe("restorableColumns", () => {
  it("omits a column the backup does not carry, so its DEFAULT applies", () => {
    const { insert, defaulted } = restorableColumns(
      [{ id: "u1", display_name: "Jon" }],
      ["id", "display_name", "preferred_bedtime"]
    );
    expect(insert).toEqual(["id", "display_name"]);
    expect(insert).not.toContain("preferred_bedtime");
    expect(defaulted).toEqual(["preferred_bedtime"]);
  });

  it("leaves the protected-recovery columns to their defaults for a backup written before they existed", () => {
    const { insert, defaulted } = restorableColumns(
      [{ id: "p1", user_id: "u1" }],
      ["id", "user_id", "recovery_start_time", "recovery_end_time", "recovery_weekdays"]
    );
    expect(insert).toEqual(["id", "user_id"]);
    // Nullable with no default: restored as NULL, which reads as recovery off.
    expect(defaulted).toEqual(["recovery_start_time", "recovery_end_time", "recovery_weekdays"]);
    const plans = restorableColumns([{ id: "d1" }], ["id", "recovery_skipped"]);
    expect(plans.defaulted).toEqual(["recovery_skipped"]);
  });

  it("drops a key for a column the schema no longer has", () => {
    const { insert, defaulted, dropped } = restorableColumns(
      [{ id: "p1", capacity_mode: "automatic" }],
      ["id", "default_usable_fraction"]
    );
    expect(insert).toEqual(["id"]);
    expect(dropped).toEqual(["capacity_mode"]);
    expect(defaulted).toEqual(["default_usable_fraction"]);
  });

  it("takes the union across rows, so a row omitting an optional key does not drop the column", () => {
    const { insert } = restorableColumns([{ id: "a" }, { id: "b", notes: "hello" }], ["id", "notes"]);
    expect(insert).toEqual(["id", "notes"]);
  });

  it("orders columns by the table, not by the JSON, so the generated SQL is deterministic", () => {
    const { insert } = restorableColumns([{ notes: "x", id: "a" }], ["id", "notes"]);
    expect(insert).toEqual(["id", "notes"]);
  });

  it("reports every column as defaulted when a table's rows carry nothing the schema still has", () => {
    const { insert, defaulted } = restorableColumns([{ gone: 1 }], ["id", "name"]);
    expect(insert).toEqual([]);
    expect(defaulted).toEqual(["id", "name"]);
  });
});

describe("readAllTables snapshot (S8-04)", () => {
  it("reads every table inside one repeatable-read, read-only transaction", async () => {
    const events: string[] = [];
    const transaction = {
      unsafe: async (query: string) => {
        events.push(query);
        return [{ id: "x" }];
      }
    };
    const sql = {
      begin: async (options: string, run: (tx: typeof transaction) => Promise<unknown>) => {
        events.push(`begin ${options}`);
        const result = await run(transaction);
        events.push("commit");
        return result;
      },
      unsafe: async () => {
        throw new Error("a read escaped the transaction");
      }
    };
    const tables = await readAllTables(sql as never);
    expect(events[0]).toBe("begin isolation level repeatable read read only");
    expect(events.at(-1)).toBe("commit");
    expect(events).toHaveLength(BACKUP_TABLES.length + 2);
    expect(Object.keys(tables)).toEqual([...BACKUP_TABLES]);
  });
});

describe("tablesWithDifferentContent (S8-11)", () => {
  it("passes equal content and names a table whose values differ at the same row count", () => {
    const expected = { a: [{ id: "1", n: "5" }], b: [{ id: "2" }] };
    expect(tablesWithDifferentContent(expected, { a: [{ id: "1", n: "5" }], b: [{ id: "2" }] })).toEqual([]);
    expect(tablesWithDifferentContent(expected, { a: [{ id: "1", n: "6" }], b: [{ id: "2" }] })).toEqual(["a"]);
    expect(tablesWithDifferentContent(expected, { a: [{ id: "1" }], b: [{ id: "2" }] })).toEqual(["a"]);
  });
});

describe("isContentVerifiedFormat (S8-11)", () => {
  it("follows the current format, so a format bump keeps the content check on", () => {
    expect(isContentVerifiedFormat(CURRENT_BACKUP_FORMAT_VERSION)).toBe(true);
    expect(isContentVerifiedFormat(CURRENT_BACKUP_FORMAT_VERSION - 1)).toBe(false);
    expect(isContentVerifiedFormat(CURRENT_BACKUP_FORMAT_VERSION + 1)).toBe(false);
  });
});

describe("backup table count", () => {
  // Adding a table to BACKUP_TABLES changes this count; that is the prompt to bump `formatVersion`, freeze
  // the previous list as a literal and update the number here, in that order.
  it("pins BACKUP_TABLES.length to the current formatVersion so an added table forces a bump", () => {
    expect(BACKUP_TABLES.length).toBe(66 + groupBackupTables("current").length); // 75 in OpenRhen
  });
});

describe("backup format 19", () => {
  it("pins the format strings: the one written, and the one the reader also accepts", () => {
    expect(BACKUP_FORMAT).toBe("priorities-postgresql-logical-backup");
    expect(ACCEPTED_BACKUP_FORMATS).toContain("openrhen-postgresql-logical-backup");
    for (const format of ACCEPTED_BACKUP_FORMATS) {
      expect(() => validateBackup(backupOf(CURRENT_BACKUP_FORMAT_VERSION, BACKUP_TABLES, format))).not.toThrow();
    }
    expect(() => validateBackup(backupOf(CURRENT_BACKUP_FORMAT_VERSION, BACKUP_TABLES, "other-backup"))).toThrow(
      /Unsupported/
    );
  });

  it("validates a current-format backup and rejects one missing a table", () => {
    expect(() => validateBackup(backupOf(CURRENT_BACKUP_FORMAT_VERSION, BACKUP_TABLES))).not.toThrow();
    expect(() => validateBackup(backupOf(CURRENT_BACKUP_FORMAT_VERSION, BACKUP_TABLES.slice(1)))).toThrow(
      /missing table/
    );
  });

  it("rejects a format newer than this build reads", () => {
    expect(() => validateBackup(backupOf(CURRENT_BACKUP_FORMAT_VERSION + 1, BACKUP_TABLES))).toThrow(
      /^Unsupported backup formatVersion 20$/
    );
  });
});

/** An older format is read only through the private reader (`./private/legacy-backups.ts`); the export ships a stand-in. */
describe("older backup formats", () => {
  afterEach(() => {
    vi.doUnmock("./private/legacy-backups.js");
    vi.resetModules();
  });

  const withSeam = async (legacyRequiredTables: (formatVersion: number) => readonly string[] | undefined) => {
    vi.resetModules();
    vi.doMock("./private/legacy-backups.js", () => ({ legacyRequiredTables }));
    return import("./backup-format.js");
  };

  it("refuses an older format, saying this build restores format 19 only, when no reader recognises it", async () => {
    const { validateBackup: validate, BACKUP_TABLES: tables } = await withSeam(() => undefined);
    for (const version of [1, 5, 18]) {
      expect(() => validate(backupOf(version, tables))).toThrow(
        `Unsupported backup formatVersion ${version}: this build restores format 19 backups only`
      );
    }
    expect(() => validate(backupOf(0, tables))).toThrow(/^Unsupported backup formatVersion 0$/);
    expect(() => validate(backupOf(19, tables))).not.toThrow();
  });

  it("validates an older format against the table list the reader returns for its version", async () => {
    const asked: number[] = [];
    const { validateBackup: validate } = await withSeam((version) => {
      asked.push(version);
      return version === 7 ? ["portal_state", "users"] : undefined;
    });
    expect(() => validate(backupOf(7, ["portal_state", "users"]))).not.toThrow();
    expect(() => validate(backupOf(7, ["portal_state"]))).toThrow("Backup is missing table users");
    expect(() => validate(backupOf(6, ["portal_state", "users"]))).toThrow(/format 19 backups only/);
    expect(asked).toEqual([7, 7, 6]);
  });

  it("does not ask the reader about a current-format backup", async () => {
    const asked: number[] = [];
    const { validateBackup: validate, BACKUP_TABLES: tables } = await withSeam((version) => {
      asked.push(version);
      return undefined;
    });
    validate(backupOf(19, tables));
    expect(asked).toEqual([]);
  });
});
