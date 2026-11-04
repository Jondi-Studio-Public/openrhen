import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { coreLegacyRows, loadMigrationSets, planSet, type MigrationSet } from "./migration-sets.js";
import { migrationHashes } from "./skipped-migrations.js";

function folder(entries: { tag: string; when: number; sql: string }[], baseline?: object): string {
  const dir = mkdtempSync(join(tmpdir(), "sets-"));
  mkdirSync(join(dir, "meta"));
  for (const e of entries) writeFileSync(join(dir, `${e.tag}.sql`), e.sql);
  writeFileSync(
    join(dir, "meta/_journal.json"),
    JSON.stringify({ entries: entries.map((e, idx) => ({ idx, tag: e.tag, when: e.when })) })
  );
  if (baseline) writeFileSync(join(dir, "meta/baseline.json"), JSON.stringify(baseline));
  return dir;
}

const legacySql = ["a", "b"];
const legacy = legacySql.map((sql, idx) => ({ idx, when: 100 + idx, hashes: migrationHashes(sql) }));

describe("loadMigrationSets", () => {
  it("has only core when the add-on folder has no journal", () => {
    const core = folder([{ tag: "0000_core", when: 200, sql: "x" }]);
    const empty = mkdtempSync(join(tmpdir(), "sets-empty-"));
    const sets = loadMigrationSets({ coreFolder: core, addonFolder: empty });
    expect(sets.all.map((set) => set.name)).toEqual(["core"]);
    expect(sets.addon).toBeNull();
    expect(sets.core.table).toBe("__drizzle_migrations");
  });

  it("adds the add-on set, with its own ledger, after core", () => {
    const core = folder([{ tag: "0000_core", when: 200, sql: "x" }]);
    const addon = folder([{ tag: "0000_addon", when: 300, sql: "y" }], {
      version: 1,
      baselineIdx: 0,
      legacyLedger: "core",
      legacy
    });
    const sets = loadMigrationSets({ coreFolder: core, addonFolder: addon });
    expect(sets.all.map((set) => set.name)).toEqual(["core", "addon"]);
    expect(sets.addon?.table).toBe("__drizzle_migrations_addon");
    expect(sets.addon?.legacyLedger).toBe("core");
  });
});

describe("planSet", () => {
  const addonDir = folder(
    [
      { tag: "0000_addon", when: 102, sql: "y" },
      { tag: "0001_more", when: 400, sql: "z" }
    ],
    { version: 1, baselineIdx: 0, legacyLedger: "core", legacy }
  );
  const addon = loadMigrationSets({ coreFolder: addonDir, addonFolder: addonDir }).addon as MigrationSet;
  const coreRow = (i: number) => ({ hash: legacySql[i]!, createdAt: 100 + i });

  it("adopts when the core ledger holds the whole legacy history, leaving only later migrations pending", () => {
    const plan = planSet(
      addon,
      [],
      [coreRow(0), coreRow(1)].map((r) => ({ ...r, hash: migrationHashes(r.hash)[0]! }))
    );
    expect(plan.adopt?.baselineTag).toBe("0000_addon");
    expect(plan.pending).toEqual(["0001_more"]);
    expect(plan.skipped).toEqual([]);
    expect(plan.problem).toBeNull();
  });

  it("runs the baseline when the core ledger holds none of it", () => {
    const plan = planSet(addon, [], []);
    expect(plan.decision?.action).toBe("fresh");
    expect(plan.pending).toEqual(["0000_addon", "0001_more"]);
  });

  it("refuses a partial history, naming the add-on set", () => {
    const plan = planSet(addon, [], [{ hash: migrationHashes("a")[0]!, createdAt: 100 }]);
    expect(plan.problem).toMatch(/^Add-on migration set: /);
  });

  it("refuses an add-on ledger newer than its journal", () => {
    const plan = planSet(addon, [{ hash: "native", createdAt: 999 }], []);
    expect(plan.problem).toMatch(/^Add-on migration set: The database is ahead/);
  });

  it("drops core's own baseline row from the legacy rows", () => {
    const coreDir = folder([{ tag: "0000_core", when: 101, sql: "core baseline" }]);
    const core = loadMigrationSets({ coreFolder: coreDir, addonFolder: addonDir }).core;
    core.baseline = { version: 1, baselineIdx: 0, legacy: [] };
    const own = { hash: migrationHashes("core baseline")[0]!, createdAt: 101 };
    const other = { hash: "x", createdAt: 5 };
    expect(coreLegacyRows(core, [own, other])).toEqual([other]);
  });
});
