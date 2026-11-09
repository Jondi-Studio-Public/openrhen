import { describe, expect, it } from "vitest";
import { materialFieldList, materialHash, type MaterialFields } from "./material-hash.js";

const base: MaterialFields = {
  title: "Renew passport",
  definitionOfDone: "New passport in the drawer",
  deadlines: ["2026-12-01T00:00:00.000Z", null],
  parentId: "outcome-1"
};

describe("material hash", () => {
  it("normalises: trimmed text, ISO instants however they were spelled, absent as empty", () => {
    const same = materialHash({
      title: "  Renew passport ",
      definitionOfDone: " New passport in the drawer\n",
      deadlines: [new Date("2026-12-01T00:00:00Z"), undefined],
      parentId: "outcome-1"
    });
    expect(same).toBe(materialHash(base));
    expect(materialHash({ ...base, deadlines: ["2026-12-01T10:00:00+10:00", ""] })).toBe(materialHash(base));
    expect(materialHash({ ...base, definitionOfDone: null })).toBe(materialHash({ ...base, definitionOfDone: "" }));
  });

  it("pins the field list so a silent change to it shows up in review", () => {
    expect(materialFieldList(base)).toBe(
      '[1,"Renew passport","New passport in the drawer","2026-12-01T00:00:00.000Z","","outcome-1"]'
    );
  });

  it.each([
    ["title", { title: "Renew passports" }],
    ["definition of done", { definitionOfDone: "Passport applied for" }],
    ["first deadline", { deadlines: ["2026-12-02T00:00:00.000Z", null] as MaterialFields["deadlines"] }],
    ["second deadline", { deadlines: [base.deadlines[0], "2026-11-20T00:00:00.000Z"] as MaterialFields["deadlines"] }],
    ["parent", { parentId: "outcome-2" }]
  ])("changes when the %s changes", (_name, change) => {
    expect(materialHash({ ...base, ...change })).not.toBe(materialHash(base));
  });

  it("does not depend on the order the two deadlines are written in the source row, only on their positions", () => {
    expect(materialHash({ ...base, deadlines: [null, base.deadlines[0]] })).not.toBe(materialHash(base));
  });

  it("reads an unparseable date as absent rather than throwing", () => {
    expect(materialHash({ ...base, deadlines: ["not a date", null] })).toBe(
      materialHash({ ...base, deadlines: [null, null] })
    );
  });
});
