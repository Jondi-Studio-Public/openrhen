import { describe, expect, it } from "vitest";
import { versionIn } from "./version-in";

interface Row {
  id: string;
  version?: number;
}

const rows: Row[] = [{ id: "a", version: 3 }, { id: "b" }];

describe("versionIn", () => {
  it("returns the version of the record found", () => {
    expect(versionIn(rows, "a")).toBe(3);
  });

  it("returns null for a record found with no version", () => {
    expect(versionIn(rows, "b")).toBeNull();
  });

  it("returns null when no record matches the id", () => {
    expect(versionIn(rows, "missing")).toBeNull();
  });

  it("returns null for an empty collection", () => {
    expect(versionIn([], "a")).toBeNull();
  });
});
