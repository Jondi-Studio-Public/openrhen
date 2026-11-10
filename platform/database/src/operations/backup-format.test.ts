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
    ...(formatVersion >= 23
      ? {
          streamed: { activity_events: { file: "x.activity-events.ndjson", rows: 0, bytes: 0, sha256: "0".repeat(64) } }
        }
      : {}),
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

  it("hands a streamed table to the writer as a cursor inside the same transaction, and never reads it whole", async () => {
    const events: string[] = [];
    const cursorBatches = [[{ id: "a" }, { id: "b" }], [{ id: "c" }]];
    const transaction = {
      unsafe: (query: string) =>
        Object.assign(Promise.resolve([{ id: "x" }]), {
          cursor: (n: number) => {
            events.push(`cursor ${n} ${query}`);
            return (async function* () {
              for (const batch of cursorBatches) yield batch;
            })();
          }
        })
    };
    const sql = {
      begin: async (_options: string, run: (tx: typeof transaction) => Promise<unknown>) => run(transaction)
    };
    const received: unknown[][] = [];
    const tables = await readAllTables(sql as never, {
      batchRows: 7,
      streamTo: async (table, batches) => {
        expect(table).toBe("activity_events");
        for await (const batch of batches) received.push([...batch]);
        return { file: "f.ndjson", rows: 3, bytes: 1, sha256: "s" };
      }
    });
    expect(received).toEqual(cursorBatches);
    // The table's slot holds nothing, though the mock would have returned a row had it been read whole.
    expect(tables.activity_events).toEqual([]);
    expect(events).toContain('cursor 7 SELECT * FROM "activity_events" ORDER BY 1');
    expect(tables.users).toEqual([{ id: "x" }]);
  });

  it("leaves a streamed table out entirely with omitStreamed", async () => {
    const queries: string[] = [];
    const transaction = {
      unsafe: async (query: string) => {
        queries.push(query);
        return [];
      }
    };
    const sql = { begin: async (_o: string, run: (tx: typeof transaction) => Promise<unknown>) => run(transaction) };
    const tables = await readAllTables(sql as never, { omitStreamed: true });
    expect(tables.activity_events).toEqual([]);
    expect(queries.some((query) => query.includes('"activity_events"'))).toBe(false);
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

/** What a format 22 or 23 backup lacks: the derived-reader tables (format 24) the comparison tables (format 25) and the settings and model-call audit (format 26). */
const NEWER_THAN_22 = [
  "derived_lineage",
  "extractor_state",
  "consequence_groups_issued",
  "consequence_comparisons",
  "derived_settings",
  "derived_model_calls"
];

describe("backup table count", () => {
  // Adding a table to BACKUP_TABLES changes this count; that is the prompt to bump `formatVersion`, freeze
  // the previous list as a literal and update the number here, in that order.
  it("pins BACKUP_TABLES.length to the current formatVersion so an added table forces a bump", () => {
    expect(BACKUP_TABLES.length).toBe(78 + groupBackupTables("current").length);
  });
});

describe("backup format 27", () => {
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

  it("requires the manifest to say where the streamed activity_events rows are, and not to duplicate them", () => {
    const { streamed: _streamed, ...bare } = backupOf(CURRENT_BACKUP_FORMAT_VERSION, BACKUP_TABLES);
    expect(() => validateBackup(bare)).toThrow(/streamed section is missing from the manifest/);
    const good = backupOf(CURRENT_BACKUP_FORMAT_VERSION, BACKUP_TABLES);
    expect(() =>
      validateBackup({
        ...good,
        streamed: { activity_events: { ...good.streamed!.activity_events, file: "../x.ndjson" } }
      })
    ).toThrow(/unusable section file/);
    const tables = { ...good.tables, activity_events: [{ id: "1" }] };
    expect(() =>
      validateBackup({
        ...good,
        tables,
        sha256: createHash("sha256").update(JSON.stringify(tables)).digest("hex")
      })
    ).toThrow(/as well as in its streamed section/);
  });

  it("rejects a format newer than this build reads", () => {
    expect(() => validateBackup(backupOf(CURRENT_BACKUP_FORMAT_VERSION + 1, BACKUP_TABLES))).toThrow(
      /^Unsupported backup formatVersion 28$/
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

  it("refuses an older format, saying this build restores format 27 only, when no reader recognises it", async () => {
    const { validateBackup: validate, BACKUP_TABLES: tables } = await withSeam(() => undefined);
    for (const version of [1, 5, 19, 20, 21, 22, 23, 24, 25, 26]) {
      expect(() => validate(backupOf(version, tables))).toThrow(
        `Unsupported backup formatVersion ${version}: this build restores format 27 backups only`
      );
    }
    expect(() => validate(backupOf(0, tables))).toThrow(/^Unsupported backup formatVersion 0$/);
    expect(() => validate(backupOf(27, tables))).not.toThrow();
  });

  it("tells the owner how to carry an unreadable older backup forward", async () => {
    const { validateBackup: validate, BACKUP_TABLES: tables } = await withSeam(() => undefined);
    expect(() => validate(backupOf(19, tables))).toThrow(
      /Restore this backup on the build that wrote it, then take a fresh backup there and restore that one here$/
    );
  });

  it("restores a format 22 backup through the shipped reader, with its rows in the JSON, with or without a skip marker", async () => {
    const { validateBackup: validate, BACKUP_TABLES: tables, tablesAbsentFrom } = await import("./backup-format.js");
    const { legacyRequiredTables } = await import("./private/legacy-backups.js");
    const format22 = legacyRequiredTables(22);
    expect(format22).toBeDefined();
    // Format 23 changed where activity_events rows live; format 24 added the two derived-reader tables, 25 the two comparison tables and 26 the settings and model-call audit.
    expect([...tables].filter((table) => !format22!.includes(table))).toEqual(NEWER_THAN_22);
    expect(format22!.filter((table) => !tables.includes(table))).toEqual([]);
    const plain = validate(backupOf(22, format22!));
    expect(tablesAbsentFrom(plain)).toEqual(NEWER_THAN_22);
    expect(plain.streamed).toBeUndefined();
    const skipped = [{ table: "activity_events", rows: 600000, reason: "over the guard" }];
    expect(validate({ ...backupOf(22, format22!), skipped }).skipped).toEqual(skipped);
  });

  it("restores a format 23 backup, whose events are streamed, with the derived-reader and comparison tables empty", async () => {
    const { validateBackup: validate, BACKUP_TABLES: tables, tablesAbsentFrom } = await import("./backup-format.js");
    const { legacyRequiredTables } = await import("./private/legacy-backups.js");
    const format23 = legacyRequiredTables(23);
    expect(format23).toBeDefined();
    expect([...tables].filter((table) => !format23!.includes(table))).toEqual(NEWER_THAN_22);
    expect(format23!.filter((table) => !tables.includes(table))).toEqual([]);
    const backup = validate(backupOf(23, format23!));
    expect(tablesAbsentFrom(backup)).toEqual(NEWER_THAN_22);
    expect(backup.streamed?.activity_events).toBeDefined();
    const { streamed: _streamed, ...bare } = backupOf(23, format23!);
    expect(() => validate(bare)).toThrow(/streamed section is missing from the manifest/);
  });

  it("restores a format 24 backup with the comparison, settings and model-call tables empty, and orders them after users", async () => {
    const { validateBackup: validate, BACKUP_TABLES: tables, tablesAbsentFrom } = await import("./backup-format.js");
    const { legacyRequiredTables } = await import("./private/legacy-backups.js");
    const format24 = legacyRequiredTables(24);
    expect(format24).toBeDefined();
    const newer = ["consequence_groups_issued", "consequence_comparisons", "derived_settings", "derived_model_calls"];
    expect([...tables].filter((table) => !format24!.includes(table))).toEqual(newer);
    expect(format24!.filter((table) => !tables.includes(table))).toEqual([]);
    const backup = validate(backupOf(24, format24!));
    expect(tablesAbsentFrom(backup)).toEqual(newer);
    // Foreign-key order: the answers reference their group, and all of them reference users.
    const index = (table: string) => tables.indexOf(table as never);
    expect(index("users")).toBeLessThan(index("consequence_groups_issued"));
    expect(index("consequence_groups_issued")).toBeLessThan(index("consequence_comparisons"));
    expect(index("users")).toBeLessThan(index("derived_settings"));
    expect(index("users")).toBeLessThan(index("derived_model_calls"));
  });

  it("restores a format 26 backup, which has every table but not the owner's expected rhythm column", async () => {
    const { validateBackup: validate, BACKUP_TABLES: tables, tablesAbsentFrom } = await import("./backup-format.js");
    const { legacyRequiredTables } = await import("./private/legacy-backups.js");
    const format26 = legacyRequiredTables(26);
    expect(format26).toBeDefined();
    expect([...tables].sort()).toEqual([...format26!].sort());
    expect(tablesAbsentFrom(validate(backupOf(26, format26!)))).toEqual([]);
  });

  it("restores a format 25 backup, which has the comparison tables but not the settings or the model-call audit", async () => {
    const { validateBackup: validate, BACKUP_TABLES: tables, tablesAbsentFrom } = await import("./backup-format.js");
    const { legacyRequiredTables } = await import("./private/legacy-backups.js");
    const format25 = legacyRequiredTables(25);
    expect(format25).toBeDefined();
    expect([...tables].filter((table) => !format25!.includes(table))).toEqual([
      "derived_settings",
      "derived_model_calls"
    ]);
    expect(format25!.filter((table) => !tables.includes(table))).toEqual([]);
    const backup = validate(backupOf(25, format25!));
    expect(tablesAbsentFrom(backup)).toEqual(["derived_settings", "derived_model_calls"]);
    expect(backup.streamed?.activity_events).toBeDefined();
    expect(() => validate(backupOf(25, format25!.slice(1)))).toThrow(/missing table/);
  });

  it("restores a format 21 backup, which has no activity tables, through the shipped reader", async () => {
    const { validateBackup: validate, BACKUP_TABLES: tables, tablesAbsentFrom } = await import("./backup-format.js");
    const { legacyRequiredTables } = await import("./private/legacy-backups.js");
    const format21 = legacyRequiredTables(21);
    expect(format21).toBeDefined();
    // Format 22 added exactly the three activity tables, and format 21's list is frozen apart from the live groups.
    expect([...tables].filter((table) => !format21!.includes(table))).toEqual([
      "activity_imports",
      "activity_events",
      "activity_source_state",
      ...NEWER_THAN_22
    ]);
    expect(format21!.filter((table) => !tables.includes(table))).toEqual([]);
    const backup = validate(backupOf(21, format21!));
    expect(tablesAbsentFrom(backup)).toEqual([
      "activity_imports",
      "activity_events",
      "activity_source_state",
      ...NEWER_THAN_22
    ]);
    expect(() => validate(backupOf(21, tables))).not.toThrow();
    expect(() => validate(backupOf(21, format21!.slice(1)))).toThrow(/missing table/);
  });

  it("restores a format 20 backup, which has no offer_log or activity tables, through the shipped reader", async () => {
    const { validateBackup: validate, BACKUP_TABLES: tables, tablesAbsentFrom } = await import("./backup-format.js");
    const { legacyRequiredTables } = await import("./private/legacy-backups.js");
    const format20 = legacyRequiredTables(20);
    expect(format20).toBeDefined();
    // Format 21 added the offer log and format 22 the activity tables; format 20's list is frozen apart from the live groups.
    expect([...tables].filter((table) => !format20!.includes(table))).toEqual([
      "offer_log",
      "activity_imports",
      "activity_events",
      "activity_source_state",
      ...NEWER_THAN_22
    ]);
    expect(format20!.filter((table) => !tables.includes(table))).toEqual([]);
    const backup = validate(backupOf(20, format20!));
    expect(tablesAbsentFrom(backup)).toEqual([
      "offer_log",
      "activity_imports",
      "activity_events",
      "activity_source_state",
      ...NEWER_THAN_22
    ]);
    expect(() => validate(backupOf(20, tables))).not.toThrow();
    expect(() => validate(backupOf(20, format20!.slice(1)))).toThrow(/missing table/);
    expect(() => validate(backupOf(19, format20!))).toThrow(
      "Unsupported backup formatVersion 19: this build restores format 27 backups and format 26 ones only"
    );
  });

  it("validates an older format against the table list the reader returns for its version", async () => {
    const asked: number[] = [];
    const { validateBackup: validate } = await withSeam((version) => {
      asked.push(version);
      return version === 7 ? ["portal_state", "users"] : undefined;
    });
    expect(() => validate(backupOf(7, ["portal_state", "users"]))).not.toThrow();
    expect(() => validate(backupOf(7, ["portal_state"]))).toThrow("Backup is missing table users");
    expect(() => validate(backupOf(6, ["portal_state", "users"]))).toThrow(/format 27 backups only/);
    expect(asked).toEqual([7, 7, 6, 26]);
  });

  it("does not ask the reader about a current-format backup", async () => {
    const asked: number[] = [];
    const { validateBackup: validate, BACKUP_TABLES: tables } = await withSeam((version) => {
      asked.push(version);
      return undefined;
    });
    validate(backupOf(27, tables));
    expect(asked).toEqual([]);
  });
});

describe("passwords and keys stay out of the backup", () => {
  it("lists the encrypted secret store and the quota counter as regenerable, never as backed up", () => {
    for (const table of ["app_secrets", "youtube_quota_use"]) {
      expect(BACKUP_TABLES, table).not.toContain(table);
      expect(REGENERABLE_TABLES, table).toContain(table);
    }
  });
});
