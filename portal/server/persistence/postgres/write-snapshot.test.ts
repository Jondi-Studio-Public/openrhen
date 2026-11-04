import { describe, expect, it } from "vitest";
import {
  snapshotKeyColumns,
  SNAPSHOT_KEYS,
  SNAPSHOT_TABLES,
  SYSTEM_COLUMNS,
  COMPARE_ONLY_SYSTEM_COLUMNS,
  TRACKED_COLUMNS,
  decodeKey,
  encodeKey,
  imageExpression,
  keyCondition,
  type SnapshotTable
} from "./write-snapshot";

/** How a snapshot names a row: the plain id for an `id` table, the JSON array of the key values for a composite one. */
describe("snapshot row keys", () => {
  // Link tables with no `id`, by the number of columns in their primary key.
  const COMPOSITE: Partial<Record<SnapshotTable, number>> = {
    action_requirements: 2,
    action_preferences: 2,
    action_dependencies: 2,
    deliverable_dependencies: 2,
    deliverable_sources: 2,
    routine_preset_step_dependencies: 2,
    routine_step_dependencies: 2,
    planning_focus_projects: 2,
    daily_plan_desired_actions: 2,
    daily_plan_deferred_actions: 2,
    condition_definitions: 2,
    entity_prerequisites: 4,
    deliverable_criterion_actions: 2,
    deliverable_blocker_actions: 2
  };

  it("keys every table by id except the link and single-owner tables, which use their primary key", () => {
    for (const table of SNAPSHOT_TABLES) {
      if (table === "user_preferences" || table === "pulse_state")
        expect(snapshotKeyColumns(table), table).toEqual(["user_id"]);
      else expect(snapshotKeyColumns(table).length, table).toBe(COMPOSITE[table] ?? 1);
    }
    for (const table of SNAPSHOT_TABLES.filter(
      (name) => !(name in COMPOSITE) && name !== "user_preferences" && name !== "pulse_state"
    ))
      expect(snapshotKeyColumns(table), table).toEqual(["id"]);
    expect(SNAPSHOT_KEYS.action_requirements).toEqual(["pathway_id", "context_key"]);
    expect(SNAPSHOT_KEYS.deliverable_sources).toEqual(["deliverable_id", "source_id"]);
  });

  it("names every table's system columns, so a revert never compares or writes what the planner owns", () => {
    expect(Object.keys(SYSTEM_COLUMNS).sort()).toEqual([...SNAPSHOT_TABLES].sort());
  });

  it("stores the plain id for an id table, so snapshots kept before composite keys existed still read", () => {
    expect(encodeKey("actions", "3b5c")).toBe("3b5c");
    expect(decodeKey("actions", "3b5c")).toEqual(["3b5c"]);
    // An id that merely looks like JSON is still just an id.
    expect(decodeKey("check_in", '["x"]')).toEqual(['["x"]']);
  });

  it("stores the JSON array of key values for a composite table, and reads it back", () => {
    const id = encodeKey("action_requirements", ["pathway-1", "home"]);
    expect(id).toBe('["pathway-1","home"]');
    expect(decodeKey("action_requirements", id)).toEqual(["pathway-1", "home"]);
    // A value with quotes or commas survives.
    const odd = encodeKey("action_preferences", ["a", 'say "hi", please']);
    expect(decodeKey("action_preferences", odd)).toEqual(["a", 'say "hi", please']);
  });

  it("refuses a key of the wrong shape for the table", () => {
    expect(() => encodeKey("actions", ["a", "b"])).toThrow(/keyed by one column/);
    expect(() => encodeKey("action_dependencies", "just-one")).toThrow(/keyed by \(action_id, depends_on_action_id\)/);
    expect(() => encodeKey("action_dependencies", ["only-one"])).toThrow(/pass those 2 values/);
    expect(() => decodeKey("action_dependencies", "not json")).toThrow();
    expect(() => decodeKey("action_dependencies", '["one"]')).toThrow(/does not fit/);
    expect(() => decodeKey("action_dependencies", "[1,2]")).toThrow(/does not fit/);
  });

  it("builds the WHERE for an id table from its id column, as before", () => {
    expect(keyCondition("actions", "t", ["a1", "a2"])).toEqual({
      where: 't."id"::text IN ($1, $2)',
      params: ["a1", "a2"]
    });
    expect(keyCondition("actions", "cur", ["a1"], 2)).toEqual({ where: 'cur."id"::text IN ($2)', params: ["a1"] });
  });

  it("builds the WHERE for a composite table from its key columns, numbering the parameters from `first`", () => {
    const ids = [encodeKey("deliverable_sources", ["d1", "s1"]), encodeKey("deliverable_sources", ["d1", "s2"])];
    expect(keyCondition("deliverable_sources", "t", ids)).toEqual({
      where: '(t."deliverable_id"::text, t."source_id"::text) IN (($1, $2), ($3, $4))',
      params: ["d1", "s1", "d1", "s2"]
    });
    expect(keyCondition("action_preferences", "cur", [encodeKey("action_preferences", ["a", "home"])], 3).where).toBe(
      '(cur."action_id"::text, cur."context_key"::text) IN (($3, $4))'
    );
  });
});

/** What a snapshot keeps of a row: the whole row, or for a wake's settings row only the columns a wake changes. */
describe("snapshot row images", () => {
  it("images a row whole unless the kind of write names the columns to track", () => {
    expect(imageExpression("sessions", "t", "wake")).toBe("to_jsonb(t)");
    expect(imageExpression("user_preferences", "t")).toBe("to_jsonb(t)");
    expect(imageExpression("user_preferences", "t", "save")).toBe("to_jsonb(t)");
    expect(Object.keys(TRACKED_COLUMNS)).toEqual(["wake", "reenter"]);
  });

  it("images a wake's settings row by the last wake and the place only, with its key, version and clock", () => {
    const expression = imageExpression("user_preferences", "t", "wake");
    for (const column of ["user_id", "last_woke_at", "current_situation", "version", "updated_at"])
      expect(expression).toContain(`'${column}'`);
    // Nothing else on the row (the device's location, the planning horizon, every preference) is compared.
    expect(expression).not.toContain("current_energy");
    expect(expression).not.toContain("device_location_state");
    expect(SYSTEM_COLUMNS.user_preferences).toContain("updated_at");
  });

  it("ignores the recorder's contact bookkeeping on pulse_state when checking for a change, but still restores it", () => {
    for (const column of ["last_contact_at", "last_contact_source"]) {
      expect(COMPARE_ONLY_SYSTEM_COLUMNS.pulse_state).toContain(column);
      // Not a system column: an undo writes it back (the original contact time, not the re-entry's).
      expect(SYSTEM_COLUMNS.pulse_state).not.toContain(column);
    }
    // The memory a re-entry moves and an undo must put back is still compared.
    for (const column of ["last_confirmed_at", "entered_lapsed_at", "unknown_since"]) {
      expect(SYSTEM_COLUMNS.pulse_state).not.toContain(column);
      expect(COMPARE_ONLY_SYSTEM_COLUMNS.pulse_state).not.toContain(column);
    }
  });
});
