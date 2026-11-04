import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKUP_LIST_IDS } from "./table-groups.js";

afterEach(() => {
  vi.doUnmock("./private/index.js");
  vi.resetModules();
});

describe("table group registry", () => {
  it("registers a group once and returns its tables per list in registration order", async () => {
    vi.resetModules();
    const { groupBackupTables, registeredTableGroups, registerTableGroup } = await import("./table-groups.js");
    const before = registeredTableGroups().length;
    registerTableGroup({ id: "test-group-a", backup: { current: ["a_one", "a_two"], v3: ["a_one"] } });
    registerTableGroup({ id: "test-group-a", backup: { current: ["ignored"] } });
    registerTableGroup({ id: "test-group-b", backup: { current: ["b_one"] } });
    expect(registeredTableGroups().length).toBe(before + 2);
    expect(groupBackupTables("current").slice(-3)).toEqual(["a_one", "a_two", "b_one"]);
    expect(groupBackupTables("v3").at(-1)).toBe("a_one");
    expect(groupBackupTables("v15")).not.toContain("a_one");
  });

  it("names every backup list a group can join", () => {
    expect(new Set(BACKUP_LIST_IDS).size).toBe(BACKUP_LIST_IDS.length);
    expect(BACKUP_LIST_IDS).toContain("current");
    expect(BACKUP_LIST_IDS).toContain("regenerable");
  });
});

describe("backup table lists", () => {
  it("are the core tables followed by the installed groups' tables, and match the core-only lists when none is installed", async () => {
    vi.resetModules();
    const withGroups = await import("../operations/backup-format.js");
    const { groupBackupTables } = await import("./table-groups.js");
    const expectedExtra = {
      BACKUP_TABLES: groupBackupTables("current").length,
      REGENERABLE_TABLES: groupBackupTables("regenerable").length
    };

    vi.resetModules();
    vi.doMock("./private/index.js", () => ({}));
    const registry = await import("./table-groups.js");
    const bare = await import("../operations/backup-format.js");

    expect(registry.registeredTableGroups()).toEqual([]);
    expect(bare.BACKUP_TABLES.length).toBeGreaterThan(0);
    expect(new Set(bare.BACKUP_TABLES).size).toBe(bare.BACKUP_TABLES.length);
    for (const name of ["BACKUP_TABLES", "REGENERABLE_TABLES"] as const) {
      const core = bare[name];
      const full = withGroups[name];
      // Core tables keep their order and come first; every extra table is one a group added.
      expect(full.slice(0, core.length)).toEqual([...core]);
      expect(full.length - core.length).toBe(expectedExtra[name]);
    }
    // Two cold imports of the backup-format module graph (it pulls the whole schema) take well over the
    // 5s default when the unit suites run in parallel on a loaded runner; the assertions are cheap.
  }, 30_000);
});
