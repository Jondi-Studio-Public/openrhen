import { describe, expect, it } from "vitest";
import { closedStampItems } from "./doctor-closed.js";

describe("closedStampItems", () => {
  it("is quiet when no table has a finding", () => {
    expect(closedStampItems({ tables: [] })).toEqual([]);
  });

  it("flags open records that carry a closed stamp, naming the tables", () => {
    const items = closedStampItems({ tables: [{ table: "routine_presets", strayStamp: 2, missingStamp: 0 }] });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "closed_stamp_stray", check: "closed_stamp_stray", tier: "tidy" });
    expect(items[0]!.title).toContain("2 records");
    expect(items[0]!.title).toContain("routine presets");
  });

  it("flags closed records without a stamp, and both kinds at once", () => {
    const items = closedStampItems({
      tables: [
        { table: "areas", strayStamp: 0, missingStamp: 1 },
        { table: "commitments", strayStamp: 1, missingStamp: 3 }
      ]
    });
    expect(items.map((i) => i.id)).toEqual(["closed_stamp_stray", "closed_stamp_missing"]);
    expect(items[1]!.title).toContain("4 closed records");
  });
});
