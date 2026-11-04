import { describe, expect, it } from "vitest";
import { InvalidCommandError } from "./command-errors";
import { assertCurrentLocationIsSavedPlace } from "./location-context";
import type { Sql } from "./sql-pool";

/** A tagged-template stand-in that answers the active-place lookup from a fixed set of saved ids. */
function fakeSql(activeIds: string[]) {
  let lookups = 0;
  const sql = (async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    lookups += 1;
    const id = values[1] as string;
    return activeIds.includes(id) ? [{ id }] : [];
  }) as unknown as Sql;
  return { sql, lookups: () => lookups };
}

describe("assertCurrentLocationIsSavedPlace", () => {
  it("accepts an active saved place", async () => {
    const { sql } = fakeSql(["home"]);
    await expect(assertCurrentLocationIsSavedPlace(sql, "u", { locationId: "home" }, null)).resolves.toBeUndefined();
  });

  it("refuses an id that is not an active saved place", async () => {
    const { sql } = fakeSql(["home"]);
    await expect(assertCurrentLocationIsSavedPlace(sql, "u", { locationId: "nowhere" }, null)).rejects.toThrow(
      InvalidCommandError
    );
  });

  it("refuses empty, padded and non-string values without trimming them into a match", async () => {
    const { sql } = fakeSql(["home"]);
    for (const bad of ["", "  ", " home ", 7, {}, false])
      await expect(assertCurrentLocationIsSavedPlace(sql, "u", { locationId: bad }, null)).rejects.toThrow(
        InvalidCommandError
      );
  });

  it("lets null clear the place, and a payload that never names it pass, without a lookup", async () => {
    const { sql, lookups } = fakeSql([]);
    await assertCurrentLocationIsSavedPlace(sql, "u", { locationId: null }, null);
    await assertCurrentLocationIsSavedPlace(sql, "u", { travelOff: true }, null);
    await assertCurrentLocationIsSavedPlace(sql, "u", undefined, null);
    expect(lookups()).toBe(0);
  });

  it("lets the stored place through unchecked, so a whole-situation save survives that place being archived", async () => {
    const { sql, lookups } = fakeSql([]);
    await expect(
      assertCurrentLocationIsSavedPlace(sql, "u", { locationId: "old-office" }, "old-office")
    ).resolves.toBeUndefined();
    expect(lookups()).toBe(0);
    await expect(assertCurrentLocationIsSavedPlace(sql, "u", { locationId: "nowhere" }, "old-office")).rejects.toThrow(
      InvalidCommandError
    );
  });
});
