import { describe, expect, it } from "vitest";
import {
  CORE_SNAPSHOT_TABLES,
  SNAPSHOT_TABLES,
  SYSTEM_COLUMNS,
  registerSnapshotTable,
  snapshotKeyColumns,
  systemColumnsFor
} from "./write-snapshot";

describe("snapshot table registry", () => {
  it("starts as the core list, and a registered table follows its anchor with its own key and columns", () => {
    expect(SNAPSHOT_TABLES).toEqual([...CORE_SNAPSHOT_TABLES]);
    registerSnapshotTable({ table: "x_notes", after: "deliverable_blocker_actions", systemColumns: ["updated_at"] });
    registerSnapshotTable({
      table: "x_links",
      after: "x_notes",
      systemColumns: [],
      key: ["note_id", "action_id"]
    });
    const at = SNAPSHOT_TABLES.indexOf("deliverable_blocker_actions");
    expect(SNAPSHOT_TABLES.slice(at, at + 3)).toEqual(["deliverable_blocker_actions", "x_notes", "x_links"]);
    expect(snapshotKeyColumns("x_notes")).toEqual(["id"]);
    expect(snapshotKeyColumns("x_links")).toEqual(["note_id", "action_id"]);
    expect(SYSTEM_COLUMNS.x_notes).toEqual(["updated_at"]);
    expect(systemColumnsFor("x_notes")).toEqual(["updated_at"]);
  });

  it("is idempotent, and refuses a table with an unknown anchor or a table that is not registered", () => {
    const before = [...SNAPSHOT_TABLES];
    registerSnapshotTable({ table: "x_notes", after: "users", systemColumns: ["other"] });
    expect(SNAPSHOT_TABLES).toEqual(before);
    expect(SYSTEM_COLUMNS.x_notes).toEqual(["updated_at"]);
    expect(() => registerSnapshotTable({ table: "y", after: "no_such_table", systemColumns: [] })).toThrow(
      /must follow/
    );
    expect(() => snapshotKeyColumns("no_such_table")).toThrow(/cannot be snapshotted/);
  });
});
