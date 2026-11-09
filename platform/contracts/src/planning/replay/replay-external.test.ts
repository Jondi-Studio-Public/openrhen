import { describe, expect, it } from "vitest";
import { parseExternalCases } from "./replay-external.js";
import { goldenCases } from "./replay-suite.js";

const file = (name: string, value: unknown) => ({ name, text: JSON.stringify(value) });

describe("external replay cases", () => {
  it("loads nothing from no files", () => {
    expect(parseExternalCases([])).toEqual([]);
  });

  it("parses single cases and arrays, in file-name order", () => {
    const cases = parseExternalCases([
      file("b.json", [{ ...goldenCases[1], id: "other-case" }]),
      file("a.json", goldenCases[0])
    ]);
    expect(cases.map((c) => c.id)).toEqual([goldenCases[0]!.id, "other-case"]);
  });

  it("rejects duplicate ids, bad cases and non-JSON", () => {
    expect(() => parseExternalCases([file("a.json", [goldenCases[0], goldenCases[0]])])).toThrow(/duplicate/);
    expect(() => parseExternalCases([file("a.json", { id: "x" })])).toThrow();
    expect(() => parseExternalCases([{ name: "a.json", text: "{" }])).toThrow(/not JSON/);
  });
});
