import { describe, expect, it } from "vitest";
import { saveEntity } from "./entity-commands";
import { InvalidCommandError } from "./command-errors";
import type { PoolSql } from "./sql-pool";

/** A pool that fails the test if the save reaches the database: a removed field name is refused before that. */
const untouched = new Proxy(() => undefined, {
  get() {
    throw new Error("the database was reached");
  },
  apply() {
    throw new Error("the database was reached");
  }
}) as unknown as PoolSql;

describe("saveEntity and the removed calendar-sharing field names", () => {
  it.each([
    ["commitment", "shareWithFamily", "shareToCalendar"],
    ["settings", "shareWithFamilyEnabled", "calendarShareEnabled"]
  ])("refuses %s %s and names %s", async (entityType, old, current) => {
    const command = {
      commandId: "0b0e3c58-55a1-4f53-9a51-2d0a0f8f3c11",
      expectedVersion: null,
      type: "save_entity",
      entityType,
      entity: { id: "x", [old]: true }
    } as never;
    const error = await saveEntity(untouched, command).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvalidCommandError);
    expect((error as Error).message).toContain(`"${old}"`);
    expect((error as Error).message).toContain(`use "${current}"`);
  });
});
